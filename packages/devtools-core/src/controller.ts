import {
  AIR_JAM_ARCADE_SURFACE_STORE_DOMAIN,
  arcadeSurfaceRuntimeIdentitySchema,
  embeddedReplicatedStoreDomainFromArcadeIdentity,
} from "@air-jam/sdk/arcade/surface";
import type {
  AirJamStateSyncPayload,
  ClientToServerEvents,
  ControllerJoinAck,
  ControllerJoinedNotice,
  ControllerLeaveAck,
  ControllerStateMessage,
  ControllerWelcomePayload,
  HostActionRpcPayload,
  PlayerProfile,
  PlayerUpdatedNotice,
  ServerErrorPayload,
  ServerToClientEvents,
  SignalPayload,
} from "@air-jam/sdk/protocol";
import type { HostRuntimeInspectionContract } from "@air-jam/sdk/runtime-inspection";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import { detectProjectContext } from "./context.js";
import { getTopology } from "./dev.js";
import {
  resolveDevtoolsHelperArgs,
  resolveDevtoolsHelperScript,
} from "./helper-scripts.js";
import {
  AIR_JAM_RUNTIME_OWNER_CAPTURE_REQUEST,
  isRuntimeOwnerCaptureResult,
  type AirJamRuntimeOwnerCaptureResult,
} from "./runtime-owner-protocol.js";
import type {
  AirJamProjectMode,
  AirJamRuntimeSnapshotInspection,
  AirJamRuntimeStoreSnapshot,
  AirJamVirtualControllerSession,
  AirJamVirtualControllerSessionSummary,
  ConnectControllerOptions,
  DisconnectControllerOptions,
  DisconnectControllerResult,
  GetTopologyOptions,
  InvokeControllerActionOptions,
  InvokeControllerActionResult,
  JsonObject,
  ReadRuntimeSnapshotOptions,
  SendControllerInputOptions,
  SendControllerInputResult,
} from "./types.js";

type ControllerSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

type PendingStateSyncWaiter = {
  requestId: string;
  minimumRevision: number;
  resolve: (snapshot: AirJamRuntimeStoreSnapshot | null) => void;
};

type InternalControllerSession = {
  cwd: string;
  summary: AirJamVirtualControllerSessionSummary;
  socket: ControllerSocket;
  projectMode: AirJamProjectMode;
  welcome: JsonObject | null;
  controllerState: JsonObject | null;
  players: JsonObject[];
  storeSnapshots: Map<string, AirJamRuntimeStoreSnapshot>;
  pendingSyncWaiters: Map<string, Set<PendingStateSyncWaiter>>;
  lastSignal: JsonObject | null;
  lastError: JsonObject | null;
  isolatedRuntimeOwner: ChildProcess | null;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_VISUAL_CAPTURE_TIMEOUT_MS = 15_000;
const WAIT_INTERVAL_MS = 25;
const virtualControllerSessions = new Map<string, InternalControllerSession>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toJsonObject = (value: unknown): JsonObject | null => {
  if (!isRecord(value)) {
    return null;
  }

  return { ...value };
};

const toJsonObjectArray = (value: unknown): JsonObject[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const objectValue = toJsonObject(entry);
    return objectValue ? [objectValue] : [];
  });
};

const upsertPlayer = (
  players: JsonObject[],
  incoming: PlayerProfile | JsonObject | null,
): JsonObject[] => {
  const nextPlayer = toJsonObject(incoming);
  const playerId =
    typeof nextPlayer?.id === "string" && nextPlayer.id ? nextPlayer.id : null;
  if (!nextPlayer || !playerId) {
    return players;
  }

  const nextPlayers = players.slice();
  const existingIndex = nextPlayers.findIndex((entry) => entry.id === playerId);
  if (existingIndex === -1) {
    nextPlayers.push(nextPlayer);
    return nextPlayers;
  }

  nextPlayers[existingIndex] = {
    ...nextPlayers[existingIndex],
    ...nextPlayer,
  };
  return nextPlayers;
};

const removePlayer = (
  players: JsonObject[],
  controllerId: string,
): JsonObject[] => players.filter((entry) => entry.id !== controllerId);

const nowIso = (): string => new Date().toISOString();

const waitForCondition = async ({
  timeoutMs,
  predicate,
}: {
  timeoutMs: number;
  predicate: () => boolean;
}): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
};

