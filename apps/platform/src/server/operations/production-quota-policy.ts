import {
  decideOperationalAdmissionPolicy,
  REALTIME_ADMISSION_POLICY,
  type OperationalBudgetState,
  type OperationalLane,
  type OperationalLaneControlSnapshot,
  type OperationalQuotaKey,
  type OperationalQuotaPolicySnapshot,
  type OperationalQuotaScopeKind,
  type OperationalQuotaUnit,
  type OperationalQuotaWindow,
} from "@air-jam/database-contract";
import type { OperationalBudgetRequirement } from "@air-jam/operations-contract";
import type { OperationalBudgetStatus } from "./production-budget-policy";

export const PRODUCTION_QUOTA_CONTRACT_VERSION = 1 as const;

const MEBIBYTE = 1_048_576;
const GIBIBYTE = 1_073_741_824;

const quotaPolicy = <const T extends OperationalQuotaPolicySnapshot>(
  policy: T,
): Readonly<T> => Object.freeze(policy);

export const OPERATIONAL_QUOTA_POLICIES = Object.freeze({
  creator_games: quotaPolicy({
    key: "creator_games",
    scopeKind: "creator",
    lanes: ["game_creation"],
    unit: "count",
    window: "lifetime",
    limit: 50,
  }),
  creator_listed_games: quotaPolicy({
    key: "creator_listed_games",
    scopeKind: "creator",
    lanes: ["game_listing"],
    unit: "count",
    window: "lifetime",
    limit: 20,
  }),
  creator_managed_storage_bytes: quotaPolicy({
    key: "creator_managed_storage_bytes",
    scopeKind: "creator",
    lanes: ["artifact_ingestion", "media_ingestion"],
    unit: "bytes",
    window: "lifetime",
    limit: 2 * GIBIBYTE,
  }),
  game_managed_storage_bytes: quotaPolicy({
    key: "game_managed_storage_bytes",
    scopeKind: "game",
    lanes: ["artifact_ingestion", "media_ingestion"],
    unit: "bytes",
    window: "lifetime",
    limit: 500 * MEBIBYTE,
  }),
  creator_release_submissions_30d: quotaPolicy({
    key: "creator_release_submissions_30d",
    scopeKind: "creator",
    lanes: ["release_submission"],
    unit: "count",
    window: "rolling_30_days",
    limit: 200,
  }),
  creator_release_submissions_day: quotaPolicy({
    key: "creator_release_submissions_day",
    scopeKind: "creator",
    lanes: ["release_submission"],
    unit: "count",
    window: "utc_day",
    limit: 50,
  }),
  creator_browser_validations_30d: quotaPolicy({
    key: "creator_browser_validations_30d",
    scopeKind: "creator",
    lanes: ["browser_validation"],
    unit: "count",
    window: "rolling_30_days",
    limit: 100,
  }),
  creator_browser_validations_day: quotaPolicy({
    key: "creator_browser_validations_day",
    scopeKind: "creator",
    lanes: ["browser_validation"],
    unit: "count",
    window: "utc_day",
    limit: 20,
  }),
  creator_concurrent_release_jobs: quotaPolicy({
    key: "creator_concurrent_release_jobs",
    scopeKind: "creator",
    lanes: ["release_processing"],
    unit: "count",
    window: "concurrent",
    limit: 2,
  }),
  creator_room_seconds_30d: quotaPolicy({
    key: "creator_room_seconds_30d",
    scopeKind: "creator",
    lanes: ["realtime_room_admission"],
    unit: "seconds",
    window: "rolling_30_days",
    limit: 1_000 * 60 * 60,
  }),
  creator_concurrent_rooms: quotaPolicy({
    key: "creator_concurrent_rooms",
    scopeKind: "creator",
    lanes: ["realtime_room_admission"],
    unit: "count",
    window: "concurrent",
    limit: REALTIME_ADMISSION_POLICY.creatorRooms,
  }),
  game_concurrent_rooms: quotaPolicy({
    key: "game_concurrent_rooms",
    scopeKind: "game",
    lanes: ["realtime_room_admission"],
    unit: "count",
    window: "concurrent",
    limit: REALTIME_ADMISSION_POLICY.gameRooms,
  }),
} satisfies Readonly<
  Record<OperationalQuotaKey, OperationalQuotaPolicySnapshot>
>);

