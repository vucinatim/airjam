import { db as platformDb } from "@/db";
import {
  operationalBudgetCycles,
  operationalBudgetEvidence,
} from "@/db/schema";
import type {
  OperationalBudgetCycleSnapshot,
  OperationalBudgetEvidenceSnapshot,
} from "@air-jam/database-contract";
import { describe, expect, it } from "vitest";
import {
  buildOperationalBudgetStatus,
  findOperationalBudgetEvidenceReplay,
  OPERATIONAL_BUDGET_POLICIES,
  OperationalBudgetConflictError,
  previewOperationalBudgetEvidence,
  recordOperationalBudgetEvidence,
  resolveOperationalBudgetProfile,
  resolveOperationalBudgetState,
} from "./production-budget-service";

type Database = typeof platformDb;
type CycleRow = typeof operationalBudgetCycles.$inferSelect;
type EvidenceRow = typeof operationalBudgetEvidence.$inferSelect;

const periodStart = new Date("2026-08-03T00:00:00.000Z");
const periodEnd = new Date("2026-09-03T00:00:00.000Z");

const makeProviderEvidence = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  contractVersion: 1,
  provider: "railway",
  scope: {
    kind: "project",
    id: "railway-project-1",
    name: "air-jam",
    workspaceId: "workspace-1",
  },
  billingPeriod: {
    start: periodStart.toISOString(),
    end: periodEnd.toISOString(),
  },
  observedAt: "2026-08-29T12:00:00.000Z",
  currency: "USD",
  actualAmountMicrousd: 7_182_550,
  projectedAmountMicrousd: 8_400_000,
  measurements: { actual: [{ measurement: "CPU_USAGE", value: 1 }] },
  costBreakdownMicrousd: { actual: { CPU_USAGE: 463 } },
  rateCard: { id: "railway-public-pricing@2026-08-29" },
  sourceVersion: "railway-graphql-v2-usage@2026-08-29",
  ...overrides,
});

const makeCycleSnapshot = (
  overrides: Partial<OperationalBudgetCycleSnapshot> = {},
): OperationalBudgetCycleSnapshot => ({
  id: `air-jam-budget:${periodStart.toISOString()}:${periodEnd.toISOString()}`,
  periodStart: periodStart.toISOString(),
  periodEnd: periodEnd.toISOString(),
  ...OPERATIONAL_BUDGET_POLICIES.ordinary,
  createdAt: "2026-08-29T12:00:00.000Z",
  ...overrides,
});

const makeEvidenceSnapshot = (
  overrides: Partial<OperationalBudgetEvidenceSnapshot> = {},
): OperationalBudgetEvidenceSnapshot => ({
  id: "evidence-1",
  idempotencyKey: "budget-sync-1",
  cycleId: makeCycleSnapshot().id,
  contractVersion: 1,
  provider: "railway",
  scopeKind: "project",
  scopeId: "railway-project-1",
  scopeName: "air-jam",
  scopeMetadata: { workspaceId: "workspace-1" },
  currency: "USD",
  observedAt: "2026-08-29T12:00:00.000Z",
  actualAmountMicrousd: 7_182_550,
  projectedAmountMicrousd: 8_400_000,
  measurements: { actual: [{ measurement: "CPU_USAGE", value: 1 }] },
  costBreakdownMicrousd: { actual: { CPU_USAGE: 463 } },
  rateCard: { id: "railway-public-pricing@2026-08-29" },
  sourceVersion: "railway-graphql-v2-usage@2026-08-29",
  collectedBy: "agent:g3-budget",
  reason: "Refresh provider spend evidence",
  createdAt: "2026-08-29T12:00:01.000Z",
  ...overrides,
});