const waitForSocketConnect = async (
  socket: ControllerSocket,
  timeoutMs: number,
): Promise<void> => {
  if (socket.connected) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for controller socket connect."));
    }, timeoutMs);

    const onConnect = () => {
      cleanup();
      resolve();
    };

    const onConnectError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("connect_error", onConnectError);
    };

    socket.once("connect", onConnect);
    socket.once("connect_error", onConnectError);
  });
};

const emitJoinWithAck = async ({
  socket,
  payload,
  timeoutMs,
}: {
  socket: ControllerSocket;
  payload: Parameters<ClientToServerEvents["controller:join"]>[0];
  timeoutMs: number;
}): Promise<ControllerJoinAck> =>
  await new Promise<ControllerJoinAck>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error("Timed out waiting for controller join acknowledgement."),
      );
    }, timeoutMs);

    socket.emit("controller:join", payload, (ack) => {
      clearTimeout(timeout);
      resolve(ack);
    });
  });

const emitLeaveWithAck = async ({
  socket,
  payload,
  timeoutMs,
}: {
  socket: ControllerSocket;
  payload: Parameters<ClientToServerEvents["controller:leave"]>[0];
  timeoutMs: number;
}): Promise<ControllerLeaveAck> =>
  await new Promise<ControllerLeaveAck>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error("Timed out waiting for controller leave acknowledgement."),
      );
    }, timeoutMs);

    (
      socket as unknown as {
        emit: (event: string, ...args: unknown[]) => void;
      }
    ).emit("controller:leave", payload, (ack: ControllerLeaveAck) => {
      clearTimeout(timeout);
      resolve(ack);
    });
  });

const emitControllerActionWithAck = async ({
  socket,
  payload,
  timeoutMs,
}: {
  socket: ControllerSocket;
  payload: Parameters<ClientToServerEvents["controller:action_rpc"]>[0];
  timeoutMs: number;
}): Promise<
  Parameters<
    NonNullable<Parameters<ClientToServerEvents["controller:action_rpc"]>[1]>
  >[0]
> =>
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error("Timed out waiting for controller action acknowledgement."),
      );
    }, timeoutMs);

    socket.emit("controller:action_rpc", payload, (ack) => {
      clearTimeout(timeout);
      resolve(ack);
    });
  });

const emitHostActionWithAck = async ({
  socket,
  payload,
  timeoutMs,
}: {
  socket: ControllerSocket;
  payload: HostActionRpcPayload;
  timeoutMs: number;
}): Promise<
  Parameters<
    NonNullable<
      Parameters<ClientToServerEvents["controller:host_action_rpc"]>[1]
    >
  >[0]
> =>
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for host action acknowledgement."));
    }, timeoutMs);

    socket.emit("controller:host_action_rpc", payload, (ack) => {
      clearTimeout(timeout);
      resolve(ack);
    });
  });

const parseJoinRoomId = (joinUrl: URL): string | null => {
  const roomId =
    joinUrl.searchParams.get("room") ?? joinUrl.searchParams.get("aj_room");
  return roomId?.trim().toUpperCase() || null;
};

const parseJoinCapabilityToken = (joinUrl: URL): string | null =>
  joinUrl.searchParams.get("aj_controller_cap")?.trim() ||
  joinUrl.searchParams.get("cap")?.trim() ||
  null;

const parseJoinControllerId = (joinUrl: URL): string | null =>
  joinUrl.searchParams.get("controllerId")?.trim() ||
  joinUrl.searchParams.get("aj_controller_id")?.trim() ||
  null;

const parseHelperJson = <T>(output: string): T => {
  const startIndex = output.indexOf("{");
  const endIndex = output.lastIndexOf("}");
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`Expected JSON helper output but received:\n${output}`);
  }

  return JSON.parse(output.slice(startIndex, endIndex + 1)) as T;
};

const isRoomNotFoundJoinError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  return /room not found/i.test(error.message);
};

const terminateIsolatedRuntimeOwner = async (
  process: ChildProcess | null,
): Promise<void> => {
  if (!process || process.killed || process.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const onExit = () => {
      process.off("exit", onExit);
      resolve();
    };

    process.once("exit", onExit);
    process.kill("SIGTERM");

    setTimeout(() => {
      process.off("exit", onExit);
      resolve();
    }, 1_000).unref();
  });
};

