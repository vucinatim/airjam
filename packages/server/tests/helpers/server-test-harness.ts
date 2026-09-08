import type { HostSessionKind } from "@air-jam/sdk/protocol";
import { io, type Socket } from "socket.io-client";
import { afterEach, beforeEach } from "vitest";
import {
  createAirJamServer,
  type AirJamServerRuntime,
  type CreateAirJamServerOptions,
} from "../../src/index";
import { RateLimitService } from "../../src/services/rate-limit-service";
import { RoomManager } from "../../src/services/room-manager";
import { getHttpServerLoopbackUrl } from "./http-server-test-url";
import {
  emitWithAck as emitWithAckWithTimeout,
  waitForSocketConnect,
} from "./socket-test-utils";

type GenericEventMap = Record<string, (...args: unknown[]) => void>;
type GenericSocket = Socket<GenericEventMap, GenericEventMap>;

interface HarnessOptions {
  server?: Omit<CreateAirJamServerOptions, "roomManager" | "rateLimitService">;
}

export interface ServerTestHarness {
  connectSocket: (options?: { origin?: string }) => Promise<GenericSocket>;
  bootstrapHost: (
    socket: GenericSocket,
    appId?: string,
    hostSessionKind?: HostSessionKind,
  ) => Promise<{ ok: boolean; code?: string; message?: string }>;
  emitWithAck: <TAck>(
    socket: GenericSocket,
    event: string,
    payload: unknown,
  ) => Promise<TAck>;
  waitForEvent: <TPayload>(
    socket: GenericSocket,
    event: string,
    timeoutMs?: number,
  ) => Promise<TPayload>;
  waitForEventMatching: <TPayload>(
    socket: GenericSocket,
    event: string,
    predicate: (payload: TPayload) => boolean,
    timeoutMs?: number,
  ) => Promise<TPayload>;
  expectNoEvent: (
    socket: GenericSocket,
    event: string,
    waitMs?: number,
  ) => Promise<void>;
  delay: (ms: number) => Promise<void>;
  getBaseUrl: () => string;
  getRoomManager: () => RoomManager;
}

export const setupServerTestHarness = (
  options: HarnessOptions = {},
): ServerTestHarness => {
  let runtime: AirJamServerRuntime | null = null;
  let roomManager = new RoomManager();
  const sockets: GenericSocket[] = [];
  let baseUrl = "";
  let previousChildTeardownMs: string | undefined;
  let previousControllerResumeLeaseMs: string | undefined;

  beforeEach(async () => {
    previousChildTeardownMs = process.env.AIR_JAM_CHILD_HOST_TEARDOWN_MS;
    previousControllerResumeLeaseMs =
      process.env.AIR_JAM_CONTROLLER_RESUME_LEASE_MS;
    process.env.AIR_JAM_CHILD_HOST_TEARDOWN_MS = "50";
    process.env.AIR_JAM_CONTROLLER_RESUME_LEASE_MS = "100";
    roomManager = new RoomManager();
    const rateLimitService = new RateLimitService();
    runtime = createAirJamServer({
      ...options.server,
      roomManager,
      rateLimitService,
    });

    await runtime.start(0);
    baseUrl = getHttpServerLoopbackUrl(runtime.httpServer);
  });

  afterEach(async () => {
    while (sockets.length > 0) {
      const socket = sockets.pop();
      socket?.disconnect();
    }

    if (runtime) {
      await runtime.stop();
      runtime = null;
    }
    baseUrl = "";
    if (previousChildTeardownMs === undefined) {
      delete process.env.AIR_JAM_CHILD_HOST_TEARDOWN_MS;
    } else {
      process.env.AIR_JAM_CHILD_HOST_TEARDOWN_MS = previousChildTeardownMs;
    }
    if (previousControllerResumeLeaseMs === undefined) {
      delete process.env.AIR_JAM_CONTROLLER_RESUME_LEASE_MS;
    } else {
      process.env.AIR_JAM_CONTROLLER_RESUME_LEASE_MS =
        previousControllerResumeLeaseMs;
    }
  });

  const connectSocket = async (options?: {
    origin?: string;
  }): Promise<GenericSocket> => {
    const nextSocket = io(baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders: options?.origin
        ? {
            origin: options.origin,
          }
        : undefined,
    });

    await waitForSocketConnect(nextSocket as GenericSocket);
    const socket = nextSocket as GenericSocket;

    sockets.push(socket);
    return socket;
  };

  const emitWithAck = async <TAck>(
    socket: GenericSocket,
    event: string,
    payload: unknown,
  ): Promise<TAck> => {
    return await emitWithAckWithTimeout<TAck>(socket, event, payload);
  };

  const bootstrapHost = async (
    socket: GenericSocket,
    appId?: string,
    hostSessionKind: HostSessionKind = "system",
  ): Promise<{ ok: boolean; code?: string; message?: string }> => {
    return await emitWithAck(socket, "host:bootstrap", {
      appId,
      hostSessionKind,
    });
  };

  const waitForEvent = async <TPayload>(
    socket: GenericSocket,
    event: string,
    timeoutMs = 750,
  ): Promise<TPayload> => {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.off(event, onEvent);
        reject(new Error(`Timed out waiting for ${event}`));
      }, timeoutMs);

      const onEvent = (...args: unknown[]) => {
        const payload = args[0] as TPayload;
        clearTimeout(timeout);
        resolve(payload);
      };

      socket.once(event, onEvent);
    });
  };

  const waitForEventMatching = async <TPayload>(
    socket: GenericSocket,
    event: string,
    predicate: (payload: TPayload) => boolean,
    timeoutMs = 750,
  ): Promise<TPayload> => {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.off(event, onEvent);
        reject(new Error(`Timed out waiting for matching ${event}`));
      }, timeoutMs);

      const onEvent = (...args: unknown[]) => {
        const payload = args[0] as TPayload;
        if (!predicate(payload)) {
          return;
        }
        clearTimeout(timeout);
        socket.off(event, onEvent);
        resolve(payload);
      };

      socket.on(event, onEvent);
    });
  };

  const expectNoEvent = async (
    socket: GenericSocket,
    event: string,
    waitMs = 250,
  ): Promise<void> => {
    await new Promise((resolve, reject) => {
      const onEvent = () => {
        clearTimeout(timer);
        reject(new Error(`Unexpected event received: ${event}`));
      };

      const timer = setTimeout(() => {
        socket.off(event, onEvent);
        resolve(undefined);
      }, waitMs);

      socket.once(event, onEvent);
    });
  };

  const delay = async (ms: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  };

  return {
    connectSocket,
    bootstrapHost,
    emitWithAck,
    waitForEvent,
    waitForEventMatching,
    expectNoEvent,
    delay,
    getBaseUrl: () => baseUrl,
    getRoomManager: () => roomManager,
  };
};
