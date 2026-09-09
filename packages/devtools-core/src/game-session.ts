import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  inspectGameAgentContract,
  invokeGameAction,
  readGameSnapshot,
  resolveGameActionPayload,
} from "./agent.js";
import {
  captureControllerSessionVisuals,
  connectController,
  disconnectController,
  invokeHostAction,
  readRuntimeSnapshot,
  resolveControllerSessionGameRuntime,
  sendControllerInput,
} from "./controller.js";
import { startDev, stopDev } from "./dev.js";
import {
  classifyGameActionOutcome,
  computeGameSnapshotObservation,
} from "./game-action-observation.js";
import type {
  AirJamGameAgentActionDescriptor,
  AirJamGameSessionActionDescriptor,
  AirJamGameSessionInspection,
  AirJamGameSessionSummary,
  AirJamGameSessionVisualCaptureResult,
  CaptureGameSessionVisualsOptions,
  CloseGameSessionOptions,
  CloseGameSessionResult,
  InvokeGameSessionActionOptions,
  InvokeGameSessionActionResult,
  OpenGameSessionOptions,
  ReadGameSessionOptions,
  SendGameSessionInputOptions,
  SendGameSessionInputResult,
} from "./types.js";

type SessionAction =
  | {
      lane: "player";
      kind: "participant";
      actionId: string;
    }
  | {
      lane: "host";
      kind: "host";
      actionId: string;
      actionName: string;
      storeDomain: string;
    };

