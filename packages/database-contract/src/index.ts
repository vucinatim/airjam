import {
  DEFAULT_OPERATIONAL_ALERT_ISSUE_MAX_ATTEMPTS,
  DEFAULT_OPERATIONAL_EVENT_DELIVERY_MAX_ATTEMPTS,
  type OperationalAlertV1,
  type OperationalEventEnvelopeV1,
  type OperationalFailureV1,
  type OperationalSloEvaluationV1,
  type OperationalSyntheticRunV1,
} from "@air-jam/operations-contract";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export const operationalLaneValues = [
  "game_creation",
  "game_listing",
  "release_submission",
  "artifact_ingestion",
  "release_processing",
  "browser_validation",
  "moderation",
  "media_ingestion",
  "product_telemetry",
  "realtime_room_admission",
  "realtime_controller_admission",
  "preview_capacity",
  "lifecycle_cleanup",
] as const;

export type OperationalLane = (typeof operationalLaneValues)[number];

export const operationalLaneModeValues = [
  "normal",
  "restricted",
  "paused",
] as const;

export type OperationalLaneMode = (typeof operationalLaneModeValues)[number];

const operationalLaneSqlList = sql.raw(
  operationalLaneValues.map((lane) => `'${lane}'`).join(", "),
);
const operationalLaneModeSqlList = sql.raw(
  operationalLaneModeValues.map((mode) => `'${mode}'`).join(", "),
);

export type OperationalLaneControlSnapshot = {
  lane: OperationalLane;
  mode: OperationalLaneMode;
  reason: string | null;
  retryAfterSeconds: number | null;
  revision: number;
  updatedBy: string | null;
  updatedAt: string | null;
};

export const operationalBudgetProfileValues = [
  "ordinary",
  "launch_1_0",
] as const;

export type OperationalBudgetProfile =
  (typeof operationalBudgetProfileValues)[number];

export const operationalBudgetStateValues = [
  "normal",
  "warning",
  "protection",
  "near_ceiling",
  "ceiling",
] as const;

export type OperationalBudgetState =
  (typeof operationalBudgetStateValues)[number];

export const operationalQuotaKeyValues = [
  "creator_games",
  "creator_listed_games",
  "creator_managed_storage_bytes",
  "game_managed_storage_bytes",
  "creator_release_submissions_30d",
  "creator_release_submissions_day",
  "creator_browser_validations_30d",
  "creator_browser_validations_day",
  "creator_concurrent_release_jobs",
  "creator_room_seconds_30d",
  "creator_concurrent_rooms",
  "game_concurrent_rooms",
] as const;

export type OperationalQuotaKey = (typeof operationalQuotaKeyValues)[number];

export const operationalQuotaScopeKindValues = ["creator", "game"] as const;
export type OperationalQuotaScopeKind =
  (typeof operationalQuotaScopeKindValues)[number];

export const operationalQuotaUnitValues = [
  "count",
  "bytes",
  "seconds",
] as const;
export type OperationalQuotaUnit = (typeof operationalQuotaUnitValues)[number];

export const operationalQuotaWindowValues = [
  "lifetime",
  "rolling_30_days",
  "utc_day",
  "concurrent",
] as const;
export type OperationalQuotaWindow =
  (typeof operationalQuotaWindowValues)[number];

export const operationalJobKindValues = [
  "release_artifact_processing",
  "release_browser_validation",
  "release_image_moderation",
  "lifecycle_cleanup",
] as const;

export type OperationalJobKind = (typeof operationalJobKindValues)[number];

export const operationalJobResourceKindValues = [
  "release_generation",
  "game_media_asset",
] as const;

export type OperationalJobResourceKind =
  (typeof operationalJobResourceKindValues)[number];

export const operationalJobStatusValues = [
  "queued",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "canceled",
] as const;

export type OperationalJobStatus = (typeof operationalJobStatusValues)[number];

export const operationalJobAttemptStatusValues = [
  "running",
  "succeeded",
  "failed",
  "canceled",
  "lease_expired",
] as const;

export type OperationalJobAttemptStatus =
  (typeof operationalJobAttemptStatusValues)[number];

export const operationalJobEventKindValues = [
  "enqueued",
  "claimed",
  "stage_recorded",
  "retry_scheduled",
  "cancel_requested",
  "canceled",
  "succeeded",
  "failed",
  "lease_recovered",
  "output_cleaned",
  "replayed",
] as const;

export type OperationalJobEventKind =
  (typeof operationalJobEventKindValues)[number];

export const operationalJobCommandKindValues = [
  "enqueue",
  "schedule_cleanup",
  "cancel",
  "replay",
  "repair_expired",
] as const;

export type OperationalJobCommandKind =
  (typeof operationalJobCommandKindValues)[number];

export const operationalEventDeliveryCommandActionValues = [
  "requeue_dead_letter",
] as const;

export type OperationalEventDeliveryCommandAction =
  (typeof operationalEventDeliveryCommandActionValues)[number];

export const operationalJobContractVersion = 1 as const;

export type OperationalQuotaPolicySnapshot = {
  key: OperationalQuotaKey;
  scopeKind: OperationalQuotaScopeKind;
  lanes: readonly OperationalLane[];
  unit: OperationalQuotaUnit;
  window: OperationalQuotaWindow;
  limit: number;
};

export const operationalBudgetEvidenceStatusValues = [
  "fresh",
  "stale",
  "missing",
] as const;

export type OperationalBudgetEvidenceStatus =
  (typeof operationalBudgetEvidenceStatusValues)[number];

export const OPERATIONAL_BUDGET_EVIDENCE_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

export type OperationalBudgetAuthoritySnapshot = {
  evidenceStatus: OperationalBudgetEvidenceStatus;
  state: OperationalBudgetState | null;
  projectedState: OperationalBudgetState | null;
  lastKnownState: OperationalBudgetState | null;
  lastKnownProjectedState: OperationalBudgetState | null;
  actualAmountMicrousd: number | null;
  projectedAmountMicrousd: number | null;
  oldestSourceObservedAt: string | null;
  newestSourceObservedAt: string | null;
};

export class OperationalAdmissionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationalAdmissionPolicyError";
  }
}