const resolveSocketOriginFromTopology = async (
  options: GetTopologyOptions,
): Promise<string | null> => {
  try {
    const topology = await getTopology(options);
    const preferredSurfaces = [
      topology.surfaces.controller,
      topology.surfaces.embeddedController,
      topology.surfaces.platformController,
    ];

    for (const surface of preferredSurfaces) {
      const objectSurface = toJsonObject(surface);
      const socketOrigin =
        (typeof objectSurface?.socketOrigin === "string"
          ? objectSurface.socketOrigin
          : null) ??
        (typeof objectSurface?.backendOrigin === "string"
          ? objectSurface.backendOrigin
          : null) ??
        (typeof objectSurface?.appOrigin === "string"
          ? objectSurface.appOrigin
          : null);
      if (socketOrigin) {
        return socketOrigin;
      }
    }
  } catch {
    // Fall back to the join URL origin below.
  }

  return null;
};

const resolveControllerJoinUrlFromTopology = async ({
  cwd,
  gameId,
  mode,
  secure,
  roomId,
  capabilityToken,
}: {
  cwd: string;
  gameId?: string;
  mode: NonNullable<ConnectControllerOptions["mode"]>;
  secure: boolean;
  roomId?: string;
  capabilityToken?: string;
}): Promise<string | null> => {
  if (!roomId) {
    return null;
  }

  const topology = await getTopology({
    cwd,
    gameId,
    mode,
    secure,
  });
  if (!topology.urls.controllerBaseUrl) {
    return null;
  }

  const joinUrl = new URL(topology.urls.controllerBaseUrl);
  joinUrl.searchParams.set("room", roomId);
  if (capabilityToken?.trim()) {
    joinUrl.searchParams.set("aj_controller_cap", capabilityToken.trim());
  }

  return joinUrl.toString();
};

