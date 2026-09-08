import { io, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAirJamServer, type AirJamServerRuntime } from "../src/index";
import type { HostBootstrapAuthService } from "../src/services/auth-service";
import { RoomManager } from "../src/services/room-manager";
import { getHttpServerLoopbackUrl } from "./helpers/http-server-test-url";
import { emitWithAck, waitForSocketConnect } from "./helpers/socket-test-utils";

describe("server runtime cleanup", () => {
  let runtime: AirJamServerRuntime | null = null;
  let roomManager: RoomManager;
  let baseUrl = "";
  let host: Socket | null = null;
  let controller: Socket | null = null;

  beforeEach(async () => {
    roomManager = new RoomManager();
    const authService: HostBootstrapAuthService = {
      verifyHostBootstrap: async ({ appId }: { appId?: string }) => ({
        isVerified: true,
        appId,
        verifiedVia: "appId" as const,
      }),
    };

    runtime = createAirJamServer({
      roomManager,
      authService,
    });
    await runtime.start(0);
    baseUrl = getHttpServerLoopbackUrl(runtime.httpServer);
  });

  afterEach(async () => {
    controller?.disconnect();
    controller = null;
    host?.disconnect();
    host = null;

    if (runtime) {
      await runtime.stop();
      runtime = null;
    }
  });

  it("clears room state and pending disconnect timers on stop", async () => {
    host = io(baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    controller = io(baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });

    await Promise.all([
      waitForSocketConnect(host),
      waitForSocketConnect(controller),
    ]);

    const bootstrapAck = await emitWithAck<{ ok: boolean }>(
      host,
      "host:bootstrap",
      {
        appId: "aj_app_cleanup_test",
      },
    );
    expect(bootstrapAck.ok).toBe(true);

    const createRoomAck = await emitWithAck<{ ok: boolean; roomId?: string }>(
      host,
      "host:createRoom",
      { maxPlayers: 4 },
    );
    expect(createRoomAck.ok).toBe(true);

    const roomId = createRoomAck.roomId as string;
    const joinAck = await emitWithAck<{ ok: boolean }>(
      controller,
      "controller:join",
      {
        roomId,
        controllerId: "ctrl_cleanup_1",
        nickname: "Cleanup",
      },
    );
    expect(joinAck.ok).toBe(true);
    expect(roomManager.getAllRooms().size).toBe(1);

    controller.disconnect();
    controller = null;
    host.disconnect();
    host = null;

    await runtime?.stop();
    runtime = null;

    expect(roomManager.getAllRooms().size).toBe(0);
  });
});
