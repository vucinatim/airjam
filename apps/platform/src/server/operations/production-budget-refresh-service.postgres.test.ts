import * as schema from "@/db/schema";
import {
  operationalBudgetCycles,
  operationalBudgetEvidence,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runOperationalBudgetRefreshCycle } from "./production-budget-refresh-service";
import type { RailwayBudgetEvidenceCollector } from "./railway-budget-evidence-adapter";

const databaseUrl = process.env.AIR_JAM_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("operational budget refresh PostgreSQL authority", () => {
  const client = postgres(databaseUrl!, { max: 1 });
  const database = drizzle(client, { schema });
  const offset = Number.parseInt(crypto.randomUUID().slice(0, 8), 16);
  const periodStart = new Date(Date.UTC(2041, 0, 1) + offset);
  const periodEnd = new Date(periodStart.getTime() + 31 * 24 * 60 * 60 * 1_000);
  const authorityNow = new Date(periodStart.getTime() + 24 * 60 * 60 * 1_000);
  const projectId = `project-budget-refresh-${crypto.randomUUID()}`;
  const cycleId = `air-jam-budget:${periodStart.toISOString()}:${periodEnd.toISOString()}`;

  afterAll(async () => {
    await database
      .delete(operationalBudgetEvidence)
      .where(eq(operationalBudgetEvidence.cycleId, cycleId));
    await database
      .delete(operationalBudgetCycles)
      .where(eq(operationalBudgetCycles.id, cycleId));
    await client.end();
  });

  it("collects outside the lock and persists one result across overlapping workers", async () => {
    let providerCalls = 0;
    let providerCallsInFlight = 0;
    let maximumProviderCallsInFlight = 0;
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const collector: RailwayBudgetEvidenceCollector = {
      collect: async ({ observedAt }) => {
        providerCalls += 1;
        providerCallsInFlight += 1;
        maximumProviderCallsInFlight = Math.max(
          maximumProviderCallsInFlight,
          providerCallsInFlight,
        );
        try {
          await providerGate;
          return {
            contractVersion: 1,
            provider: "railway",
            scope: {
              kind: "project",
              id: projectId,
              name: "air-jam",
              workspaceId: "workspace-test",
              workspaceName: "Air Jam",
              environmentId: "environment-test",
            },
            billingPeriod: {
              start: periodStart.toISOString(),
              end: periodEnd.toISOString(),
            },
            observedAt: observedAt.toISOString(),
            currency: "USD",
            actualAmountMicrousd: 1_000_000,
            projectedAmountMicrousd: 2_000_000,
            measurements: { actual: [], projected: [] },
            costBreakdownMicrousd: { actual: {}, projected: {} },
            rateCard: {
              id: "railway-public-pricing@2026-08-29",
              currency: "USD",
              minutesInMonth: 43_200,
              memoryGbMonthUsd: 10,
              cpuVcpuMonthUsd: 20,
              networkEgressGbUsd: 0.05,
              volumeGbMonthUsd: 0.15,
              backupGbMonthUsd: 0.15,
            },
            sourceVersion: "test-provider@1",
          };
        } finally {
          providerCallsInFlight -= 1;
        }
      },
    };
    const input = {
      database,
      collector,
      actor: "worker:budget-postgres",
      projectId,
      refreshIntervalMs: 900_000,
      testNow: authorityNow,
    };

    const resultsPromise = Promise.all([
      runOperationalBudgetRefreshCycle(input),
      runOperationalBudgetRefreshCycle(input),
    ]);
    let overlapFailure: unknown;
    try {
      await vi.waitFor(() => expect(providerCalls).toBe(2), {
        interval: 5,
        timeout: 1_000,
      });
      expect(providerCallsInFlight).toBe(2);
      expect(maximumProviderCallsInFlight).toBe(2);
    } catch (error) {
      overlapFailure = error;
    } finally {
      releaseProvider();
    }

    const results = await resultsPromise;
    if (overlapFailure) throw overlapFailure;
    expect(results.map((result) => result.status).sort()).toEqual([
      "not_due",
      "recorded",
    ]);
    expect(providerCalls).toBe(2);
    expect(providerCallsInFlight).toBe(0);
    expect(maximumProviderCallsInFlight).toBe(2);
    const stored = await database.query.operationalBudgetEvidence.findMany({
      where: (table, { eq }) => eq(table.scopeId, projectId),
    });
    expect(stored).toHaveLength(1);

    const afterFreshEvidence = await runOperationalBudgetRefreshCycle(input);
    expect(afterFreshEvidence.status).toBe("not_due");
    expect(providerCalls).toBe(2);
  });
});