export const operationalBudgetEvidenceContractVersion = 1 as const;

const operationalBudgetEvidenceContractVersionSql = sql.raw(
  String(operationalBudgetEvidenceContractVersion),
);

const operationalBudgetProfileSqlList = sql.raw(
  operationalBudgetProfileValues.map((profile) => `'${profile}'`).join(", "),
);

export type OperationalBudgetCycleSnapshot = {
  id: string;
  periodStart: string;
  periodEnd: string;
  profile: OperationalBudgetProfile;
  normalTargetMicrousd: number;
  warningMicrousd: number;
  protectionMicrousd: number;
  nearCeilingMicrousd: number;
  ceilingMicrousd: number;
  createdAt: string;
};

export type OperationalBudgetEvidenceSnapshot = {
  id: string;
  idempotencyKey: string;
  cycleId: string;
  contractVersion: number;
  provider: string;
  scopeKind: string;
  scopeId: string;
  scopeName: string;
  scopeMetadata: Record<string, unknown>;
  currency: "USD";
  observedAt: string;
  actualAmountMicrousd: number;
  projectedAmountMicrousd: number | null;
  measurements: Record<string, unknown>;
  costBreakdownMicrousd: Record<string, unknown>;
  rateCard: Record<string, unknown>;
  sourceVersion: string;
  collectedBy: string;
  reason: string;
  createdAt: string;
};

const operationalBudgetEvidenceSourceKey = (
  evidence: OperationalBudgetEvidenceSnapshot,
): string =>
  `${evidence.provider}\u0000${evidence.scopeKind}\u0000${evidence.scopeId}`;

export const selectLatestOperationalBudgetEvidence = (
  rows: readonly OperationalBudgetEvidenceSnapshot[],
): OperationalBudgetEvidenceSnapshot[] => {
  const latest = new Map<string, OperationalBudgetEvidenceSnapshot>();
  for (const row of rows) {
    const key = operationalBudgetEvidenceSourceKey(row);
    const current = latest.get(key);
    if (
      !current ||
      row.observedAt > current.observedAt ||
      (row.observedAt === current.observedAt &&
        row.createdAt > current.createdAt)
    ) {
      latest.set(key, row);
    }
  }
  return [...latest.values()].sort((left, right) =>
    operationalBudgetEvidenceSourceKey(left).localeCompare(
      operationalBudgetEvidenceSourceKey(right),
    ),
  );
};

export const resolveOperationalBudgetStateFromCycle = ({
  amountMicrousd,
  cycle,
}: {
  amountMicrousd: number;
  cycle: OperationalBudgetCycleSnapshot;
}): OperationalBudgetState => {
  if (amountMicrousd >= cycle.ceilingMicrousd) return "ceiling";
  if (amountMicrousd >= cycle.nearCeilingMicrousd) return "near_ceiling";
  if (amountMicrousd >= cycle.protectionMicrousd) return "protection";
  if (amountMicrousd >= cycle.warningMicrousd) return "warning";
  return "normal";
};

export const deriveOperationalBudgetAuthoritySnapshot = ({
  cycle,
  evidence,
  asOf,
  maxEvidenceAgeMs = OPERATIONAL_BUDGET_EVIDENCE_MAX_AGE_MS,
}: {
  cycle: OperationalBudgetCycleSnapshot | null;
  evidence: readonly OperationalBudgetEvidenceSnapshot[];
  asOf: Date;
  maxEvidenceAgeMs?: number;
}): OperationalBudgetAuthoritySnapshot => {
  if (Number.isNaN(asOf.getTime())) {
    throw new OperationalAdmissionPolicyError(
      "Budget status time must be valid.",
    );
  }
  if (!Number.isFinite(maxEvidenceAgeMs) || maxEvidenceAgeMs < 0) {
    throw new OperationalAdmissionPolicyError(
      "Budget evidence maximum age must be a non-negative finite number.",
    );
  }
  if (!cycle || evidence.length === 0) {
    return {
      evidenceStatus: "missing",
      state: null,
      projectedState: null,
      lastKnownState: null,
      lastKnownProjectedState: null,
      actualAmountMicrousd: null,
      projectedAmountMicrousd: null,
      oldestSourceObservedAt: null,
      newestSourceObservedAt: null,
    };
  }

  const latestEvidence = selectLatestOperationalBudgetEvidence(evidence);
  const observedTimes = latestEvidence.map((row) => Date.parse(row.observedAt));
  if (observedTimes.some(Number.isNaN)) {
    throw new OperationalAdmissionPolicyError(
      "Stored budget evidence contains an invalid observedAt value.",
    );
  }
  const oldestObservedAt = Math.min(...observedTimes);
  const newestObservedAt = Math.max(...observedTimes);
  const stale = asOf.getTime() - oldestObservedAt > maxEvidenceAgeMs;
  const actualAmountMicrousd = latestEvidence.reduce(
    (total, row) => total + row.actualAmountMicrousd,
    0,
  );
  const projectedAmountMicrousd = latestEvidence.every(
    (row) => row.projectedAmountMicrousd !== null,
  )
    ? latestEvidence.reduce(
        (total, row) => total + (row.projectedAmountMicrousd ?? 0),
        0,
      )
    : null;
  const lastKnownState = resolveOperationalBudgetStateFromCycle({
    amountMicrousd: actualAmountMicrousd,
    cycle,
  });
  const lastKnownProjectedState =
    projectedAmountMicrousd === null
      ? null
      : resolveOperationalBudgetStateFromCycle({
          amountMicrousd: projectedAmountMicrousd,
          cycle,
        });

  return {
    evidenceStatus: stale ? "stale" : "fresh",
    state: stale ? null : lastKnownState,
    projectedState: stale ? null : lastKnownProjectedState,
    lastKnownState,
    lastKnownProjectedState,
    actualAmountMicrousd,
    projectedAmountMicrousd,
    oldestSourceObservedAt: new Date(oldestObservedAt).toISOString(),
    newestSourceObservedAt: new Date(newestObservedAt).toISOString(),
  };
};

export type RuntimeDatabaseSchemaOptions = {
  appIdGameIdReference?: () => AnyPgColumn;
  appIdOwnerScopeReference?: () => {
    gameId: AnyPgColumn;
    creatorId: AnyPgColumn;
  };
};