export type OperationalQuotaAuthorityStatus = "available" | "unavailable";

export type OperationalQuotaUsageSnapshot = {
  key: OperationalQuotaKey;
  scope: { kind: OperationalQuotaScopeKind; id: string };
  authorityStatus: OperationalQuotaAuthorityStatus;
  authorityReason: string | null;
  current: number | null;
  limit: number;
  remaining: number | null;
  unit: OperationalQuotaUnit;
  window: OperationalQuotaWindow;
  observedAt: string;
  resetAt: string | null;
};

export type OperationalQuotaAdmissionDecision = {
  contractVersion: typeof PRODUCTION_QUOTA_CONTRACT_VERSION;
  decisionId: string;
  lane: OperationalLane;
  quotaKey: OperationalQuotaKey;
  scope: { kind: OperationalQuotaScopeKind; id: string };
  controlStatus: "available" | "unavailable";
  controlRevision: number | null;
  mode: OperationalLaneControlSnapshot["mode"] | null;
  budgetStatus: OperationalBudgetStatus["evidenceStatus"];
  budgetState: OperationalBudgetState | null;
  outcome: "allowed" | "shadow_denied" | "denied";
  reason:
    | "lane_paused"
    | "budget_protection"
    | "quota_exceeded"
    | "control_unavailable"
    | null;
  usage: OperationalQuotaUsageSnapshot;
  requestedAmount: number;
  projectedUsage: number | null;
  retryAfterSeconds: number | null;
  byocAvailable: boolean;
};

export class OperationalQuotaPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationalQuotaPolicyError";
  }
}

export const decideOperationalQuotaAdmission = ({
  lane,
  usage,
  requestedAmount,
  control,
  budget,
  budgetRequirement,
  decisionId = crypto.randomUUID(),
}: {
  lane: OperationalLane;
  usage: OperationalQuotaUsageSnapshot;
  requestedAmount: number;
  control: OperationalLaneControlSnapshot | null;
  budget: OperationalBudgetStatus;
  budgetRequirement: OperationalBudgetRequirement;
  decisionId?: string;
}): OperationalQuotaAdmissionDecision => {
  if (!Number.isSafeInteger(requestedAmount) || requestedAmount < 0) {
    throw new OperationalQuotaPolicyError(
      "Requested quota amount must be a non-negative safe integer.",
    );
  }
  const policy: OperationalQuotaPolicySnapshot =
    OPERATIONAL_QUOTA_POLICIES[usage.key];
  if (!policy.lanes.includes(lane)) {
    throw new OperationalQuotaPolicyError(
      `Quota ${usage.key} does not apply to lane ${lane}.`,
    );
  }
  if (
    usage.scope.kind !== policy.scopeKind ||
    usage.limit !== policy.limit ||
    usage.unit !== policy.unit ||
    usage.window !== policy.window
  ) {
    throw new OperationalQuotaPolicyError(
      `Quota usage for ${usage.key} does not match the canonical policy.`,
    );
  }

  let policyDecision;
  try {
    policyDecision = decideOperationalAdmissionPolicy({
      lane,
      control,
      budget,
      budgetRequirement,
      quota: {
        authorityAvailable: usage.authorityStatus === "available",
        current: usage.current,
        limit: usage.limit,
        requestedAmount,
      },
    });
  } catch (error) {
    throw new OperationalQuotaPolicyError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const base = {
    contractVersion: PRODUCTION_QUOTA_CONTRACT_VERSION,
    decisionId,
    lane,
    quotaKey: usage.key,
    scope: usage.scope,
    controlStatus: control ? ("available" as const) : ("unavailable" as const),
    controlRevision: control?.revision ?? null,
    mode: control?.mode ?? null,
    budgetStatus: budget.evidenceStatus,
    budgetState: budget.state,
    usage,
    requestedAmount,
    projectedUsage: policyDecision.projectedUsage,
  };
  return {
    ...base,
    outcome: policyDecision.outcome,
    reason: policyDecision.reason,
    retryAfterSeconds: policyDecision.retryAfterSeconds,
    byocAvailable: policyDecision.outcome === "denied",
  };
};
