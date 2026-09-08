import { db } from "@/db";
import {
  operationalAlerts,
  operationalSloEvaluations,
  operationalSyntheticRuns,
} from "@/db/schema";
import {
  normalizeOrigin,
  resolvePlatformDeploymentConfig,
} from "@/lib/platform-deployment-config";
import {
  createStructuredOperationalFailure,
  normalizeUnknownOperationalFailure,
  operationalAlertSchemaV1,
  operationalSloEvaluationSchemaV1,
  operationalSyntheticRunSchemaV1,
  resolveDeploymentEnvironment,
  type DeploymentEnvironment,
  type OperationalAlertV1,
  type OperationalSyntheticCheckV1,
  type OperationalSyntheticRunV1,
} from "@air-jam/operations-contract";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@air-jam/sdk/protocol";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { io, type Socket } from "socket.io-client";
import { resolveDatabaseAuthorityNow } from "./database-authority";
import {
  enqueueOperationalEventInTransaction,
  type OperationalEventDatabase,
  type OperationalEventTransaction,
} from "./operational-event-delivery-service";
import {
  getOperationalSloDefinition,
  getOperationalSyntheticCheck,
  OPERATIONAL_SLO_DEFINITIONS,
  OPERATIONAL_SYNTHETIC_CHECKS,
} from "./operational-reliability-policy";

type AirJamSyntheticSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type SyntheticAcknowledgedEvent =
  | "host:bootstrap"
  | "host:createRoom"
  | "controller:join"
  | "controller:action_rpc";
type EventPayload<E extends SyntheticAcknowledgedEvent> = Parameters<
  ClientToServerEvents[E]
>[0];
type EventAcknowledgement<E extends SyntheticAcknowledgedEvent> = Parameters<
  Exclude<Parameters<ClientToServerEvents[E]>[1], undefined>
>[0];

export type OperationalSyntheticRuntimeConfig = {
  environment: DeploymentEnvironment;
  targets: Readonly<Record<string, string | null>>;
  appId: string | null;
};

export type OperationalSyntheticPersistenceResult = {
  run: OperationalSyntheticRunV1;
  evaluation: ReturnType<typeof operationalSloEvaluationSchemaV1.parse> | null;
  alert: OperationalAlertV1 | null;
  transition: "opened" | "recovered" | "refreshed" | "replayed" | null;
  evaluationDisposition: "evaluated" | "stale_ignored" | "replayed";
};

export class OperationalSyntheticConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationalSyntheticConflictError";
  }
}

const normalizeOperationalSyntheticCommand = ({
  actor,
  reason,
  idempotencyKey,
}: {
  actor: string;
  reason: string;
  idempotencyKey: string;
}) => {
  const normalizedActor = actor.trim();
  const normalizedReason = reason.trim();
  const normalizedKey = idempotencyKey.trim();
  if (!normalizedActor || !normalizedReason || !normalizedKey) {
    throw new OperationalSyntheticConflictError(
      "Actor, reason, and idempotency key are required.",
    );
  }
  return { normalizedActor, normalizedReason, normalizedKey };
};

type OperationalSyntheticReplayReader = Pick<OperationalEventDatabase, "query">;

export const resolveReplayedSyntheticRun = async ({
  database,
  checkId,
  environment,
  idempotencyKey,
}: {
  database: OperationalSyntheticReplayReader;
  checkId: string;
  environment: DeploymentEnvironment;
  idempotencyKey: string;
}): Promise<OperationalSyntheticPersistenceResult | null> => {
  const replay = await database.query.operationalSyntheticRuns.findFirst({
    where: (table, { eq }) => eq(table.idempotencyKey, idempotencyKey),
  });
  if (!replay) return null;
  if (replay.checkId !== checkId || replay.environment !== environment) {
    throw new OperationalSyntheticConflictError(
      "The idempotency key was already used for a different synthetic run.",
    );
  }
  return {
    run: replay.document,
    evaluation: null,
    alert: null,
    transition: "replayed",
    evaluationDisposition: "replayed",
  };
};

const absoluteUrl = (value: string | undefined): string | null => {
  const normalized = value?.trim();
  if (!normalized) return null;
  try {
    return new URL(normalized).toString();
  } catch {
    return null;
  }
};

const urlFromOrigin = (origin: string | null, path: string): string | null =>
  origin ? new URL(path, origin).toString() : null;

