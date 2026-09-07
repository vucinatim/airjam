import {
  operationalJobContractVersion,
  operationalJobKindValues,
  operationalJobResourceKindValues,
  operationalJobStatusValues,
  operationalLaneModeValues,
  operationalLaneValues,
  operationalQuotaKeyValues,
  type OperationalJobKind,
  type OperationalJobResourceKind,
  type OperationalJobStatus,
  type OperationalLane,
  type OperationalLaneMode,
  type OperationalQuotaKey,
} from "@air-jam/database-contract";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import {
  OPERATIONAL_JOB_CREATOR_GLOBAL_CONCURRENCY,
  OPERATIONAL_JOB_POLICIES,
} from "../src/server/jobs/operational-job-policy";
import {
  getOperationalJob,
  getOperationalJobAuthorityTime,
  isOperationalJobExpired,
  listOperationalJobs,
  planExpiredOperationalJobRepair,
  previewOperationalJobCancellation,
  repairExpiredOperationalJobs,
  replayOperationalJob,
  requestOperationalJobCancellation,
} from "../src/server/jobs/operational-job-service";
import { runOperationalJobWorkerCycle } from "../src/server/jobs/operational-job-worker";
import {
  cleanupReleaseJobOrphanOutputs,
  listReleaseJobOrphanOutputs,
} from "../src/server/jobs/release-job-output-cleanup";
import {
  inspectLifecycleCleanupCandidates,
  scheduleLifecycleCleanup,
} from "../src/server/operations/lifecycle-cleanup-service";
import {
  findOperationalBudgetEvidenceReplay,
  getOperationalBudgetStatus,
  previewOperationalBudgetEvidence,
  recordOperationalBudgetEvidence,
} from "../src/server/operations/production-budget-service";
import {
  getOperationalLaneControl,
  listOperationalLaneControls,
  PRODUCTION_CONTROL_CONTRACT_VERSION,
  setOperationalLaneControl,
} from "../src/server/operations/production-control-service";
import {
  OPERATIONAL_QUOTA_POLICIES,
  PRODUCTION_QUOTA_CONTRACT_VERSION,
} from "../src/server/operations/production-quota-policy";
import {
  decideOperationalQuotaAdmissionWithDatabase,
  listOperationalQuotaUsage,
} from "../src/server/operations/production-quota-service";

type ProductionControlCliInput =
  | { command: "status"; json: boolean }
  | { command: "budget-status"; json: boolean }
  | {
      command: "jobs-policy";
      kind?: OperationalJobKind;
      json: boolean;
    }
  | {
      command: "jobs-status";
      kind?: OperationalJobKind;
      json: boolean;
    }
  | {
      command: "jobs-list";
      kind?: OperationalJobKind;
      statuses?: OperationalJobStatus[];
      creatorId?: string;
      releaseId?: string;
      resourceKind?: OperationalJobResourceKind;
      resourceId?: string;
      limit: number;
      json: boolean;
    }
  | { command: "jobs-inspect"; jobId: string; json: boolean }
  | {
      command: "jobs-cancel";
      jobId: string;
      expectedRevision: number;
      actor: string;
      reason: string;
      idempotencyKey: string;
      apply: boolean;
      json: boolean;
    }
  | {
      command: "jobs-replay";
      jobId: string;
      actor: string;
      reason: string;
      idempotencyKey: string;
      apply: boolean;
      json: boolean;
    }
  | {
      command: "jobs-repair-expired";
      kind: OperationalJobKind;
      actor: string;
      reason: string;
      idempotencyKey: string;
      limit: number;
      apply: boolean;
      json: boolean;
    }
  | {
      command: "jobs-cleanup-orphans";
      actor: string;
      reason: string;
      limit: number;
      apply: boolean;
      json: boolean;
    }
  | {
      command: "jobs-worker-once";
      kind: OperationalJobKind;
      workerId: string;
      apply: boolean;
      json: boolean;
    }
  | {
      command: "lifecycle-cleanup";
      actor: string;
      reason: string;
      idempotencyKey: string;
      limit: number;
      apply: boolean;
      json: boolean;
    }
  | {
      command: "quota-status";
      creatorId: string;
      gameId?: string;
      json: boolean;
    }
  | {
      command: "quota-check";
      key: OperationalQuotaKey;
      lane: OperationalLane;
      creatorId: string;
      gameId?: string;
      requestedAmount: number;
      json: boolean;
    }
  | {
      command: "budget-replay";
      provider: string;
      scopeKind: string;
      scopeId: string;
      reason: string;
      actor: string;
      idempotencyKey: string;
      json: true;
    }
  | {
      command: "budget-sync";
      evidence: unknown;
      reason: string;
      actor: string;
      idempotencyKey: string;
      apply: boolean;
      json: boolean;
    }
  | {
      command: "lane-set";
      lane: OperationalLane;
      mode: OperationalLaneMode;
      reason: string;
      retryAfterSeconds: number | null;
      expectedRevision: number;
      actor: string;
      idempotencyKey: string;
      apply: boolean;
      json: boolean;
    };

