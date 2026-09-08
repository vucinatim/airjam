import { describe, expect, it } from "vitest";
import {
  runDueOperationalSynthetics,
  runOperationalSynthetic,
} from "./operational-synthetic-scheduler";
import type { OperationalSyntheticRuntimeConfig } from "./operational-synthetic-service";

const config: OperationalSyntheticRuntimeConfig = {
  environment: "test",
  targets: {},
  appId: "app:synthetic-scheduler-test",
};

describe("operational synthetic scheduling", () => {
  it("isolates each due check and reports retained failures without starving the catalog", async () => {
    const visited: string[] = [];
    const database = {
      query: {
        operationalSyntheticRuns: { findFirst: async () => null },
      },
    };
    const result = await runDueOperationalSynthetics({
      database: database as never,
      actor: "agent:test",
      config,
      now: new Date("2026-09-04T12:00:00.000Z"),
      runSynthetic: (async ({ checkId }) => {
        visited.push(checkId);
        if (visited.length === 1) {
          throw new Error("DATABASE_URL=must-not-leak");
        }
        return {
          run: { checkId } as never,
          evaluation: null,
          alert: null,
          transition: null,
          evaluationDisposition:
            visited.length === 2 ? "stale_ignored" : "evaluated",
        };
      }) as typeof runOperationalSynthetic,
    });

    expect(visited).toHaveLength(6);
    expect(result).toMatchObject({
      dueCount: 6,
      completedCount: 5,
      failureCount: 1,
      staleIgnoredCount: 1,
      skippedCount: 0,
    });
    expect(result.checks[0]).toMatchObject({
      status: "failed",
      failure: {
        code: "synthetic.schedule_item_failed",
        details: { checkId: visited[0] },
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("distinguishes not-due checks from lookup failures without inflating due accounting", async () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    let lookupCount = 0;
    const visited: string[] = [];
    const database = {
      query: {
        operationalSyntheticRuns: {
          findFirst: async () => {
            lookupCount += 1;
            if (lookupCount === 1) return { completedAt: now };
            if (lookupCount === 2) throw new Error("lookup unavailable");
            return null;
          },
        },
      },
    };
    const result = await runDueOperationalSynthetics({
      database: database as never,
      actor: "agent:test",
      config,
      now,
      runSynthetic: (async ({ checkId }) => {
        visited.push(checkId);
        return {
          run: { checkId } as never,
          evaluation: null,
          alert: null,
          transition: null,
          evaluationDisposition: "evaluated",
        };
      }) as typeof runOperationalSynthetic,
    });

    expect(visited).toHaveLength(4);
    expect(result).toMatchObject({
      dueCount: 4,
      completedCount: 4,
      failureCount: 1,
      staleIgnoredCount: 0,
      skippedCount: 1,
    });
    expect(result.checks[0]).toMatchObject({ status: "not_due" });
    expect(result.checks[1]).toMatchObject({
      status: "failed",
      failure: { code: "synthetic.schedule_item_failed" },
    });
  });
});
