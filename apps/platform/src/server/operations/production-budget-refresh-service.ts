import { db } from "@/db";
import {
  operationalBudgetCycles,
  operationalBudgetEvidence,
} from "@/db/schema";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { resolveDatabaseAuthorityNow } from "./database-authority";
import {
  findOperationalBudgetEvidenceReplay,
  getOperationalBudgetStatus,
  previewOperationalBudgetEvidence,
  PRODUCTION_BUDGET_EVIDENCE_MAX_AGE_MS,
  recordOperationalBudgetEvidence,
  type OperationalBudgetEvidencePreview,
  type OperationalBudgetStatus,
} from "./production-budget-service";
import type { RailwayBudgetEvidenceCollector } from "./railway-budget-evidence-adapter";

export const OPERATIONAL_BUDGET_REFRESH_INTERVAL_MS = 15 * 60 * 1_000;

type BudgetRefreshDatabase = Pick<typeof db, "transaction">;
type BudgetRefreshTransaction = Parameters<
  Parameters<(typeof db)["transaction"]>[0]
>[0];

const readOperationalBudgetRefreshDueState = async ({
  tx,
  projectId,
  refreshIntervalMs,
  testNow,
}: {
  tx: BudgetRefreshTransaction;
  projectId: string;
  refreshIntervalMs: number;
  testNow?: Date;
}) => {
  const authorityNow = await resolveDatabaseAuthorityNow(tx, testNow);
  const latest = await tx.query.operationalBudgetEvidence.findFirst({
    where: and(
      eq(operationalBudgetEvidence.provider, "railway"),
      eq(operationalBudgetEvidence.scopeKind, "project"),
      eq(operationalBudgetEvidence.scopeId, projectId),
    ),
    orderBy: [desc(operationalBudgetEvidence.observedAt)],
  });
  const currentCycle = await tx.query.operationalBudgetCycles.findFirst({
    where: and(
      lte(operationalBudgetCycles.periodStart, authorityNow),
      gt(operationalBudgetCycles.periodEnd, authorityNow),
    ),
    orderBy: [desc(operationalBudgetCycles.periodStart)],
  });
  const due = !(
    latest &&
    currentCycle?.id === latest.cycleId &&
    authorityNow.getTime() - latest.observedAt.getTime() < refreshIntervalMs
  );
  return { authorityNow, due };
};

export const isOperationalBudgetRefreshAuthorityFresh = ({
  budget,
  projectId,
}: {
  budget: OperationalBudgetStatus;
  projectId: string;
}): boolean => {
  if (budget.evidenceStatus !== "fresh") return false;
  const asOf = Date.parse(budget.asOf);
  const latestObservedAt = budget.evidence
    .filter(
      (evidence) =>
        evidence.provider === "railway" &&
        evidence.scopeKind === "project" &&
        evidence.scopeId === projectId,
    )
    .map((evidence) => Date.parse(evidence.observedAt))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  return (
    Number.isFinite(asOf) &&
    latestObservedAt !== undefined &&
    asOf - latestObservedAt <= PRODUCTION_BUDGET_EVIDENCE_MAX_AGE_MS
  );
};

const assertExactRailwayProjectEvidence = (
  evidence: Awaited<ReturnType<RailwayBudgetEvidenceCollector["collect"]>>,
  projectId: string,
) => {
  if (
    evidence.provider !== "railway" ||
    evidence.scope.kind !== "project" ||
    evidence.scope.id !== projectId
  ) {
    throw new Error(
      "Railway budget evidence did not match the configured project scope.",
    );
  }
};

export type OperationalBudgetRefreshResult =
  | {
      status: "recorded";
      observedAt: string;
      budget: OperationalBudgetStatus;
    }
  | {
      status: "not_due";
      observedAt: string;
      budget: OperationalBudgetStatus;
    };

export const inspectOperationalBudgetRefreshAuthority = async ({
  database = db,
  testNow,
}: {
  database?: BudgetRefreshDatabase;
  testNow?: Date;
} = {}): Promise<OperationalBudgetStatus> =>
  database.transaction(async (tx) => {
    const authorityNow = await resolveDatabaseAuthorityNow(tx, testNow);
    return getOperationalBudgetStatus({ database: tx, asOf: authorityNow });
  });