export const resolveOperationalSyntheticRuntimeConfig = (
  env: Record<string, string | undefined> = process.env,
): OperationalSyntheticRuntimeConfig => {
  const environment = resolveDeploymentEnvironment(env);
  const platform = resolvePlatformDeploymentConfig(env as NodeJS.ProcessEnv);
  const environmentScopedOrigin = (
    previewKey: string,
    productionValue: string | undefined,
  ): string | null =>
    platform.isRailwayPreviewEnvironment
      ? normalizeOrigin(env[previewKey])
      : normalizeOrigin(productionValue);
  const platformOrigin = environmentScopedOrigin(
    "RAILWAY_SERVICE_AIR_JAM_PLATFORM_URL",
    platform.platformPublicUrl,
  );
  const realtimeOrigin = environmentScopedOrigin(
    "RAILWAY_SERVICE_AIR_JAM_SERVER_URL",
    platform.backendPublicUrl,
  );
  const workerOrigin = environmentScopedOrigin(
    "RAILWAY_SERVICE_AIR_JAM_PLATFORM_WORKER_URL",
    env.AIRJAM_SYNTHETIC_WORKER_ORIGIN,
  );
  const browserWorkerOrigin = environmentScopedOrigin(
    "RAILWAY_SERVICE_AIR_JAM_RELEASE_BROWSER_WORKER_URL",
    env.AIRJAM_SYNTHETIC_BROWSER_WORKER_ORIGIN,
  );
  const hostedReleaseUrl = platform.isRailwayPreviewEnvironment
    ? null
    : absoluteUrl(env.AIRJAM_SYNTHETIC_HOSTED_RELEASE_URL);
  return {
    environment,
    targets: Object.freeze({
      "platform.home": urlFromOrigin(platformOrigin, "/"),
      "platform.docs": urlFromOrigin(platformOrigin, "/docs"),
      "platform.arcade": urlFromOrigin(platformOrigin, "/arcade"),
      "platform.health": urlFromOrigin(platformOrigin, "/api/health"),
      "platform.readiness": urlFromOrigin(platformOrigin, "/api/readiness"),
      "realtime.health": urlFromOrigin(realtimeOrigin, "/health"),
      "hosted.release": hostedReleaseUrl,
      "worker.ready": urlFromOrigin(workerOrigin, "/ready"),
      "browser_worker.health": urlFromOrigin(browserWorkerOrigin, "/health"),
      "realtime.room_controller": realtimeOrigin,
      "realtime.semantic_action": realtimeOrigin,
    }),
    appId:
      env.AIRJAM_SYNTHETIC_APP_ID?.trim() || platform.appId?.trim() || null,
  };
};

const timed = async <T>(operation: () => Promise<T>) => {
  const started = performance.now();
  try {
    return {
      ok: true as const,
      value: await operation(),
      latencyMilliseconds: Math.max(0, Math.round(performance.now() - started)),
    };
  } catch (error) {
    return {
      ok: false as const,
      error,
      latencyMilliseconds: Math.max(0, Math.round(performance.now() - started)),
    };
  }
};

const unconfiguredTargetObservation = (
  step: OperationalSyntheticCheckV1["steps"][number],
  targetKey = step.targetKey,
): OperationalSyntheticRunV1["observations"][number] => ({
  stepId: step.stepId,
  status: "error",
  latencyMilliseconds: 0,
  failure: createStructuredOperationalFailure({
    code: "synthetic.target_unconfigured",
    failureClass: "invalid_input",
    summary: "A required synthetic target is not configured.",
    retryable: false,
    details: { targetKey },
  }),
});

const executeHttpStep = async ({
  step,
  target,
  timeoutMilliseconds,
  fetchImpl,
}: {
  step: OperationalSyntheticCheckV1["steps"][number];
  target: string | null;
  timeoutMilliseconds: number;
  fetchImpl: typeof fetch;
}): Promise<OperationalSyntheticRunV1["observations"][number]> => {
  if (!target) return unconfiguredTargetObservation(step);
  const result = await timed(async () => {
    const response = await fetchImpl(target, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMilliseconds),
      headers: { "user-agent": "AirJam-Operational-Synthetic/1" },
    });
    let assertionPassed = response.ok;
    if (step.assertion === "json_ok" || step.assertion === "dependency_ready") {
      const body = (await response.json()) as Record<string, unknown>;
      assertionPassed = response.ok && body.ok === true;
      if (step.assertion === "dependency_ready") {
        const boundaries = body.boundaries as
          | Record<string, unknown>
          | undefined;
        assertionPassed =
          assertionPassed &&
          Boolean(boundaries) &&
          Object.values(boundaries!).every((boundary) => {
            if (!boundary || typeof boundary !== "object") return false;
            const value = boundary as Record<string, unknown>;
            return value.required !== true || value.status === "ready";
          });
      }
    } else if (step.assertion === "html_marker") {
      const contentType = response.headers.get("content-type") ?? "";
      const body = (await response.text()).slice(0, 64 * 1024).toLowerCase();
      assertionPassed =
        response.ok &&
        contentType.includes("text/html") &&
        (body.includes("<!doctype html") || body.includes("<html"));
    }
    return { response, assertionPassed };
  });
  if (!result.ok) {
    return {
      stepId: step.stepId,
      status: "error",
      latencyMilliseconds: result.latencyMilliseconds,
      failure: normalizeUnknownOperationalFailure({
        error: result.error,
        code:
          result.error instanceof DOMException &&
          result.error.name === "TimeoutError"
            ? "synthetic.http_timeout"
            : "synthetic.http_error",
        summary: "The synthetic HTTP request could not be completed.",
        retryable: true,
        details: { targetKey: step.targetKey },
      }),
    };
  }
  const httpStatus = result.value.response.status;
  if (!result.value.assertionPassed) {
    return {
      stepId: step.stepId,
      status: "failed",
      latencyMilliseconds: result.latencyMilliseconds,
      httpStatus,
      failure: createStructuredOperationalFailure({
        code: "synthetic.assertion_failed",
        failureClass: "dependency",
        summary:
          "The synthetic response did not satisfy its declared assertion.",
        retryable: true,
        details: {
          targetKey: step.targetKey,
          assertion: step.assertion,
          httpStatus,
        },
      }),
    };
  }
  return {
    stepId: step.stepId,
    status: "passed",
    latencyMilliseconds: result.latencyMilliseconds,
    httpStatus,
  };
};

