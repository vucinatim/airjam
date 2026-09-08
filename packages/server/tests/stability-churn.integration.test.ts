import { describe, expect, it } from "vitest";
import type { AuthService } from "../src/services/auth-service";
import { setupServerTestHarness } from "./helpers/server-test-harness";

type HostCreateRoomAck = {
  ok: boolean;
  roomId?: string;
  hostResumeCapability?: { token: string };
};

type ControllerJoinAck = {
  ok: boolean;
};

const allowAllAuthService = {
  verifyHostBootstrap: async ({ appId }: { appId?: string }) => ({
    isVerified: true,
    appId,
    verifiedVia: "appId" as const,
  }),
} as AuthService;

describe("server stability churn", () => {
  const harness = setupServerTestHarness({
    server: { authService: allowAllAuthService },
  });

  it("handles repeated host reconnect cycles without losing room ownership", async () => {
    let host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);

    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 8 },
    );

    expect(createAck.ok).toBe(true);
    const roomId = createAck.roomId!;
    const resumeCapabilityToken = createAck.hostResumeCapability!.token;

    for (let i = 0; i < 5; i += 1) {
      host.disconnect();
      await harness.delay(25);

      host = await harness.connectSocket();
      expect((await harness.bootstrapHost(host)).ok).toBe(true);
      const reconnectAck = await harness.emitWithAck<HostCreateRoomAck>(
        host,
        "host:reconnect",
        { roomId, resumeCapabilityToken },
      );

      expect(reconnectAck.ok).toBe(true);
      expect(reconnectAck.roomId).toBe(roomId);
    }
  });

  it("handles rapid controller join/leave churn without stale controller sessions", async () => {
    const host = await harness.connectSocket();
    expect((await harness.bootstrapHost(host)).ok).toBe(true);

    const createAck = await harness.emitWithAck<HostCreateRoomAck>(
      host,
      "host:createRoom",
      { maxPlayers: 16 },
    );

    expect(createAck.ok).toBe(true);
    const roomId = createAck.roomId!;

    for (let i = 0; i < 12; i += 1) {
      const controllerId = `ctrl_churn_${i}`;
      const controller = await harness.connectSocket();

      const joinAck = await harness.emitWithAck<ControllerJoinAck>(
        controller,
        "controller:join",
        {
          roomId,
          controllerId,
          nickname: `Player ${i}`,
        },
      );

      expect(joinAck.ok).toBe(true);

      const leftNoticePromise = harness.waitForEvent<{ controllerId: string }>(
        host,
        "server:controllerLeft",
      );

      await harness.emitWithAck<{ ok: boolean }>(
        controller,
        "controller:leave",
        {
          roomId,
          controllerId,
        },
      );

      const leftNotice = await leftNoticePromise;
      expect(leftNotice.controllerId).toBe(controllerId);
      controller.disconnect();
    }

    const room = harness.getRoomManager().getRoom(roomId);
    expect(room).toBeDefined();
    expect(room?.controllers.size).toBe(0);
  });
});
