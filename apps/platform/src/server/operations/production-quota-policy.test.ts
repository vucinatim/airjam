import type {
  OperationalBudgetState,
  OperationalLane,
  OperationalLaneControlSnapshot,
  OperationalQuotaKey,
} from "@air-jam/database-contract";
import { describe, expect, it } from "vitest";
import type { OperationalBudgetStatus } from "./production-budget-policy";
import {
  decideOperationalQuotaAdmission,
  OPERATIONAL_QUOTA_POLICIES,
  OperationalQuotaPolicyError,
  type OperationalQuotaUsageSnapshot,
} from "./production-quota-policy";

const budget = (
  state: OperationalBudgetState | null,
  evidenceStatus: OperationalBudgetStatus["evidenceStatus"] = "fresh",
): OperationalBudgetStatus => ({
  contractVersion: 1,
  asOf: "2026-08-29T12:00:00.000Z",
  evidenceStatus,
  cycle: null,
  state,
  projectedState: state,
  lastKnownState: state,
  lastKnownProjectedState: state,
  actualAmountMicrousd: state === null ? null : 1,
  projectedAmountMicrousd: state === null ? null : 1,
  headroomMicrousd: state === null ? null : 1,
  oldestSourceObservedAt: null,
  newestSourceObservedAt: null,
  evidence: [],
});

const control = (
  lane: OperationalLane,
  mode: OperationalLaneControlSnapshot["mode"] = "normal",
): OperationalLaneControlSnapshot => ({
  lane,
  mode,
  reason: null,
  retryAfterSeconds: mode === "paused" ? 60 : null,
  revision: 3,
  updatedBy: "test",
  updatedAt: "2026-08-29T11:00:00.000Z",
});

const usage = ({
  key = "creator_games",
  current = 50,
  available = true,
}: {
  key?: OperationalQuotaKey;
  current?: number;
  available?: boolean;
} = {}): OperationalQuotaUsageSnapshot => {
  const policy = OPERATIONAL_QUOTA_POLICIES[key];
  return {
    key,
    scope: { kind: policy.scopeKind, id: "scope_1" },
    authorityStatus: available ? "available" : "unavailable",
    authorityReason: available ? null : "No durable concurrency authority yet.",
    current: available ? current : null,
    limit: policy.limit,
    remaining: available ? Math.max(policy.limit - current, 0) : null,
    unit: policy.unit,
    window: policy.window,
    observedAt: "2026-08-29T12:00:00.000Z",
    resetAt: null,
  };
};

describe("production quota policy", () => {
  it("keeps legitimate over-limit work shadow-only under normal and warning budgets", () => {
    for (const state of ["normal", "warning"] as const) {
      expect(
        decideOperationalQuotaAdmission({
          lane: "game_creation",
          usage: usage(),
          requestedAmount: 1,
          control: control("game_creation"),
          budget: budget(state),
          budgetRequirement: "required",
          decisionId: `decision-${state}`,
        }),
      ).toMatchObject({
        outcome: "shadow_denied",
        reason: "quota_exceeded",
        projectedUsage: 51,
        byocAvailable: false,
      });
    }
  });

  it("enforces the same allowance in restricted or protection mode", () => {
    const restricted = decideOperationalQuotaAdmission({
      lane: "game_creation",
      usage: usage(),
      requestedAmount: 1,
      control: control("game_creation", "restricted"),
      budget: budget("normal"),
      budgetRequirement: "required",
    });
    const protectedDecision = decideOperationalQuotaAdmission({
      lane: "game_creation",
      usage: usage(),
      requestedAmount: 1,
      control: control("game_creation"),
      budget: budget("protection"),
      budgetRequirement: "required",
    });

    expect(restricted).toMatchObject({
      outcome: "denied",
      reason: "quota_exceeded",
      byocAvailable: true,
    });
    expect(protectedDecision).toMatchObject({
      outcome: "denied",
      reason: "quota_exceeded",
      byocAvailable: true,
    });
  });

  it("applies the budget ladder before a quota boundary", () => {
    expect(
      decideOperationalQuotaAdmission({
        lane: "browser_validation",
        usage: usage({
          key: "creator_browser_validations_30d",
          current: 1,
        }),
        requestedAmount: 1,
        control: control("browser_validation"),
        budget: budget("near_ceiling"),
        budgetRequirement: "required",
      }),
    ).toMatchObject({
      outcome: "denied",
      reason: "budget_protection",
    });
  });

  it("fails closed when lane, budget, or usage authority is unavailable", () => {
    const inputs = [
      {
        control: null,
        budget: budget("normal"),
        usage: usage(),
      },
      {
        control: control("game_creation"),
        budget: budget(null, "missing"),
        usage: usage(),
      },
      {
        control: control("game_creation"),
        budget: budget("normal"),
        usage: usage({ available: false }),
      },
    ];

    for (const input of inputs) {
      expect(
        decideOperationalQuotaAdmission({
          lane: "game_creation",
          requestedAmount: 1,
          budgetRequirement: "required",
          ...input,
        }),
      ).toMatchObject({
        outcome: "denied",
        reason: "control_unavailable",
      });
    }
  });

  it("preserves paused-lane retry guidance", () => {
    expect(
      decideOperationalQuotaAdmission({
        lane: "game_creation",
        usage: usage({ current: 0 }),
        requestedAmount: 1,
        control: control("game_creation", "paused"),
        budget: budget("normal"),
        budgetRequirement: "required",
      }),
    ).toMatchObject({
      outcome: "denied",
      reason: "lane_paused",
      retryAfterSeconds: 60,
    });
  });

  it("rejects caller-policy drift and unsafe requested amounts", () => {
    expect(() =>
      decideOperationalQuotaAdmission({
        lane: "release_submission",
        usage: usage(),
        requestedAmount: 1,
        control: control("release_submission"),
        budget: budget("normal"),
        budgetRequirement: "required",
      }),
    ).toThrow(OperationalQuotaPolicyError);

    expect(() =>
      decideOperationalQuotaAdmission({
        lane: "game_creation",
        usage: { ...usage(), limit: 51 },
        requestedAmount: 1,
        control: control("game_creation"),
        budget: budget("normal"),
        budgetRequirement: "required",
      }),
    ).toThrow(OperationalQuotaPolicyError);

    expect(() =>
      decideOperationalQuotaAdmission({
        lane: "game_creation",
        usage: usage(),
        requestedAmount: -1,
        control: control("game_creation"),
        budget: budget("normal"),
        budgetRequirement: "required",
      }),
    ).toThrow(OperationalQuotaPolicyError);
  });
});