type OperationalJobInspection = Awaited<ReturnType<typeof getOperationalJob>>;
type OperationalJobReplayInput = Extract<
  ProductionControlCliInput,
  { command: "jobs-replay" }
>;

const verifyOperationalJobReplayLineage = ({
  original,
  persisted,
  input,
  expectedReplayJobId,
}: {
  original: OperationalJobInspection["job"];
  persisted: OperationalJobInspection;
  input: OperationalJobReplayInput;
  expectedReplayJobId: string;
}) => {
  const replayEvent = persisted.events.find(
    (event) => event.kind === "replayed",
  );
  const checks = [
    {
      id: "job.replay-target",
      passed:
        persisted.job.id === expectedReplayJobId &&
        persisted.job.id !== original.id &&
        persisted.job.replayOfJobId === original.id,
      expected: {
        replayJobId: expectedReplayJobId,
        replayOfJobId: original.id,
      },
      observed: {
        replayJobId: persisted.job.id,
        replayOfJobId: persisted.job.replayOfJobId,
      },
    },
    {
      id: "job.replay-scope",
      passed:
        persisted.job.kind === original.kind &&
        persisted.job.creatorId === original.creatorId &&
        persisted.job.gameId === original.gameId &&
        persisted.job.releaseId === original.releaseId &&
        persisted.job.generationId === original.generationId &&
        persisted.job.resourceKind === original.resourceKind &&
        persisted.job.resourceId === original.resourceId &&
        persisted.job.correlationId === original.correlationId,
      expected: {
        kind: original.kind,
        creatorId: original.creatorId,
        gameId: original.gameId,
        releaseId: original.releaseId,
        generationId: original.generationId,
        resourceKind: original.resourceKind,
        resourceId: original.resourceId,
        correlationId: original.correlationId,
      },
      observed: {
        kind: persisted.job.kind,
        creatorId: persisted.job.creatorId,
        gameId: persisted.job.gameId,
        releaseId: persisted.job.releaseId,
        generationId: persisted.job.generationId,
        resourceKind: persisted.job.resourceKind,
        resourceId: persisted.job.resourceId,
        correlationId: persisted.job.correlationId,
      },
    },
    {
      id: "job.replay-audit-event",
      passed:
        replayEvent?.actor === input.actor &&
        replayEvent.reason === input.reason &&
        replayEvent.correlationId === original.correlationId &&
        replayEvent.detailKeys.includes("replayOfJobId"),
      expected: {
        actor: input.actor,
        reason: input.reason,
        correlationId: original.correlationId,
        detailKey: "replayOfJobId",
      },
      observed: replayEvent
        ? {
            actor: replayEvent.actor,
            reason: replayEvent.reason,
            correlationId: replayEvent.correlationId,
            detailKeys: replayEvent.detailKeys,
          }
        : null,
    },
  ];
  return { passed: checks.every((check) => check.passed), checks };
};

const fail = (message: string): never => {
  throw new Error(message);
};

const readRequiredText = (
  input: Record<string, unknown>,
  key: string,
): string => {
  const value = typeof input[key] === "string" ? input[key].trim() : "";
  return value || fail(`${key} is required.`);
};