const waitForConnect = (
  socket: AirJamSyntheticSocket,
  timeoutMilliseconds: number,
) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Synthetic socket connection timed out."));
    }, timeoutMilliseconds);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const emitWithAck = <E extends SyntheticAcknowledgedEvent>(
  socket: AirJamSyntheticSocket,
  event: E,
  payload: EventPayload<E>,
  timeoutMilliseconds: number,
): Promise<EventAcknowledgement<E>> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Synthetic ${event} acknowledgement timed out.`)),
      timeoutMilliseconds,
    );
    const emit = socket.emit.bind(socket) as (
      event: E,
      payload: EventPayload<E>,
      callback: (ack: EventAcknowledgement<E>) => void,
    ) => void;
    emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });

const waitForStateSync = (
  socket: AirJamSyntheticSocket,
  timeoutMilliseconds: number,
): Promise<Parameters<ServerToClientEvents["airjam:state_sync"]>[0]> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Synthetic state-sync event timed out.")),
      timeoutMilliseconds,
    );
    socket.once("airjam:state_sync", (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const executeAirJamSessionStep = async ({
  check,
  step,
  target,
  config,
  socketFactory,
}: {
  check: OperationalSyntheticCheckV1;
  step: OperationalSyntheticCheckV1["steps"][number];
  target: string | null;
  config: OperationalSyntheticRuntimeConfig;
  socketFactory: typeof io;
}): Promise<OperationalSyntheticRunV1["observations"][number]> => {
  if (!target) return unconfiguredTargetObservation(step);
  const requestOrigin = config.targets["platform.home"] ?? null;
  if (!requestOrigin) {
    return unconfiguredTargetObservation(step, "platform.home");
  }
  if (!config.appId) {
    return {
      stepId: step.stepId,
      status: "error",
      latencyMilliseconds: 0,
      failure: createStructuredOperationalFailure({
        code: "synthetic.app_identity_unconfigured",
        failureClass: "authorization",
        summary: "The synthetic Air Jam app identity is not configured.",
        retryable: false,
      }),
    };
  }
  const appId = config.appId;
  const result = await timed(async () => {
    const socketOptions = {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders: { origin: new URL(requestOrigin).origin },
    };
    const host = socketFactory(target, socketOptions) as AirJamSyntheticSocket;
    const controller = socketFactory(
      target,
      socketOptions,
    ) as AirJamSyntheticSocket;
    try {
      await Promise.all([
        waitForConnect(host, check.timeoutMilliseconds),
        waitForConnect(controller, check.timeoutMilliseconds),
      ]);
      const bootstrap = await emitWithAck(
        host,
        "host:bootstrap",
        { appId, hostSessionKind: "system" },
        check.timeoutMilliseconds,
      );
      if (!bootstrap.ok)
        throw new Error(
          `Host bootstrap rejected: ${bootstrap.code ?? "unknown"}.`,
        );
      const created = await emitWithAck(
        host,
        "host:createRoom",
        { maxPlayers: 1 },
        check.timeoutMilliseconds,
      );
      if (!created.ok || !created.roomId) {
        throw new Error(
          `Room creation rejected: ${created.code ?? "unknown"}.`,
        );
      }
      const controllerId = `aj-mcp-synthetic-${crypto.randomUUID()}`;
      const joined = await emitWithAck(
        controller,
        "controller:join",
        {
          roomId: created.roomId,
          controllerId,
          deviceId: `aj-mcp-device-synthetic-${crypto.randomUUID()}`,
          nickname: "Air Jam Synthetic",
          ...(created.controllerCapability?.token
            ? { capabilityToken: created.controllerCapability.token }
            : {}),
        },
        check.timeoutMilliseconds,
      );
      if (!joined.ok)
        throw new Error(
          `Controller join rejected: ${joined.code ?? "unknown"}.`,
        );

      if (step.targetKey === "realtime.semantic_action") {
        const statePromise = waitForStateSync(
          controller,
          check.timeoutMilliseconds,
        );
        host.emit("host:state_sync", {
          roomId: created.roomId,
          data: { phase: "playing", synthetic: true },
          storeDomain: "synthetic",
          revision: 1,
        });
        const state = await statePromise;
        if (state.revision !== 1 || state.data.synthetic !== true) {
          throw new Error("Replicated synthetic state was not preserved.");
        }
        host.once("airjam:action_rpc", (payload, acknowledge) => {
          if (payload.actionName !== "synthetic.ping") {
            acknowledge?.({
              ok: false,
              status: "rejected",
              source: "host",
              reason: "unexpected_action",
              message: "The synthetic host received an unexpected action.",
            });
            return;
          }
          acknowledge?.({
            ok: true,
            status: "accepted",
            source: "host",
            result: { pong: true },
          });
        });
        const action = await emitWithAck(
          controller,
          "controller:action_rpc",
          {
            roomId: created.roomId,
            actionName: "synthetic.ping",
            payload: { sequence: 1 },
            storeDomain: "synthetic",
          },
          check.timeoutMilliseconds,
        );
        const actionResult =
          action.ok && action.result && typeof action.result === "object"
            ? (action.result as { pong?: unknown })
            : null;
        if (!action.ok || actionResult?.pong !== true) {
          throw new Error(
            "Semantic synthetic action was not accepted end to end.",
          );
        }
      }
    } finally {
      host.disconnect();
      controller.disconnect();
    }
  });
  if (!result.ok) {
    return {
      stepId: step.stepId,
      status: "failed",
      latencyMilliseconds: result.latencyMilliseconds,
      failure: normalizeUnknownOperationalFailure({
        error: result.error,
        code: "synthetic.airjam_session_failed",
        summary:
          "The Air Jam multiplayer synthetic did not complete its declared story.",
        retryable: true,
        details: { story: check.story },
      }),
    };
  }
  return {
    stepId: step.stepId,
    status: "passed",
    latencyMilliseconds: result.latencyMilliseconds,
  };
};

export const executeOperationalSyntheticCheck = async ({
  check,
  config,
  fetchImpl = fetch,
  socketFactory = io,
  startedAt = new Date(),
  runId = crypto.randomUUID(),
}: {
  check: OperationalSyntheticCheckV1;
  config: OperationalSyntheticRuntimeConfig;
  fetchImpl?: typeof fetch;
  socketFactory?: typeof io;
  startedAt?: Date;
  runId?: string;
}): Promise<OperationalSyntheticRunV1> => {
  const executionStartedAt = performance.now();
  const observations = [];
  for (const step of check.steps) {
    const target = config.targets[step.targetKey] ?? null;
    observations.push(
      check.executor === "airjam_semantic"
        ? await executeAirJamSessionStep({
            check,
            step,
            target,
            config,
            socketFactory,
          })
        : await executeHttpStep({
            step,
            target,
            timeoutMilliseconds: check.timeoutMilliseconds,
            fetchImpl,
          }),
    );
  }
  const durationMilliseconds = Math.max(
    0,
    Math.round(performance.now() - executionStartedAt),
  );
  const completedAt = new Date(startedAt.getTime() + durationMilliseconds);
  const status = observations.some(
    (observation) => observation.status === "error",
  )
    ? "error"
    : observations.some((observation) => observation.status === "failed")
      ? "failed"
      : "passed";
  return operationalSyntheticRunSchemaV1.parse({
    contractVersion: 1,
    runId,
    checkId: check.checkId,
    environment: config.environment,
    status,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMilliseconds,
    eventId: `synthetic-event:${runId}`,
    observations,
    evidence: [
      {
        kind: "snapshot",
        reference: `synthetic-run:${runId}`,
        collectedAt: completedAt.toISOString(),
      },
    ],
  });
};

export const anchorOperationalSyntheticRunToDatabaseTime = ({
  run: rawRun,
  authorityNow,
}: {
  run: OperationalSyntheticRunV1;
  authorityNow: Date;
}): OperationalSyntheticRunV1 => {
  const run = operationalSyntheticRunSchemaV1.parse(rawRun);
  const completedAt = new Date(authorityNow);
  if (Number.isNaN(completedAt.getTime())) {
    throw new OperationalSyntheticConflictError(
      "The database authority time was invalid.",
    );
  }
  const startedAt = new Date(completedAt.getTime() - run.durationMilliseconds);
  return operationalSyntheticRunSchemaV1.parse({
    ...run,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    evidence: run.evidence.map((evidence) => ({
      ...evidence,
      collectedAt: completedAt.toISOString(),
    })),
  });
};

const buildSyntheticEvent = ({
  check,
  run,
  actor,
  reason,
}: {
  check: OperationalSyntheticCheckV1;
  run: OperationalSyntheticRunV1;
  actor: string;
  reason: string;
}) => ({
  contractVersion: 1 as const,
  plane: "lifecycle_runtime" as const,
  eventId: run.eventId,
  kind: `synthetic.${check.checkId}.${run.status}`,
  severity: run.status === "passed" ? ("info" as const) : ("error" as const),
  outcome:
    run.status === "passed" ? ("succeeded" as const) : ("failed" as const),
  authority: "synthetic_observation" as const,
  source: {
    service: check.service,
    component: `synthetic:${check.checkId}`,
    environment: run.environment,
  },
  subject: { type: "synthetic_check" as const, id: check.checkId },
  actor: { type: "agent" as const, id: actor },
  correlation: {
    contractVersion: 1 as const,
    correlationId: `synthetic:${run.runId}`,
  },
  occurredAt: run.completedAt,
  observedAt: run.completedAt,
  payload: {
    checkId: check.checkId,
    story: check.story,
    status: run.status,
    durationMilliseconds: run.durationMilliseconds,
    failedStepIds: run.observations
      .filter((observation) => observation.status !== "passed")
      .map((observation) => observation.stepId),
    failureCodes: run.observations
      .map((observation) => observation.failure?.code)
      .filter((code): code is string => Boolean(code)),
    reason: reason.slice(0, 500),
  },
  evidence: run.evidence,
});

const createAlertEvent = ({
  eventId,
  alertKey,
  status,
  severity,
  evaluation,
  sourceEventId,
  actor,
}: {
  eventId: string;
  alertKey: string;
  status: "open" | "recovered";
  severity: "warning" | "error" | "critical";
  evaluation: ReturnType<typeof operationalSloEvaluationSchemaV1.parse>;
  sourceEventId: string;
  actor: string;
}) => ({
  contractVersion: 1 as const,
  plane: "lifecycle_runtime" as const,
  eventId,
  kind: `alert.slo.${status}`,
  severity: status === "recovered" ? ("info" as const) : severity,
  outcome:
    status === "recovered" ? ("recovered" as const) : ("degraded" as const),
  authority: "airjam_authoritative" as const,
  source: {
    service: evaluation.service,
    component: "slo-evaluator",
    environment: evaluation.environment,
  },
  subject: { type: "service" as const, id: evaluation.service },
  actor: { type: "system" as const, id: actor },
  correlation: {
    contractVersion: 1 as const,
    correlationId: `slo:${evaluation.sloId}:${evaluation.environment}`,
    causationEventId: sourceEventId,
  },
  occurredAt: evaluation.evaluatedAt,
  observedAt: evaluation.evaluatedAt,
  payload: {
    alertKey,
    sloId: evaluation.sloId,
    evaluationId: evaluation.evaluationId,
    status,
    sampleCount: evaluation.sampleCount,
    successRatioBasisPoints: evaluation.successRatioBasisPoints,
    objectiveBasisPoints: evaluation.objectiveBasisPoints,
  },
  evidence: evaluation.evidence,
});

const evaluateAndRouteAlertInTransaction = async ({
  tx,
  run,
  check,
  actor,
}: {
  tx: OperationalEventTransaction;
  run: OperationalSyntheticRunV1;
  check: OperationalSyntheticCheckV1;
  actor: string;
}) => {
  const definition = getOperationalSloDefinition(check.sloId);
  const evaluatedAt = new Date(run.completedAt);
  const evaluationId = `slo-evaluation:${definition.sloId}:${run.runId}`;
  const previous = await tx.query.operationalSloEvaluations.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.sloId, definition.sloId),
        eq(table.environment, run.environment),
      ),
    orderBy: (table, { desc }) => desc(table.evaluatedAt),
  });
  if (previous && previous.evaluatedAt.getTime() > evaluatedAt.getTime()) {
    const existing = await tx.query.operationalAlerts.findFirst({
      where: (table, { eq }) =>
        eq(table.alertKey, `slo:${definition.sloId}:${run.environment}`),
    });
    return {
      evaluation: null,
      alert: existing?.document ?? null,
      transition: null,
      evaluationDisposition: "stale_ignored" as const,
    };
  }
  const windowStartedAt = new Date(
    evaluatedAt.getTime() - definition.windowSeconds * 1_000,
  );
  const samples = await tx
    .select()
    .from(operationalSyntheticRuns)
    .where(
      and(
        inArray(operationalSyntheticRuns.checkId, [
          ...definition.syntheticCheckIds,
        ]),
        eq(operationalSyntheticRuns.environment, run.environment),
        gte(operationalSyntheticRuns.completedAt, windowStartedAt),
        lte(operationalSyntheticRuns.completedAt, evaluatedAt),
      ),
    );
  const sampleCount = samples.length;
  const successCount = samples.filter(
    (sample) => sample.status === "passed",
  ).length;
  const ratio =
    sampleCount === 0
      ? null
      : Math.floor((successCount * 10_000) / sampleCount);
  const baseStatus =
    sampleCount < definition.minimumSamples
      ? "insufficient_data"
      : ratio! >= definition.objectiveBasisPoints
        ? "healthy"
        : "breaching";
  const previousDocument = previous?.document;
  const consecutiveBreaches =
    baseStatus === "breaching"
      ? previousDocument?.status === "breaching"
        ? previousDocument.consecutiveBreaches + 1
        : 1
      : 0;
  const consecutiveRecoveries =
    baseStatus === "healthy"
      ? previousDocument?.status === "healthy"
        ? previousDocument.consecutiveRecoveries + 1
        : 1
      : 0;
  const evaluation = operationalSloEvaluationSchemaV1.parse({
    contractVersion: 1,
    evaluationId,
    sloId: definition.sloId,
    environment: run.environment,
    service: definition.service,
    windowStartedAt: windowStartedAt.toISOString(),
    windowEndedAt: evaluatedAt.toISOString(),
    sampleCount,
    successCount,
    successRatioBasisPoints: ratio,
    objectiveBasisPoints: definition.objectiveBasisPoints,
    status: baseStatus,
    consecutiveBreaches,
    consecutiveRecoveries,
    evaluatedAt: evaluatedAt.toISOString(),
    evidence: [
      {
        kind: "event",
        reference: `event:${run.eventId}`,
        collectedAt: evaluatedAt.toISOString(),
      },
    ],
  });
  await tx.insert(operationalSloEvaluations).values({
    id: evaluation.evaluationId,
    sloId: evaluation.sloId,
    environment: evaluation.environment,
    status: evaluation.status,
    triggerEventId: run.eventId,
    document: evaluation,
    evaluatedAt,
    createdAt: evaluatedAt,
  });

  const alertKey = `slo:${definition.sloId}:${run.environment}`;
  const [existing] = await tx
    .select()
    .from(operationalAlerts)
    .where(eq(operationalAlerts.alertKey, alertKey))
    .limit(1)
    .for("update");
  const shouldOpen =
    baseStatus === "breaching" &&
    consecutiveBreaches >= definition.alerting.consecutiveBreaches &&
    existing?.status !== "open";
  const shouldRecover =
    baseStatus === "healthy" &&
    consecutiveRecoveries >= definition.alerting.consecutiveRecoveries &&
    existing?.status === "open";
  const shouldRefresh =
    baseStatus === "breaching" && existing?.status === "open";
  if (!shouldOpen && !shouldRecover && !shouldRefresh) {
    return {
      evaluation,
      alert: existing?.document ?? null,
      transition: null,
      evaluationDisposition: "evaluated" as const,
    };
  }

  const alertStatus = shouldRecover ? "recovered" : "open";
  const revision = (existing?.revision ?? 0) + 1;
  const alertEventId = `alert-event:${definition.sloId}:${run.runId}:${alertStatus}`;
  const alertEvent = createAlertEvent({
    eventId: alertEventId,
    alertKey,
    status: alertStatus,
    severity: definition.alerting.severity,
    evaluation,
    sourceEventId: run.eventId,
    actor,
  });
  await enqueueOperationalEventInTransaction({
    tx,
    event: alertEvent,
    now: evaluatedAt,
  });
  const firstTriggeredAt =
    shouldOpen || !existing
      ? evaluatedAt.toISOString()
      : existing.document.firstTriggeredAt;
  const alert = operationalAlertSchemaV1.parse({
    contractVersion: 1,
    alertId: existing?.id ?? `alert:${definition.sloId}:${run.environment}`,
    alertKey,
    policyId: definition.sloId,
    environment: run.environment,
    service: definition.service,
    severity: definition.alerting.severity,
    status: alertStatus,
    summary:
      alertStatus === "open"
        ? `${definition.title} is below its ${definition.objectiveBasisPoints / 100}% objective.`
        : `${definition.title} recovered above its objective.`,
    firstTriggeredAt,
    lastObservedAt: evaluatedAt.toISOString(),
    occurrenceCount: (existing?.document.occurrenceCount ?? 0) + 1,
    latestEventId: alertEventId,
    latestEvaluationId: evaluation.evaluationId,
    ...(alertStatus === "recovered"
      ? { recoveredAt: evaluatedAt.toISOString() }
      : {}),
    revision,
  });
  if (existing) {
    const [updated] = await tx
      .update(operationalAlerts)
      .set({
        status: alert.status,
        severity: alert.severity,
        latestEventId: alert.latestEventId,
        latestEvaluationId: alert.latestEvaluationId,
        revision: alert.revision,
        document: alert,
        updatedAt: evaluatedAt,
      })
      .where(
        and(
          eq(operationalAlerts.id, existing.id),
          eq(operationalAlerts.revision, existing.revision),
        ),
      )
      .returning({ id: operationalAlerts.id });
    if (!updated) {
      throw new OperationalSyntheticConflictError(
        "The operational alert revision changed during evaluation.",
      );
    }
  } else {
    await tx.insert(operationalAlerts).values({
      id: alert.alertId,
      alertKey: alert.alertKey,
      policyId: alert.policyId,
      environment: alert.environment,
      service: alert.service,
      severity: alert.severity,
      status: alert.status,
      latestEventId: alert.latestEventId,
      latestEvaluationId: alert.latestEvaluationId,
      revision: alert.revision,
      document: alert,
      createdAt: evaluatedAt,
      updatedAt: evaluatedAt,
    });
  }
  const transition: "opened" | "recovered" | "refreshed" = shouldOpen
    ? "opened"
    : shouldRecover
      ? "recovered"
      : "refreshed";
  return {
    evaluation,
    alert,
    transition,
    evaluationDisposition: "evaluated" as const,
  };
};

const acquireOperationalSyntheticExecutionFence = async ({
  tx,
  checkId,
  environment,
  idempotencyKey,
}: {
  tx: OperationalEventTransaction;
  checkId: string;
  environment: DeploymentEnvironment;
  idempotencyKey: string;
}) => {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`airjam:synthetic:${idempotencyKey}`}))`,
  );
  return resolveReplayedSyntheticRun({
    database: tx,
    checkId,
    environment,
    idempotencyKey,
  });
};