const createFakeDatabase = () => {
  let cycle: CycleRow | null = null;
  let evidence: EvidenceRow | null = null;
  let cycleInsertCount = 0;
  let evidenceInsertCount = 0;

  const query = {
    operationalBudgetCycles: {
      findFirst: async () => cycle ?? undefined,
    },
    operationalBudgetEvidence: {
      findFirst: async () => evidence ?? undefined,
      findMany: async () => (evidence ? [evidence] : []),
    },
  };
  const transactionDatabase = {
    query,
    insert: (table: unknown) => ({
      values: (values: CycleRow | EvidenceRow) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table === operationalBudgetCycles) {
              if (cycle) return [];
              cycle = values as CycleRow;
              cycleInsertCount += 1;
              return [cycle];
            }
            if (table === operationalBudgetEvidence) {
              if (evidence) return [];
              evidence = values as EvidenceRow;
              evidenceInsertCount += 1;
              return [evidence];
            }
            throw new Error("Unexpected insert table.");
          },
        }),
      }),
    }),
  };
  const database = {
    query,
    transaction: async <T>(
      callback: (tx: typeof transactionDatabase) => Promise<T>,
    ) => callback(transactionDatabase),
  } as unknown as Database;

  return {
    database,
    getCycleInsertCount: () => cycleInsertCount,
    getEvidenceInsertCount: () => evidenceInsertCount,
  };
};

