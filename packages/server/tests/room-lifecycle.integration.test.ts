import { ErrorCode } from "@air-jam/sdk/protocol";
import { describe, expect, it } from "vitest";
import type { AuthService } from "../src/services/auth-service";
import { setupServerTestHarness } from "./helpers/server-test-harness";

type HostCreateRoomAck = {
  ok: boolean;
  roomId?: string;
  message?: string;
  code?: ErrorCode | string;
  players?: Array<{
    id: string;
    label: string;
    color?: string;
    avatarId?: string;
  }>;
};

type ControllerJoinAck = {
  ok: boolean;
  controllerId?: string;
  roomId?: string;
  resumed?: boolean;
  message?: string;
  code?: ErrorCode | string;
};

const allowAllAuthService = {
  verifyHostBootstrap: async ({ appId }: { appId?: string }) => ({
    isVerified: true,
    appId,
    verifiedVia: "appId" as const,
  }),
} as AuthService;

describe("server room lifecycle", () => {
  const harness = setupServerTestHarness({
    server: { authService: allowAllAuthService },
  });

  it("allows host reconnect after disconnect", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);
    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );

    expect(createAck.ok).toBe(true);
    expect(createAck.roomId).toBeTypeOf("string");

    const roomId = createAck.roomId!;
    host.disconnect();
    await harness.delay(30);

    const reconnectedHost = await harness.connectSocket();
    expect((await harness.bootstrapHost(reconnectedHost)).ok).toBe(true);
    const reconnectAck = await harness.emitWithAck<HostCreateRoomAck>(
      reconnectedHost,
      "host:reconnect",
      { roomId },
    );

    expect(reconnectAck.ok).toBe(true);
    expect(reconnectAck.roomId).toBe(roomId);
  });

  it("returns the current controller roster in the host reconnect ack", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);
    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );

    expect(createAck.ok).toBe(true);
    const roomId = createAck.roomId!;

    const controller = await harness.connectSocket();
    const joinAck = await harness.emitWithAck<ControllerJoinAck>(
      controller,
      "controller:join",
      { roomId, controllerId: "ctrl_existing_1", nickname: "Existing" },
    );
    expect(joinAck.ok).toBe(true);

    host.disconnect();
    await harness.delay(30);

    const reconnectedHost = await harness.connectSocket();
    expect((await harness.bootstrapHost(reconnectedHost)).ok).toBe(true);
    const reconnectAck = await harness.emitWithAck<HostCreateRoomAck>(
      reconnectedHost,
      "host:reconnect",
      { roomId },
    );

    expect(reconnectAck.ok).toBe(true);
    expect(reconnectAck.players).toEqual([
      expect.objectContaining({
        id: "ctrl_existing_1",
        label: "Existing",
      }),
    ]);
  });

  it("routes controller join/leave/rejoin notices to the host", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);
    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );

    expect(createAck.ok).toBe(true);
    const roomId = createAck.roomId!;

    const controllerA = await harness.connectSocket();
    const joinedNoticePromise = harness.waitForEvent<{ controllerId: string }>(
      host,
      "server:controllerJoined",
    );
    const joinAck = await harness.emitWithAck<ControllerJoinAck>(
      controllerA,
      "controller:join",
      { roomId, controllerId: "ctrl_rejoin_1", nickname: "First" },
    );

    expect(joinAck.ok).toBe(true);
    const joinedNotice = await joinedNoticePromise;
    expect(joinedNotice.controllerId).toBe("ctrl_rejoin_1");

    const leftNoticePromise = harness.waitForEvent<{ controllerId: string }>(
      host,
      "server:controllerLeft",
    );
    await harness.emitWithAck<{ ok: boolean }>(
      controllerA,
      "controller:leave",
      {
        roomId,
        controllerId: "ctrl_rejoin_1",
      },
    );
    const leftNotice = await leftNoticePromise;
    expect(leftNotice.controllerId).toBe("ctrl_rejoin_1");
    await expect(
      harness.emitWithAck<{ ok: boolean }>(controllerA, "controller:leave", {
        roomId,
        controllerId: "ctrl_rejoin_1",
      }),
    ).resolves.toEqual({ ok: true });
    expect(harness.getRoomManager().getControllerInfo(controllerA.id!)).toBe(
      undefined,
    );

    const controllerB = await harness.connectSocket();
    const rejoinedNoticePromise = harness.waitForEvent<{
      controllerId: string;
    }>(host, "server:controllerJoined");
    const rejoinAck = await harness.emitWithAck<ControllerJoinAck>(
      controllerB,
      "controller:join",
      { roomId, controllerId: "ctrl_rejoin_1", nickname: "Second" },
    );

    expect(rejoinAck.ok).toBe(true);
    const rejoinedNotice = await rejoinedNoticePromise;
    expect(rejoinedNotice.controllerId).toBe("ctrl_rejoin_1");
  });

  it("hydrates controller welcome rosters and streams roster deltas to other controllers", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);
    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );

    expect(createAck.ok).toBe(true);
    const roomId = createAck.roomId!;

    const controllerA = await harness.connectSocket();
    const welcomeAPromise = harness.waitForEvent<{
      controllerId: string;
      players?: Array<{ id: string; label: string }>;
    }>(controllerA, "server:welcome");
    const joinAckA = await harness.emitWithAck<ControllerJoinAck>(
      controllerA,
      "controller:join",
      { roomId, controllerId: "ctrl_roster_1", nickname: "Alpha" },
    );

    expect(joinAckA.ok).toBe(true);
    expect(await welcomeAPromise).toEqual(
      expect.objectContaining({
        controllerId: "ctrl_roster_1",
        players: [
          expect.objectContaining({
            id: "ctrl_roster_1",
            label: "Alpha",
          }),
        ],
      }),
    );

    const controllerB = await harness.connectSocket();
    const controllerAJoinedPromise = harness.waitForEvent<{
      controllerId: string;
      player?: { id: string; label: string };
    }>(controllerA, "server:controllerJoined");
    const welcomeBPromise = harness.waitForEvent<{
      controllerId: string;
      players?: Array<{ id: string; label: string }>;
    }>(controllerB, "server:welcome");
    const joinAckB = await harness.emitWithAck<ControllerJoinAck>(
      controllerB,
      "controller:join",
      { roomId, controllerId: "ctrl_roster_2", nickname: "Beta" },
    );

    expect(joinAckB.ok).toBe(true);
    expect(await controllerAJoinedPromise).toEqual(
      expect.objectContaining({
        controllerId: "ctrl_roster_2",
        player: expect.objectContaining({
          id: "ctrl_roster_2",
          label: "Beta",
        }),
      }),
    );
    expect(await welcomeBPromise).toEqual(
      expect.objectContaining({
        controllerId: "ctrl_roster_2",
        players: expect.arrayContaining([
          expect.objectContaining({
            id: "ctrl_roster_1",
            label: "Alpha",
          }),
          expect.objectContaining({
            id: "ctrl_roster_2",
            label: "Beta",
          }),
        ]),
      }),
    );

    const controllerBLeftPromise = harness.waitForEvent<{
      controllerId: string;
    }>(controllerB, "server:controllerLeft");
    await harness.emitWithAck<{ ok: boolean }>(
      controllerA,
      "controller:leave",
      {
        roomId,
        controllerId: "ctrl_roster_1",
      },
    );

    expect(await controllerBLeftPromise).toEqual({
      controllerId: "ctrl_roster_1",
    });
  });

  it("resumes the same controller binding after disconnect when the device id matches", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);
    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );

    expect(createAck.ok).toBe(true);
    const roomId = createAck.roomId!;
    const deviceId = "device_resume_same_1";

    const controllerA = await harness.connectSocket();
    const firstJoinAck = await harness.emitWithAck<ControllerJoinAck>(
      controllerA,
      "controller:join",
      {
        roomId,
        controllerId: "ctrl_resume_1",
        deviceId,
        nickname: "Resume Me",
      },
    );
    expect(firstJoinAck.ok).toBe(true);
    controllerA.disconnect();

    await harness.expectNoEvent(host, "server:controllerLeft", 15);

    const controllerB = await harness.connectSocket();
    const resumedNoticePromise = harness.waitForEvent<{
      controllerId: string;
      resumed?: boolean;
    }>(host, "server:controllerJoined");
    const resumeAck = await harness.emitWithAck<ControllerJoinAck>(
      controllerB,
      "controller:join",
      {
        roomId,
        controllerId: "ctrl_resume_1",
        deviceId,
        nickname: "Resume Me",
      },
    );

    expect(resumeAck).toEqual(
      expect.objectContaining({
        ok: true,
        controllerId: "ctrl_resume_1",
        resumed: true,
      }),
    );
    expect(await resumedNoticePromise).toEqual(
      expect.objectContaining({
        controllerId: "ctrl_resume_1",
        resumed: true,
      }),
    );

    const session = harness.getRoomManager().getRoom(roomId)!;
    expect(session.controllers.get("ctrl_resume_1")).toEqual(
      expect.objectContaining({
        deviceId,
        connected: true,
      }),
    );
  });

  it("removes virtual controllers immediately on disconnect instead of holding a resume lease", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);
    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );

    expect(createAck.ok).toBe(true);
    const roomId = createAck.roomId!;

    const controller = await harness.connectSocket();
    const joinAck = await harness.emitWithAck<ControllerJoinAck>(
      controller,
      "controller:join",
      {
        roomId,
        controllerId: "ctrl_virtual_1",
        deviceId: "aj-mcp-device-test",
        nickname: "Virtual",
      },
    );
    expect(joinAck.ok).toBe(true);

    const leftNoticePromise = harness.waitForEvent<{ controllerId: string }>(
      host,
      "server:controllerLeft",
    );
    controller.disconnect();

    const leftNotice = await leftNoticePromise;
    expect(leftNotice.controllerId).toBe("ctrl_virtual_1");

    host.disconnect();
    await harness.delay(30);

    const reconnectHost = await harness.connectSocket();
    expect((await harness.bootstrapHost(reconnectHost)).ok).toBe(true);
    const reconnectAck = await harness.emitWithAck<HostCreateRoomAck>(
      reconnectHost,
      "host:reconnect",
      { roomId },
    );

    expect(reconnectAck.ok).toBe(true);
    expect(reconnectAck.players ?? []).not.toContainEqual(
      expect.objectContaining({ id: "ctrl_virtual_1" }),
    );
  });

  it("lets the active host remove a controller explicitly", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);
    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );

    expect(createAck.ok).toBe(true);
    const roomId = createAck.roomId!;

    const controller = await harness.connectSocket();
    const joinAck = await harness.emitWithAck<ControllerJoinAck>(
      controller,
      "controller:join",
      { roomId, controllerId: "ctrl_remove_1", nickname: "Remove Me" },
    );
    expect(joinAck.ok).toBe(true);

    const leftNoticePromise = harness.waitForEvent<{ controllerId: string }>(
      host,
      "server:controllerLeft",
    );
    const removeAck = await harness.emitWithAck<{ ok: boolean }>(
      host,
      "host:removeController",
      { roomId, controllerId: "ctrl_remove_1" },
    );

    expect(removeAck.ok).toBe(true);
    expect(await leftNoticePromise).toEqual({
      controllerId: "ctrl_remove_1",
    });

    host.disconnect();
    await harness.delay(30);

    const reconnectHost = await harness.connectSocket();
    expect((await harness.bootstrapHost(reconnectHost)).ok).toBe(true);
    const reconnectAck = await harness.emitWithAck<HostCreateRoomAck>(
      reconnectHost,
      "host:reconnect",
      { roomId },
    );

    expect(reconnectAck.ok).toBe(true);
    expect(reconnectAck.players ?? []).not.toContainEqual(
      expect.objectContaining({ id: "ctrl_remove_1" }),
    );
  });

  it("lets the master host reset the room into a fresh empty room", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);
    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );

    expect(createAck.ok).toBe(true);
    const previousRoomId = createAck.roomId!;

    const controller = await harness.connectSocket();
    const hostLeftPromise = harness.waitForEvent<{
      roomId: string;
      reason: string;
    }>(controller, "server:hostLeft");
    const joinAck = await harness.emitWithAck<ControllerJoinAck>(
      controller,
      "controller:join",
      {
        roomId: previousRoomId,
        controllerId: "ctrl_reset_1",
        nickname: "Reset Me",
      },
    );
    expect(joinAck.ok).toBe(true);

    const resetAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:resetRoom",
      { roomId: previousRoomId },
    );

    expect(resetAck.ok).toBe(true);
    expect(resetAck.roomId).toBeTypeOf("string");
    expect(resetAck.roomId).not.toBe(previousRoomId);
    expect(resetAck.players ?? []).toEqual([]);

    expect(await hostLeftPromise).toEqual({
      roomId: previousRoomId,
      reason: "room_reset",
    });
    expect(harness.getRoomManager().getRoom(previousRoomId)).toBeUndefined();
    expect(harness.getRoomManager().getRoom(resetAck.roomId!)).toBeDefined();
  });

  it("rejects resume attempts when a different device id tries to claim an existing controller binding", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);
    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );

    expect(createAck.ok).toBe(true);
    const roomId = createAck.roomId!;

    const controllerA = await harness.connectSocket();
    const firstJoinAck = await harness.emitWithAck<ControllerJoinAck>(
      controllerA,
      "controller:join",
      {
        roomId,
        controllerId: "ctrl_resume_conflict_1",
        deviceId: "device_a_conflict",
        nickname: "Owner",
      },
    );
    expect(firstJoinAck.ok).toBe(true);
    controllerA.disconnect();
    await harness.expectNoEvent(host, "server:controllerLeft", 15);

    const controllerB = await harness.connectSocket();
    const conflictAck = await harness.emitWithAck<ControllerJoinAck>(
      controllerB,
      "controller:join",
      {
        roomId,
        controllerId: "ctrl_resume_conflict_1",
        deviceId: "device_b_conflict",
        nickname: "Intruder",
      },
    );

    expect(conflictAck).toEqual(
      expect.objectContaining({
        ok: false,
        code: ErrorCode.INVALID_PAYLOAD,
      }),
    );
    await harness.expectNoEvent(host, "server:controllerJoined", 50);
  });

  it("replaces the previous controller identity when the same socket rejoins with a new controller id", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);
    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );

    expect(createAck.ok).toBe(true);
    const roomId = createAck.roomId!;

    const controller = await harness.connectSocket();
    const firstJoinAck = await harness.emitWithAck<ControllerJoinAck>(
      controller,
      "controller:join",
      { roomId, controllerId: "ctrl_old_1", nickname: "Old" },
    );
    expect(firstJoinAck.ok).toBe(true);

    const leftNoticePromise = harness.waitForEvent<{ controllerId: string }>(
      host,
      "server:controllerLeft",
      2_000,
    );
    const secondJoinAck = await harness.emitWithAck<ControllerJoinAck>(
      controller,
      "controller:join",
      { roomId, controllerId: "ctrl_new_1", nickname: "New" },
    );

    expect(secondJoinAck.ok).toBe(true);
    expect((await leftNoticePromise).controllerId).toBe("ctrl_old_1");

    const session = harness.getRoomManager().getRoom(roomId)!;
    expect(Array.from(session.controllers.keys())).toEqual(["ctrl_new_1"]);

    controller.disconnect();
    await harness.delay(30);
    expect(session.controllers.get("ctrl_new_1")).toEqual(
      expect.objectContaining({
        connected: false,
      }),
    );

    await harness.delay(90);
    expect(Array.from(session.controllers.keys())).toEqual([]);
  });

  it("cleans up room state after host disconnect timeout", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);

    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );

    expect(createAck.ok).toBe(true);
    expect(harness.getRoomManager().getAllRooms().size).toBe(1);

    host.disconnect();
    await harness.delay(3_250);

    expect(harness.getRoomManager().getAllRooms().size).toBe(0);
  });
});
