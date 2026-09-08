import {
  createGitHubAlertIssueProjector,
  resolveGitHubAlertIssueConfig,
} from "@/server/operations/github-alert-issue-adapter";
import { scheduleLifecycleCleanup } from "@/server/operations/lifecycle-cleanup-service";
import {
  repairExpiredOperationalAlertIssueProjections,
  runOperationalAlertIssueProjectionCycle,
} from "@/server/operations/operational-alert-issue-projection-service";
import {
  repairExpiredOperationalEventDeliveries,
  runOperationalEventDeliveryCycle,
} from "@/server/operations/operational-event-delivery-service";
import { runDueOperationalSynthetics } from "@/server/operations/operational-synthetic-scheduler";
import { resolveOperationalSyntheticRuntimeConfig } from "@/server/operations/operational-synthetic-service";
import {
  createRailwayBudgetEvidenceAdapter,
  resolveRailwayBudgetEvidenceConfig,
} from "@/server/operations/railway-budget-evidence-adapter";
import {
  inspectOperationalBudgetRefreshAuthority,
  isOperationalBudgetRefreshAuthorityFresh,
  OPERATIONAL_BUDGET_REFRESH_INTERVAL_MS,
  runOperationalBudgetRefreshCycle,
  type OperationalBudgetRefreshResult,
} from "@/server/operations/production-budget-refresh-service";
import {
  PRODUCTION_BUDGET_EVIDENCE_MAX_AGE_MS,
  type OperationalBudgetStatus,
} from "@/server/operations/production-budget-service";
import {
  PlatformSchemaIncompatibleError,
  readPlatformSchemaCompatibility,
  type PlatformSchemaCompatibility,
} from "@/server/operations/platform-schema-compatibility";
import { applyProductTelemetryRetention } from "@/server/product-telemetry/persistence";
import { validateEnv } from "@air-jam/env";
import {
  normalizeUnknownOperationalFailure,
  operationalIdentifierSchema,
} from "@air-jam/operations-contract";
import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { repairExpiredOperationalJobs } from "./operational-job-service";
import {
  operationalJobWorkerKinds,
  runOperationalJobWorkerCycle,
  type OperationalJobWorkerCycleResult,
} from "./operational-job-worker";
import { cleanupReleaseJobOrphanOutputs } from "./release-job-output-cleanup";

const optionalTrimmedString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined,
  z.string().optional(),
);

const optionalOperationalIdentifier = optionalTrimmedString.superRefine(
  (value, context) => {
    if (value && !operationalIdentifierSchema.safeParse(value).success) {
      context.addIssue({
        code: "custom",
        message: "Must be a valid operations identifier.",
      });
    }
  },
);

const positiveInteger = (fallback: number) =>
  optionalTrimmedString.transform((value, context) => {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      context.addIssue({
        code: "custom",
        message: "Must be a positive integer.",
      });
      return z.NEVER;
    }
    return parsed;
  });