describe("production budget service", () => {
  it("keeps launch elevation code-reviewed and derives every threshold state", () => {
    const cycle = makeCycleSnapshot();

    expect(resolveOperationalBudgetProfile(periodStart)).toBe("ordinary");
    expect(
      [0, 49_999_999, 50_000_000, 75_000_000, 90_000_000, 100_000_000].map(
        (amountMicrousd) =>
          resolveOperationalBudgetState({ amountMicrousd, cycle }),
      ),
    ).toEqual([
      "normal",
      "normal",
      "warning",
      "protection",
      "near_ceiling",
      "ceiling",
    ]);
  });

  it("uses only the newest evidence per provider scope and reports forecast state", () => {
    const cycle = makeCycleSnapshot();
    const status = buildOperationalBudgetStatus({
      cycle,
      asOf: new Date("2026-08-29T14:00:00.000Z"),
      evidence: [
        makeEvidenceSnapshot({
          id: "old",
          actualAmountMicrousd: 80_000_000,
          projectedAmountMicrousd: 100_000_000,
          observedAt: "2026-08-29T10:00:00.000Z",
        }),
        makeEvidenceSnapshot({
          id: "new",
          actualAmountMicrousd: 7_000_000,
          projectedAmountMicrousd: 55_000_000,
          observedAt: "2026-08-29T13:00:00.000Z",
        }),
        makeEvidenceSnapshot({
          id: "storage",
          provider: "r2",
          scopeKind: "bucket",
          scopeId: "bucket-1",
          actualAmountMicrousd: 1_000_000,
          projectedAmountMicrousd: 2_000_000,
          observedAt: "2026-08-29T12:30:00.000Z",
        }),
      ],
    });

    expect(status).toMatchObject({
      evidenceStatus: "fresh",
      state: "normal",
      projectedState: "warning",
      actualAmountMicrousd: 8_000_000,
      projectedAmountMicrousd: 57_000_000,
      headroomMicrousd: 92_000_000,
    });
    expect(status.evidence.map((entry) => entry.id).sort()).toEqual([
      "new",
      "storage",
    ]);
  });

  it("marks old provider evidence stale and rejects a caller-supplied state", async () => {
    const status = buildOperationalBudgetStatus({
      cycle: makeCycleSnapshot(),
      evidence: [makeEvidenceSnapshot()],
      asOf: new Date("2026-08-29T19:00:00.001Z"),
    });
    expect(status.evidenceStatus).toBe("stale");
    expect(status.state).toBeNull();
    expect(status.lastKnownState).toBe("normal");

    const fake = createFakeDatabase();
    await expect(
      previewOperationalBudgetEvidence({
        database: fake.database,
        input: {
          evidence: makeProviderEvidence({ state: "normal" }),
          actor: "agent:g3-budget",
          reason: "Refresh provider spend evidence",
          idempotencyKey: "budget-sync-state-injection",
        },
      }),
    ).rejects.toThrow(/unsupported fields: state/u);
  });

  it("translates only contract validation failures and retains their cause", () => {
    let caught: unknown;
    try {
      buildOperationalBudgetStatus({
        cycle: makeCycleSnapshot(),
        evidence: [makeEvidenceSnapshot()],
        asOf: new Date(Number.NaN),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OperationalBudgetConflictError);
    expect((caught as Error & { cause?: unknown }).cause).toMatchObject({
      name: "OperationalAdmissionPolicyError",
      message: "Budget status time must be valid.",
    });
  });

  it("previews without writes, then records and replays one immutable evidence item", async () => {
    const fake = createFakeDatabase();
    const input = {
      evidence: makeProviderEvidence(),
      actor: "agent:g3-budget",
      reason: "Refresh provider spend evidence",
      idempotencyKey: "budget-sync-1",
    };

    const preview = await previewOperationalBudgetEvidence({
      database: fake.database,
      input,
      now: new Date("2026-08-29T12:00:01.000Z"),
    });
    expect(preview).toMatchObject({
      wouldCreateCycle: true,
      wouldRecordEvidence: true,
      replayed: false,
      status: {
        evidenceStatus: "fresh",
        state: "normal",
        projectedState: "normal",
      },
    });
    expect(fake.getCycleInsertCount()).toBe(0);
    expect(fake.getEvidenceInsertCount()).toBe(0);

    const first = await recordOperationalBudgetEvidence({
      database: fake.database,
      input,
      now: new Date("2026-08-29T12:00:01.000Z"),
      evidenceId: "evidence-1",
    });
    const replay = await recordOperationalBudgetEvidence({
      database: fake.database,
      input,
      now: new Date("2026-08-29T12:30:00.000Z"),
      evidenceId: "evidence-2",
    });

    expect(replay).toEqual(first);
    expect(fake.getCycleInsertCount()).toBe(1);
    expect(fake.getEvidenceInsertCount()).toBe(1);

    await expect(
      findOperationalBudgetEvidenceReplay({
        database: fake.database,
        input: {
          provider: "railway",
          scopeKind: "project",
          scopeId: "railway-project-1",
          actor: input.actor,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        },
      }),
    ).resolves.toEqual(first);
    await expect(
      findOperationalBudgetEvidenceReplay({
        database: fake.database,
        input: {
          provider: "railway",
          scopeKind: "project",
          scopeId: "railway-project-1",
          actor: "agent:different",
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        },
      }),
    ).rejects.toBeInstanceOf(OperationalBudgetConflictError);
  });

  it("rejects conflicting idempotency reuse and malformed monetary evidence", async () => {
    const fake = createFakeDatabase();
    const input = {
      evidence: makeProviderEvidence(),
      actor: "agent:g3-budget",
      reason: "Refresh provider spend evidence",
      idempotencyKey: "budget-sync-1",
    };
    await recordOperationalBudgetEvidence({
      database: fake.database,
      input,
      now: new Date("2026-08-29T12:00:01.000Z"),
    });

    await expect(
      recordOperationalBudgetEvidence({
        database: fake.database,
        input: {
          ...input,
          evidence: makeProviderEvidence({
            actualAmountMicrousd: 7_182_551,
          }),
        },
      }),
    ).rejects.toBeInstanceOf(OperationalBudgetConflictError);

    await expect(
      previewOperationalBudgetEvidence({
        database: fake.database,
        input: {
          ...input,
          idempotencyKey: "budget-sync-overlap",
          evidence: makeProviderEvidence({
            billingPeriod: {
              start: "2026-08-04T00:00:00.000Z",
              end: "2026-09-04T00:00:00.000Z",
            },
          }),
        },
        now: new Date("2026-08-29T12:00:01.000Z"),
      }),
    ).rejects.toThrow(/does not match the reviewed source policy/u);

    await expect(
      previewOperationalBudgetEvidence({
        database: createFakeDatabase().database,
        input: {
          ...input,
          idempotencyKey: "budget-sync-invalid",
          evidence: makeProviderEvidence({ actualAmountMicrousd: 7.5 }),
        },
      }),
    ).rejects.toThrow(/non-negative safe integer/u);

    await expect(
      previewOperationalBudgetEvidence({
        database: createFakeDatabase().database,
        input: {
          ...input,
          idempotencyKey: "budget-sync-version",
          evidence: makeProviderEvidence({ contractVersion: 2 }),
        },
      }),
    ).rejects.toThrow(/contractVersion must be 1/u);

    await expect(
      previewOperationalBudgetEvidence({
        database: createFakeDatabase().database,
        input: {
          ...input,
          idempotencyKey: "budget-sync-future",
          evidence: makeProviderEvidence({
            observedAt: "2026-08-29T12:10:00.001Z",
          }),
        },
        now: new Date("2026-08-29T12:00:00.000Z"),
      }),
    ).rejects.toThrow(/too far in the future/u);
  });
});