const startIsolatedRuntimeOwner = async ({
  cwd,
  gameId,
  mode,
  secure,
  roomId,
  timeoutMs,
}: {
  cwd: string;
  gameId?: string;
  mode: NonNullable<ConnectControllerOptions["mode"]>;
  secure: boolean;
  roomId?: string;
  timeoutMs: number;
}): Promise<{
  process: ChildProcess;
  roomId: string | null;
  controllerJoinUrl: string | null;
  inspection: HostRuntimeInspectionContract | null;
}> => {
  const topology = await getTopology({
    cwd,
    gameId,
    mode,
    secure,
  });

  const appOrigin = topology.urls.appOrigin;
  const hostUrl = topology.urls.hostUrl;
  const controllerBaseUrl = topology.urls.controllerBaseUrl;
  const publicHost = topology.urls.publicHost;
  if (!appOrigin || !hostUrl || !controllerBaseUrl || !publicHost) {
    throw new Error(
      "Unable to start an isolated runtime owner because the resolved topology is incomplete.",
    );
  }

  const helperFile = resolveDevtoolsHelperScript("hold-runtime-host.ts");
  const args = [
    ...resolveDevtoolsHelperArgs(helperFile),
    "--app-origin",
    appOrigin,
    "--host-url",
    hostUrl,
    "--controller-base-url",
    controllerBaseUrl,
    "--public-host",
    publicHost,
    "--mode",
    mode,
    "--timeout-ms",
    String(timeoutMs),
  ];
  if (topology.urls.localBuildUrl) {
    args.push("--local-build-url", topology.urls.localBuildUrl);
  }
  if (topology.urls.browserBuildUrl) {
    args.push("--browser-build-url", topology.urls.browserBuildUrl);
  }
  if (roomId) {
    args.push("--room-id", roomId);
  }

  const helperProcess = spawn(process.execPath, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  return await new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    const timeout = setTimeout(() => {
      cleanup();
      void terminateIsolatedRuntimeOwner(helperProcess).finally(() => {
        const stderrSummary = stderrBuffer.trim();
        const stderrSuffix = stderrSummary
          ? ` Helper stderr: ${stderrSummary}`
          : "";
        reject(
          new Error(
            "Timed out waiting for isolated runtime ownership. Another local game session may still own the isolated runtime lease, or no host page may be available to create a room. Run `pnpm exec airjam status` to inspect local dev processes; if the state looks stale, run `pnpm exec airjam reset local` and then reopen the host page." +
              stderrSuffix,
          ),
        );
      });
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      helperProcess.stdout?.off("data", onStdout);
      helperProcess.stderr?.off("data", onStderr);
      helperProcess.off("exit", onExit);
      helperProcess.off("error", onError);
    };

    const maybeResolve = () => {
      try {
        const payload = parseHelperJson<{
          roomId: string | null;
          controllerJoinUrl: string | null;
          inspection: HostRuntimeInspectionContract | null;
        }>(stdoutBuffer);
        settled = true;
        cleanup();
        resolve({
          process: helperProcess,
          roomId: payload.roomId,
          controllerJoinUrl: payload.controllerJoinUrl,
          inspection: payload.inspection,
        });
      } catch {
        // Wait for the full JSON payload.
      }
    };

    const onStdout = (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      maybeResolve();
    };

    const onStderr = (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
    };

    const onError = (error: Error) => {
      if (settled) {
        return;
      }
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      cleanup();
      reject(
        new Error(
          [
            "Isolated runtime owner exited before producing a join URL.",
            stderrBuffer.trim(),
            `exit=${code ?? "null"} signal=${signal ?? "null"}`,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    };

    helperProcess.stdout?.on("data", onStdout);
    helperProcess.stderr?.on("data", onStderr);
    helperProcess.once("error", onError);
    helperProcess.once("exit", onExit);
  });
};

export const captureControllerSessionVisuals = async ({
  controllerSessionId,
  relativeDir,
  timeoutMs = DEFAULT_VISUAL_CAPTURE_TIMEOUT_MS,
}: {
  controllerSessionId: string;
  relativeDir: string;
  timeoutMs?: number;
}) => {
  const session = getRequiredSession(controllerSessionId);
  const owner = session.isolatedRuntimeOwner;
  if (!owner?.connected) {
    throw new Error(
      `Air Jam controller session "${controllerSessionId}" does not own a capturable host runtime. Capture from the first game session opened for the room.`,
    );
  }

  const requestId = randomUUID();
  const result = await new Promise<AirJamRuntimeOwnerCaptureResult>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for runtime visual capture."));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        owner.off("message", onMessage);
        owner.off("error", onError);
        owner.off("exit", onExit);
      };
      const onMessage = (message: unknown) => {
        if (
          !isRuntimeOwnerCaptureResult(message) ||
          message.requestId !== requestId
        ) {
          return;
        }
        cleanup();
        if (!message.ok) {
          reject(new Error(message.error ?? "Runtime visual capture failed."));
          return;
        }
        resolve(message);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(
          new Error(
            `Runtime owner exited before visual capture completed (code ${code ?? "unknown"}).`,
          ),
        );
      };

      owner.on("message", onMessage);
      owner.once("error", onError);
      owner.once("exit", onExit);
      owner.send(
        {
          type: AIR_JAM_RUNTIME_OWNER_CAPTURE_REQUEST,
          requestId,
          relativeDir,
        },
        (error) => {
          if (error) onError(error);
        },
      );
    },
  );

  return {
    capturedAt: result.capturedAt,
    screenshots: result.screenshots,
  };
};

const buildRuntimeSnapshot = ({
  session,
  requestedStoreDomains = [],
  missingStoreDomains = [],
}: {
  session: InternalControllerSession;
  requestedStoreDomains?: string[];
  missingStoreDomains?: string[];
}): AirJamRuntimeSnapshotInspection => ({
  ...session.summary,
  welcome: session.welcome,
  controllerState: session.controllerState,
  players: session.players.slice(),
  storeSnapshots: Array.from(session.storeSnapshots.values()).sort(
    (left, right) => left.storeDomain.localeCompare(right.storeDomain),
  ),
  lastSignal: session.lastSignal,
  lastError: session.lastError,
  requestedStoreDomains: [...requestedStoreDomains],
  missingStoreDomains: [...missingStoreDomains],
});

const buildSessionSummary = (
  session: InternalControllerSession,
): AirJamVirtualControllerSessionSummary => ({
  ...session.summary,
});

const getRequiredSession = (
  controllerSessionId: string,
): InternalControllerSession => {
  const session = virtualControllerSessions.get(controllerSessionId);
  if (!session) {
    throw new Error(
      `Unknown Air Jam controller session "${controllerSessionId}". Connect a controller first.`,
    );
  }

  return session;
};

export const inspectControllerSessionContext = (
  controllerSessionId: string,
): {
  cwd: string;
  gameId: string | null;
  controllerId: string;
  session: AirJamVirtualControllerSessionSummary;
} => {
  const session = getRequiredSession(controllerSessionId);
  return {
    cwd: session.cwd,
    gameId: session.summary.gameId,
    controllerId: session.summary.controllerId,
    session: buildSessionSummary(session),
  };
};