const readInteger = (
  input: Record<string, unknown>,
  key: string,
  minimum: number,
): number => {
  const value = Number(input[key]);
  if (!Number.isInteger(value) || value < minimum) {
    fail(`${key} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
};

const readIntegerInRange = (
  input: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number => {
  const value = readInteger(input, key, minimum);
  if (value > maximum) {
    fail(`${key} must be less than or equal to ${maximum}.`);
  }
  return value;
};

const readOptionalText = (
  input: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = typeof input[key] === "string" ? input[key].trim() : "";
  return value || undefined;
};

const readOptionalJobKind = (
  input: Record<string, unknown>,
): OperationalJobKind | undefined => {
  const kind = readOptionalText(input, "kind");
  if (!kind) return undefined;
  if (!operationalJobKindValues.includes(kind as OperationalJobKind)) {
    fail(`kind must be one of: ${operationalJobKindValues.join(", ")}.`);
  }
  return kind as OperationalJobKind;
};

const readRequiredJobKind = (
  input: Record<string, unknown>,
): OperationalJobKind =>
  readOptionalJobKind(input) ?? fail("kind is required.");

const readOptionalJobResourceKind = (
  input: Record<string, unknown>,
): OperationalJobResourceKind | undefined => {
  const resourceKind = readOptionalText(input, "resourceKind");
  if (!resourceKind) return undefined;
  if (
    !operationalJobResourceKindValues.includes(
      resourceKind as OperationalJobResourceKind,
    )
  ) {
    fail(
      `resourceKind must be one of: ${operationalJobResourceKindValues.join(", ")}.`,
    );
  }
  return resourceKind as OperationalJobResourceKind;
};

const readOptionalJobStatuses = (
  input: Record<string, unknown>,
): OperationalJobStatus[] | undefined => {
  if (input.statuses === undefined) return undefined;
  const rawStatuses = Array.isArray(input.statuses)
    ? input.statuses
    : [input.statuses];
  const statuses = rawStatuses.map((value) =>
    typeof value === "string" ? value.trim() : "",
  );
  if (
    statuses.length === 0 ||
    statuses.some(
      (status) =>
        !operationalJobStatusValues.includes(status as OperationalJobStatus),
    )
  ) {
    fail(
      `statuses must contain only: ${operationalJobStatusValues.join(", ")}.`,
    );
  }
  return [...new Set(statuses)] as OperationalJobStatus[];
};

const parseInput = (raw: string | undefined): ProductionControlCliInput => {
  const serializedInput = raw ?? fail("Missing production-control operation.");
  let value: unknown;
  try {
    value = JSON.parse(serializedInput);
  } catch {
    fail("Production-control operation is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Production-control operation must be an object.");
  }

  const input = value as Record<string, unknown>;
  const json = input.json === true;
  if (input.command === "status") return { command: "status", json };
  if (input.command === "budget-status") {
    return { command: "budget-status", json };
  }
  if (input.command === "jobs-policy") {
    return { command: "jobs-policy", kind: readOptionalJobKind(input), json };
  }
  if (input.command === "jobs-status") {
    return { command: "jobs-status", kind: readOptionalJobKind(input), json };
  }
  if (input.command === "jobs-list") {
    return {
      command: "jobs-list",
      kind: readOptionalJobKind(input),
      statuses: readOptionalJobStatuses(input),
      creatorId: readOptionalText(input, "creatorId"),
      releaseId: readOptionalText(input, "releaseId"),
      resourceKind: readOptionalJobResourceKind(input),
      resourceId: readOptionalText(input, "resourceId"),
      limit:
        input.limit === undefined
          ? 100
          : readIntegerInRange(input, "limit", 1, 500),
      json,
    };
  }
  if (input.command === "jobs-inspect") {
    return {
      command: "jobs-inspect",
      jobId: readRequiredText(input, "jobId"),
      json,
    };
  }
  if (input.command === "jobs-cancel") {
    return {
      command: "jobs-cancel",
      jobId: readRequiredText(input, "jobId"),
      expectedRevision: readInteger(input, "expectedRevision", 0),
      actor: readRequiredText(input, "actor"),
      reason: readRequiredText(input, "reason"),
      idempotencyKey: readRequiredText(input, "idempotencyKey"),
      apply: input.apply === true,
      json,
    };
  }
  if (input.command === "jobs-replay") {
    return {
      command: "jobs-replay",
      jobId: readRequiredText(input, "jobId"),
      actor: readRequiredText(input, "actor"),
      reason: readRequiredText(input, "reason"),
      idempotencyKey: readRequiredText(input, "idempotencyKey"),
      apply: input.apply === true,
      json,
    };
  }
  if (input.command === "jobs-repair-expired") {
    return {
      command: "jobs-repair-expired",
      kind: readRequiredJobKind(input),
      actor: readRequiredText(input, "actor"),
      reason: readRequiredText(input, "reason"),
      idempotencyKey: readRequiredText(input, "idempotencyKey"),
      limit:
        input.limit === undefined
          ? 100
          : readIntegerInRange(input, "limit", 1, 500),
      apply: input.apply === true,
      json,
    };
  }
  if (input.command === "jobs-cleanup-orphans") {
    return {
      command: "jobs-cleanup-orphans",
      actor: readRequiredText(input, "actor"),
      reason: readRequiredText(input, "reason"),
      limit:
        input.limit === undefined
          ? 100
          : readIntegerInRange(input, "limit", 1, 500),
      apply: input.apply === true,
      json,
    };
  }
  if (input.command === "jobs-worker-once") {
    return {
      command: "jobs-worker-once",
      kind: readRequiredJobKind(input),
      workerId: readRequiredText(input, "workerId"),
      apply: input.apply === true,
      json,
    };
  }
  if (input.command === "lifecycle-cleanup") {
    return {
      command: "lifecycle-cleanup",
      actor: readRequiredText(input, "actor"),
      reason: readRequiredText(input, "reason"),
      idempotencyKey: readRequiredText(input, "idempotencyKey"),
      limit:
        input.limit === undefined
          ? 100
          : readIntegerInRange(input, "limit", 1, 500),
      apply: input.apply === true,
      json,
    };
  }
  if (input.command === "quota-status") {
    return {
      command: "quota-status",
      creatorId: readRequiredText(input, "creatorId"),
      gameId:
        typeof input.gameId === "string" && input.gameId.trim()
          ? input.gameId.trim()
          : undefined,
      json,
    };
  }
  if (input.command === "quota-check") {
    const key = readRequiredText(input, "key");
    if (!operationalQuotaKeyValues.includes(key as OperationalQuotaKey)) {
      fail(`key must be one of: ${operationalQuotaKeyValues.join(", ")}.`);
    }
    const lane = readRequiredText(input, "lane");
    if (!operationalLaneValues.includes(lane as OperationalLane)) {
      fail(`lane must be one of: ${operationalLaneValues.join(", ")}.`);
    }
    return {
      command: "quota-check",
      key: key as OperationalQuotaKey,
      lane: lane as OperationalLane,
      creatorId: readRequiredText(input, "creatorId"),
      gameId:
        typeof input.gameId === "string" && input.gameId.trim()
          ? input.gameId.trim()
          : undefined,
      requestedAmount: readInteger(input, "requestedAmount", 0),
      json,
    };
  }
  if (input.command === "budget-replay") {
    return {
      command: "budget-replay",
      provider: readRequiredText(input, "provider"),
      scopeKind: readRequiredText(input, "scopeKind"),
      scopeId: readRequiredText(input, "scopeId"),
      reason: readRequiredText(input, "reason"),
      actor: readRequiredText(input, "actor"),
      idempotencyKey: readRequiredText(input, "idempotencyKey"),
      json: true,
    };
  }
  if (input.command === "budget-sync") {
    return {
      command: "budget-sync",
      evidence: input.evidence,
      reason: readRequiredText(input, "reason"),
      actor: readRequiredText(input, "actor"),
      idempotencyKey: readRequiredText(input, "idempotencyKey"),
      apply: input.apply === true,
      json,
    };
  }
  if (input.command !== "lane-set") {
    return fail("Unknown production-control command.");
  }

  const lane = readRequiredText(input, "lane");
  if (!operationalLaneValues.includes(lane as OperationalLane)) {
    fail(`lane must be one of: ${operationalLaneValues.join(", ")}.`);
  }
  const mode = readRequiredText(input, "mode");
  if (!operationalLaneModeValues.includes(mode as OperationalLaneMode)) {
    fail(`mode must be one of: ${operationalLaneModeValues.join(", ")}.`);
  }

  const retryAfterSeconds =
    input.retryAfterSeconds === null || input.retryAfterSeconds === undefined
      ? null
      : readInteger(input, "retryAfterSeconds", 1);

  return {
    command: "lane-set",
    lane: lane as OperationalLane,
    mode: mode as OperationalLaneMode,
    reason: readRequiredText(input, "reason"),
    retryAfterSeconds,
    expectedRevision: readInteger(input, "expectedRevision", 0),
    actor: readRequiredText(input, "actor"),
    idempotencyKey: readRequiredText(input, "idempotencyKey"),
    apply: input.apply === true,
    json,
  };
};

const selectOperationalJobPolicies = (kind?: OperationalJobKind) =>
  kind
    ? [OPERATIONAL_JOB_POLICIES[kind]]
    : operationalJobKindValues.map(
        (policyKind) => OPERATIONAL_JOB_POLICIES[policyKind],
      );

const printJson = (
  command: string,
  applied: boolean,
  result: unknown,
): void => {
  console.log(
    JSON.stringify(
      {
        contractVersion: PRODUCTION_CONTROL_CONTRACT_VERSION,
        command,
        applied,
        result,
      },
      null,
      2,
    ),
  );
};

const main = async (): Promise<void> => {
  const input = parseInput(process.argv[2]);

  if (input.command === "jobs-policy") {
    const result = {
      jobContractVersion: operationalJobContractVersion,
      creatorGlobalConcurrency: OPERATIONAL_JOB_CREATOR_GLOBAL_CONCURRENCY,
      policies: selectOperationalJobPolicies(input.kind),
    };
    if (input.json) printJson(input.command, false, result);
    else {
      for (const policy of result.policies) {
        console.log(
          `${policy.kind}: concurrency ${policy.globalConcurrency}, creator ${policy.perCreatorConcurrency}, queue ${policy.queueDepth}, attempts ${policy.maxAttempts}`,
        );
      }
    }
    return;
  }

  const databaseUrl =
    process.env.DATABASE_URL?.trim() ||
    fail(
      "DATABASE_URL is required. Set it directly or select a Railway environment through the repo CLI.",
    );
  const client = postgres(databaseUrl, { max: 1 });
  const database = drizzle(client, { schema });

  try {
    if (input.command === "status") {
      const result = {
        lanes: await listOperationalLaneControls({ database }),
        budget: await getOperationalBudgetStatus({ database }),
      };
      if (input.json) printJson(input.command, false, result);
      else {
        for (const lane of result.lanes) {
          console.log(
            `${lane.lane}: ${lane.mode} (revision ${lane.revision})${lane.reason ? ` — ${lane.reason}` : ""}`,
          );
        }
      }
      return;
    }

    if (input.command === "budget-status") {
      const result = { budget: await getOperationalBudgetStatus({ database }) };
      if (input.json) printJson(input.command, false, result);
      else {
        const { budget } = result;
        console.log(
          budget.state
            ? `Budget: ${budget.state} at $${(
                (budget.actualAmountMicrousd ?? 0) / 1_000_000
              ).toFixed(2)} (${budget.evidenceStatus} evidence).`
            : `Budget: unavailable (${budget.evidenceStatus} evidence).`,
        );
      }
      return;
    }

    if (input.command === "jobs-status") {
      const observedAt = await getOperationalJobAuthorityTime({ database });
      const kinds = input.kind ? [input.kind] : [...operationalJobKindValues];
      const queues = await Promise.all(
        kinds.map(async (kind) => {
          const jobs = await listOperationalJobs({
            database,
            kind,
            statuses: ["queued", "running", "cancel_requested"],
            limit: 500,
          });
          const counts = {
            queued: jobs.filter((job) => job.status === "queued").length,
            running: jobs.filter((job) => job.status === "running").length,
            cancelRequested: jobs.filter(
              (job) => job.status === "cancel_requested",
            ).length,
            expired: jobs.filter((job) =>
              isOperationalJobExpired(job, observedAt),
            ).length,
          };
          return {
            kind,
            policy: OPERATIONAL_JOB_POLICIES[kind],
            counts,
            oldestQueuedAt:
              jobs
                .filter((job) => job.status === "queued")
                .sort((left, right) =>
                  left.createdAt.localeCompare(right.createdAt),
                )[0]?.createdAt ?? null,
          };
        }),
      );
      const result = {
        jobContractVersion: operationalJobContractVersion,
        creatorGlobalConcurrency: OPERATIONAL_JOB_CREATOR_GLOBAL_CONCURRENCY,
        observedAt: observedAt.toISOString(),
        queues,
      };
      if (input.json) printJson(input.command, false, result);
      else {
        for (const queue of queues) {
          console.log(
            `${queue.kind}: ${queue.counts.queued} queued, ${queue.counts.running} running, ${queue.counts.cancelRequested} cancel requested, ${queue.counts.expired} expired`,
          );
        }
      }
      return;
    }

    if (input.command === "jobs-list") {
      const jobs = await listOperationalJobs({
        database,
        kind: input.kind,
        statuses: input.statuses,
        creatorId: input.creatorId,
        releaseId: input.releaseId,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        limit: input.limit,
      });
      const result = {
        jobContractVersion: operationalJobContractVersion,
        filters: {
          kind: input.kind ?? null,
          statuses: input.statuses ?? [],
          creatorId: input.creatorId ?? null,
          releaseId: input.releaseId ?? null,
          limit: input.limit,
        },
        jobs,
      };
      if (input.json) printJson(input.command, false, result);
      else {
        for (const job of jobs) {
          console.log(
            `${job.id}: ${job.kind} ${job.status}@${job.revision} release ${job.releaseId}`,
          );
        }
      }
      return;
    }

    if (input.command === "jobs-inspect") {
      const inspection = await getOperationalJob({
        database,
        jobId: input.jobId,
      });
      const result = {
        jobContractVersion: operationalJobContractVersion,
        ...inspection,
      };
      if (input.json) printJson(input.command, false, result);
      else {
        console.log(
          `${inspection.job.id}: ${inspection.job.kind} ${inspection.job.status}@${inspection.job.revision}`,
        );
        console.log(`${inspection.events.length} persisted lifecycle events.`);
      }
      return;
    }

    if (input.command === "jobs-cancel") {
      if (!input.apply) {
        const preview = await previewOperationalJobCancellation({
          database,
          jobId: input.jobId,
          expectedRevision: input.expectedRevision,
          actor: input.actor,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        });
        const result = {
          jobContractVersion: operationalJobContractVersion,
          ...preview,
        };
        if (input.json) printJson(input.command, false, result);
        else {
          console.log(
            result.eligible && result.current
              ? `${result.wouldReplay ? "Would replay" : "Would request"} cancellation of ${result.current.id}: ${result.current.status}@${result.current.revision} -> ${result.nextStatus}.`
              : `Cancellation is not eligible: ${result.rejectionReason}`,
          );
          console.log(
            result.eligible && !result.wouldReplay
              ? "Pass --apply to persist the request."
              : result.wouldReplay
                ? "Pass --apply to return the immutable prior command result."
                : "Apply would reject this new cancellation request.",
          );
        }
        return;
      }
      const cancellation = await requestOperationalJobCancellation({
        database,
        jobId: input.jobId,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
        reason: input.reason,
      });
      if (input.json)
        printJson(input.command, true, {
          jobContractVersion: operationalJobContractVersion,
          ...cancellation,
        });
      else
        console.log(
          `Cancellation state for ${cancellation.job.id}: ${cancellation.job.status}@${cancellation.job.revision}${cancellation.replayed ? " (replayed command)" : ""}.`,
        );
      return;
    }

    if (input.command === "jobs-replay") {
      const original = (
        await getOperationalJob({
          database,
          jobId: input.jobId,
        })
      ).job;
      if (!input.apply) {
        const result = {
          jobContractVersion: operationalJobContractVersion,
          original,
          eligible: ["failed", "canceled"].includes(original.status),
          requested: {
            actor: input.actor,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
          },
        };
        if (input.json) printJson(input.command, false, result);
        else {
          console.log(
            `Would replay ${original.id} (${original.status}) with idempotency key ${input.idempotencyKey}.`,
          );
          console.log("Pass --apply to enqueue the replay.");
        }
        return;
      }
      let replayJobId: string | null = null;
      try {
        const replay = await replayOperationalJob({
          database,
          jobId: input.jobId,
          idempotencyKey: input.idempotencyKey,
          actor: input.actor,
          reason: input.reason,
        });
        replayJobId = replay.job.id;
        const persisted = await getOperationalJob({
          database,
          jobId: replay.job.id,
        });
        const verification = verifyOperationalJobReplayLineage({
          original,
          persisted,
          input,
          expectedReplayJobId: replay.job.id,
        });
        if (!verification.passed) {
          throw new Error(
            "Persisted replay lineage did not match the exact requested job.",
          );
        }
        const result = {
          jobContractVersion: operationalJobContractVersion,
          status: "verified",
          verifiedAt: new Date().toISOString(),
          ...replay,
          persisted: persisted.job,
          verification,
        };
        if (input.json) printJson(input.command, true, result);
        else
          console.log(
            `${replay.replayed ? "Reused" : "Enqueued"} and independently verified replay job ${replay.job.id}.`,
          );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Operational job replay verification failed.";
        const result = {
          jobContractVersion: operationalJobContractVersion,
          status: "failed",
          error: { message },
          escalationBundle: {
            kind: "operational_job_replay_failed",
            originalJobId: input.jobId,
            replayJobId,
            actor: input.actor,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
            nextActions: [
              "Inspect the original and replay jobs through platform operations jobs inspect.",
              "Preserve the exact idempotency key and do not enqueue a broader replay.",
              "Repair the underlying job or worker condition before retrying the same logical replay.",
            ],
          },
        };
        if (input.json) printJson(input.command, replayJobId !== null, result);
        else console.error(message);
        process.exitCode = 1;
      }
      return;
    }

    if (input.command === "jobs-repair-expired") {
      const observedAt = await getOperationalJobAuthorityTime({ database });
      const active = await listOperationalJobs({
        database,
        kind: input.kind,
        statuses: ["queued", "running", "cancel_requested"],
        limit: 500,
      });
      const candidates = active
        .filter((job) => isOperationalJobExpired(job, observedAt))
        .sort(
          (left, right) =>
            left.deadlineAt.localeCompare(right.deadlineAt) ||
            left.createdAt.localeCompare(right.createdAt),
        )
        .slice(0, input.limit)
        .map((job) => planExpiredOperationalJobRepair(job, observedAt))
        .filter((plan) => plan !== null)
        .map((plan) => ({
          ...plan,
          retryAt: plan.retryAt?.toISOString() ?? null,
        }));
      if (!input.apply) {
        const result = {
          jobContractVersion: operationalJobContractVersion,
          observedAt: observedAt.toISOString(),
          actor: input.actor,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          kind: input.kind,
          limit: input.limit,
          candidates,
        };
        if (input.json) printJson(input.command, false, result);
        else {
          console.log(
            `Would repair ${candidates.length} expired ${input.kind} jobs.`,
          );
          console.log("Pass --apply to persist the repair.");
        }
        return;
      }
      const repair = await repairExpiredOperationalJobs({
        database,
        kind: input.kind,
        actor: input.actor,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        limit: input.limit,
      });
      const result = {
        jobContractVersion: operationalJobContractVersion,
        observedAt: observedAt.toISOString(),
        actor: input.actor,
        reason: input.reason,
        ...repair,
      };
      if (input.json) printJson(input.command, true, result);
      else
        console.log(
          `${repair.replayed ? "Replayed" : "Repaired"} ${repair.jobs.length} expired jobs.`,
        );
      return;
    }

    if (input.command === "jobs-cleanup-orphans") {
      const redactCandidates = (
        candidates: Awaited<ReturnType<typeof listReleaseJobOrphanOutputs>>,
      ) =>
        candidates.map(({ outputRootKey: _outputRootKey, ...candidate }) => ({
          ...candidate,
          privateData: { hasOutputRoot: true },
        }));
      if (!input.apply) {
        const candidates = await listReleaseJobOrphanOutputs({
          database,
          limit: input.limit,
        });
        const result = {
          jobContractVersion: operationalJobContractVersion,
          actor: input.actor,
          reason: input.reason,
          limit: input.limit,
          candidates: redactCandidates(candidates),
        };
        if (input.json) printJson(input.command, false, result);
        else {
          console.log(
            `Would delete attempt-scoped output for ${candidates.length} terminal jobs.`,
          );
          console.log("Pass --apply to remove the orphan outputs.");
        }
        return;
      }
      const cleanup = await cleanupReleaseJobOrphanOutputs({
        database,
        actor: input.actor,
        reason: input.reason,
        limit: input.limit,
      });
      const result = {
        jobContractVersion: operationalJobContractVersion,
        candidates: redactCandidates(cleanup.candidates),
        cleaned: cleanup.cleaned,
      };
      if (input.json) printJson(input.command, true, result);
      else console.log(`Cleaned ${cleanup.cleaned.length} orphan outputs.`);
      return;
    }

    if (input.command === "lifecycle-cleanup") {
      const redactCandidate = <
        Candidate extends {
          storageRootKey: string;
          objects?: Array<{ key: string }>;
        },
      >({
        storageRootKey: _storageRootKey,
        objects,
        ...candidate
      }: Candidate) => ({
        ...candidate,
        privateData: {
          hasStorageRootKey: true,
          hasObjectKeys: Boolean(objects?.length),
        },
      });
      if (!input.apply) {
        const inspection = await inspectLifecycleCleanupCandidates({
          database,
          limit: input.limit,
        });
        const result = {
          lifecycleCleanupContractVersion: 1,
          actor: input.actor,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          limit: input.limit,
          observedAt: inspection.observedAt,
          retentionTransitions: inspection.retentionTransitions,
          candidates: inspection.candidates.map(redactCandidate),
        };
        if (input.json) printJson(input.command, false, result);
        else {
          const bytes = inspection.candidates.reduce(
            (total, candidate) => total + candidate.bytes,
            0,
          );
          console.log(
            `Would schedule ${inspection.candidates.length} lifecycle cleanup jobs covering ${bytes} bytes.`,
          );
          if (inspection.retentionTransitions.length > 0) {
            console.log(
              `Would persist ${inspection.retentionTransitions.length} superseded-release retention transitions.`,
            );
          }
          console.log("Pass --apply to enqueue durable cleanup jobs.");
        }
        return;
      }
      const scheduled = await scheduleLifecycleCleanup({
        database,
        actor: input.actor,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        limit: input.limit,
      });
      const result = {
        lifecycleCleanupContractVersion: 1,
        retentionTransitions: scheduled.retentionTransitions,
        candidates: scheduled.candidates.map(redactCandidate),
        jobs: scheduled.jobs,
        replayed: scheduled.replayed,
      };
      if (input.json) printJson(input.command, true, result);
      else
        console.log(
          `Scheduled ${scheduled.jobs.length} durable lifecycle cleanup jobs.`,
        );
      return;
    }

    if (input.command === "jobs-worker-once") {
      if (!input.apply) {
        const queued = await listOperationalJobs({
          database,
          kind: input.kind,
          statuses: ["queued"],
          limit: 1,
        });
        const result = {
          jobContractVersion: operationalJobContractVersion,
          kind: input.kind,
          workerId: input.workerId,
          queuedCandidate: queued[0] ?? null,
          note: "Claim authority is decided transactionally only during apply.",
        };
        if (input.json) printJson(input.command, false, result);
        else {
          console.log(
            queued[0]
              ? `Would let ${input.workerId} claim at most one ${input.kind} job.`
              : `No queued ${input.kind} job is currently visible.`,
          );
          console.log("Pass --apply to run one worker cycle.");
        }
        return;
      }
      const cycle = await runOperationalJobWorkerCycle({
        database,
        kind: input.kind,
        workerId: input.workerId,
      });
      const result = {
        jobContractVersion: operationalJobContractVersion,
        cycle,
      };
      if (input.json) printJson(input.command, true, result);
      else console.log(`${input.kind} worker cycle finished: ${cycle.status}.`);
      return;
    }

    if (input.command === "quota-status") {
      const [budget, quotas] = await Promise.all([
        getOperationalBudgetStatus({ database }),
        listOperationalQuotaUsage({
          database,
          creatorId: input.creatorId,
          gameId: input.gameId,
        }),
      ]);
      const result = {
        quotaContractVersion: PRODUCTION_QUOTA_CONTRACT_VERSION,
        policies: OPERATIONAL_QUOTA_POLICIES,
        budget,
        quotas,
      };
      if (input.json) printJson(input.command, false, result);
      else {
        console.log(
          `Quota authority for creator ${input.creatorId}${input.gameId ? ` and game ${input.gameId}` : ""}:`,
        );
        for (const quota of quotas) {
          console.log(
            quota.current === null
              ? `${quota.key}: unavailable — ${quota.authorityReason}`
              : `${quota.key}: ${quota.current}/${quota.limit} ${quota.unit}`,
          );
        }
      }
      return;
    }

    if (input.command === "quota-check") {
      const decision = await decideOperationalQuotaAdmissionWithDatabase({
        database,
        key: input.key,
        lane: input.lane,
        creatorId: input.creatorId,
        gameId: input.gameId,
        requestedAmount: input.requestedAmount,
      });
      if (input.json) printJson(input.command, false, { decision });
      else {
        console.log(
          `${decision.outcome}: ${decision.quotaKey} would move from ${decision.usage.current ?? "unavailable"} to ${decision.projectedUsage ?? "unavailable"} ${decision.usage.unit}${decision.reason ? ` (${decision.reason})` : ""}.`,
        );
      }
      return;
    }

    if (input.command === "budget-replay") {
      const evidence = await findOperationalBudgetEvidenceReplay({
        database,
        input,
      });
      const budget = evidence
        ? await getOperationalBudgetStatus({ database })
        : null;
      printJson(evidence ? "budget-sync" : input.command, evidence !== null, {
        evidence,
        budget,
        replayed: evidence !== null,
      });
      return;
    }

    if (input.command === "budget-sync") {
      const operationInput = {
        evidence: input.evidence,
        actor: input.actor,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      };
      if (!input.apply) {
        const result = await previewOperationalBudgetEvidence({
          database,
          input: operationInput,
        });
        if (input.json) printJson(input.command, false, result);
        else {
          console.log(
            `Would record provider budget evidence and derive ${result.status.state ?? "unavailable"} state.`,
          );
          console.log("Pass --apply to persist this immutable evidence item.");
        }
        return;
      }

      const evidence = await recordOperationalBudgetEvidence({
        database,
        input: operationInput,
      });
      const budget = await getOperationalBudgetStatus({ database });
      const result = { evidence, budget, replayed: false };
      if (input.json) printJson(input.command, true, result);
      else {
        console.log(
          `Recorded ${evidence.provider} budget evidence at $${(
            evidence.actualAmountMicrousd / 1_000_000
          ).toFixed(2)}; derived ${budget.state ?? "unavailable"} state.`,
        );
      }
      return;
    }

    const current = await getOperationalLaneControl({
      database,
      lane: input.lane,
    });
    if (!input.apply) {
      const result = {
        current,
        requested: {
          lane: input.lane,
          mode: input.mode,
          reason: input.reason,
          retryAfterSeconds: input.retryAfterSeconds,
          expectedRevision: input.expectedRevision,
          actor: input.actor,
          idempotencyKey: input.idempotencyKey,
        },
        revisionMatches: current.revision === input.expectedRevision,
      };
      if (input.json) printJson(input.command, false, result);
      else {
        console.log(
          `Would set ${input.lane} from ${current.mode}@${current.revision} to ${input.mode}.`,
        );
        console.log(
          result.revisionMatches
            ? "Expected revision matches. Pass --apply to persist the change."
            : `Expected revision does not match current revision ${current.revision}; apply would fail.`,
        );
      }
      return;
    }

    const control = await setOperationalLaneControl({
      database,
      input: {
        lane: input.lane,
        mode: input.mode,
        reason: input.reason,
        retryAfterSeconds: input.retryAfterSeconds,
        expectedRevision: input.expectedRevision,
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (input.json) printJson(input.command, true, { control });
    else {
      console.log(
        `Set ${control.lane} to ${control.mode} at revision ${control.revision}.`,
      );
    }
  } finally {
    await client.end();
  }
};

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Production-control operation failed.",
  );
  process.exitCode = 1;
});