export const runOperationalBudgetRefreshCycle = async ({
  database = db,
  collector,
  actor,
  projectId,
  refreshIntervalMs = OPERATIONAL_BUDGET_REFRESH_INTERVAL_MS,
  testNow,
}: {
  database?: BudgetRefreshDatabase;
  collector: RailwayBudgetEvidenceCollector;
  actor: string;
  projectId: string;
  refreshIntervalMs?: number;
  testNow?: Date;
}): Promise<OperationalBudgetRefreshResult> => {
  const exactProjectId = projectId.trim();
  if (!exactProjectId)
    throw new Error("Budget refresh project id is required.");
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs <= 0) {
    throw new Error("Budget refresh interval must be a positive integer.");
  }

  const initial = await database.transaction(async (tx) => {
    const dueState = await readOperationalBudgetRefreshDueState({
      tx,
      projectId: exactProjectId,
      refreshIntervalMs,
      testNow,
    });
    if (dueState.due) {
      return { ...dueState, due: true as const };
    }
    return {
      ...dueState,
      due: false as const,
      budget: await getOperationalBudgetStatus({
        database: tx,
        asOf: dueState.authorityNow,
      }),
    };
  });
  if (!initial.due) {
    return {
      status: "not_due",
      observedAt: initial.authorityNow.toISOString(),
      budget: initial.budget,
    };
  }

  const evidence = await collector.collect({
    observedAt: initial.authorityNow,
  });
  assertExactRailwayProjectEvidence(evidence, exactProjectId);

  return database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`airjam:budget-refresh:railway:project:${exactProjectId}`}))`,
    );
    const commit = await readOperationalBudgetRefreshDueState({
      tx,
      projectId: exactProjectId,
      refreshIntervalMs,
      testNow,
    });
    if (!commit.due) {
      return {
        status: "not_due",
        observedAt: commit.authorityNow.toISOString(),
        budget: await getOperationalBudgetStatus({
          database: tx,
          asOf: commit.authorityNow,
        }),
      };
    }

    await recordOperationalBudgetEvidence({
      database: tx,
      input: {
        evidence,
        actor,
        reason:
          "Platform operational worker refreshed Railway budget evidence.",
        idempotencyKey: `worker-budget-refresh:${exactProjectId}:${evidence.observedAt}`,
      },
      now: commit.authorityNow,
    });
    return {
      status: "recorded",
      observedAt: evidence.observedAt,
      budget: await getOperationalBudgetStatus({
        database: tx,
        asOf: commit.authorityNow,
      }),
    };
  });
};

export type ManualOperationalBudgetSyncResult =
  | {
      mode: "preview";
      replayed: false;
      preview: OperationalBudgetEvidencePreview;
    }
  | {
      mode: "applied";
      replayed: boolean;
      evidence: Awaited<ReturnType<typeof recordOperationalBudgetEvidence>>;
      budget: OperationalBudgetStatus;
    };

export const syncRailwayOperationalBudgetEvidence = async ({
  database = db,
  collector,
  projectId,
  actor,
  reason,
  idempotencyKey,
  apply,
  now = new Date(),
}: {
  database?: typeof db;
  collector: RailwayBudgetEvidenceCollector;
  projectId: string;
  actor: string;
  reason: string;
  idempotencyKey: string;
  apply: boolean;
  now?: Date;
}): Promise<ManualOperationalBudgetSyncResult> => {
  const exactProjectId = projectId.trim();
  const replay = await findOperationalBudgetEvidenceReplay({
    database,
    input: {
      provider: "railway",
      scopeKind: "project",
      scopeId: exactProjectId,
      actor,
      reason,
      idempotencyKey,
    },
  });
  if (replay) {
    return {
      mode: "applied",
      replayed: true,
      evidence: replay,
      budget: await getOperationalBudgetStatus({ database, asOf: now }),
    };
  }

  const evidence = await collector.collect({ observedAt: now });
  assertExactRailwayProjectEvidence(evidence, exactProjectId);
  const input = { evidence, actor, reason, idempotencyKey };
  if (!apply) {
    return {
      mode: "preview",
      replayed: false,
      preview: await previewOperationalBudgetEvidence({
        database,
        input,
        now,
      }),
    };
  }
  const recorded = await recordOperationalBudgetEvidence({
    database,
    input,
    now,
  });
  return {
    mode: "applied",
    replayed: false,
    evidence: recorded,
    budget: await getOperationalBudgetStatus({ database, asOf: now }),
  };
};