export const createRuntimeDatabaseSchema = ({
  appIdGameIdReference,
  appIdOwnerScopeReference,
}: RuntimeDatabaseSchemaOptions = {}) => {
  const appIdGameIdColumn = appIdGameIdReference
    ? text("game_id").references(appIdGameIdReference)
    : text("game_id");

  const appIds = pgTable(
    "app_ids",
    {
      id: text("id").primaryKey(),
      gameId: appIdGameIdColumn.notNull().unique(),
      creatorId: text("creator_id"),
      key: text("key").notNull().unique(),
      allowedOrigins: jsonb("allowed_origins").$type<string[]>(),
      isActive: boolean("is_active").default(true).notNull(),
      createdAt: timestamp("created_at").defaultNow().notNull(),
      lastUsedAt: timestamp("last_used_at"),
    },
    (table) => {
      const ownerScope = appIdOwnerScopeReference?.();
      return ownerScope
        ? [
            foreignKey({
              name: "app_ids_game_creator_fk",
              columns: [table.gameId, table.creatorId],
              foreignColumns: [ownerScope.gameId, ownerScope.creatorId],
            }),
          ]
        : [];
    },
  );

  const runtimeUsageSessions = pgTable(
    "runtime_usage_sessions",
    {
      id: text("id").primaryKey(),
      roomId: text("room_id").notNull(),
      appId: text("app_id"),
      hostVerifiedVia: text("host_verified_via"),
      hostVerifiedOrigin: text("host_verified_origin"),
      startedAt: timestamp("started_at").notNull(),
      createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
      index("runtime_usage_sessions_app_id_idx").on(table.appId),
      index("runtime_usage_sessions_started_at_idx").on(table.startedAt),
    ],
  );

  const runtimeUsageEvents = pgTable(
    "runtime_usage_events",
    {
      id: text("id").primaryKey(),
      kind: text("kind").notNull(),
      occurredAt: timestamp("occurred_at").notNull(),
      runtimeSessionId: text("runtime_session_id").references(
        () => runtimeUsageSessions.id,
        { onDelete: "set null" },
      ),
      roomId: text("room_id"),
      appId: text("app_id"),
      gameId: text("game_id"),
      hostVerifiedVia: text("host_verified_via"),
      hostVerifiedOrigin: text("host_verified_origin"),
      payload: jsonb("payload")
        .$type<Record<string, unknown>>()
        .default(sql`'{}'::jsonb`)
        .notNull(),
      createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
      index("runtime_usage_events_kind_idx").on(table.kind),
      index("runtime_usage_events_occurred_at_idx").on(table.occurredAt),
      index("runtime_usage_events_runtime_session_id_idx").on(
        table.runtimeSessionId,
      ),
      index("runtime_usage_events_room_id_idx").on(table.roomId),
      index("runtime_usage_events_app_id_idx").on(table.appId),
    ],
  );

  const runtimeUsageControllerSegments = pgTable(
    "runtime_usage_controller_segments",
    {
      id: text("id").primaryKey(),
      runtimeSessionId: text("runtime_session_id")
        .references(() => runtimeUsageSessions.id, { onDelete: "cascade" })
        .notNull(),
      roomId: text("room_id").notNull(),
      appId: text("app_id"),
      controllerId: text("controller_id").notNull(),
      startedAt: timestamp("started_at").notNull(),
      endedAt: timestamp("ended_at"),
      startEventId: text("start_event_id").notNull(),
      endEventId: text("end_event_id"),
      endReason: text("end_reason"),
      createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
      index("runtime_usage_controller_segments_runtime_session_id_idx").on(
        table.runtimeSessionId,
      ),
      index("runtime_usage_controller_segments_controller_id_idx").on(
        table.controllerId,
      ),
      index("runtime_usage_controller_segments_started_at_idx").on(
        table.startedAt,
      ),
    ],
  );

  const runtimeUsageGameSegments = pgTable(
    "runtime_usage_game_segments",
    {
      id: text("id").primaryKey(),
      runtimeSessionId: text("runtime_session_id")
        .references(() => runtimeUsageSessions.id, { onDelete: "cascade" })
        .notNull(),
      roomId: text("room_id").notNull(),
      appId: text("app_id"),
      gameId: text("game_id").notNull(),
      startedAt: timestamp("started_at").notNull(),
      endedAt: timestamp("ended_at"),
      startEventId: text("start_event_id").notNull(),
      endEventId: text("end_event_id"),
      startReason: text("start_reason"),
      endReason: text("end_reason"),
      createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
      index("runtime_usage_game_segments_runtime_session_id_idx").on(
        table.runtimeSessionId,
      ),
      index("runtime_usage_game_segments_game_id_idx").on(table.gameId),
      index("runtime_usage_game_segments_started_at_idx").on(table.startedAt),
    ],
  );

  const runtimeUsageEligibleSegments = pgTable(
    "runtime_usage_eligible_segments",
    {
      id: text("id").primaryKey(),
      runtimeSessionId: text("runtime_session_id")
        .references(() => runtimeUsageSessions.id, { onDelete: "cascade" })
        .notNull(),
      roomId: text("room_id").notNull(),
      appId: text("app_id"),
      gameId: text("game_id"),
      startedAt: timestamp("started_at").notNull(),
      endedAt: timestamp("ended_at"),
      startEventId: text("start_event_id").notNull(),
      endEventId: text("end_event_id"),
      startReason: text("start_reason"),
      endReason: text("end_reason"),
      createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (table) => [
      index("runtime_usage_eligible_segments_runtime_session_id_idx").on(
        table.runtimeSessionId,
      ),
      index("runtime_usage_eligible_segments_game_id_idx").on(table.gameId),
      index("runtime_usage_eligible_segments_started_at_idx").on(
        table.startedAt,
      ),
    ],
  );

  const runtimeUsageGameSessionMetrics = pgTable(
    "runtime_usage_game_session_metrics",
    {
      id: text("id").primaryKey(),
      runtimeSessionId: text("runtime_session_id")
        .references(() => runtimeUsageSessions.id, { onDelete: "cascade" })
        .notNull(),
      roomId: text("room_id").notNull(),
      appId: text("app_id"),
      gameId: text("game_id").notNull(),
      startedAt: timestamp("started_at").notNull(),
      endedAt: timestamp("ended_at"),
      controllerSeconds: integer("controller_seconds").default(0).notNull(),
      rawEligiblePlaytimeSeconds: integer("raw_eligible_playtime_seconds")
        .default(0)
        .notNull(),
      eligiblePlaytimeSeconds: integer("eligible_playtime_seconds")
        .default(0)
        .notNull(),
      trustFlags: jsonb("trust_flags")
        .$type<string[]>()
        .default(sql`'[]'::jsonb`)
        .notNull(),
      peakConcurrentControllers: integer("peak_concurrent_controllers")
        .default(0)
        .notNull(),
      createdAt: timestamp("created_at").defaultNow().notNull(),
      updatedAt: timestamp("updated_at").defaultNow().notNull(),
    },
    (table) => [
      index("runtime_usage_game_session_metrics_runtime_session_id_idx").on(
        table.runtimeSessionId,
      ),
      index("runtime_usage_game_session_metrics_game_id_idx").on(table.gameId),
      index("runtime_usage_game_session_metrics_started_at_idx").on(
        table.startedAt,
      ),
    ],
  );

  const runtimeUsageDailyGameMetrics = pgTable(
    "runtime_usage_daily_game_metrics",
    {
      id: text("id").primaryKey(),
      bucketDate: date("bucket_date").notNull(),
      appId: text("app_id"),
      gameId: text("game_id").notNull(),
      sessionCount: integer("session_count").default(0).notNull(),
      totalGameActiveSeconds: integer("total_game_active_seconds")
        .default(0)
        .notNull(),
      totalControllerSeconds: integer("total_controller_seconds")
        .default(0)
        .notNull(),
      totalRawEligiblePlaytimeSeconds: integer(
        "total_raw_eligible_playtime_seconds",
      )
        .default(0)
        .notNull(),
      totalEligiblePlaytimeSeconds: integer("total_eligible_playtime_seconds")
        .default(0)
        .notNull(),
      guardedSessionCount: integer("guarded_session_count")
        .default(0)
        .notNull(),
      peakConcurrentControllers: integer("peak_concurrent_controllers")
        .default(0)
        .notNull(),
      lastActivityAt: timestamp("last_activity_at"),
      createdAt: timestamp("created_at").defaultNow().notNull(),
      updatedAt: timestamp("updated_at").defaultNow().notNull(),
    },
    (table) => [
      index("runtime_usage_daily_game_metrics_bucket_date_idx").on(
        table.bucketDate,
      ),
      index("runtime_usage_daily_game_metrics_game_id_idx").on(table.gameId),
    ],
  );

  const operationalLaneControls = pgTable(
    "operational_lane_controls",
    {
      lane: text("lane").$type<OperationalLane>().primaryKey(),
      mode: text("mode")
        .$type<OperationalLaneMode>()
        .default("normal")
        .notNull(),
      reason: text("reason"),
      retryAfterSeconds: integer("retry_after_seconds"),
      revision: integer("revision").default(1).notNull(),
      updatedBy: text("updated_by").notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      check(
        "operational_lane_controls_lane_check",
        sql`${table.lane} in (${operationalLaneSqlList})`,
      ),
      check(
        "operational_lane_controls_mode_check",
        sql`${table.mode} in (${operationalLaneModeSqlList})`,
      ),
      check(
        "operational_lane_controls_retry_after_check",
        sql`${table.retryAfterSeconds} is null or ${table.retryAfterSeconds} > 0`,
      ),
      check(
        "operational_lane_controls_revision_check",
        sql`${table.revision} > 0`,
      ),
      index("operational_lane_controls_mode_idx").on(table.mode),
      index("operational_lane_controls_updated_at_idx").on(table.updatedAt),
    ],
  );

  const operationalControlEvents = pgTable(
    "operational_control_events",
    {
      id: text("id").primaryKey(),
      idempotencyKey: text("idempotency_key").notNull(),
      action: text("action").$type<"set_lane_mode">().notNull(),
      lane: text("lane").$type<OperationalLane>().notNull(),
      expectedRevision: integer("expected_revision").notNull(),
      previous: jsonb("previous")
        .$type<OperationalLaneControlSnapshot>()
        .notNull(),
      next: jsonb("next").$type<OperationalLaneControlSnapshot>().notNull(),
      actor: text("actor").notNull(),
      reason: text("reason").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      uniqueIndex("operational_control_events_idempotency_key_uidx").on(
        table.idempotencyKey,
      ),
      index("operational_control_events_lane_created_at_idx").on(
        table.lane,
        table.createdAt,
      ),
      check(
        "operational_control_events_action_check",
        sql`${table.action} = 'set_lane_mode'`,
      ),
      check(
        "operational_control_events_lane_check",
        sql`${table.lane} in (${operationalLaneSqlList})`,
      ),
      check(
        "operational_control_events_expected_revision_check",
        sql`${table.expectedRevision} >= 0`,
      ),
    ],
  );

  const operationalBudgetCycles = pgTable(
    "operational_budget_cycles",
    {
      id: text("id").primaryKey(),
      periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
      periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
      profile: text("profile").$type<OperationalBudgetProfile>().notNull(),
      normalTargetMicrousd: bigint("normal_target_microusd", {
        mode: "number",
      }).notNull(),
      warningMicrousd: bigint("warning_microusd", {
        mode: "number",
      }).notNull(),
      protectionMicrousd: bigint("protection_microusd", {
        mode: "number",
      }).notNull(),
      nearCeilingMicrousd: bigint("near_ceiling_microusd", {
        mode: "number",
      }).notNull(),
      ceilingMicrousd: bigint("ceiling_microusd", {
        mode: "number",
      }).notNull(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      uniqueIndex("operational_budget_cycles_period_uidx").on(
        table.periodStart,
        table.periodEnd,
      ),
      check(
        "operational_budget_cycles_period_check",
        sql`${table.periodEnd} > ${table.periodStart}`,
      ),
      check(
        "operational_budget_cycles_id_check",
        sql`length(btrim(${table.id})) > 0`,
      ),
      check(
        "operational_budget_cycles_profile_check",
        sql`${table.profile} in (${operationalBudgetProfileSqlList})`,
      ),
      check(
        "operational_budget_cycles_thresholds_check",
        sql`${table.normalTargetMicrousd} > 0 and ${table.warningMicrousd} > ${table.normalTargetMicrousd} and ${table.protectionMicrousd} > ${table.warningMicrousd} and ${table.nearCeilingMicrousd} > ${table.protectionMicrousd} and ${table.ceilingMicrousd} > ${table.nearCeilingMicrousd}`,
      ),
    ],
  );

  const operationalBudgetEvidence = pgTable(
    "operational_budget_evidence",
    {
      id: text("id").primaryKey(),
      idempotencyKey: text("idempotency_key").notNull(),
      cycleId: text("cycle_id")
        .notNull()
        .references(() => operationalBudgetCycles.id),
      contractVersion: integer("contract_version").notNull(),
      provider: text("provider").notNull(),
      scopeKind: text("scope_kind").notNull(),
      scopeId: text("scope_id").notNull(),
      scopeName: text("scope_name").notNull(),
      scopeMetadata: jsonb("scope_metadata")
        .$type<Record<string, unknown>>()
        .notNull(),
      currency: text("currency").$type<"USD">().default("USD").notNull(),
      observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
      actualAmountMicrousd: bigint("actual_amount_microusd", {
        mode: "number",
      }).notNull(),
      projectedAmountMicrousd: bigint("projected_amount_microusd", {
        mode: "number",
      }),
      measurements: jsonb("measurements")
        .$type<Record<string, unknown>>()
        .notNull(),
      costBreakdownMicrousd: jsonb("cost_breakdown_microusd")
        .$type<Record<string, unknown>>()
        .notNull(),
      rateCard: jsonb("rate_card").$type<Record<string, unknown>>().notNull(),
      sourceVersion: text("source_version").notNull(),
      collectedBy: text("collected_by").notNull(),
      reason: text("reason").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      uniqueIndex("operational_budget_evidence_idempotency_key_uidx").on(
        table.idempotencyKey,
      ),
      index("operational_budget_evidence_cycle_observed_at_idx").on(
        table.cycleId,
        table.observedAt,
      ),
      index("operational_budget_evidence_source_observed_at_idx").on(
        table.provider,
        table.scopeKind,
        table.scopeId,
        table.observedAt,
      ),
      check(
        "operational_budget_evidence_currency_check",
        sql`${table.currency} = 'USD'`,
      ),
      check(
        "operational_budget_evidence_contract_version_check",
        sql`${table.contractVersion} = ${operationalBudgetEvidenceContractVersionSql}`,
      ),
      check(
        "operational_budget_evidence_required_text_check",
        sql`length(btrim(${table.id})) > 0 and length(btrim(${table.idempotencyKey})) > 0 and length(btrim(${table.provider})) > 0 and length(btrim(${table.scopeKind})) > 0 and length(btrim(${table.scopeId})) > 0 and length(btrim(${table.scopeName})) > 0 and length(btrim(${table.sourceVersion})) > 0 and length(btrim(${table.collectedBy})) > 0 and length(btrim(${table.reason})) > 0`,
      ),
      check(
        "operational_budget_evidence_json_objects_check",
        sql`jsonb_typeof(${table.scopeMetadata}) = 'object' and jsonb_typeof(${table.measurements}) = 'object' and jsonb_typeof(${table.costBreakdownMicrousd}) = 'object' and jsonb_typeof(${table.rateCard}) = 'object'`,
      ),
      check(
        "operational_budget_evidence_actual_amount_check",
        sql`${table.actualAmountMicrousd} >= 0`,
      ),
      check(
        "operational_budget_evidence_projected_amount_check",
        sql`${table.projectedAmountMicrousd} is null or ${table.projectedAmountMicrousd} >= 0`,
      ),
    ],
  );

  const operationalEventOutbox = pgTable(
    "operational_event_outbox",
    {
      id: text("id").primaryKey(),
      contractVersion: integer("contract_version").notNull(),
      envelope: jsonb("envelope").$type<OperationalEventEnvelopeV1>().notNull(),
      status: text("status")
        .$type<"pending" | "delivering" | "delivered" | "dead_letter">()
        .default("pending")
        .notNull(),
      attemptCount: integer("attempt_count").default(0).notNull(),
      maxAttempts: integer("max_attempts")
        .default(DEFAULT_OPERATIONAL_EVENT_DELIVERY_MAX_ATTEMPTS)
        .notNull(),
      availableAt: timestamp("available_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
      leaseOwner: text("lease_owner"),
      leaseToken: text("lease_token"),
      leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
      deliveredAt: timestamp("delivered_at", { withTimezone: true }),
      lastError: jsonb("last_error").$type<OperationalFailureV1>(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table) => ({
      deliveryQueueIdx: index("operational_event_outbox_delivery_queue_idx")
        .on(table.status, table.availableAt, table.createdAt)
        .where(sql`${table.status} = 'pending'`),
      leaseExpiryIdx: index("operational_event_outbox_lease_expiry_idx")
        .on(table.leaseExpiresAt)
        .where(sql`${table.status} = 'delivering'`),
      statusCheck: check(
        "operational_event_outbox_status_check",
        sql`${table.status} in ('pending', 'delivering', 'delivered', 'dead_letter')`,
      ),
      contractVersionCheck: check(
        "operational_event_outbox_contract_version_check",
        sql`${table.contractVersion} = 1`,
      ),
      attemptsCheck: check(
        "operational_event_outbox_attempts_check",
        sql`${table.attemptCount} >= 0 and ${table.maxAttempts} > 0 and ${table.attemptCount} <= ${table.maxAttempts}`,
      ),
      envelopeCheck: check(
        "operational_event_outbox_envelope_check",
        sql`jsonb_typeof(${table.envelope}) = 'object'`,
      ),
      lifecycleCheck: check(
        "operational_event_outbox_lifecycle_check",
        sql`(
        ${table.status} = 'pending'
        and ${table.leaseOwner} is null
        and ${table.leaseToken} is null
        and ${table.leaseExpiresAt} is null
        and ${table.deliveredAt} is null
      ) or (
        ${table.status} = 'delivering'
        and ${table.leaseOwner} is not null
        and ${table.leaseToken} is not null
        and ${table.leaseExpiresAt} is not null
        and ${table.deliveredAt} is null
      ) or (
        ${table.status} = 'delivered'
        and ${table.leaseOwner} is null
        and ${table.leaseToken} is null
        and ${table.leaseExpiresAt} is null
        and ${table.deliveredAt} is not null
      ) or (
        ${table.status} = 'dead_letter'
        and ${table.leaseOwner} is null
        and ${table.leaseToken} is null
        and ${table.leaseExpiresAt} is null
        and ${table.deliveredAt} is null
        and ${table.lastError} is not null
      )`,
      ),
    }),
  );

  const operationalEventDeliveryCommands = pgTable(
    "operational_event_delivery_commands",
    {
      id: text("id").primaryKey(),
      contractVersion: integer("contract_version").default(1).notNull(),
      idempotencyKey: text("idempotency_key").notNull().unique(),
      eventId: text("event_id")
        .notNull()
        .references(() => operationalEventOutbox.id, { onDelete: "restrict" }),
      action: text("action")
        .$type<OperationalEventDeliveryCommandAction>()
        .notNull(),
      requestHash: text("request_hash").notNull(),
      actor: text("actor").notNull(),
      reason: text("reason").notNull(),
      request: jsonb("request").$type<Record<string, unknown>>().notNull(),
      result: jsonb("result").$type<Record<string, unknown>>(),
      completedAt: timestamp("completed_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table) => ({
      eventTimeIdx: index(
        "operational_event_delivery_commands_event_time_idx",
      ).on(table.eventId, table.createdAt),
      actionCheck: check(
        "operational_event_delivery_commands_action_check",
        sql`${table.action} = 'requeue_dead_letter'`,
      ),
      contractVersionCheck: check(
        "operational_event_delivery_commands_contract_version_check",
        sql`${table.contractVersion} = 1`,
      ),
      requestHashCheck: check(
        "operational_event_delivery_commands_request_hash_check",
        sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
      ),
      requiredTextCheck: check(
        "operational_event_delivery_commands_required_text_check",
        sql`length(btrim(${table.idempotencyKey})) > 0 and length(btrim(${table.eventId})) > 0 and length(btrim(${table.actor})) > 0 and length(btrim(${table.reason})) > 0`,
      ),
      requestCheck: check(
        "operational_event_delivery_commands_request_check",
        sql`jsonb_typeof(${table.request}) = 'object'`,
      ),
      completionCheck: check(
        "operational_event_delivery_commands_completion_check",
        sql`(${table.result} is null and ${table.completedAt} is null) or (jsonb_typeof(${table.result}) = 'object' and ${table.completedAt} is not null)`,
      ),
    }),
  );

  const operationalEvents = pgTable(
    "operational_events",
    {
      id: text("id").primaryKey(),
      contractVersion: integer("contract_version").notNull(),
      kind: text("kind").notNull(),
      severity: text("severity").notNull(),
      outcome: text("outcome").notNull(),
      authority: text("authority").notNull(),
      service: text("service").notNull(),
      environment: text("environment").notNull(),
      subjectType: text("subject_type").notNull(),
      subjectId: text("subject_id").notNull(),
      correlationId: text("correlation_id").notNull(),
      occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
      observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
      envelope: jsonb("envelope").$type<OperationalEventEnvelopeV1>().notNull(),
      storedAt: timestamp("stored_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table) => ({
      kindTimeIdx: index("operational_events_kind_time_idx").on(
        table.kind,
        table.occurredAt,
      ),
      serviceTimeIdx: index("operational_events_service_time_idx").on(
        table.environment,
        table.service,
        table.occurredAt,
      ),
      subjectTimeIdx: index("operational_events_subject_time_idx").on(
        table.subjectType,
        table.subjectId,
        table.occurredAt,
      ),
      correlationIdx: index("operational_events_correlation_idx").on(
        table.correlationId,
        table.occurredAt,
      ),
      contractVersionCheck: check(
        "operational_events_contract_version_check",
        sql`${table.contractVersion} = 1`,
      ),
      envelopeCheck: check(
        "operational_events_envelope_check",
        sql`jsonb_typeof(${table.envelope}) = 'object'`,
      ),
      chronologyCheck: check(
        "operational_events_chronology_check",
        sql`${table.observedAt} >= ${table.occurredAt}`,
      ),
    }),
  );

  const operationalSyntheticRuns = pgTable(
    "operational_synthetic_runs",
    {
      id: text("id").primaryKey(),
      idempotencyKey: text("idempotency_key").notNull().unique(),
      checkId: text("check_id").notNull(),
      environment: text("environment").notNull(),
      status: text("status").$type<"passed" | "failed" | "error">().notNull(),
      eventId: text("event_id")
        .notNull()
        .references(() => operationalEventOutbox.id, { onDelete: "restrict" }),
      document: jsonb("document").$type<OperationalSyntheticRunV1>().notNull(),
      startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
      completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table) => ({
      checkTimeIdx: index("operational_synthetic_runs_check_time_idx").on(
        table.checkId,
        table.environment,
        table.completedAt,
      ),
      statusCheck: check(
        "operational_synthetic_runs_status_check",
        sql`${table.status} in ('passed', 'failed', 'error')`,
      ),
      documentCheck: check(
        "operational_synthetic_runs_document_check",
        sql`jsonb_typeof(${table.document}) = 'object'`,
      ),
      chronologyCheck: check(
        "operational_synthetic_runs_chronology_check",
        sql`${table.completedAt} >= ${table.startedAt}`,
      ),
    }),
  );

  const operationalSloEvaluations = pgTable(
    "operational_slo_evaluations",
    {
      id: text("id").primaryKey(),
      sloId: text("slo_id").notNull(),
      environment: text("environment").notNull(),
      status: text("status")
        .$type<"insufficient_data" | "healthy" | "breaching">()
        .notNull(),
      triggerEventId: text("trigger_event_id")
        .notNull()
        .references(() => operationalEventOutbox.id, { onDelete: "restrict" }),
      document: jsonb("document").$type<OperationalSloEvaluationV1>().notNull(),
      evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table) => ({
      sloTimeIdx: index("operational_slo_evaluations_slo_time_idx").on(
        table.sloId,
        table.environment,
        table.evaluatedAt,
      ),
      statusCheck: check(
        "operational_slo_evaluations_status_check",
        sql`${table.status} in ('insufficient_data', 'healthy', 'breaching')`,
      ),
      documentCheck: check(
        "operational_slo_evaluations_document_check",
        sql`jsonb_typeof(${table.document}) = 'object'`,
      ),
    }),
  );

  const operationalAlerts = pgTable(
    "operational_alerts",
    {
      id: text("id").primaryKey(),
      alertKey: text("alert_key").notNull().unique(),
      policyId: text("policy_id").notNull(),
      environment: text("environment").notNull(),
      service: text("service").notNull(),
      severity: text("severity")
        .$type<"warning" | "error" | "critical">()
        .notNull(),
      status: text("status").$type<"open" | "recovered">().notNull(),
      latestEventId: text("latest_event_id")
        .notNull()
        .references(() => operationalEventOutbox.id, { onDelete: "restrict" }),
      latestEvaluationId: text("latest_evaluation_id")
        .notNull()
        .references(() => operationalSloEvaluations.id, {
          onDelete: "restrict",
        }),
      revision: integer("revision").notNull(),
      document: jsonb("document").$type<OperationalAlertV1>().notNull(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table) => ({
      statusSeverityIdx: index("operational_alerts_status_severity_idx").on(
        table.status,
        table.severity,
        table.updatedAt,
      ),
      policyIdx: index("operational_alerts_policy_idx").on(
        table.policyId,
        table.environment,
      ),
      statusCheck: check(
        "operational_alerts_status_check",
        sql`${table.status} in ('open', 'recovered')`,
      ),
      severityCheck: check(
        "operational_alerts_severity_check",
        sql`${table.severity} in ('warning', 'error', 'critical')`,
      ),
      revisionCheck: check(
        "operational_alerts_revision_check",
        sql`${table.revision} > 0`,
      ),
      documentCheck: check(
        "operational_alerts_document_check",
        sql`jsonb_typeof(${table.document}) = 'object'`,
      ),
    }),
  );

  const operationalAlertIssueProjections = pgTable(
    "operational_alert_issue_projections",
    {
      id: text("id").primaryKey(),
      contractVersion: integer("contract_version").default(1).notNull(),
      alertKey: text("alert_key").notNull(),
      repository: text("repository").notNull(),
      targetAlertRevision: integer("target_alert_revision").notNull(),
      targetAlert: jsonb("target_alert").$type<OperationalAlertV1>().notNull(),
      projectedAlertRevision: integer("projected_alert_revision")
        .default(0)
        .notNull(),
      status: text("status")
        .$type<"pending" | "delivering" | "delivered" | "dead_letter">()
        .default("pending")
        .notNull(),
      attemptCount: integer("attempt_count").default(0).notNull(),
      maxAttempts: integer("max_attempts")
        .default(DEFAULT_OPERATIONAL_ALERT_ISSUE_MAX_ATTEMPTS)
        .notNull(),
      availableAt: timestamp("available_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
      leaseOwner: text("lease_owner"),
      leaseToken: text("lease_token"),
      leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
      issueNumber: integer("issue_number"),
      issueUrl: text("issue_url"),
      issueState: text("issue_state").$type<"open" | "closed">(),
      managedBodyHash: text("managed_body_hash"),
      projectedAt: timestamp("projected_at", { withTimezone: true }),
      lastError: jsonb("last_error").$type<OperationalFailureV1>(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table) => ({
      alertKeyFk: foreignKey({
        name: "operational_alert_issue_projection_alert_fk",
        columns: [table.alertKey],
        foreignColumns: [operationalAlerts.alertKey],
      }).onDelete("restrict"),
      alertRepositoryIdx: uniqueIndex(
        "operational_alert_issue_projections_alert_repository_idx",
      ).on(table.alertKey, table.repository),
      deliveryQueueIdx: index(
        "operational_alert_issue_projections_delivery_queue_idx",
      )
        .on(table.status, table.availableAt, table.createdAt)
        .where(sql`${table.status} = 'pending'`),
      leaseExpiryIdx: index(
        "operational_alert_issue_projections_lease_expiry_idx",
      )
        .on(table.leaseExpiresAt)
        .where(sql`${table.status} = 'delivering'`),
      statusCheck: check(
        "operational_alert_issue_projections_status_check",
        sql`${table.status} in ('pending', 'delivering', 'delivered', 'dead_letter')`,
      ),
      issueStateCheck: check(
        "operational_alert_issue_projections_issue_state_check",
        sql`${table.issueState} is null or ${table.issueState} in ('open', 'closed')`,
      ),
      contractVersionCheck: check(
        "operational_alert_issue_projections_contract_version_check",
        sql`${table.contractVersion} = 1`,
      ),
      revisionCheck: check(
        "operational_alert_issue_projections_revision_check",
        sql`${table.targetAlertRevision} > 0 and ${table.projectedAlertRevision} >= 0 and ${table.projectedAlertRevision} <= ${table.targetAlertRevision}`,
      ),
      targetAlertCheck: check(
        "operational_alert_issue_projections_target_alert_check",
        sql`jsonb_typeof(${table.targetAlert}) = 'object'`,
      ),
      attemptsCheck: check(
        "operational_alert_issue_projections_attempts_check",
        sql`${table.attemptCount} >= 0 and ${table.maxAttempts} > 0 and ${table.attemptCount} <= ${table.maxAttempts}`,
      ),
      issueIdentityCheck: check(
        "operational_alert_issue_projections_issue_identity_check",
        sql`(
          ${table.issueNumber} is null
          and ${table.issueUrl} is null
          and ${table.issueState} is null
        ) or (
          ${table.issueNumber} > 0
          and length(btrim(${table.issueUrl})) > 0
          and ${table.issueState} is not null
        )`,
      ),
      lifecycleCheck: check(
        "operational_alert_issue_projections_lifecycle_check",
        sql`(
          ${table.status} = 'pending'
          and ${table.leaseOwner} is null
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
        ) or (
          ${table.status} = 'delivering'
          and ${table.leaseOwner} is not null
          and ${table.leaseToken} is not null
          and ${table.leaseExpiresAt} is not null
        ) or (
          ${table.status} = 'delivered'
          and ${table.leaseOwner} is null
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
          and ${table.projectedAlertRevision} = ${table.targetAlertRevision}
          and ${table.issueNumber} is not null
          and ${table.managedBodyHash} is not null
          and ${table.projectedAt} is not null
          and ${table.lastError} is null
        ) or (
          ${table.status} = 'dead_letter'
          and ${table.leaseOwner} is null
          and ${table.leaseToken} is null
          and ${table.leaseExpiresAt} is null
          and ${table.lastError} is not null
        )`,
      ),
    }),
  );

  return {
    appIds,
    runtimeUsageSessions,
    runtimeUsageEvents,
    runtimeUsageControllerSegments,
    runtimeUsageGameSegments,
    runtimeUsageEligibleSegments,
    runtimeUsageGameSessionMetrics,
    runtimeUsageDailyGameMetrics,
    operationalLaneControls,
    operationalControlEvents,
    operationalBudgetCycles,
    operationalBudgetEvidence,
    operationalEventOutbox,
    operationalEventDeliveryCommands,
    operationalEvents,
    operationalSyntheticRuns,
    operationalSloEvaluations,
    operationalAlerts,
    operationalAlertIssueProjections,
  };
};

export type RuntimeDatabaseSchema = ReturnType<
  typeof createRuntimeDatabaseSchema
>;

type OperationalSelectDatabase = Pick<PostgresJsDatabase, "select">;

export type OperationalBudgetTables = Pick<
  RuntimeDatabaseSchema,
  "operationalBudgetCycles" | "operationalBudgetEvidence"
>;

export type OperationalLaneControlTables = Pick<
  RuntimeDatabaseSchema,
  "operationalLaneControls"
>;

export const serializeOperationalBudgetCycle = (
  row: RuntimeDatabaseSchema["operationalBudgetCycles"]["$inferSelect"],
): OperationalBudgetCycleSnapshot => ({
  id: row.id,
  periodStart: row.periodStart.toISOString(),
  periodEnd: row.periodEnd.toISOString(),
  profile: row.profile,
  normalTargetMicrousd: row.normalTargetMicrousd,
  warningMicrousd: row.warningMicrousd,
  protectionMicrousd: row.protectionMicrousd,
  nearCeilingMicrousd: row.nearCeilingMicrousd,
  ceilingMicrousd: row.ceilingMicrousd,
  createdAt: row.createdAt.toISOString(),
});

export const serializeOperationalBudgetEvidence = (
  row: RuntimeDatabaseSchema["operationalBudgetEvidence"]["$inferSelect"],
): OperationalBudgetEvidenceSnapshot => ({
  id: row.id,
  idempotencyKey: row.idempotencyKey,
  cycleId: row.cycleId,
  contractVersion: row.contractVersion,
  provider: row.provider,
  scopeKind: row.scopeKind,
  scopeId: row.scopeId,
  scopeName: row.scopeName,
  scopeMetadata: row.scopeMetadata,
  currency: row.currency,
  observedAt: row.observedAt.toISOString(),
  actualAmountMicrousd: row.actualAmountMicrousd,
  projectedAmountMicrousd: row.projectedAmountMicrousd,
  measurements: row.measurements,
  costBreakdownMicrousd: row.costBreakdownMicrousd,
  rateCard: row.rateCard,
  sourceVersion: row.sourceVersion,
  collectedBy: row.collectedBy,
  reason: row.reason,
  createdAt: row.createdAt.toISOString(),
});

export const serializeOperationalLaneControl = (
  row: RuntimeDatabaseSchema["operationalLaneControls"]["$inferSelect"],
): OperationalLaneControlSnapshot => ({
  lane: row.lane,
  mode: row.mode,
  reason: row.reason,
  retryAfterSeconds: row.retryAfterSeconds,
  revision: row.revision,
  updatedBy: row.updatedBy,
  updatedAt: row.updatedAt.toISOString(),
});

export const getDefaultOperationalLaneControl = (
  lane: OperationalLane,
): OperationalLaneControlSnapshot => ({
  lane,
  mode: "normal",
  reason: null,
  retryAfterSeconds: null,
  revision: 0,
  updatedBy: null,
  updatedAt: null,
});

export const readOperationalBudgetSnapshot = async ({
  database,
  tables,
  asOf,
}: {
  database: OperationalSelectDatabase;
  tables: OperationalBudgetTables;
  asOf: Date;
}): Promise<{
  cycle: OperationalBudgetCycleSnapshot | null;
  evidence: OperationalBudgetEvidenceSnapshot[];
}> => {
  const [cycleRow] = await database
    .select()
    .from(tables.operationalBudgetCycles)
    .where(
      and(
        lte(tables.operationalBudgetCycles.periodStart, asOf),
        gt(tables.operationalBudgetCycles.periodEnd, asOf),
      ),
    )
    .orderBy(desc(tables.operationalBudgetCycles.periodStart))
    .limit(1);
  const evidenceRows = cycleRow
    ? await database
        .select()
        .from(tables.operationalBudgetEvidence)
        .where(eq(tables.operationalBudgetEvidence.cycleId, cycleRow.id))
    : [];
  const cycle = cycleRow ? serializeOperationalBudgetCycle(cycleRow) : null;
  const evidence = evidenceRows.map(serializeOperationalBudgetEvidence);
  return { cycle, evidence };
};

export const readOperationalLaneControl = async ({
  database,
  tables,
  lane,
}: {
  database: OperationalSelectDatabase;
  tables: OperationalLaneControlTables;
  lane: OperationalLane;
}): Promise<OperationalLaneControlSnapshot> => {
  const [row] = await database
    .select()
    .from(tables.operationalLaneControls)
    .where(eq(tables.operationalLaneControls.lane, lane))
    .limit(1);
  return row
    ? serializeOperationalLaneControl(row)
    : getDefaultOperationalLaneControl(lane);
};