const persistOperationalSyntheticRunInTransaction = async ({
  tx,
  submittedRun,
  actor,
  reason,
  idempotencyKey,
  testNow,
}: {
  tx: OperationalEventTransaction;
  submittedRun: OperationalSyntheticRunV1;
  actor: string;
  reason: string;
  idempotencyKey: string;
  testNow?: Date;
}): Promise<OperationalSyntheticPersistenceResult> => {
  const check = getOperationalSyntheticCheck(submittedRun.checkId);
  const definition = getOperationalSloDefinition(check.sloId);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`airjam:slo:${definition.sloId}:${submittedRun.environment}`}))`,
  );
  const authorityNow = await resolveDatabaseAuthorityNow(tx, testNow);
  const run = anchorOperationalSyntheticRunToDatabaseTime({
    run: submittedRun,
    authorityNow,
  });
  await enqueueOperationalEventInTransaction({
    tx,
    event: buildSyntheticEvent({
      check,
      run,
      actor,
      reason,
    }),
    now: authorityNow,
  });
  await tx.insert(operationalSyntheticRuns).values({
    id: run.runId,
    idempotencyKey,
    checkId: run.checkId,
    environment: run.environment,
    status: run.status,
    eventId: run.eventId,
    document: run,
    startedAt: new Date(run.startedAt),
    completedAt: new Date(run.completedAt),
    createdAt: new Date(run.completedAt),
  });
  const routed = await evaluateAndRouteAlertInTransaction({
    tx,
    run,
    check,
    actor,
  });
  return { run, ...routed };
};

export const persistOperationalSyntheticRun = async ({
  database = db,
  run: rawRun,
  actor,
  reason,
  idempotencyKey,
  now: testNow,
}: {
  database?: OperationalEventDatabase;
  run: OperationalSyntheticRunV1;
  actor: string;
  reason: string;
  idempotencyKey: string;
  now?: Date;
}): Promise<OperationalSyntheticPersistenceResult> => {
  const submittedRun = operationalSyntheticRunSchemaV1.parse(rawRun);
  const { normalizedActor, normalizedReason, normalizedKey } =
    normalizeOperationalSyntheticCommand({ actor, reason, idempotencyKey });
  return database.transaction(async (tx) => {
    const replay = await acquireOperationalSyntheticExecutionFence({
      tx,
      checkId: submittedRun.checkId,
      environment: submittedRun.environment,
      idempotencyKey: normalizedKey,
    });
    if (replay) return replay;
    return persistOperationalSyntheticRunInTransaction({
      tx,
      submittedRun,
      actor: normalizedActor,
      reason: normalizedReason,
      idempotencyKey: normalizedKey,
      testNow,
    });
  });
};

export const runOperationalSynthetic = async ({
  database = db,
  checkId,
  actor,
  reason,
  idempotencyKey,
  config = resolveOperationalSyntheticRuntimeConfig(),
  fetchImpl,
  socketFactory,
}: {
  database?: OperationalEventDatabase;
  checkId: string;
  actor: string;
  reason: string;
  idempotencyKey: string;
  config?: OperationalSyntheticRuntimeConfig;
  fetchImpl?: typeof fetch;
  socketFactory?: typeof io;
}): Promise<OperationalSyntheticPersistenceResult> => {
  const check = getOperationalSyntheticCheck(checkId);
  const { normalizedActor, normalizedReason, normalizedKey } =
    normalizeOperationalSyntheticCommand({ actor, reason, idempotencyKey });
  return database.transaction(async (tx) => {
    const replay = await acquireOperationalSyntheticExecutionFence({
      tx,
      checkId: check.checkId,
      environment: config.environment,
      idempotencyKey: normalizedKey,
    });
    if (replay) return replay;
    const run = await executeOperationalSyntheticCheck({
      check,
      config,
      fetchImpl,
      socketFactory,
    });
    return persistOperationalSyntheticRunInTransaction({
      tx,
      submittedRun: operationalSyntheticRunSchemaV1.parse(run),
      actor: normalizedActor,
      reason: normalizedReason,
      idempotencyKey: normalizedKey,
    });
  });
};

export const getOperationalReliabilityStatus = async ({
  database = db,
  environment,
}: {
  database?: OperationalEventDatabase;
  environment: DeploymentEnvironment;
}) => {
  const [latestRuns, latestEvaluations, alerts] = await Promise.all([
    Promise.all(
      OPERATIONAL_SYNTHETIC_CHECKS.map((check) =>
        database.query.operationalSyntheticRuns.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.checkId, check.checkId),
              eq(table.environment, environment),
            ),
          orderBy: (table, { desc }) => desc(table.completedAt),
        }),
      ),
    ),
    Promise.all(
      OPERATIONAL_SLO_DEFINITIONS.map((definition) =>
        database.query.operationalSloEvaluations.findFirst({
          where: (table, { and, eq }) =>
            and(
              eq(table.sloId, definition.sloId),
              eq(table.environment, environment),
            ),
          orderBy: (table, { desc }) => desc(table.evaluatedAt),
        }),
      ),
    ),
    database.query.operationalAlerts.findMany({
      where: (table, { eq }) => eq(table.environment, environment),
      orderBy: (table, { desc }) => desc(table.updatedAt),
    }),
  ]);
  return {
    contractVersion: 1 as const,
    environment,
    checks: OPERATIONAL_SYNTHETIC_CHECKS.map((check, index) => ({
      checkId: check.checkId,
      story: check.story,
      intervalSeconds: check.intervalSeconds,
      latestRun: latestRuns[index]?.document ?? null,
    })),
    slos: OPERATIONAL_SLO_DEFINITIONS.map((definition, index) => ({
      sloId: definition.sloId,
      objectiveBasisPoints: definition.objectiveBasisPoints,
      latestEvaluation: latestEvaluations[index]?.document ?? null,
    })),
    alerts: alerts.map((alert) => alert.document),
  };
};

export const listOperationalSyntheticRuns = async ({
  database = db,
  checkId,
  environment,
  limit = 100,
}: {
  database?: OperationalEventDatabase;
  checkId?: string;
  environment?: DeploymentEnvironment;
  limit?: number;
} = {}) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new OperationalSyntheticConflictError(
      "List limit must be between 1 and 500.",
    );
  }
  const conditions = [];
  if (checkId) conditions.push(eq(operationalSyntheticRuns.checkId, checkId));
  if (environment)
    conditions.push(eq(operationalSyntheticRuns.environment, environment));
  const rows = await database
    .select()
    .from(operationalSyntheticRuns)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(operationalSyntheticRuns.completedAt))
    .limit(limit);
  return rows.map((row) => row.document);
};

export const listOperationalAlerts = async ({
  database = db,
  environment,
  status,
}: {
  database?: OperationalEventDatabase;
  environment?: DeploymentEnvironment;
  status?: "open" | "recovered";
} = {}): Promise<OperationalAlertV1[]> => {
  const conditions = [];
  if (environment)
    conditions.push(eq(operationalAlerts.environment, environment));
  if (status) conditions.push(eq(operationalAlerts.status, status));
  const rows = await database
    .select()
    .from(operationalAlerts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(operationalAlerts.updatedAt));
  return rows.map((row) => operationalAlertSchemaV1.parse(row.document));
};

export const inspectOperationalAlert = async ({
  database = db,
  alertKey,
}: {
  database?: OperationalEventDatabase;
  alertKey: string;
}): Promise<OperationalAlertV1 | null> => {
  const row = await database.query.operationalAlerts.findFirst({
    where: (table, { eq }) => eq(table.alertKey, alertKey),
  });
  return row ? operationalAlertSchemaV1.parse(row.document) : null;
};