const workerEnvSchema = z
  .object({
    PORT: optionalTrimmedString,
    RAILWAY_ENVIRONMENT_NAME: optionalTrimmedString,
    RAILWAY_PROJECT_ID: optionalTrimmedString,
    RAILWAY_ENVIRONMENT_ID: optionalTrimmedString,
    RAILWAY_PROJECT_TOKEN: optionalTrimmedString,
    AIRJAM_PLATFORM_WORKER_PORT: optionalTrimmedString,
    AIRJAM_PLATFORM_WORKER_HOST: optionalTrimmedString.transform(
      (value) => value ?? "0.0.0.0",
    ),
    AIRJAM_PLATFORM_WORKER_ID: optionalOperationalIdentifier,
    AIRJAM_PLATFORM_WORKER_CONTROL_TOKEN: optionalTrimmedString,
    AIRJAM_PLATFORM_WORKER_POLL_MS: positiveInteger(2_000),
    AIRJAM_PLATFORM_WORKER_REPAIR_MS: positiveInteger(30_000),
    AIRJAM_PLATFORM_WORKER_LIFECYCLE_CLEANUP_MS: positiveInteger(900_000),
    AIRJAM_PLATFORM_WORKER_TELEMETRY_RETENTION_MS: positiveInteger(900_000),
    AIRJAM_PLATFORM_WORKER_EVENT_DELIVERY_MS: positiveInteger(1_000),
    AIRJAM_PLATFORM_WORKER_SYNTHETIC_MS: positiveInteger(30_000),
    AIRJAM_PLATFORM_WORKER_ISSUE_PROJECTION_MS: positiveInteger(5_000),
    AIRJAM_PLATFORM_WORKER_BUDGET_REFRESH_MODE: z
      .enum(["enabled", "disabled"])
      .optional(),
    AIRJAM_PLATFORM_WORKER_BUDGET_REFRESH_MS: positiveInteger(
      OPERATIONAL_BUDGET_REFRESH_INTERVAL_MS,
    ),
    AIRJAM_PLATFORM_WORKER_MAX_IN_FLIGHT: positiveInteger(4),
    AIRJAM_PLATFORM_WORKER_DRAIN_TIMEOUT_MS: positiveInteger(300_000),
  })
  .transform((value, context) => {
    const production = value.RAILWAY_ENVIRONMENT_NAME === "production";
    const budgetRefreshEnabled =
      value.AIRJAM_PLATFORM_WORKER_BUDGET_REFRESH_MODE
        ? value.AIRJAM_PLATFORM_WORKER_BUDGET_REFRESH_MODE === "enabled"
        : production;
    if (
      production &&
      !value.AIRJAM_PLATFORM_WORKER_CONTROL_TOKEN
    ) {
      context.addIssue({
        code: "custom",
        path: ["AIRJAM_PLATFORM_WORKER_CONTROL_TOKEN"],
        message: "A worker control token is required in production.",
      });
      return z.NEVER;
    }
    if (production && !budgetRefreshEnabled) {
      context.addIssue({
        code: "custom",
        path: ["AIRJAM_PLATFORM_WORKER_BUDGET_REFRESH_MODE"],
        message: "Budget refresh cannot be disabled in production.",
      });
      return z.NEVER;
    }
    if (
      budgetRefreshEnabled &&
      value.AIRJAM_PLATFORM_WORKER_BUDGET_REFRESH_MS >=
      PRODUCTION_BUDGET_EVIDENCE_MAX_AGE_MS
    ) {
      context.addIssue({
        code: "custom",
        path: ["AIRJAM_PLATFORM_WORKER_BUDGET_REFRESH_MS"],
        message: "Budget refresh cadence must be shorter than evidence staleness.",
      });
      return z.NEVER;
    }
    if (
      budgetRefreshEnabled &&
      (!value.RAILWAY_PROJECT_ID ||
        !value.RAILWAY_ENVIRONMENT_ID ||
        !value.RAILWAY_PROJECT_TOKEN)
    ) {
      context.addIssue({
        code: "custom",
        path: ["RAILWAY_PROJECT_TOKEN"],
        message:
          "Enabled budget refresh requires exact RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, and a sealed RAILWAY_PROJECT_TOKEN.",
      });
      return z.NEVER;
    }
    const portValue = value.PORT ?? value.AIRJAM_PLATFORM_WORKER_PORT ?? "8080";
    const port = Number.parseInt(portValue, 10);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
      context.addIssue({
        code: "custom",
        path: [value.PORT ? "PORT" : "AIRJAM_PLATFORM_WORKER_PORT"],
        message: "Worker port must be between 1 and 65535.",
      });
      return z.NEVER;
    }
    return {
      host: value.AIRJAM_PLATFORM_WORKER_HOST,
      port,
      environmentName: value.RAILWAY_ENVIRONMENT_NAME ?? null,
      workerId:
        value.AIRJAM_PLATFORM_WORKER_ID ??
        `platform-worker:${process.pid}:${crypto.randomUUID()}`,
      controlToken: value.AIRJAM_PLATFORM_WORKER_CONTROL_TOKEN ?? null,
      pollMs: value.AIRJAM_PLATFORM_WORKER_POLL_MS,
      repairMs: value.AIRJAM_PLATFORM_WORKER_REPAIR_MS,
      lifecycleCleanupMs: value.AIRJAM_PLATFORM_WORKER_LIFECYCLE_CLEANUP_MS,
      telemetryRetentionMs: value.AIRJAM_PLATFORM_WORKER_TELEMETRY_RETENTION_MS,
      eventDeliveryMs: value.AIRJAM_PLATFORM_WORKER_EVENT_DELIVERY_MS,
      syntheticMs: value.AIRJAM_PLATFORM_WORKER_SYNTHETIC_MS,
      issueProjectionMs: value.AIRJAM_PLATFORM_WORKER_ISSUE_PROJECTION_MS,
      budgetRefreshEnabled,
      budgetRefreshMs: value.AIRJAM_PLATFORM_WORKER_BUDGET_REFRESH_MS,
      railwayProjectId: value.RAILWAY_PROJECT_ID ?? null,
      railwayEnvironmentId: value.RAILWAY_ENVIRONMENT_ID ?? null,
      railwayProjectToken: value.RAILWAY_PROJECT_TOKEN ?? null,
      maxInFlight: value.AIRJAM_PLATFORM_WORKER_MAX_IN_FLIGHT,
      drainTimeoutMs: value.AIRJAM_PLATFORM_WORKER_DRAIN_TIMEOUT_MS,
    };
  });

