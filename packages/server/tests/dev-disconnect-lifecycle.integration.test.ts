import { AIRJAM_DEV_LOG_EVENTS } from "@air-jam/sdk/protocol";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { io, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAirJamServer, type AirJamServerRuntime } from "../src/index";
import type { HostBootstrapAuthService } from "../src/services/auth-service";
import { getHttpServerLoopbackUrl } from "./helpers/http-server-test-url";
import { emitWithAck, waitForSocketConnect } from "./helpers/socket-test-utils";

describe("dev disconnect lifecycle logs", () => {
  let runtime: AirJamServerRuntime | null = null;
  let baseUrl = "";
  let tempDir = "";
  let host: Socket | null = null;
  let childHost: Socket | null = null;
  let controller: Socket | null = null;
  let previousChildTeardownMs: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "air-jam-disconnect-logs-"));
    previousChildTeardownMs = process.env.AIR_JAM_CHILD_HOST_TEARDOWN_MS;
    process.env.AIR_JAM_CHILD_HOST_TEARDOWN_MS = "25";
    const authService: HostBootstrapAuthService = {
      verifyHostBootstrap: async ({ appId }: { appId?: string }) => ({
        isVerified: true,
        appId,
        verifiedVia: "appId" as const,
      }),
    };
    runtime = createAirJamServer({
      devLogDir: tempDir,
      authService,
    });
    await runtime.start(0);
    baseUrl = getHttpServerLoopbackUrl(runtime.httpServer);
  });

  afterEach(async () => {
    controller?.disconnect();
    controller = null;
    childHost?.disconnect();
    childHost = null;
    host?.disconnect();
    host = null;

    if (runtime) {
      await runtime.stop();
      runtime = null;
    }

    if (previousChildTeardownMs === undefined) {
      delete process.env.AIR_JAM_CHILD_HOST_TEARDOWN_MS;
    } else {
      process.env.AIR_JAM_CHILD_HOST_TEARDOWN_MS = previousChildTeardownMs;
    }

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("logs disconnect-driven lifecycle recovery edges", async () => {
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
        appId: "aj_app_disconnect_test",
      },
    );
    expect(bootstrapAck.ok).toBe(true);

    const createRoomAck = await emitWithAck<{
      ok: boolean;
      roomId?: string;
    }>(host, "host:createRoom", { maxPlayers: 4 });
    expect(createRoomAck.ok).toBe(true);
    const roomId = createRoomAck.roomId as string;

    const joinAck = await emitWithAck<{ ok: boolean }>(
      controller,
      "controller:join",
      {
        roomId,
        controllerId: "ctrl_disconnect_1",
        nickname: "Disconnect",
      },
    );
    expect(joinAck.ok).toBe(true);

    const launchAck = await emitWithAck<{
      ok: boolean;
      launchCapability?: { token: string };
    }>(host, "system:launchGame", {
      roomId,
      gameId: "pong",
    });
    expect(launchAck.ok).toBe(true);
    expect(launchAck.launchCapability?.token).toBeTruthy();

    childHost = io(baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    await waitForSocketConnect(childHost);
    const childJoinAck = await emitWithAck<{ ok: boolean }>(
      childHost,
      "host:joinAsChild",
      {
        roomId,
        capabilityToken: launchAck.launchCapability?.token,
      },
    );
    expect(childJoinAck.ok).toBe(true);

    controller.disconnect();
    controller = null;
    childHost.disconnect();
    childHost = null;
    await new Promise((resolve) => setTimeout(resolve, 80));

    host.disconnect();
    host = null;
    await new Promise((resolve) => setTimeout(resolve, 3_150));

    const latestContents = await readFile(
      path.join(tempDir, "dev-latest.ndjson"),
      "utf8",
    );

    expect(latestContents).toContain(
      `"event":"${AIRJAM_DEV_LOG_EVENTS.controller.disconnectPendingResume}"`,
    );
    expect(latestContents).toContain(
      `"event":"${AIRJAM_DEV_LOG_EVENTS.childHost.disconnectPendingSystemFocus}"`,
    );
    expect(latestContents).toContain(
      `"event":"${AIRJAM_DEV_LOG_EVENTS.childHost.disconnectSystemFocusRestored}"`,
    );
    expect(latestContents).toContain(
      `"event":"${AIRJAM_DEV_LOG_EVENTS.host.disconnectPendingRoomClose}"`,
    );
    expect(latestContents).toContain(
      `"event":"${AIRJAM_DEV_LOG_EVENTS.host.disconnectRoomClosed}"`,
    );
    expect(latestContents).toContain('"controllerId":"ctrl_disconnect_1"');
    expect(latestContents).toContain(`"roomId":"${roomId}"`);
  });
});
