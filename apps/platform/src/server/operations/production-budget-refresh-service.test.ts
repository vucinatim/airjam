import type { OperationalBudgetStatus } from "./production-budget-service";
import { isOperationalBudgetRefreshAuthorityFresh } from "./production-budget-refresh-service";
import { describe, expect, it } from "vitest";

const status = ({
  evidenceStatus = "fresh",
  scopeId = "project-1",
  observedAt = "2026-09-08T11:00:00.000Z",
}: {
  evidenceStatus?: OperationalBudgetStatus["evidenceStatus"];
  scopeId?: string;
  observedAt?: string;
} = {}): OperationalBudgetStatus =>
  ({
    evidenceStatus,
    asOf: "2026-09-08T12:00:00.000Z",
    evidence: [{ provider: "railway", scopeKind: "project", scopeId, observedAt }],
  }) as OperationalBudgetStatus;

describe("operational budget refresh authority", () => {
  it("requires fresh evidence for the exact Railway project", () => {
    expect(
      isOperationalBudgetRefreshAuthorityFresh({
        budget: status(),
        projectId: "project-1",
      }),
    ).toBe(true);
    expect(
      isOperationalBudgetRefreshAuthorityFresh({
        budget: status({ scopeId: "project-other" }),
        projectId: "project-1",
      }),
    ).toBe(false);
    expect(
      isOperationalBudgetRefreshAuthorityFresh({
        budget: status({ evidenceStatus: "stale" }),
        projectId: "project-1",
      }),
    ).toBe(false);
  });
});