export type OperationalJobWorkerServiceConfig = z.output<
  typeof workerEnvSchema
>;

export const loadOperationalJobWorkerServiceConfig = (
  env: Record<string, string | undefined> = process.env,
): OperationalJobWorkerServiceConfig =>
  validateEnv({
    boundary: "platform-operational-job-worker",
    schema: workerEnvSchema,
    env,
    docsHint:
      "Set AIRJAM_PLATFORM_WORKER_* variables for the durable operational executor.",
  });

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  value: Record<string, unknown>,
) => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
};

const isAuthorized = ({
  authorization,
  token,
}: {
  authorization: string | undefined;
  token: string | null;
}): boolean => Boolean(token) && authorization === `Bearer ${token}`;

export type OperationalJobWorkerServiceHandle = {
  config: OperationalJobWorkerServiceConfig;
  drain: () => Promise<void>;
  close: () => Promise<void>;
};

const workerAuthorityNames = [
  "schema",
  "jobs",
  "maintenance",
  "lifecycleCleanup",
  "telemetryRetention",
  "eventDelivery",
  "synthetics",
  "issueProjection",
  "budgetEvidence",
] as const;

type WorkerAuthorityName = (typeof workerAuthorityNames)[number];
type WorkerAuthorityState = {
  status: "pending" | "ready" | "failed" | "disabled";
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
};

const coreWorkerAuthorityNames = [
  "schema",
  "jobs",
  "eventDelivery",
  "telemetryRetention",
] as const satisfies readonly WorkerAuthorityName[];

type RefreshBudgetEvidence = (input: {
  actor: string;
  projectId: string;
  refreshIntervalMs: number;
}) => Promise<OperationalBudgetRefreshResult>;

type InspectBudgetEvidence = () => Promise<OperationalBudgetStatus>;

