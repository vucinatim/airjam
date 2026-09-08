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

describe("dev log summaries", () => {
  let runtime: AirJamServerRuntime | null = null;
  let tempDir = "";
  let baseUrl = "";
  let host: Socket | null = null;
  let controller: Socket | null = null;
  let previousSummaryWindowMs: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "air-jam-log-summaries-"));
    previousSummaryWindowMs = process.env.AIR_JAM_DEV_LOG_SUMMARY_WINDOW_MS;
    process.env.AIR_JAM_DEV_LOG_SUMMARY_WINDOW_MS = "25";
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
    host?.disconnect();
    host = null;

    if (runtime) {
      await runtime.stop();
      runtime = null;
    }

    if (previousSummaryWindowMs === undefined) {
      delete process.env.AIR_JAM_DEV_LOG_SUMMARY_WINDOW_MS;
    } else {
      process.env.AIR_JAM_DEV_LOG_SUMMARY_WINDOW_MS = previousSummaryWindowMs;
    }

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("summarizes high-frequency controller input, action RPC, and host state sync traffic", async () => {
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
        appId: "aj_app_summary_test",
      },
    );
    expect(bootstrapAck.ok).toBe(true);

    const createRoomAck = await emitWithAck<{
      ok: boolean;
      roomId?: string;
      controllerCapability?: { token: string };
    }>(host, "host:createRoom", { maxPlayers: 4 });
    expect(createRoomAck.ok).toBe(true);
    expect(createRoomAck.roomId).toBeTruthy();

    const roomId = createRoomAck.roomId as string;

    const controllerJoinAck = await emitWithAck<{ ok: boolean }>(
      controller,
      "controller:join",
      {
        roomId,
        controllerId: "ctrl_summary_1",
        nickname: "Summary Controller",
        capabilityToken: createRoomAck.controllerCapability?.token,
      },
    );
    expect(controllerJoinAck.ok).toBe(true);

    controller.emit("controller:input", {
      roomId,
      controllerId: "ctrl_summary_1",
      input: {
        vector: { x: 1, y: 0 },
        action: false,
      },
    });
    controller.emit("controller:input", {
      roomId,
      controllerId: "ctrl_summary_1",
      input: {
        vector: { x: 0, y: 0 },
        action: true,
      },
    });
    controller.emit("controller:action_rpc", {
      roomId,
      actionName: "jump",
      payload: { force: 1 },
      storeDomain: "game",
    });
    controller.emit("controller:action_rpc", {
      roomId,
      actionName: "jump",
      payload: { force: 2 },
      storeDomain: "game",
    });
    host.emit("host:state_sync", {
      roomId,
      storeDomain: "game",
      data: { score: 1 },
      revision: 0,
    });
    host.emit("host:state_sync", {
      roomId,
      storeDomain: "game",
      data: { score: 2 },
      revision: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    await runtime?.flushDevLogs();

    const latestContents = await readFile(
      path.join(tempDir, "dev-latest.ndjson"),
      "utf8",
    );

    expect(latestContents).toContain(
      `"event":"${AIRJAM_DEV_LOG_EVENTS.controller.inputSummary}"`,
    );
    expect(latestContents).toContain('"inputCount":2');
    expect(latestContents).toContain('"activeInputCount":2');
    expect(latestContents).toContain(
      `"event":"${AIRJAM_DEV_LOG_EVENTS.controller.actionRpcSummary}"`,
    );
    expect(latestContents).toContain('"rpcCount":2');
    expect(latestContents).toContain('"actionName":"jump"');
    expect(latestContents).toContain(
      `"event":"${AIRJAM_DEV_LOG_EVENTS.host.stateSyncSummary}"`,
    );
    expect(latestContents).toContain('"syncCount":2');
    expect(latestContents).toContain('"storeDomain":"game"');
  });

  it("suppresses repeated idle controller input summaries once the signal stops changing", async () => {
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
        appId: "aj_app_summary_test",
      },
    );
    expect(bootstrapAck.ok).toBe(true);

    const createRoomAck = await emitWithAck<{
      ok: boolean;
      roomId?: string;
      controllerCapability?: { token: string };
    }>(host, "host:createRoom", { maxPlayers: 4 });
    expect(createRoomAck.ok).toBe(true);
    expect(createRoomAck.roomId).toBeTruthy();

    const roomId = createRoomAck.roomId as string;

    const controllerJoinAck = await emitWithAck<{ ok: boolean }>(
      controller,
      "controller:join",
      {
        roomId,
        controllerId: "ctrl_idle_1",
        nickname: "Idle Controller",
        capabilityToken: createRoomAck.controllerCapability?.token,
      },
    );
    expect(controllerJoinAck.ok).toBe(true);

    const emitNeutralInputs = (count: number): void => {
      for (let index = 0; index < count; index += 1) {
        controller!.emit("controller:input", {
          roomId,
          controllerId: "ctrl_idle_1",
          input: {
            vector: { x: 0, y: 0 },
            action: false,
          },
        });
      }
    };

    emitNeutralInputs(2);
    await new Promise((resolve) => setTimeout(resolve, 80));
    emitNeutralInputs(2);
    await new Promise((resolve) => setTimeout(resolve, 80));
    emitNeutralInputs(2);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await runtime?.flushDevLogs();

    const latestContents = await readFile(
      path.join(tempDir, "dev-latest.ndjson"),
      "utf8",
    );

    const inputSummaryCount = (
      latestContents.match(
        new RegExp(
          `"event":"${AIRJAM_DEV_LOG_EVENTS.controller.inputSummary}"`,
          "g",
        ),
      ) ?? []
    ).length;

    expect(inputSummaryCount).toBe(1);
    expect(latestContents).toContain('"inputCount":2');
    expect(latestContents).toContain('"activeInputCount":0');
  });
});