export const resolveControllerSessionGameRuntime = async ({
  controllerSessionId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  controllerSessionId: string;
  timeoutMs?: number;
}): Promise<{
  gameId: string | null;
  defaultStoreDomain: string;
}> => {
  const session = getRequiredSession(controllerSessionId);
  const usesArcadeRuntime =
    session.summary.mode === "arcade-dev" ||
    session.summary.mode === "arcade-test" ||
    session.summary.topologyMode === "arcade-live" ||
    session.summary.topologyMode === "arcade-built";

  if (!usesArcadeRuntime) {
    return {
      gameId: session.summary.gameId,
      defaultStoreDomain: "default",
    };
  }

  const minimumRevision =
    session.storeSnapshots.get(AIR_JAM_ARCADE_SURFACE_STORE_DOMAIN)?.revision ??
    0;
  const surfaceSnapshot = await waitForStateSync({
    session,
    storeDomain: AIR_JAM_ARCADE_SURFACE_STORE_DOMAIN,
    minimumRevision,
    timeoutMs,
  });
  const parsedSurface = arcadeSurfaceRuntimeIdentitySchema.safeParse(
    surfaceSnapshot?.data,
  );

  if (!parsedSurface.success) {
    throw new Error(
      `Arcade controller session "${controllerSessionId}" did not expose a valid "${AIR_JAM_ARCADE_SURFACE_STORE_DOMAIN}" snapshot.`,
    );
  }

  if (parsedSurface.data.kind !== "game" || !parsedSurface.data.gameId) {
    session.summary.gameId = null;
    throw new Error(
      `Arcade controller session "${controllerSessionId}" does not currently have an active embedded game.`,
    );
  }

  session.summary.gameId = parsedSurface.data.gameId;

  return {
    gameId: parsedSurface.data.gameId,
    defaultStoreDomain: embeddedReplicatedStoreDomainFromArcadeIdentity(
      parsedSurface.data,
    ),
  };
};

const waitForStateSync = async ({
  session,
  storeDomain,
  minimumRevision,
  timeoutMs,
}: {
  session: InternalControllerSession;
  storeDomain: string;
  minimumRevision: number;
  timeoutMs: number;
}): Promise<AirJamRuntimeStoreSnapshot | null> =>
  await new Promise<AirJamRuntimeStoreSnapshot | null>((resolve) => {
    const requestId = randomUUID();
    const waiters = session.pendingSyncWaiters.get(storeDomain) ?? new Set();
    const timeout = setTimeout(() => {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        session.pendingSyncWaiters.delete(storeDomain);
      }
      resolve(null);
    }, timeoutMs);

    const waiter: PendingStateSyncWaiter = {
      requestId,
      minimumRevision,
      resolve: (snapshot) => {
        clearTimeout(timeout);
        waiters.delete(waiter);
        if (waiters.size === 0) {
          session.pendingSyncWaiters.delete(storeDomain);
        }
        resolve(snapshot);
      },
    };

    waiters.add(waiter);
    session.pendingSyncWaiters.set(storeDomain, waiters);
    session.socket.emit("controller:state_sync_request", {
      roomId: session.summary.roomId,
      storeDomain,
      requestId,
    });
  });

const resolvePendingStateSyncWaiters = ({
  session,
  snapshot,
  requestId,
}: {
  session: InternalControllerSession;
  snapshot: AirJamRuntimeStoreSnapshot;
  requestId?: string;
}): void => {
  const waiters = session.pendingSyncWaiters.get(snapshot.storeDomain);
  if (!waiters) {
    return;
  }

  for (const waiter of Array.from(waiters)) {
    if (requestId !== waiter.requestId) {
      continue;
    }
    if (snapshot.revision < waiter.minimumRevision) {
      continue;
    }
    waiter.resolve(snapshot);
  }
};