export const startOperationalJobWorkerService = async ({
  env = process.env,
  runCycle = runOperationalJobWorkerCycle,
  repair = repairExpiredOperationalJobs,
  cleanup = cleanupReleaseJobOrphanOutputs,
  scheduleCleanup = scheduleLifecycleCleanup,
  retainTelemetry = applyProductTelemetryRetention,
  deliverEvent = runOperationalEventDeliveryCycle,
  repairEventDelivery = repairExpiredOperationalEventDeliveries,
  runSynthetics = runDueOperationalSynthetics,
  runIssueProjection = runOperationalAlertIssueProjectionCycle,
  repairIssueProjection = repairExpiredOperationalAlertIssueProjections,
  readSchemaCompatibility = readPlatformSchemaCompatibility,
  refreshBudgetEvidence,
  inspectBudgetEvidence = inspectOperationalBudgetRefreshAuthority,
}: {
  env?: Record<string, string | undefined>;
  runCycle?: typeof runOperationalJobWorkerCycle;
  repair?: typeof repairExpiredOperationalJobs;
  cleanup?: typeof cleanupReleaseJobOrphanOutputs;
  scheduleCleanup?: typeof scheduleLifecycleCleanup;
  retainTelemetry?: typeof applyProductTelemetryRetention;
  deliverEvent?: typeof runOperationalEventDeliveryCycle;
  repairEventDelivery?: typeof repairExpiredOperationalEventDeliveries;
  runSynthetics?: typeof runDueOperationalSynthetics;
  runIssueProjection?: typeof runOperationalAlertIssueProjectionCycle;
  repairIssueProjection?: typeof repairExpiredOperationalAlertIssueProjections;
  readSchemaCompatibility?: typeof readPlatformSchemaCompatibility;
  refreshBudgetEvidence?: RefreshBudgetEvidence;
  inspectBudgetEvidence?: InspectBudgetEvidence;
} = {}): Promise<OperationalJobWorkerServiceHandle> => {
  const config = loadOperationalJobWorkerServiceConfig(env);
  const githubIssueConfig = resolveGitHubAlertIssueConfig(env);
  const githubIssueProjector = githubIssueConfig.enabled
    ? createGitHubAlertIssueProjector({ config: githubIssueConfig })
    : null;
  const budgetCollector = config.budgetRefreshEnabled
    ? createRailwayBudgetEvidenceAdapter(
        resolveRailwayBudgetEvidenceConfig({
          env,
          projectId: config.railwayProjectId ?? undefined,
          environmentId: config.railwayEnvironmentId ?? undefined,
        }),
      )
    : null;
  const refreshBudget: RefreshBudgetEvidence =
    refreshBudgetEvidence ??
    ((input) => {
      if (!budgetCollector) {
        throw new Error("Budget evidence collector is not configured.");
      }
      return runOperationalBudgetRefreshCycle({
        ...input,
        collector: budgetCollector,
      });
    });
  const inFlight = new Set<Promise<OperationalJobWorkerCycleResult>>();
  let accepting = true;
  let closed = false;
  let scheduling = false;
  let lastCycleAt: string | null = null;
  let lastCycleResult: OperationalJobWorkerCycleResult | null = null;
  let lastErrorAt: string | null = null;
  let lastErrorCode: string | null = null;
  let schemaCompatibility: PlatformSchemaCompatibility | null = null;
  const authorities = Object.fromEntries(
    workerAuthorityNames.map((name) => [
      name,
      {
        status: "pending",
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureCode: null,
      } satisfies WorkerAuthorityState,
    ]),
  ) as Record<WorkerAuthorityName, WorkerAuthorityState>;
  if (!config.budgetRefreshEnabled) {
    authorities.budgetEvidence.status = "disabled";
  }
  let maintenanceInFlight: Promise<void> | null = null;
  let lifecycleCleanupInFlight: Promise<void> | null = null;
  let telemetryRetentionInFlight: Promise<void> | null = null;
  let eventDeliveryInFlight: Promise<void> | null = null;
  let syntheticInFlight: Promise<void> | null = null;
  let issueProjectionInFlight: Promise<void> | null = null;
  let budgetRefreshInFlight: Promise<void> | null = null;
  let lastEventDeliveryAt: string | null = null;
  let lastEventDeliveryStatus: string | null = null;
  let lastSyntheticAt: string | null = null;
  let lastSyntheticBatch: {
    scheduledAt: string;
    dueCount: number;
    completedCount: number;
    failureCount: number;
    staleIgnoredCount: number;
    skippedCount: number;
    failedCheckIds: string[];
    staleIgnoredCheckIds: string[];
  } | null = null;
  let lastIssueProjectionAt: string | null = null;
  let lastIssueProjectionStatus: string | null = githubIssueConfig.enabled
    ? null
    : "disabled";
  let lastBudgetRefreshAt: string | null = null;
  let lastBudgetRefreshStatus:
    | "recorded"
    | "not_due"
    | "failed"
    | "disabled"
    | null = config.budgetRefreshEnabled ? null : "disabled";
  let lastBudgetRefreshErrorCode: string | null = null;
  let budgetStatus: OperationalBudgetStatus | null = null;
  let kindCursor = 0;

  const recordAuthoritySuccess = (authority: WorkerAuthorityName) => {
    const at = new Date().toISOString();
    authorities[authority] = {
      status: "ready",
      lastSuccessAt: at,
      lastFailureAt: authorities[authority].lastFailureAt,
      lastFailureCode: null,
    };
  };

  const recordAuthorityFailure = (
    authority: WorkerAuthorityName,
    error: unknown,
  ) => {
    const at = new Date().toISOString();
    const failureCode =
      error instanceof Error ? error.name : "unknown_worker_error";
    authorities[authority] = {
      status: "failed",
      lastSuccessAt: authorities[authority].lastSuccessAt,
      lastFailureAt: at,
      lastFailureCode: failureCode,
    };
    lastErrorAt = at;
    lastErrorCode = failureCode;
  };

  const logFailure = ({
    event,
    error,
    details,
  }: {
    event: string;
    error: unknown;
    details?: Record<string, unknown>;
  }) => {
    const failure = normalizeUnknownOperationalFailure({
      error,
      code: event,
      summary:
        "The platform operational worker encountered a structured failure.",
      retryable: true,
      details,
    });
    console.error(
      JSON.stringify({
        service: "air-jam-platform-worker",
        event,
        failure,
      }),
    );
  };

  const refreshSchemaCompatibility = async () => {
    const compatibility = await readSchemaCompatibility();
    schemaCompatibility = compatibility;
    if (compatibility.compatible) {
      recordAuthoritySuccess("schema");
      return;
    }
    recordAuthorityFailure(
      "schema",
      new PlatformSchemaIncompatibleError(compatibility),
    );
  };

  const canScheduleWork = () =>
    accepting && !closed && schemaCompatibility?.compatible === true;

  const runOne = (kind: (typeof operationalJobWorkerKinds)[number]) => {
    if (!canScheduleWork()) return;
    const task = runCycle({ kind, workerId: config.workerId })
      .then((result) => {
        lastCycleAt = new Date().toISOString();
        lastCycleResult = result;
        recordAuthoritySuccess("jobs");
        return result;
      })
      .catch((error: unknown) => {
        recordAuthorityFailure("jobs", error);
        throw error;
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
    void task.catch((error: unknown) => {
      logFailure({
        event: "operational_job.cycle_failed",
        error,
        details: { kind },
      });
    });
  };

  const schedule = () => {
    if (!canScheduleWork() || scheduling) return;
    scheduling = true;
    try {
      while (inFlight.size < config.maxInFlight) {
        const kind =
          operationalJobWorkerKinds[
            kindCursor % operationalJobWorkerKinds.length
          ];
        kindCursor += 1;
        if (!kind) break;
        runOne(kind);
      }
    } finally {
      scheduling = false;
    }
  };

  await refreshSchemaCompatibility();
  const schemaTimer = setInterval(() => {
    void refreshSchemaCompatibility().catch((error: unknown) => {
      recordAuthorityFailure("schema", error);
    });
  }, config.repairMs);
  schemaTimer.unref();

  const scheduler = setInterval(schedule, config.pollMs);
  scheduler.unref();
  schedule();

  const repairExpired = async () => {
    let successful = true;
    const bucket = Math.floor(Date.now() / config.repairMs);
    for (const kind of operationalJobWorkerKinds) {
      try {
        await repair({
          kind,
          actor: config.workerId,
          reason: "Platform worker repaired expired operational job authority.",
          idempotencyKey: `worker-repair:${kind}:${bucket}`,
        });
      } catch (error) {
        successful = false;
        recordAuthorityFailure("maintenance", error);
        logFailure({
          event: "operational_job.repair_failed",
          error,
          details: { kind },
        });
      }
    }
    try {
      await cleanup({
        actor: config.workerId,
        reason: "Platform worker removed terminal attempt orphan outputs.",
      });
    } catch (error) {
      successful = false;
      recordAuthorityFailure("maintenance", error);
      logFailure({ event: "operational_job.output_cleanup_failed", error });
    }
    try {
      await repairEventDelivery();
    } catch (error) {
      successful = false;
      recordAuthorityFailure("maintenance", error);
      logFailure({ event: "operational_event.delivery_repair_failed", error });
    }
    if (githubIssueConfig.enabled) {
      try {
        await repairIssueProjection({
          repository: githubIssueConfig.repository,
        });
      } catch (error) {
        successful = false;
        recordAuthorityFailure("maintenance", error);
        logFailure({
          event: "github_issue_projection.delivery_repair_failed",
          error,
        });
      }
    }
    if (successful) recordAuthoritySuccess("maintenance");
  };

  const runMaintenance = () => {
    if (!canScheduleWork() || maintenanceInFlight) return;
    const task = repairExpired().finally(() => {
      if (maintenanceInFlight === task) maintenanceInFlight = null;
    });
    maintenanceInFlight = task;
  };

  const repairTimer = setInterval(runMaintenance, config.repairMs);
  repairTimer.unref();
  runMaintenance();

  const scheduleCleanupJobs = async () => {
    const bucket = Math.floor(Date.now() / config.lifecycleCleanupMs);
    try {
      await scheduleCleanup({
        actor: config.workerId,
        reason:
          "Platform worker scheduled retention-eligible lifecycle cleanup.",
        idempotencyKey: `worker-lifecycle-cleanup:${bucket}`,
      });
      recordAuthoritySuccess("lifecycleCleanup");
    } catch (error) {
      recordAuthorityFailure("lifecycleCleanup", error);
      logFailure({ event: "lifecycle_cleanup.schedule_failed", error });
    }
  };

  const runLifecycleCleanupScheduler = () => {
    if (!canScheduleWork() || lifecycleCleanupInFlight) return;
    const task = scheduleCleanupJobs().finally(() => {
      if (lifecycleCleanupInFlight === task) lifecycleCleanupInFlight = null;
    });
    lifecycleCleanupInFlight = task;
  };

  const lifecycleCleanupTimer = setInterval(
    runLifecycleCleanupScheduler,
    config.lifecycleCleanupMs,
  );
  lifecycleCleanupTimer.unref();
  runLifecycleCleanupScheduler();

  const runTelemetryRetention = () => {
    if (!canScheduleWork() || telemetryRetentionInFlight) return;
    const task = retainTelemetry()
      .then((result) => {
        recordAuthoritySuccess("telemetryRetention");
        console.log(
          JSON.stringify({
            service: "air-jam-platform-worker",
            event: "product_telemetry.retention_applied",
            rawEventsDeleted: result.rawEventsDeleted,
            sessionContributionsDeleted: result.sessionContributionsDeleted,
            rawCutoff: result.rawCutoff.toISOString(),
            sessionContributionCutoffDate: result.sessionContributionCutoffDate,
          }),
        );
      })
      .catch((error: unknown) => {
        recordAuthorityFailure("telemetryRetention", error);
        logFailure({ event: "product_telemetry.retention_failed", error });
      })
      .finally(() => {
        if (telemetryRetentionInFlight === task)
          telemetryRetentionInFlight = null;
      });
    telemetryRetentionInFlight = task;
  };

  const telemetryRetentionTimer = setInterval(
    runTelemetryRetention,
    config.telemetryRetentionMs,
  );
  telemetryRetentionTimer.unref();
  runTelemetryRetention();

  const deliverNextEvent = () => {
    if (!canScheduleWork() || eventDeliveryInFlight) return;
    const task = deliverEvent({ workerId: config.workerId })
      .then((result) => {
        lastEventDeliveryAt = new Date().toISOString();
        lastEventDeliveryStatus = result.status;
        recordAuthoritySuccess("eventDelivery");
      })
      .catch((error: unknown) => {
        recordAuthorityFailure("eventDelivery", error);
        logFailure({ event: "operational_event.delivery_cycle_failed", error });
      })
      .finally(() => {
        if (eventDeliveryInFlight === task) eventDeliveryInFlight = null;
      });
    eventDeliveryInFlight = task;
  };

  const eventDeliveryTimer = setInterval(
    deliverNextEvent,
    config.eventDeliveryMs,
  );
  eventDeliveryTimer.unref();
  deliverNextEvent();

  const runSyntheticSchedule = () => {
    if (!canScheduleWork() || syntheticInFlight) return;
    const task = runSynthetics({
      actor: config.workerId,
      config: resolveOperationalSyntheticRuntimeConfig(env),
    })
      .then((result) => {
        lastSyntheticAt = new Date().toISOString();
        const failedCheckIds = result.checks
          .filter((check) => check.status === "failed")
          .map((check) => check.checkId);
        const staleIgnoredCheckIds = result.checks
          .filter(
            (check) =>
              check.status === "completed" &&
              check.result.evaluationDisposition === "stale_ignored",
          )
          .map((check) => check.checkId);
        lastSyntheticBatch = {
          scheduledAt: result.scheduledAt,
          dueCount: result.dueCount,
          completedCount: result.completedCount,
          failureCount: result.failureCount,
          staleIgnoredCount: result.staleIgnoredCount,
          skippedCount: result.skippedCount,
          failedCheckIds,
          staleIgnoredCheckIds,
        };
        if (staleIgnoredCheckIds.length > 0) {
          console.warn(
            JSON.stringify({
              service: "air-jam-platform-worker",
              event: "operational_synthetic.evaluation_fenced",
              details: {
                staleIgnoredCount: result.staleIgnoredCount,
                staleIgnoredCheckIds,
              },
            }),
          );
        }
        if (result.failureCount === 0) {
          recordAuthoritySuccess("synthetics");
          return;
        }
        const error = new Error(
          `${result.failureCount} operational synthetic checks failed.`,
        );
        error.name = "OperationalSyntheticBatchFailure";
        recordAuthorityFailure("synthetics", error);
        logFailure({
          event: "operational_synthetic.schedule_degraded",
          error,
          details: {
            failureCount: result.failureCount,
            failedCheckIds,
          },
        });
      })
      .catch((error: unknown) => {
        recordAuthorityFailure("synthetics", error);
        logFailure({ event: "operational_synthetic.schedule_failed", error });
      })
      .finally(() => {
        if (syntheticInFlight === task) syntheticInFlight = null;
      });
    syntheticInFlight = task;
  };

  const syntheticTimer = setInterval(runSyntheticSchedule, config.syntheticMs);
  syntheticTimer.unref();
  runSyntheticSchedule();

  const runIssueProjectionSchedule = () => {
    if (
      !accepting ||
      closed ||
      schemaCompatibility?.compatible !== true ||
      issueProjectionInFlight ||
      !githubIssueConfig.enabled ||
      !githubIssueProjector
    ) {
      return;
    }
    const task = runIssueProjection({
      repository: githubIssueConfig.repository,
      workerId: config.workerId,
      projector: githubIssueProjector,
    })
      .then((result) => {
        lastIssueProjectionAt = new Date().toISOString();
        lastIssueProjectionStatus = result.status;
        if (
          result.status === "retried" ||
          result.status === "dead_lettered" ||
          result.status === "lease_lost"
        ) {
          const projection =
            "projection" in result ? result.projection : undefined;
          const error = new Error(
            `GitHub issue projection ended with ${result.status}.`,
          );
          error.name = "OperationalAlertIssueProjectionFailure";
          recordAuthorityFailure("issueProjection", error);
          logFailure({
            event: "github_issue_projection.delivery_degraded",
            error,
            details: {
              status: result.status,
              alertKey: projection?.alertKey ?? null,
              failureCode: projection
                ? (projection.lastError?.code ?? null)
                : "github_issue_projection.lease_lost",
            },
          });
          return;
        }
        recordAuthoritySuccess("issueProjection");
      })
      .catch((error: unknown) => {
        recordAuthorityFailure("issueProjection", error);
        logFailure({ event: "github_issue_projection.schedule_failed", error });
      })
      .finally(() => {
        if (issueProjectionInFlight === task) issueProjectionInFlight = null;
      });
    issueProjectionInFlight = task;
  };

  const issueProjectionTimer = setInterval(
    runIssueProjectionSchedule,
    config.issueProjectionMs,
  );
  issueProjectionTimer.unref();
  runIssueProjectionSchedule();

  const runBudgetRefreshSchedule = () => {
    const budgetProjectId = config.railwayProjectId;
    if (
      !canScheduleWork() ||
      !config.budgetRefreshEnabled ||
      budgetRefreshInFlight ||
      !budgetProjectId
    ) {
      return;
    }
    const task = refreshBudget({
      actor: config.workerId,
      projectId: budgetProjectId,
      refreshIntervalMs: config.budgetRefreshMs,
    })
      .then((result) => {
        lastBudgetRefreshAt = new Date().toISOString();
        lastBudgetRefreshStatus = result.status;
        lastBudgetRefreshErrorCode = null;
        budgetStatus = result.budget;
        if (
          !isOperationalBudgetRefreshAuthorityFresh({
            budget: result.budget,
            projectId: budgetProjectId,
          })
        ) {
          const error = new Error(
            "Persisted operational budget evidence is stale or missing.",
          );
          error.name = "OperationalBudgetAuthorityUnavailable";
          recordAuthorityFailure("budgetEvidence", error);
          return;
        }
        recordAuthoritySuccess("budgetEvidence");
      })
      .catch(async (error: unknown) => {
        lastBudgetRefreshAt = new Date().toISOString();
        lastBudgetRefreshStatus = "failed";
        lastBudgetRefreshErrorCode =
          error instanceof Error ? error.name : "unknown_worker_error";
        let retainedBudgetStatus: OperationalBudgetStatus | null = null;
        try {
          retainedBudgetStatus = await inspectBudgetEvidence();
          budgetStatus = retainedBudgetStatus;
        } catch (inspectionError) {
          recordAuthorityFailure("budgetEvidence", inspectionError);
          logFailure({
            event: "operational_budget.authority_inspection_failed",
            error: inspectionError,
          });
        }
        if (
          retainedBudgetStatus &&
          isOperationalBudgetRefreshAuthorityFresh({
            budget: retainedBudgetStatus,
            projectId: budgetProjectId,
          })
        ) {
          recordAuthoritySuccess("budgetEvidence");
        } else if (retainedBudgetStatus) {
          recordAuthorityFailure("budgetEvidence", error);
        }
        logFailure({
          event: "operational_budget.refresh_failed",
          error,
          details: {
            retainedEvidenceStatus:
              retainedBudgetStatus?.evidenceStatus ?? "unavailable",
          },
        });
      })
      .finally(() => {
        if (budgetRefreshInFlight === task) budgetRefreshInFlight = null;
      });
    budgetRefreshInFlight = task;
  };

  const budgetRefreshTimer = config.budgetRefreshEnabled
    ? setInterval(runBudgetRefreshSchedule, config.budgetRefreshMs)
    : null;
  budgetRefreshTimer?.unref();
  if (config.budgetRefreshEnabled) runBudgetRefreshSchedule();

  const status = () => {
    const requiredAuthorities = config.budgetRefreshEnabled
      ? [...coreWorkerAuthorityNames, "budgetEvidence" as const]
      : coreWorkerAuthorityNames;
    const authorityReady = requiredAuthorities.every(
      (authority) => authorities[authority].status === "ready",
    );
    const lastAuthoritySuccessAt =
      coreWorkerAuthorityNames
        .map((authority) => authorities[authority].lastSuccessAt)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ?? null;
    const degradedAuthorities = workerAuthorityNames.filter(
      (authority) => authorities[authority].status === "failed",
    );
    return {
      ok: !closed,
      service: "air-jam-platform-worker",
      workerId: config.workerId,
      accepting,
      draining: !accepting && !closed,
      inFlight: inFlight.size,
      maintenanceInFlight: maintenanceInFlight !== null,
      lifecycleCleanupInFlight: lifecycleCleanupInFlight !== null,
      telemetryRetentionInFlight: telemetryRetentionInFlight !== null,
      eventDeliveryInFlight: eventDeliveryInFlight !== null,
      syntheticInFlight: syntheticInFlight !== null,
      issueProjectionInFlight: issueProjectionInFlight !== null,
      budgetRefreshInFlight: budgetRefreshInFlight !== null,
      budgetRefreshConfigured: config.budgetRefreshEnabled,
      budgetAuthorityRequired: config.budgetRefreshEnabled,
      issueProjectionConfigured: githubIssueConfig.enabled,
      maxInFlight: config.maxInFlight,
      schemaCompatibility,
      authorityReady,
      authorities,
      degradedAuthorities,
      lastAuthoritySuccessAt,
      lastCycleAt,
      lastCycleResult,
      lastEventDeliveryAt,
      lastEventDeliveryStatus,
      lastSyntheticAt,
      lastSyntheticBatch,
      lastIssueProjectionAt,
      lastIssueProjectionStatus,
      lastBudgetRefreshAt,
      lastBudgetRefreshStatus,
      lastBudgetRefreshErrorCode,
      budgetStatus,
      lastErrorAt,
      lastErrorCode,
    };
  };

  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (request.method === "GET" && path === "/health") {
      writeJson(response, closed ? 503 : 200, status());
      return;
    }
    if (request.method === "GET" && path === "/ready") {
      const currentStatus = status();
      writeJson(
        response,
        accepting && !closed && currentStatus.authorityReady ? 200 : 503,
        currentStatus,
      );
      return;
    }
    if (
      !isAuthorized({
        authorization: request.headers.authorization,
        token: config.controlToken,
      })
    ) {
      writeJson(response, config.controlToken ? 401 : 404, {
        ok: false,
        error: config.controlToken ? "unauthorized" : "not_found",
      });
      return;
    }
    if (request.method === "GET" && path === "/status") {
      writeJson(response, 200, status());
      return;
    }
    if (request.method === "POST" && path === "/drain") {
      accepting = false;
      writeJson(response, 202, status());
      return;
    }
    writeJson(response, 404, { ok: false, error: "not_found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.log(
    JSON.stringify({
      service: "air-jam-platform-worker",
      event: "worker.started",
      workerId: config.workerId,
      host: config.host,
      port: config.port,
      maxInFlight: config.maxInFlight,
    }),
  );

  const drain = async () => {
    accepting = false;
    clearInterval(scheduler);
    clearInterval(schemaTimer);
    clearInterval(repairTimer);
    clearInterval(lifecycleCleanupTimer);
    clearInterval(telemetryRetentionTimer);
    clearInterval(eventDeliveryTimer);
    clearInterval(syntheticTimer);
    clearInterval(issueProjectionTimer);
    if (budgetRefreshTimer) clearInterval(budgetRefreshTimer);
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.drainTimeoutMs);
      timer.unref();
    });
    await Promise.race([
      Promise.allSettled([
        ...inFlight,
        ...(maintenanceInFlight ? [maintenanceInFlight] : []),
        ...(lifecycleCleanupInFlight ? [lifecycleCleanupInFlight] : []),
        ...(telemetryRetentionInFlight ? [telemetryRetentionInFlight] : []),
        ...(eventDeliveryInFlight ? [eventDeliveryInFlight] : []),
        ...(syntheticInFlight ? [syntheticInFlight] : []),
        ...(issueProjectionInFlight ? [issueProjectionInFlight] : []),
        ...(budgetRefreshInFlight ? [budgetRefreshInFlight] : []),
      ]).then(() => undefined),
      timeout,
    ]);
  };

  const close = async () => {
    if (closed) return;
    await drain();
    closed = true;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };

  return { config, drain, close };
};
