import { AIR_JAM_ARCADE_SURFACE_STORE_DOMAIN } from "@air-jam/sdk/arcade/surface";
import { describe, expect, it } from "vitest";
import type { AuthService } from "../src/services/auth-service";
import { setupServerTestHarness } from "./helpers/server-test-harness";

type HostCreateRoomAck = {
  ok: boolean;
  roomId?: string;
  hostResumeCapability?: { token: string };
};

const allowAllAuthService = {
  verifyHostBootstrap: async ({ appId }: { appId?: string }) => ({
    isVerified: true,
    appId,
    verifiedVia: "appId" as const,
  }),
} as AuthService;

describe("server state sync", () => {
  const harness = setupServerTestHarness({
    server: { authService: allowAllAuthService },
  });

  it("broadcasts host state sync to all controllers in the room", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);
    const controllerA = await harness.connectSocket();
    const controllerB = await harness.connectSocket();

    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );

    expect(createAck.ok).toBe(true);
    const roomId = createAck.roomId!;

    const joinAckA = await harness.emitWithAck<{ ok: boolean }>(
      controllerA,
      "controller:join",
      { roomId, controllerId: "ctrl_sync_a", nickname: "A" },
    );
    const joinAckB = await harness.emitWithAck<{ ok: boolean }>(
      controllerB,
      "controller:join",
      { roomId, controllerId: "ctrl_sync_b", nickname: "B" },
    );

    expect(joinAckA.ok).toBe(true);
    expect(joinAckB.ok).toBe(true);

    host.emit("host:state_sync", {
      roomId,
      data: { phase: "playing", score: 5 },
      storeDomain: "default",
      revision: 0,
    });

    const payloadA = await harness.waitForEvent<{
      roomId: string;
      data: Record<string, unknown>;
      storeDomain: string;
      revision: number;
    }>(controllerA, "airjam:state_sync");
    const payloadB = await harness.waitForEvent<{
      roomId: string;
      data: Record<string, unknown>;
      storeDomain: string;
      revision: number;
    }>(controllerB, "airjam:state_sync");

    expect(payloadA.roomId).toBe(roomId);
    expect(payloadB.roomId).toBe(roomId);
    expect(payloadA.storeDomain).toBe("default");
    expect(payloadB.storeDomain).toBe("default");
    expect(payloadA.revision).toBe(0);
    expect(payloadB.revision).toBe(0);
    expect(payloadA.data).toEqual({ phase: "playing", score: 5 });
    expect(payloadB.data).toEqual({ phase: "playing", score: 5 });
  });

  it("replays cached replicated store snapshots to a reconnecting host", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);

    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );

    expect(createAck.ok).toBe(true);
    const roomId = createAck.roomId!;
    const resumeCapabilityToken = createAck.hostResumeCapability!.token;

    host.emit("host:state_sync", {
      roomId,
      data: { phase: "playing", announcement: "SESSION QA OK" },
      storeDomain: "default",
      revision: 2,
    });

    await harness.delay(25);
    host.disconnect();

    const reconnectingHost = await harness.connectSocket();
    expect((await harness.bootstrapHost(reconnectingHost)).ok).toBe(true);

    const reconnectSequence: string[] = [];
    const restoredSyncPromise = new Promise<{
      roomId: string;
      data: Record<string, unknown>;
      storeDomain: string;
      revision: number;
    }>((resolve) => {
      reconnectingHost.once("airjam:state_sync", (payload: unknown) => {
        reconnectSequence.push("state_sync");
        resolve(
          payload as {
            roomId: string;
            data: Record<string, unknown>;
            storeDomain: string;
            revision: number;
          },
        );
      });
    });
    const reconnectAck = await new Promise<{
      ok: boolean;
      roomId?: string;
    }>((resolve) => {
      reconnectingHost.emit(
        "host:reconnect",
        { roomId, resumeCapabilityToken },
        (ack: { ok: boolean; roomId?: string }) => {
          reconnectSequence.push("ack");
          resolve(ack);
        },
      );
    });

    expect(reconnectAck).toMatchObject({
      ok: true,
      roomId,
    });

    const restoredSync = await restoredSyncPromise;
    expect(reconnectSequence).toEqual(["ack", "state_sync"]);

    expect(restoredSync).toEqual({
      roomId,
      data: { phase: "playing", announcement: "SESSION QA OK" },
      storeDomain: "default",
      revision: 2,
    });
  });

  it("restores arcade surface state from the typed reconnect session instead of a cached store snapshot", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);

    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );
    const roomId = createAck.roomId!;
    const resumeCapabilityToken = createAck.hostResumeCapability!.token;

    const launchAck = await harness.emitWithAck<{ ok: boolean }>(
      host,
      "system:launchGame",
      { roomId, gameId: "pong" },
    );
    expect(launchAck.ok).toBe(true);

    host.emit("host:state_sync", {
      roomId,
      data: { epoch: 4, kind: "game", gameId: "pong" },
      storeDomain: AIR_JAM_ARCADE_SURFACE_STORE_DOMAIN,
      revision: 3,
    });
    await harness.delay(25);
    host.disconnect();

    const reconnectingHost = await harness.connectSocket();
    expect((await harness.bootstrapHost(reconnectingHost)).ok).toBe(true);
    const replayedDomains: string[] = [];
    reconnectingHost.on("airjam:state_sync", (payload: unknown) => {
      replayedDomains.push((payload as { storeDomain: string }).storeDomain);
    });

    const reconnectAck = await harness.emitWithAck<{
      ok: boolean;
      arcadeSession?: {
        gameId: string;
      };
      arcadeSurfaceCheckpoint?: { epoch: number; revision: number };
    }>(reconnectingHost, "host:reconnect", {
      roomId,
      resumeCapabilityToken,
    });
    await harness.delay(25);

    expect(reconnectAck).toMatchObject({
      ok: true,
      arcadeSession: { gameId: "pong" },
      arcadeSurfaceCheckpoint: { epoch: 4, revision: 3 },
    });
    expect(replayedDomains).not.toContain(AIR_JAM_ARCADE_SURFACE_STORE_DOMAIN);
  });

  it("preserves the arcade counter checkpoint when reconnecting in system focus", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);

    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );
    const roomId = createAck.roomId!;
    const resumeCapabilityToken = createAck.hostResumeCapability!.token;

    host.emit("host:state_sync", {
      roomId,
      data: { epoch: 9, kind: "browser", gameId: null },
      storeDomain: AIR_JAM_ARCADE_SURFACE_STORE_DOMAIN,
      revision: 12,
    });
    await harness.delay(25);
    host.disconnect();

    const reconnectingHost = await harness.connectSocket();
    expect((await harness.bootstrapHost(reconnectingHost)).ok).toBe(true);
    const replayedDomains: string[] = [];
    reconnectingHost.on("airjam:state_sync", (payload: unknown) => {
      replayedDomains.push((payload as { storeDomain: string }).storeDomain);
    });

    const reconnectAck = await harness.emitWithAck<{
      ok: boolean;
      arcadeSession?: { gameId: string };
      arcadeSurfaceCheckpoint?: { epoch: number; revision: number };
    }>(reconnectingHost, "host:reconnect", {
      roomId,
      resumeCapabilityToken,
    });
    await harness.delay(25);

    expect(reconnectAck).toMatchObject({
      ok: true,
      arcadeSurfaceCheckpoint: { epoch: 9, revision: 12 },
    });
    expect(reconnectAck.arcadeSession).toBeUndefined();
    expect(replayedDomains).not.toContain(AIR_JAM_ARCADE_SURFACE_STORE_DOMAIN);
  });

  it("ignores forged host state sync from non-host sockets", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);
    const controller = await harness.connectSocket();
    const attacker = await harness.connectSocket();

    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );
    expect(createAck.ok).toBe(true);

    const roomId = createAck.roomId!;

    const joinAck = await harness.emitWithAck<{ ok: boolean }>(
      controller,
      "controller:join",
      { roomId, controllerId: "ctrl_sync_guard", nickname: "Guard" },
    );
    expect(joinAck.ok).toBe(true);

    attacker.emit("host:state_sync", {
      roomId,
      data: { hacked: true },
      storeDomain: "default",
      revision: 0,
    });

    await harness.expectNoEvent(controller, "airjam:state_sync");
  });

  it("routes controller state sync requests to the active host only", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);
    const controller = await harness.connectSocket();
    const attacker = await harness.connectSocket();

    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );
    expect(createAck.ok).toBe(true);
    const roomId = createAck.roomId!;

    const joinAck = await harness.emitWithAck<{ ok: boolean }>(
      controller,
      "controller:join",
      { roomId, controllerId: "ctrl_sync_request_1", nickname: "Requester" },
    );
    expect(joinAck.ok).toBe(true);

    const hostRequestPromise = harness.waitForEvent<{
      roomId: string;
      storeDomain: string;
      requestId?: string;
    }>(host, "airjam:state_sync_request");

    controller.emit("controller:state_sync_request", {
      roomId,
      storeDomain: "default",
    });

    await expect(hostRequestPromise).resolves.toEqual({
      roomId,
      storeDomain: "default",
    });

    const correlatedRequestPromise = harness.waitForEvent<{
      roomId: string;
      storeDomain: string;
      requestId?: string;
    }>(host, "airjam:state_sync_request");

    controller.emit("controller:state_sync_request", {
      roomId,
      storeDomain: "default",
      requestId: "sync_req_fixture",
    });

    await expect(correlatedRequestPromise).resolves.toEqual({
      roomId,
      storeDomain: "default",
      requestId: "sync_req_fixture",
    });

    attacker.emit("controller:state_sync_request", {
      roomId,
      storeDomain: "default",
    });

    await harness.expectNoEvent(host, "airjam:state_sync_request", 50);
  });

  it("updates player profile and notifies host + controller", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);
    const controller = await harness.connectSocket();

    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );
    expect(createAck.ok).toBe(true);
    const roomId = createAck.roomId!;

    const joinAck = await harness.emitWithAck<{ ok: boolean }>(
      controller,
      "controller:join",
      {
        roomId,
        controllerId: "ctrl_profile_1",
        nickname: "Old",
        avatarId: "aj-1",
      },
    );
    expect(joinAck.ok).toBe(true);

    const hostNoticePromise = harness.waitForEvent<{
      player: { id: string; label: string; avatarId?: string };
    }>(host, "server:playerUpdated");
    const selfNoticePromise = harness.waitForEvent<{
      player: { id: string; label: string; avatarId?: string };
    }>(controller, "server:playerUpdated");

    const updateAck = await harness.emitWithAck<{
      ok: boolean;
      player?: { id: string; label: string; avatarId?: string };
    }>(controller, "controller:updatePlayerProfile", {
      roomId,
      controllerId: "ctrl_profile_1",
      patch: { label: "NewName", avatarId: "aj-2" },
    });

    expect(updateAck.ok).toBe(true);
    expect(updateAck.player?.label).toBe("NewName");
    expect(updateAck.player?.avatarId).toBe("aj-2");

    const hostNotice = await hostNoticePromise;
    const selfNotice = await selfNoticePromise;
    expect(hostNotice.player.label).toBe("NewName");
    expect(selfNotice.player.id).toBe("ctrl_profile_1");
  });
});