const attachSocketListeners = (session: InternalControllerSession): void => {
  session.socket.on("server:welcome", (payload: ControllerWelcomePayload) => {
    session.welcome = {
      ...payload,
    };
    session.players = toJsonObjectArray(payload.players);
  });

  session.socket.on("server:state", (payload: ControllerStateMessage) => {
    session.controllerState = toJsonObject(payload.state);
  });

  session.socket.on(
    "server:controllerJoined",
    (payload: ControllerJoinedNotice) => {
      const fallbackPlayer =
        payload.player ??
        ({
          id: payload.controllerId,
          label: payload.nickname ?? payload.controllerId,
        } satisfies JsonObject);
      session.players = upsertPlayer(session.players, fallbackPlayer);
    },
  );

  session.socket.on("server:controllerLeft", (payload) => {
    session.players = removePlayer(session.players, payload.controllerId);
  });

  session.socket.on("server:playerUpdated", (payload: PlayerUpdatedNotice) => {
    session.players = upsertPlayer(session.players, payload.player);
  });

  session.socket.on("server:signal", (payload: SignalPayload) => {
    session.lastSignal = toJsonObject(payload);
  });

  session.socket.on("server:error", (payload: ServerErrorPayload) => {
    session.lastError = toJsonObject(payload);
  });

  session.socket.on("airjam:state_sync", (payload: AirJamStateSyncPayload) => {
    const previousSnapshot = session.storeSnapshots.get(payload.storeDomain);
    if (previousSnapshot && payload.revision < previousSnapshot.revision) {
      return;
    }

    const snapshot: AirJamRuntimeStoreSnapshot = {
      storeDomain: payload.storeDomain,
      data: { ...payload.data },
      updatedAt: nowIso(),
      revision: payload.revision,
    };
    session.storeSnapshots.set(payload.storeDomain, snapshot);
    resolvePendingStateSyncWaiters({
      session,
      snapshot,
      requestId: payload.requestId,
    });
  });

  session.socket.on("disconnect", (reason) => {
    session.summary.connected = false;
    session.summary.disconnectedAt = nowIso();
    session.summary.disconnectReason = reason ?? "unknown";
    void terminateIsolatedRuntimeOwner(session.isolatedRuntimeOwner).finally(
      () => {
        session.isolatedRuntimeOwner = null;
      },
    );
    for (const waiters of session.pendingSyncWaiters.values()) {
      for (const waiter of waiters) {
        waiter.resolve(null);
      }
    }
    session.pendingSyncWaiters.clear();
  });
};

