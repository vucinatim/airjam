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

const parseEvents = (contents: string): Array<Record<string, unknown>> =>
  contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("dev browser log sink", () => {
  let runtime: AirJamServerRuntime | null = null;
  let baseUrl = "";
  let tempDir = "";
  let socket: Socket | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "air-jam-browser-logs-"));
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
    socket?.disconnect();
    socket = null;

    if (runtime) {
      await runtime.stop();
      runtime = null;
    }

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("writes server and browser events into one canonical dev file", async () => {
    socket = io(baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });

    await waitForSocketConnect(socket);

    const bootstrapAck = await emitWithAck<{ ok: boolean; traceId?: string }>(
      socket,
      "host:bootstrap",
      { appId: "aj_app_test123" },
    );

    expect(bootstrapAck.ok).toBe(true);
    expect(bootstrapAck.traceId).toBeTruthy();

    const resetResponse = await fetch(`${baseUrl}/__airjam/dev/browser-logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "reset",
        sessionId: "session-one",
        metadata: {
          appId: "aj_app_test123",
          traceId: bootstrapAck.traceId,
          origin: "http://localhost:5173",
          pathname: "/",
        },
        entries: [
          {
            occurredAt: "2026-03-26T20:00:00.000Z",
            level: "info",
            source: "console",
            sourceSeq: 1,
            message: "hello from browser",
            consoleCategory: "app",
          },
        ],
      }),
    });

    expect(resetResponse.status).toBe(200);

    const appendResponse = await fetch(`${baseUrl}/__airjam/dev/browser-logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "append",
        sessionId: "session-one",
        metadata: {
          appId: "aj_app_test123",
          traceId: bootstrapAck.traceId,
          origin: "http://localhost:5173",
          pathname: "/play",
        },
        entries: [
          {
            occurredAt: "2026-03-26T20:00:01.000Z",
            level: "error",
            source: "window-error",
            sourceSeq: 2,
            message: "boom",
            stack: "Error: boom",
          },
          {
            occurredAt: "2026-03-26T20:00:01.050Z",
            level: "warn",
            source: "console",
            sourceSeq: 3,
            message: "[InputManager] Invalid input",
            consoleCategory: "airjam",
            repeatCount: 5,
          },
          {
            occurredAt: "2026-03-26T20:00:01.100Z",
            level: "info",
            source: "runtime",
            sourceSeq: 4,
            event: AIRJAM_DEV_LOG_EVENTS.runtime.embeddedBridgeAttached,
            message: "Embedded host bridge attached",
            runtimeKind: "arcade-host-runtime",
            runtimeEpoch: 2,
            roomId: "ROOM1",
          },
        ],
      }),
    });

    expect(appendResponse.status).toBe(200);

    const unloadResponse = await fetch(
      `${baseUrl}/__airjam/dev/browser-unload`,
      {
        method: "POST",
        headers: {
          "content-type": "text/plain;charset=UTF-8",
        },
        body: JSON.stringify({
          sessionId: "session-one",
          metadata: {
            appId: "aj_app_test123",
            traceId: bootstrapAck.traceId,
            origin: "http://localhost:5173",
            pathname: "/play",
          },
          entry: {
            occurredAt: "2026-03-26T20:00:01.150Z",
            level: "info",
            source: "runtime",
            sourceSeq: 5,
            event: AIRJAM_DEV_LOG_EVENTS.runtime.windowPageHide,
            message: "Window pagehide observed",
            data: [{ trigger: "pagehide" }],
          },
        }),
      },
    );

    expect(unloadResponse.status).toBe(204);

    const unloadBeforeResponse = await fetch(
      `${baseUrl}/__airjam/dev/browser-unload`,
      {
        method: "POST",
        headers: {
          "content-type": "text/plain;charset=UTF-8",
        },
        body: JSON.stringify({
          sessionId: "session-one",
          metadata: {
            appId: "aj_app_test123",
            traceId: bootstrapAck.traceId,
            origin: "http://localhost:5173",
            pathname: "/play",
          },
          entry: {
            occurredAt: "2026-03-26T20:00:01.175Z",
            level: "info",
            source: "runtime",
            sourceSeq: 6,
            event: AIRJAM_DEV_LOG_EVENTS.runtime.windowBeforeUnload,
            message: "Window beforeunload observed",
            data: [{ trigger: "beforeunload" }],
          },
        }),
      },
    );

    expect(unloadBeforeResponse.status).toBe(204);

    await new Promise((resolve) => setTimeout(resolve, 75));
    await runtime?.flushDevLogs();

    const latestContents = await readFile(
      path.join(tempDir, "dev-latest.ndjson"),
      "utf8",
    );
    const events = parseEvents(latestContents);
    const browserConsoleEvent = events.find(
      (event) => event.event === AIRJAM_DEV_LOG_EVENTS.browser.console,
    );
    const repeatedConsoleEvent = events.find(
      (event) =>
        event.event === AIRJAM_DEV_LOG_EVENTS.browser.console &&
        event.msg === "[InputManager] Invalid input",
    );
    const runtimeEvent = events.find(
      (event) =>
        event.event === AIRJAM_DEV_LOG_EVENTS.runtime.embeddedBridgeAttached,
    );
    const pageHideEvent = events.find(
      (event) => event.event === AIRJAM_DEV_LOG_EVENTS.runtime.windowPageHide,
    );
    const beforeUnloadEvent = events.find(
      (event) =>
        event.event === AIRJAM_DEV_LOG_EVENTS.runtime.windowBeforeUnload,
    );
    const collectorSeqs = events
      .map((event) => event.collectorSeq)
      .filter((value): value is number => typeof value === "number");

    expect(latestContents).toContain('"source":"server"');
    expect(latestContents).toContain('"source":"browser"');
    expect(latestContents).toContain('"msg":"Host bootstrap verified"');
    expect(latestContents).toContain(
      `"event":"${AIRJAM_DEV_LOG_EVENTS.server.started}"`,
    );
    expect(latestContents).toContain(
      `"event":"${AIRJAM_DEV_LOG_EVENTS.host.bootstrapVerified}"`,
    );
    expect(latestContents).toContain('"msg":"hello from browser"');
    expect(latestContents).toContain(`"traceId":"${bootstrapAck.traceId}"`);
    expect(latestContents).toContain('"sessionId":"session-one"');
    expect(latestContents).toContain(
      `"event":"${AIRJAM_DEV_LOG_EVENTS.browser.console}"`,
    );
    expect(latestContents).toContain(
      `"event":"${AIRJAM_DEV_LOG_EVENTS.runtime.embeddedBridgeAttached}"`,
    );
    expect(latestContents).toContain('"runtimeKind":"arcade-host-runtime"');
    expect(latestContents).toContain('"runtimeEpoch":2');
    expect(browserConsoleEvent?.occurredAt).toBe("2026-03-26T20:00:00.000Z");
    expect(browserConsoleEvent?.time).toBe("2026-03-26T20:00:00.000Z");
    expect(browserConsoleEvent?.sourceSeq).toBe(1);
    expect(browserConsoleEvent?.consoleCategory).toBe("app");
    expect(repeatedConsoleEvent?.consoleCategory).toBe("airjam");
    expect(repeatedConsoleEvent?.repeatCount).toBe(5);
    expect(typeof browserConsoleEvent?.collectorSeq).toBe("number");
    expect(typeof browserConsoleEvent?.ingestedAt).toBe("string");
    expect(runtimeEvent?.sourceSeq).toBe(4);
    expect(pageHideEvent?.sourceSeq).toBe(5);
    expect(pageHideEvent?.msg).toBe("Window pagehide observed");
    expect(beforeUnloadEvent?.sourceSeq).toBe(6);
    expect(beforeUnloadEvent?.msg).toBe("Window beforeunload observed");
    expect(collectorSeqs).toEqual([...collectorSeqs].sort((a, b) => a - b));
  });

  it("preserves controller correlation fields and controller lifecycle events in the canonical dev file", async () => {
    socket = io(baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });

    await new Promise<void>((resolve, reject) => {
      socket!.once("connect", () => resolve());
      socket!.once("connect_error", (error: Error) => reject(error));
    });

    const bootstrapAck = await new Promise<{ ok: boolean; traceId?: string }>(
      (resolve) => {
        socket!.emit("host:bootstrap", { appId: "aj_app_test123" }, resolve);
      },
    );

    expect(bootstrapAck.ok).toBe(true);

    const createRoomAck = await new Promise<{ ok: boolean; roomId?: string }>(
      (resolve) => {
        socket!.emit("host:createRoom", { maxPlayers: 4 }, resolve);
      },
    );

    expect(createRoomAck.ok).toBe(true);
    expect(createRoomAck.roomId).toBeTruthy();

    const controllerSocket = io(baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });

    await new Promise<void>((resolve, reject) => {
      controllerSocket.once("connect", () => resolve());
      controllerSocket.once("connect_error", (error: Error) => reject(error));
    });

    const controllerJoinAck = await new Promise<{
      ok: boolean;
      roomId?: string;
      controllerId?: string;
    }>((resolve) => {
      controllerSocket.emit(
        "controller:join",
        {
          roomId: createRoomAck.roomId,
          controllerId: "ctrl_dev_logs_1",
          nickname: "Dev Logs",
        },
        resolve,
      );
    });

    expect(controllerJoinAck.ok).toBe(true);

    const response = await fetch(`${baseUrl}/__airjam/dev/browser-logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "reset",
        sessionId: "controller-session",
        metadata: {
          appId: "aj_app_test123",
          roomId: createRoomAck.roomId,
          controllerId: "ctrl_dev_logs_1",
          role: "controller",
          origin: "http://localhost:5173",
          pathname: "/controller",
        },
        entries: [
          {
            occurredAt: "2026-03-26T20:10:00.000Z",
            level: "warn",
            source: "console",
            sourceSeq: 1,
            message: "controller browser log",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 25));

    controllerSocket.disconnect();

    const latestContents = await readFile(
      path.join(tempDir, "dev-latest.ndjson"),
      "utf8",
    );

    expect(latestContents).toContain(
      `"event":"${AIRJAM_DEV_LOG_EVENTS.controller.joinAccepted}"`,
    );
    expect(latestContents).toContain(
      `"event":"${AIRJAM_DEV_LOG_EVENTS.host.createRoomAccepted}"`,
    );
    expect(latestContents).toContain('"roomId":"');
    expect(latestContents).toContain('"controllerId":"ctrl_dev_logs_1"');
    expect(latestContents).toContain('"role":"controller"');
    expect(latestContents).toContain('"msg":"controller browser log"');
  });

  it("rejects malformed payloads", async () => {
    const response = await fetch(`${baseUrl}/__airjam/dev/browser-logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "reset",
        sessionId: "session-one",
        metadata: {},
        entries: [],
      }),
    });

    expect(response.status).toBe(400);
  });
});