type InternalGameSession = {
  summary: AirJamGameSessionSummary;
  lookup: {
    cwd: string;
    gameId?: string;
  };
  actionRegistry: Map<string, SessionAction>;
  devProcessId: string | null;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_SESSION_OPEN_TIMEOUT_MS = 30_000;
const gameSessions = new Map<string, InternalGameSession>();
const devProcessLeases = new Map<
  string,
  { cwd: string; referenceCount: number; stopOnZero: boolean }
>();

const acquireDevProcessLease = async (
  options: OpenGameSessionOptions,
): Promise<string | null> => {
  if (options.controllerJoinUrl) {
    return null;
  }
  const started = await startDev({
    cwd: options.cwd,
    gameId: options.gameId,
    mode: options.mode,
    secure: options.secure,
  });
  const processId = started.process.id;
  const existing = devProcessLeases.get(processId);
  devProcessLeases.set(processId, {
    cwd: started.process.cwd,
    referenceCount: (existing?.referenceCount ?? 0) + 1,
    stopOnZero: existing?.stopOnZero ?? !started.reusedExistingProcess,
  });
  return processId;
};

const releaseDevProcessLease = async (processId: string): Promise<void> => {
  const lease = devProcessLeases.get(processId);
  if (!lease) {
    return;
  }
  if (lease.referenceCount > 1) {
    devProcessLeases.set(processId, {
      ...lease,
      referenceCount: lease.referenceCount - 1,
    });
    return;
  }

  devProcessLeases.delete(processId);
  if (lease.stopOnZero) {
    await stopDev({ cwd: lease.cwd, processId });
  }
};

const toSessionActionId = (lane: "player" | "host", actionId: string): string =>
  `${lane}:${actionId}`;

const describeSessionActions = (
  actions: AirJamGameAgentActionDescriptor[],
): AirJamGameSessionActionDescriptor[] =>
  actions.map((action) => ({
    actionId: toSessionActionId(
      action.target.kind === "host" ? "host" : "player",
      action.actionId,
    ),
    lane: action.target.kind === "host" ? "host" : "player",
    source: "semantic-game",
    description: action.description,
    availability: action.availability,
    payload: {
      kind: action.payload.kind,
      description: action.payload.description,
      ...(action.payload.allowedValues
        ? { allowedValues: [...action.payload.allowedValues] }
        : {}),
    },
    resultDescription: action.resultDescription,
  }));

const buildActionRegistry = (
  actions: AirJamGameAgentActionDescriptor[],
): Map<string, SessionAction> => {
  const registry = new Map<string, SessionAction>();
  for (const action of actions) {
    if (action.target.kind === "host") {
      registry.set(toSessionActionId("host", action.actionId), {
        lane: "host",
        kind: "host",
        actionId: action.actionId,
        actionName: action.target.actionName,
        storeDomain: action.target.storeDomain ?? "default",
      });
    } else {
      registry.set(toSessionActionId("player", action.actionId), {
        lane: "player",
        kind: "participant",
        actionId: action.actionId,
      });
    }
  }
  return registry;
};

const getRequiredGameSession = (gameSessionId: string): InternalGameSession => {
  const session = gameSessions.get(gameSessionId);
  if (!session) {
    throw new Error(
      `Unknown Air Jam game session "${gameSessionId}". Open a game session first.`,
    );
  }
  return session;
};

const updateSummary = (
  session: InternalGameSession,
  overrides: Partial<AirJamGameSessionSummary>,
): void => {
  session.summary = { ...session.summary, ...overrides };
};

export const openGameSession = async (
  options: OpenGameSessionOptions = {},
): Promise<AirJamGameSessionSummary> => {
  const devProcessId = await acquireDevProcessLease(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_OPEN_TIMEOUT_MS;
  let controllerSession: Awaited<ReturnType<typeof connectController>>;
  try {
    controllerSession = await connectController({ ...options, timeoutMs });
  } catch (error) {
    if (devProcessId) {
      await releaseDevProcessLease(devProcessId).catch(() => undefined);
    }
    throw error;
  }
  try {
    const runtime = await resolveControllerSessionGameRuntime({
      controllerSessionId: controllerSession.controllerSessionId,
      timeoutMs,
    });
    const gameId =
      runtime.gameId ?? controllerSession.gameId ?? options.gameId ?? null;
    const contract = gameId
      ? await inspectGameAgentContract({ cwd: options.cwd, gameId }).catch(
          () => null,
        )
      : null;
    const gameActions = contract?.actions ?? [];
    const summary: AirJamGameSessionSummary = {
      gameSessionId: randomUUID(),
      cwd: options.cwd ?? process.cwd(),
      gameId,
      controllerSessionId: controllerSession.controllerSessionId,
      projectMode: controllerSession.projectMode,
      mode: controllerSession.mode,
      topologyMode: controllerSession.topologyMode,
      secure: controllerSession.secure,
      process: controllerSession.process,
      roomId: controllerSession.roomId,
      controllerId: controllerSession.controllerId,
      deviceId: controllerSession.deviceId,
      controllerJoinUrl: controllerSession.controllerJoinUrl,
      socketOrigin: controllerSession.socketOrigin,
      connected: controllerSession.connected,
      connectedAt: controllerSession.connectedAt,
      disconnectedAt: controllerSession.disconnectedAt,
      disconnectReason: controllerSession.disconnectReason,
      hasAgentContract: Boolean(contract?.hasContract),
      actions: describeSessionActions(gameActions),
    };

    gameSessions.set(summary.gameSessionId, {
      summary,
      lookup: {
        cwd: summary.cwd,
        ...(gameId ? { gameId } : {}),
      },
      actionRegistry: buildActionRegistry(gameActions),
      devProcessId,
    });
    return summary;
  } catch (error) {
    await disconnectController({
      controllerSessionId: controllerSession.controllerSessionId,
    }).catch(() => undefined);
    if (devProcessId) {
      await releaseDevProcessLease(devProcessId).catch(() => undefined);
    }
    throw error;
  }
};

export const readGameSession = async ({
  gameSessionId,
  requestSync = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ReadGameSessionOptions): Promise<AirJamGameSessionInspection> => {
  const session = getRequiredGameSession(gameSessionId);
  const runtimeSnapshot = await readRuntimeSnapshot({
    controllerSessionId: session.summary.controllerSessionId,
    requestSync: false,
  });
  const gameSnapshot = session.summary.hasAgentContract
    ? await readGameSnapshot({
        controllerSessionId: session.summary.controllerSessionId,
        requestSync,
        timeoutMs,
      })
    : null;
  const actions = gameSnapshot?.actions ?? [];

  updateSummary(session, {
    connected: runtimeSnapshot.connected,
    disconnectedAt: runtimeSnapshot.disconnectedAt,
    disconnectReason: runtimeSnapshot.disconnectReason,
    process: runtimeSnapshot.process,
    actions: describeSessionActions(actions),
  });
  session.actionRegistry = buildActionRegistry(actions);

  return { ...session.summary, runtimeSnapshot, gameSnapshot };
};

export const sendGameSessionInput = async ({
  gameSessionId,
  input,
}: SendGameSessionInputOptions): Promise<SendGameSessionInputResult> => {
  const session = getRequiredGameSession(gameSessionId);
  const sent = await sendControllerInput({
    controllerSessionId: session.summary.controllerSessionId,
    input,
  });
  updateSummary(session, {
    connected: sent.connected,
    disconnectedAt: sent.disconnectedAt,
    disconnectReason: sent.disconnectReason,
    process: sent.process,
  });
  return { ...session.summary, input: sent.input, sentAt: sent.sentAt };
};

export const invokeGameSessionAction = async (
  options: InvokeGameSessionActionOptions,
): Promise<InvokeGameSessionActionResult> => {
  const session = getRequiredGameSession(options.gameSessionId);
  const action = session.actionRegistry.get(options.actionId);
  if (!action) {
    throw new Error(
      `Unknown game session action "${options.actionId}" for session "${options.gameSessionId}".`,
    );
  }

  if (action.kind === "participant") {
    const invocation = await invokeGameAction({
      controllerSessionId: session.summary.controllerSessionId,
      actionId: action.actionId,
      payload: options.payload,
      timeoutMs: options.timeoutMs,
    });
    return {
      ...session.summary,
      actionId: options.actionId,
      lane: "player",
      invocation,
    };
  }

  const snapshotBefore = await readGameSnapshot({
    controllerSessionId: session.summary.controllerSessionId,
    requestSync: true,
    timeoutMs: options.timeoutMs,
  });
  const runtimeStoreDomain =
    snapshotBefore.storeDomainBindings.find(
      (binding) => binding.contractStoreDomain === action.storeDomain,
    )?.runtimeStoreDomain ?? action.storeDomain;
  const payload = session.lookup.gameId
    ? await resolveGameActionPayload({
        cwd: session.lookup.cwd,
        gameId: session.lookup.gameId,
        actionId: action.actionId,
        payload: options.payload,
      })
    : undefined;
  const sent = await invokeHostAction({
    controllerSessionId: session.summary.controllerSessionId,
    actionName: action.actionName,
    storeDomain: runtimeStoreDomain,
    payload,
  });
  const snapshotAfter = await readGameSnapshot({
    controllerSessionId: session.summary.controllerSessionId,
    requestSync: true,
    timeoutMs: options.timeoutMs,
  });
  const { snapshotAfterStatus, observedStateChange } =
    computeGameSnapshotObservation({ snapshotBefore, snapshotAfter });
  const { acknowledgementObservation, outcome } = classifyGameActionOutcome({
    acknowledgement: sent.acknowledgement,
    observedStateChange,
  });

  return {
    ...session.summary,
    actionId: options.actionId,
    lane: "host",
    invocation: {
      ...sent,
      actionId: action.actionId,
      lane: "host",
      ...(options.payload !== undefined ? { payload: options.payload } : {}),
      acknowledgementObservation,
      outcome,
      snapshotBefore,
      snapshotAfter,
      snapshotAfterStatus,
      observedStateChange,
    },
  };
};

export const captureGameSessionVisuals = async ({
  gameSessionId,
  timeoutMs,
}: CaptureGameSessionVisualsOptions): Promise<AirJamGameSessionVisualCaptureResult> => {
  const session = getRequiredGameSession(gameSessionId);
  const captureId = `${new Date()
    .toISOString()
    .replaceAll(/[^0-9A-Za-z]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const relativeDir = path.join(
    ".airjam",
    "artifacts",
    "session-visuals",
    gameSessionId,
    captureId,
  );
  const captured = await captureControllerSessionVisuals({
    controllerSessionId: session.summary.controllerSessionId,
    relativeDir,
    timeoutMs,
  });
  return {
    ...session.summary,
    contract: "air-jam-game-session-visual-capture/v1",
    capturedAt: captured.capturedAt,
    artifactDir: path.join(session.summary.cwd, relativeDir),
    screenshots: captured.screenshots.map((screenshot) => ({
      ...screenshot,
      filePath: path.join(session.summary.cwd, screenshot.relativePath),
    })),
  };
};

export const closeGameSession = async ({
  gameSessionId,
}: CloseGameSessionOptions): Promise<CloseGameSessionResult> => {
  const session = getRequiredGameSession(gameSessionId);
  const disconnected = await disconnectController({
    controllerSessionId: session.summary.controllerSessionId,
  });
  updateSummary(session, {
    connected: disconnected.session.connected,
    disconnectedAt: disconnected.session.disconnectedAt,
    disconnectReason: disconnected.session.disconnectReason,
    process: disconnected.session.process,
  });
  gameSessions.delete(gameSessionId);
  if (session.devProcessId) {
    await releaseDevProcessLease(session.devProcessId);
  }
  return { closed: true, session: session.summary };
};