export const connectController = async ({
  cwd = process.cwd(),
  gameId,
  mode = "standalone-dev",
  secure = false,
  roomId,
  controllerJoinUrl,
  controllerId,
  deviceId,
  nickname,
  avatarId,
  capabilityToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ConnectControllerOptions = {}): Promise<AirJamVirtualControllerSession> => {
  const context = await detectProjectContext({ cwd });
  const normalizedRequestedRoomId = roomId?.trim().toUpperCase() || undefined;
  const normalizedCapabilityToken = capabilityToken?.trim() || undefined;
  const canUseIsolatedOwner =
    Boolean(gameId) || context.mode === "standalone-game";

  const connectWithJoinUrl = async ({
    joinUrlString,
    ownedRuntimeProcess,
  }: {
    joinUrlString: string;
    ownedRuntimeProcess: ChildProcess | null;
  }): Promise<AirJamVirtualControllerSession> => {
    const joinUrl = new URL(joinUrlString);
    const resolvedRoomId =
      normalizedRequestedRoomId ?? parseJoinRoomId(joinUrl);
    if (!resolvedRoomId) {
      throw new Error(
        `Controller join URL "${joinUrlString}" does not include a room code.`,
      );
    }

    const resolvedControllerId =
      controllerId?.trim() ||
      parseJoinControllerId(joinUrl) ||
      `ctrl_mcp_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const resolvedDeviceId =
      deviceId?.trim() || `aj-mcp-device-${randomUUID()}`;
    const topology = await getTopology({
      cwd,
      gameId,
      mode,
      secure,
    }).catch(() => null);
    const resolvedGameId = gameId ?? topology?.gameId ?? null;
    const resolvedSocketOrigin =
      (await resolveSocketOriginFromTopology({
        cwd,
        gameId: resolvedGameId ?? undefined,
        mode,
        secure,
      })) ?? joinUrl.origin;
    const resolvedCapabilityToken =
      normalizedCapabilityToken ||
      parseJoinCapabilityToken(joinUrl) ||
      undefined;
    const controllerSessionId = randomUUID();

    const socket = io(resolvedSocketOrigin, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    }) as ControllerSocket;

    const internalSession: InternalControllerSession = {
      cwd,
      summary: {
        controllerSessionId,
        gameId: resolvedGameId,
        projectMode: context.mode,
        mode,
        topologyMode: topology?.topologyMode ?? null,
        secure,
        process: topology?.process ?? null,
        roomId: resolvedRoomId,
        controllerId: resolvedControllerId,
        deviceId: resolvedDeviceId,
        controllerJoinUrl: joinUrlString,
        socketOrigin: resolvedSocketOrigin,
        connected: false,
        connectedAt: nowIso(),
        disconnectedAt: null,
        disconnectReason: null,
      },
      socket,
      projectMode: context.mode,
      welcome: null,
      controllerState: null,
      players: [],
      storeSnapshots: new Map(),
      pendingSyncWaiters: new Map(),
      lastSignal: null,
      lastError: null,
      isolatedRuntimeOwner: ownedRuntimeProcess,
    };

    attachSocketListeners(internalSession);

    try {
      await waitForSocketConnect(socket, timeoutMs);
      const ack = await emitJoinWithAck({
        socket,
        payload: {
          roomId: resolvedRoomId,
          controllerId: resolvedControllerId,
          deviceId: resolvedDeviceId,
          nickname: nickname?.trim() || undefined,
          avatarId: avatarId?.trim() || undefined,
          capabilityToken: resolvedCapabilityToken,
        },
        timeoutMs,
      });

      if (!ack.ok) {
        throw new Error(
          ack.message ??
            `Controller join was rejected${ack.code ? ` (${ack.code})` : ""}.`,
        );
      }

      internalSession.summary.connected = true;
      internalSession.summary.roomId = ack.roomId ?? resolvedRoomId;
      internalSession.summary.controllerId =
        ack.controllerId ?? resolvedControllerId;
      await waitForCondition({
        timeoutMs: Math.min(timeoutMs, 500),
        predicate: () =>
          internalSession.welcome !== null ||
          internalSession.controllerState !== null,
      });
      virtualControllerSessions.set(controllerSessionId, internalSession);
      return buildRuntimeSnapshot({ session: internalSession });
    } catch (error) {
      socket.disconnect();
      await terminateIsolatedRuntimeOwner(ownedRuntimeProcess);
      throw error;
    }
  };

  const resolvedJoinUrl =
    controllerJoinUrl ??
    (await resolveControllerJoinUrlFromTopology({
      cwd,
      gameId,
      mode,
      secure,
      roomId: normalizedRequestedRoomId,
      capabilityToken: normalizedCapabilityToken,
    }));
  if (!resolvedJoinUrl) {
    if (!canUseIsolatedOwner) {
      throw new Error(
        "Unable to resolve a controller join URL. Open the host page first so a room exists, or provide roomId/controllerJoinUrl explicitly. If a stale dev process may be holding the local runtime, run `pnpm exec airjam status` and then `pnpm exec airjam reset local`.",
      );
    }

    const owner = await startIsolatedRuntimeOwner({
      cwd,
      gameId,
      mode,
      secure,
      roomId: normalizedRequestedRoomId,
      timeoutMs,
    });
    if (!owner.controllerJoinUrl) {
      await terminateIsolatedRuntimeOwner(owner.process);
      throw new Error(
        "Isolated runtime owner did not produce a controller join URL.",
      );
    }

    return connectWithJoinUrl({
      joinUrlString: owner.controllerJoinUrl,
      ownedRuntimeProcess: owner.process,
    });
  }

  try {
    return await connectWithJoinUrl({
      joinUrlString: resolvedJoinUrl,
      ownedRuntimeProcess: null,
    });
  } catch (error) {
    if (canUseIsolatedOwner && isRoomNotFoundJoinError(error)) {
      const owner = await startIsolatedRuntimeOwner({
        cwd,
        gameId,
        mode,
        secure,
        roomId: normalizedRequestedRoomId,
        timeoutMs,
      });
      if (!owner.controllerJoinUrl) {
        await terminateIsolatedRuntimeOwner(owner.process);
        throw error;
      }

      return await connectWithJoinUrl({
        joinUrlString: owner.controllerJoinUrl,
        ownedRuntimeProcess: owner.process,
      });
    }

    throw error;
  }
};

export const sendControllerInput = async ({
  controllerSessionId,
  input,
}: SendControllerInputOptions): Promise<SendControllerInputResult> => {
  const session = getRequiredSession(controllerSessionId);
  if (!session.summary.connected) {
    throw new Error(
      `Air Jam controller session "${controllerSessionId}" is not connected.`,
    );
  }

  const payload = { ...input };
  session.socket.emit("controller:input", {
    roomId: session.summary.roomId,
    controllerId: session.summary.controllerId,
    input: payload,
  });

  return {
    ...buildSessionSummary(session),
    input: payload,
    sentAt: nowIso(),
  };
};

export const invokeControllerAction = async ({
  controllerSessionId,
  actionName,
  storeDomain,
  payload,
}: InvokeControllerActionOptions): Promise<InvokeControllerActionResult> => {
  const session = getRequiredSession(controllerSessionId);
  if (!session.summary.connected) {
    throw new Error(
      `Air Jam controller session "${controllerSessionId}" is not connected.`,
    );
  }

  const normalizedPayload = payload ? { ...payload } : undefined;
  const acknowledgement = await emitControllerActionWithAck({
    socket: session.socket,
    payload: {
      roomId: session.summary.roomId,
      actionName,
      payload: normalizedPayload,
      storeDomain,
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  return {
    ...buildSessionSummary(session),
    actionName,
    storeDomain,
    ...(normalizedPayload ? { payload: normalizedPayload } : {}),
    sentAt: nowIso(),
    acknowledgement,
  };
};

export const invokeHostAction = async ({
  controllerSessionId,
  actionName,
  storeDomain,
  payload,
}: {
  controllerSessionId: string;
  actionName: string;
  storeDomain: string;
  payload?: Record<string, unknown>;
}): Promise<InvokeControllerActionResult> => {
  const session = getRequiredSession(controllerSessionId);
  if (!session.summary.connected) {
    throw new Error(
      `Air Jam controller session "${controllerSessionId}" is not connected.`,
    );
  }

  const normalizedPayload = payload ? { ...payload } : undefined;
  const acknowledgement = await emitHostActionWithAck({
    socket: session.socket,
    payload: {
      roomId: session.summary.roomId,
      actionName,
      payload: normalizedPayload,
      storeDomain,
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  return {
    ...buildSessionSummary(session),
    actionName,
    storeDomain,
    ...(normalizedPayload ? { payload: normalizedPayload } : {}),
    sentAt: nowIso(),
    acknowledgement,
  };
};

export const readRuntimeSnapshot = async ({
  controllerSessionId,
  storeDomains = [],
  requestSync = storeDomains.length > 0,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ReadRuntimeSnapshotOptions): Promise<AirJamRuntimeSnapshotInspection> => {
  const session = getRequiredSession(controllerSessionId);
  const normalizedStoreDomains = Array.from(
    new Set(
      storeDomains
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );

  const missingStoreDomains: string[] = [];
  if (requestSync && normalizedStoreDomains.length > 0) {
    const syncResults = await Promise.all(
      normalizedStoreDomains.map(async (storeDomain) => {
        const minimumRevision =
          session.storeSnapshots.get(storeDomain)?.revision ?? 0;
        const result = await waitForStateSync({
          session,
          storeDomain,
          minimumRevision,
          timeoutMs,
        });
        return {
          storeDomain,
          ok: result !== null,
        };
      }),
    );

    for (const result of syncResults) {
      if (!result.ok) {
        missingStoreDomains.push(result.storeDomain);
      }
    }
  }

  return buildRuntimeSnapshot({
    session,
    requestedStoreDomains: normalizedStoreDomains,
    missingStoreDomains,
  });
};

export const disconnectController = async ({
  controllerSessionId,
}: DisconnectControllerOptions): Promise<DisconnectControllerResult> => {
  const session = getRequiredSession(controllerSessionId);
  if (session.summary.connected) {
    try {
      const ack = await emitLeaveWithAck({
        socket: session.socket,
        payload: {
          roomId: session.summary.roomId,
          controllerId: session.summary.controllerId,
        },
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      if (!ack.ok) {
        throw new Error(
          ack.message ?? "Controller leave request was rejected by the server.",
        );
      }
    } catch {
      // Fall back to socket disconnect. Manual devtools teardown should not hang
      // forever when the room is already gone or the socket is mid-teardown.
    }
  }
  session.socket.disconnect();
  session.summary.connected = false;
  session.summary.disconnectedAt = session.summary.disconnectedAt ?? nowIso();
  session.summary.disconnectReason =
    session.summary.disconnectReason ?? "manual_disconnect";
  await terminateIsolatedRuntimeOwner(session.isolatedRuntimeOwner);
  session.isolatedRuntimeOwner = null;
  virtualControllerSessions.delete(controllerSessionId);

  return {
    disconnected: true,
    session: buildSessionSummary(session),
  };
};
