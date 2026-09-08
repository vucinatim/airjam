import type { ArcadeVisibility } from "@/lib/games/arcade-visibility";
import type { GameConfig } from "@/lib/games/game-config-contract";
import type {
  GameMediaKind,
  GameMediaStatus,
} from "@/lib/games/game-media-contract";
import type {
  ProductTelemetryActorClass,
  ProductTelemetryAgentFamily,
  ProductTelemetryAgentResource,
  ProductTelemetryDeploymentEnvironment,
  ProductTelemetryExternalTarget,
  ProductTelemetryPlacement,
  ProductTelemetryReferrerSource,
  ProductTelemetryStoredEventKind,
  ProductTelemetrySurface,
} from "@/lib/product-telemetry-contract";
import type {
  GameReleaseSourceKind,
  GameReleaseStatus,
  ReleaseCheckKind,
  ReleaseCheckStatus,
  ReleaseGenerationStatus,
  ReleaseReportSource,
  ReleaseReportStatus,
} from "@/lib/releases/release-contract";
import {
  createRuntimeDatabaseSchema,
  operationalJobContractVersion,
  type OperationalJobAttemptStatus,
  type OperationalJobCommandKind,
  type OperationalJobEventKind,
  type OperationalJobKind,
  type OperationalJobResourceKind,
  type OperationalJobStatus,
} from "@air-jam/database-contract";
import type { PlatformMachineDeviceGrantStatus } from "@air-jam/sdk/platform-machine";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const operationalJobContractVersionSql = sql.raw(
  String(operationalJobContractVersion),
);

export const userRoleEnum = pgEnum("user_role", ["creator", "ops_admin"]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull(),
  image: text("image"),
  role: userRoleEnum("role").default("creator").notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .references(() => users.id)
    .notNull(),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .references(() => users.id)
    .notNull(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verificationTokens = pgTable("verification_tokens", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const machineAuthDeviceGrants = pgTable(
  "machine_auth_device_grants",
  {
    id: text("id").primaryKey(),
    deviceCode: text("device_code").notNull().unique(),
    userCode: text("user_code").notNull().unique(),
    clientName: text("client_name"),
    status: text("status").$type<PlatformMachineDeviceGrantStatus>().notNull(),
    userId: text("user_id").references(() => users.id),
    sessionToken: text("session_token"),
    expiresAt: timestamp("expires_at").notNull(),
    approvedAt: timestamp("approved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    deviceCodeIdx: index("machine_auth_device_grants_device_code_idx").on(
      table.deviceCode,
    ),
    userCodeIdx: index("machine_auth_device_grants_user_code_idx").on(
      table.userCode,
    ),
    statusIdx: index("machine_auth_device_grants_status_idx").on(table.status),
    expiresAtIdx: index("machine_auth_device_grants_expires_at_idx").on(
      table.expiresAt,
    ),
    userIdx: index("machine_auth_device_grants_user_id_idx").on(table.userId),
  }),
);

export const games = pgTable(
  "games",
  {
    id: text("id").primaryKey(), // Changed to text to match user ID style or keep UUID if preferred, but text is easier with BetterAuth user IDs
    userId: text("user_id")
      .references(() => users.id)
      .notNull(),
    name: text("name").notNull(),
    slug: text("slug").unique(), // For pretty URLs
    description: text("description"),
    url: text("url"), // Optional creator-only preview URL used for local/external iframe testing
    arcadeVisibility: text("arcade_visibility")
      .$type<ArcadeVisibility>()
      .default("hidden")
      .notNull(),
    // Schema-owned JSON bucket. See `@/lib/games/game-config-contract` for the
    // Zod schema and validation helpers. All write paths MUST validate via
    // `parseGameConfig` before persisting.
    config: jsonb("config")
      .$type<GameConfig>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("games_user_id_idx").on(table.userId),
    ownerScopeIdx: uniqueIndex("games_owner_scope_idx").on(
      table.id,
      table.userId,
    ),
  }),
);

export const {
  appIds,
  operationalBudgetCycles,
  operationalBudgetEvidence,
  operationalEventDeliveryCommands,
  operationalEventOutbox,
  operationalEvents,
  operationalSyntheticRuns,
  operationalSloEvaluations,
  operationalAlerts,
  operationalAlertIssueProjections,
  operationalControlEvents,
  operationalLaneControls,
  realtimeAdmissionInstances,
  realtimeHostGrantConsumptions,
  realtimeControllerAdmissionLeases,
  realtimeRoomAdmissionLeases,
  runtimeUsageSessions,
  runtimeUsageEvents,
  runtimeUsageControllerSegments,
  runtimeUsageGameSegments,
  runtimeUsageEligibleSegments,
  runtimeUsageGameSessionMetrics,
  runtimeUsageDailyGameMetrics,
} = createRuntimeDatabaseSchema({
  appIdOwnerScopeReference: () => ({
    gameId: games.id,
    creatorId: games.userId,
  }),
});

export const platformSchemaMigrationRunStatusValues = [
  "applying",
  "applied",
  "apply_failed",
  "verified",
  "verification_failed",
] as const;

export type PlatformSchemaMigrationRunStatus =
  (typeof platformSchemaMigrationRunStatusValues)[number];

const platformSchemaMigrationRunStatusSql = sql.raw(
  platformSchemaMigrationRunStatusValues
    .map((status) => `'${status}'`)
    .join(", "),
);

export const platformSchemaMigrationRuns = pgTable(
  "platform_schema_migration_runs",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").default(1).notNull(),
    planDigest: text("plan_digest").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    targetFingerprint: text("target_fingerprint").notNull(),
    sourceCommit: text("source_commit").notNull(),
    sourceHeadTag: text("source_head_tag").notNull(),
    sourceHeadCreatedAt: bigint("source_head_created_at", {
      mode: "number",
    }).notNull(),
    sourceHeadHash: text("source_head_hash").notNull(),
    status: text("status").$type<PlatformSchemaMigrationRunStatus>().notNull(),
    actor: text("actor").notNull(),
    reason: text("reason").notNull(),
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
    backupEvidence: jsonb("backup_evidence")
      .$type<Record<string, unknown>>()
      .notNull(),
    drainEvidence: jsonb("drain_evidence")
      .$type<Record<string, unknown>>()
      .notNull(),
    verification: jsonb("verification").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("platform_schema_migration_runs_plan_digest_uidx").on(
      table.planDigest,
    ),
    uniqueIndex("platform_schema_migration_runs_idempotency_key_uidx").on(
      table.idempotencyKey,
    ),
    index("platform_schema_migration_runs_status_updated_at_idx").on(
      table.status,
      table.updatedAt,
    ),
    check(
      "platform_schema_migration_runs_contract_version_check",
      sql`${table.contractVersion} = 1`,
    ),
    check(
      "platform_schema_migration_runs_status_check",
      sql`${table.status} in (${platformSchemaMigrationRunStatusSql})`,
    ),
    check(
      "platform_schema_migration_runs_digest_check",
      sql`${table.planDigest} ~ '^[a-f0-9]{64}$' and ${table.sourceHeadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "platform_schema_migration_runs_required_text_check",
      sql`length(btrim(${table.idempotencyKey})) > 0 and length(btrim(${table.targetFingerprint})) > 0 and length(btrim(${table.sourceCommit})) > 0 and length(btrim(${table.sourceHeadTag})) > 0 and length(btrim(${table.actor})) > 0 and length(btrim(${table.reason})) > 0`,
    ),
    check(
      "platform_schema_migration_runs_documents_check",
      sql`jsonb_typeof(${table.plan}) = 'object' and jsonb_typeof(${table.backupEvidence}) = 'object' and jsonb_typeof(${table.drainEvidence}) = 'object' and (${table.verification} is null or jsonb_typeof(${table.verification}) = 'object')`,
    ),
    check(
      "platform_schema_migration_runs_lifecycle_check",
      sql`(
        ${table.status} = 'applying'
        and ${table.appliedAt} is null
        and ${table.completedAt} is null
        and ${table.verification} is null
      ) or (
        ${table.status} = 'applied'
        and ${table.appliedAt} is not null
        and ${table.completedAt} is null
        and ${table.verification} is null
      ) or (
        ${table.status} = 'apply_failed'
        and ${table.appliedAt} is null
        and ${table.completedAt} is not null
        and ${table.verification} is not null
      ) or (
        ${table.status} in ('verified', 'verification_failed')
        and ${table.appliedAt} is not null
        and ${table.completedAt} is not null
        and ${table.verification} is not null
      )`,
    ),
  ],
);

export const gameReleaseGenerations = pgTable(
  "game_release_generations",
  {
    id: text("id").primaryKey(),
    releaseId: text("release_id")
      .references((): AnyPgColumn => gameReleases.id, { onDelete: "cascade" })
      .notNull(),
    sequence: integer("sequence").notNull(),
    status: text("status").$type<ReleaseGenerationStatus>().notNull(),
    originalFilename: text("original_filename").notNull(),
    contentType: text("content_type").notNull(),
    declaredSizeBytes: integer("declared_size_bytes").notNull(),
    zipObjectKey: text("zip_object_key").notNull().unique(),
    siteRootKey: text("site_root_key").unique(),
    observedSizeBytes: integer("observed_size_bytes"),
    observedContentType: text("observed_content_type"),
    observedEtag: text("observed_etag"),
    observedLastModifiedAt: timestamp("observed_last_modified_at", {
      withTimezone: true,
    }),
    extractedSizeBytes: integer("extracted_size_bytes"),
    fileCount: integer("file_count"),
    entryPath: text("entry_path"),
    contentHash: text("content_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    uploadObservedAt: timestamp("upload_observed_at", { withTimezone: true }),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true,
    }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    storageInactiveAt: timestamp("storage_inactive_at", { withTimezone: true }),
    storageRetentionWarnedAt: timestamp("storage_retention_warned_at", {
      withTimezone: true,
    }),
    storageRetentionEligibleAt: timestamp("storage_retention_eligible_at", {
      withTimezone: true,
    }),
    storageCleanupStartedAt: timestamp("storage_cleanup_started_at", {
      withTimezone: true,
    }),
    storageDeletedAt: timestamp("storage_deleted_at", { withTimezone: true }),
  },
  (table) => ({
    releaseSequenceIdx: uniqueIndex(
      "game_release_generations_release_sequence_idx",
    ).on(table.releaseId, table.sequence),
    releaseScopeIdx: uniqueIndex(
      "game_release_generations_release_scope_idx",
    ).on(table.id, table.releaseId),
    releaseStatusIdx: index("game_release_generations_release_status_idx").on(
      table.releaseId,
      table.status,
    ),
    oneActiveGenerationPerReleaseIdx: uniqueIndex(
      "game_release_generations_one_active_per_release_idx",
    )
      .on(table.releaseId)
      .where(sql`${table.status} in ('awaiting_upload', 'processing')`),
    createdAtIdx: index("game_release_generations_created_at_idx").on(
      table.createdAt,
    ),
    cleanupIdx: index("game_release_generations_cleanup_idx")
      .on(table.status, table.storageRetentionEligibleAt, table.createdAt)
      .where(
        sql`${table.storageDeletedAt} is null and (${table.status} in ('failed', 'abandoned') or (${table.status} = 'ready' and ${table.storageRetentionEligibleAt} is not null))`,
      ),
    requiredTextCheck: check(
      "game_release_generations_required_text_check",
      sql`btrim(${table.id}) <> '' and btrim(${table.releaseId}) <> '' and btrim(${table.originalFilename}) <> '' and btrim(${table.contentType}) <> '' and btrim(${table.zipObjectKey}) <> '' and (${table.observedContentType} is null or btrim(${table.observedContentType}) <> '') and (${table.observedEtag} is null or btrim(${table.observedEtag}) <> '') and (${table.siteRootKey} is null or btrim(${table.siteRootKey}) <> '') and (${table.entryPath} is null or btrim(${table.entryPath}) <> '')`,
    ),
    sequenceCheck: check(
      "game_release_generations_sequence_check",
      sql`${table.sequence} > 0`,
    ),
    sizeCheck: check(
      "game_release_generations_size_check",
      sql`${table.declaredSizeBytes} > 0 and (${table.observedSizeBytes} is null or ${table.observedSizeBytes} > 0) and (${table.extractedSizeBytes} is null or ${table.extractedSizeBytes} >= 0) and (${table.fileCount} is null or ${table.fileCount} > 0)`,
    ),
    statusCheck: check(
      "game_release_generations_status_check",
      sql`${table.status} in ('awaiting_upload', 'processing', 'ready', 'failed', 'abandoned')`,
    ),
    observedFactsCheck: check(
      "game_release_generations_observed_facts_check",
      sql`(${table.uploadObservedAt} is null and ${table.observedSizeBytes} is null and ${table.observedContentType} is null) or (${table.uploadObservedAt} is not null and ${table.observedSizeBytes} is not null and ${table.observedContentType} is not null)`,
    ),
    outputFactsCheck: check(
      "game_release_generations_output_facts_check",
      sql`(${table.siteRootKey} is null and ${table.extractedSizeBytes} is null and ${table.fileCount} is null and ${table.entryPath} is null and ${table.contentHash} is null) or (${table.siteRootKey} is not null and ${table.extractedSizeBytes} is not null and ${table.fileCount} is not null and ${table.entryPath} is not null and ${table.contentHash} ~ '^[0-9a-f]{64}$')`,
    ),
    storageCleanupCheck: check(
      "game_release_generations_storage_cleanup_check",
      sql`(${table.storageCleanupStartedAt} is null and ${table.storageDeletedAt} is null) or (${table.storageCleanupStartedAt} is not null and (${table.status} in ('failed', 'abandoned') or (${table.status} = 'ready' and ${table.storageRetentionEligibleAt} is not null)) and (${table.storageDeletedAt} is null or ${table.storageDeletedAt} >= ${table.storageCleanupStartedAt}))`,
    ),
    storageRetentionCheck: check(
      "game_release_generations_storage_retention_check",
      sql`(
        ${table.storageInactiveAt} is null
        and ${table.storageRetentionWarnedAt} is null
        and ${table.storageRetentionEligibleAt} is null
      ) or (
        ${table.status} = 'ready'
        and ${table.storageInactiveAt} is not null
        and (
          (${table.storageRetentionWarnedAt} is null and ${table.storageRetentionEligibleAt} is null)
          or (
            ${table.storageRetentionWarnedAt} is not null
            and ${table.storageRetentionEligibleAt} is not null
            and ${table.storageRetentionWarnedAt} >= ${table.storageInactiveAt}
            and ${table.storageRetentionEligibleAt} >= ${table.storageInactiveAt} + interval '180 days'
            and ${table.storageRetentionEligibleAt} >= ${table.storageRetentionWarnedAt} + interval '7 days'
          )
        )
      )`,
    ),
    lifecycleCheck: check(
      "game_release_generations_lifecycle_check",
      sql`(
        ${table.status} = 'awaiting_upload'
        and ${table.uploadObservedAt} is null
        and ${table.processingStartedAt} is null
        and ${table.readyAt} is null
        and ${table.failedAt} is null
        and ${table.abandonedAt} is null
        and ${table.siteRootKey} is null
      ) or (
        ${table.status} = 'processing'
        and ${table.uploadObservedAt} is not null
        and ${table.processingStartedAt} is not null
        and ${table.readyAt} is null
        and ${table.failedAt} is null
        and ${table.abandonedAt} is null
        and ${table.siteRootKey} is null
      ) or (
        ${table.status} = 'ready'
        and ${table.uploadObservedAt} is not null
        and ${table.processingStartedAt} is not null
        and ${table.readyAt} is not null
        and ${table.failedAt} is null
        and ${table.abandonedAt} is null
        and ${table.siteRootKey} is not null
      ) or (
        ${table.status} = 'failed'
        and ${table.readyAt} is null
        and ${table.failedAt} is not null
        and ${table.abandonedAt} is null
        and ${table.siteRootKey} is null
      ) or (
        ${table.status} = 'abandoned'
        and ${table.readyAt} is null
        and ${table.failedAt} is null
        and ${table.abandonedAt} is not null
        and ${table.siteRootKey} is null
      )`,
    ),
  }),
);

export const gameReleases = pgTable(
  "game_releases",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id")
      .references(() => games.id, { onDelete: "cascade" })
      .notNull(),
    sourceKind: text("source_kind").$type<GameReleaseSourceKind>().notNull(),
    status: text("status").$type<GameReleaseStatus>().notNull(),
    candidateGenerationId: text("candidate_generation_id"),
    promotedGenerationId: text("promoted_generation_id"),
    versionLabel: text("version_label"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    uploadedAt: timestamp("uploaded_at"),
    checkedAt: timestamp("checked_at"),
    publishedAt: timestamp("published_at"),
    quarantinedAt: timestamp("quarantined_at"),
    archivedAt: timestamp("archived_at"),
  },
  (table) => ({
    gameIdx: index("game_releases_game_id_idx").on(table.gameId),
    gameScopeIdx: uniqueIndex("game_releases_game_scope_idx").on(
      table.id,
      table.gameId,
    ),
    candidateGenerationFk: foreignKey({
      name: "game_releases_candidate_generation_fk",
      columns: [table.candidateGenerationId, table.id],
      foreignColumns: [
        gameReleaseGenerations.id,
        gameReleaseGenerations.releaseId,
      ],
    }).onDelete("restrict"),
    promotedGenerationFk: foreignKey({
      name: "game_releases_promoted_generation_fk",
      columns: [table.promotedGenerationId, table.id],
      foreignColumns: [
        gameReleaseGenerations.id,
        gameReleaseGenerations.releaseId,
      ],
    }).onDelete("restrict"),
    statusIdx: index("game_releases_status_idx").on(table.status),
    createdAtIdx: index("game_releases_created_at_idx").on(table.createdAt),
    oneLivePerGameIdx: uniqueIndex("game_releases_one_live_per_game_idx")
      .on(table.gameId)
      .where(sql`${table.status} = 'live'`),
    generationLifecycleCheck: check(
      "game_releases_generation_lifecycle_check",
      sql`(
        ${table.status} = 'draft'
        and ${table.candidateGenerationId} is null
        and ${table.promotedGenerationId} is null
      ) or (
        ${table.status} in ('uploading', 'checking')
        and ${table.candidateGenerationId} is not null
      ) or (
        ${table.status} in ('ready', 'live', 'quarantined')
        and ${table.candidateGenerationId} is null
        and ${table.promotedGenerationId} is not null
      ) or (
        ${table.status} = 'failed'
        and ${table.candidateGenerationId} is null
      ) or ${table.status} = 'archived'`,
    ),
  }),
);

export const operationalJobCommands = pgTable(
  "operational_job_commands",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    kind: text("kind").$type<OperationalJobCommandKind>().notNull(),
    requestHash: text("request_hash").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason").notNull(),
    request: jsonb("request")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    kindCreatedAtIdx: index("operational_job_commands_kind_created_at_idx").on(
      table.kind,
      table.createdAt,
    ),
    contractVersionCheck: check(
      "operational_job_commands_contract_version_check",
      sql`${table.contractVersion} = ${operationalJobContractVersionSql}`,
    ),
    kindCheck: check(
      "operational_job_commands_kind_check",
      sql`${table.kind} in ('enqueue', 'schedule_cleanup', 'cancel', 'replay', 'repair_expired')`,
    ),
    requiredTextCheck: check(
      "operational_job_commands_required_text_check",
      sql`btrim(${table.id}) <> '' and btrim(${table.idempotencyKey}) <> '' and btrim(${table.actor}) <> '' and btrim(${table.reason}) <> ''`,
    ),
    requestHashCheck: check(
      "operational_job_commands_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    jsonShapeCheck: check(
      "operational_job_commands_json_shape_check",
      sql`jsonb_typeof(${table.request}) = 'object' and (${table.result} is null or jsonb_typeof(${table.result}) = 'object')`,
    ),
    completionCheck: check(
      "operational_job_commands_completion_check",
      sql`(${table.result} is null and ${table.completedAt} is null) or (${table.result} is not null and ${table.completedAt} is not null and ${table.completedAt} >= ${table.createdAt})`,
    ),
  }),
);

export const operationalJobs = pgTable(
  "operational_jobs",
  {
    id: text("id").primaryKey(),
    contractVersion: integer("contract_version").notNull(),
    kind: text("kind").$type<OperationalJobKind>().notNull(),
    lane: text("lane").notNull(),
    status: text("status").$type<OperationalJobStatus>().notNull(),
    creatorId: text("creator_id").notNull(),
    gameId: text("game_id").notNull(),
    releaseId: text("release_id"),
    generationId: text("generation_id"),
    resourceKind: text("resource_kind")
      .$type<OperationalJobResourceKind>()
      .notNull(),
    resourceId: text("resource_id").notNull(),
    createdByCommandId: text("created_by_command_id")
      .references(() => operationalJobCommands.id, { onDelete: "restrict" })
      .notNull(),
    requestHash: text("request_hash").notNull(),
    correlationId: text("correlation_id").notNull(),
    replayOfJobId: text("replay_of_job_id"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    progress: jsonb("progress")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    lastError: jsonb("last_error").$type<Record<string, unknown>>(),
    priority: integer("priority").default(0).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    revision: integer("revision").default(1).notNull(),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", {
      withTimezone: true,
    }),
    cancelRequestedBy: text("cancel_requested_by"),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    creatorScopeFk: foreignKey({
      name: "operational_jobs_creator_scope_fk",
      columns: [table.gameId, table.creatorId],
      foreignColumns: [games.id, games.userId],
    }).onDelete("cascade"),
    releaseScopeFk: foreignKey({
      name: "operational_jobs_release_scope_fk",
      columns: [table.releaseId, table.gameId],
      foreignColumns: [gameReleases.id, gameReleases.gameId],
    }).onDelete("cascade"),
    generationScopeFk: foreignKey({
      name: "operational_jobs_generation_scope_fk",
      columns: [table.generationId, table.releaseId],
      foreignColumns: [
        gameReleaseGenerations.id,
        gameReleaseGenerations.releaseId,
      ],
    }).onDelete("cascade"),
    replayOfFk: foreignKey({
      name: "operational_jobs_replay_of_fk",
      columns: [table.replayOfJobId, table.resourceKind, table.resourceId],
      foreignColumns: [table.id, table.resourceKind, table.resourceId],
    }).onDelete("restrict"),
    jobReleaseScopeIdx: uniqueIndex(
      "operational_jobs_job_release_scope_idx",
    ).on(table.id, table.releaseId),
    jobReleaseGenerationScopeIdx: uniqueIndex(
      "operational_jobs_job_release_generation_scope_idx",
    ).on(table.id, table.releaseId, table.generationId),
    jobResourceScopeIdx: uniqueIndex(
      "operational_jobs_job_resource_scope_idx",
    ).on(table.id, table.resourceKind, table.resourceId),
    activeResourceIdx: uniqueIndex("operational_jobs_active_resource_idx")
      .on(table.kind, table.resourceKind, table.resourceId)
      .where(sql`${table.status} in ('queued', 'running', 'cancel_requested')`),
    queueIdx: index("operational_jobs_queue_idx")
      .on(
        table.kind,
        table.status,
        table.availableAt,
        table.priority,
        table.createdAt,
      )
      .where(sql`${table.status} = 'queued'`),
    leaseExpiryIdx: index("operational_jobs_lease_expiry_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.status} in ('running', 'cancel_requested')`),
    creatorStatusIdx: index("operational_jobs_creator_status_idx").on(
      table.creatorId,
      table.kind,
      table.status,
    ),
    releaseHistoryIdx: index("operational_jobs_release_history_idx").on(
      table.releaseId,
      table.createdAt,
    ),
    correlationIdx: index("operational_jobs_correlation_idx").on(
      table.correlationId,
    ),
    createdByCommandIdx: index("operational_jobs_created_by_command_idx").on(
      table.createdByCommandId,
    ),
    kindCheck: check(
      "operational_jobs_kind_check",
      sql`${table.kind} in ('release_artifact_processing', 'release_browser_validation', 'release_image_moderation', 'lifecycle_cleanup')`,
    ),
    contractVersionCheck: check(
      "operational_jobs_contract_version_check",
      sql`${table.contractVersion} = ${operationalJobContractVersionSql}`,
    ),
    requiredTextCheck: check(
      "operational_jobs_required_text_check",
      sql`btrim(${table.id}) <> '' and btrim(${table.creatorId}) <> '' and btrim(${table.gameId}) <> '' and (${table.releaseId} is null or btrim(${table.releaseId}) <> '') and (${table.generationId} is null or btrim(${table.generationId}) <> '') and btrim(${table.resourceKind}) <> '' and btrim(${table.resourceId}) <> '' and btrim(${table.createdByCommandId}) <> '' and btrim(${table.correlationId}) <> ''`,
    ),
    requestHashCheck: check(
      "operational_jobs_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    jsonShapeCheck: check(
      "operational_jobs_json_shape_check",
      sql`jsonb_typeof(${table.payload}) = 'object' and jsonb_typeof(${table.progress}) = 'object' and (${table.result} is null or jsonb_typeof(${table.result}) = 'object') and (${table.lastError} is null or jsonb_typeof(${table.lastError}) = 'object')`,
    ),
    replayCheck: check(
      "operational_jobs_replay_check",
      sql`${table.replayOfJobId} is null or ${table.replayOfJobId} <> ${table.id}`,
    ),
    statusCheck: check(
      "operational_jobs_status_check",
      sql`${table.status} in ('queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'canceled')`,
    ),
    kindLaneCheck: check(
      "operational_jobs_kind_lane_check",
      sql`(${table.kind} = 'release_artifact_processing' and ${table.lane} = 'release_processing') or (${table.kind} = 'release_browser_validation' and ${table.lane} = 'browser_validation') or (${table.kind} = 'release_image_moderation' and ${table.lane} = 'moderation') or (${table.kind} = 'lifecycle_cleanup' and ${table.lane} = 'lifecycle_cleanup')`,
    ),
    resourceKindCheck: check(
      "operational_jobs_resource_kind_check",
      sql`${table.resourceKind} in ('release_generation', 'game_media_asset')`,
    ),
    resourceScopeCheck: check(
      "operational_jobs_resource_scope_check",
      sql`(
        ${table.resourceKind} = 'release_generation'
        and ${table.releaseId} is not null
        and ${table.generationId} is not null
        and ${table.resourceId} = ${table.generationId}
      ) or (
        ${table.kind} = 'lifecycle_cleanup'
        and ${table.resourceKind} = 'game_media_asset'
        and ${table.releaseId} is null
        and ${table.generationId} is null
      )`,
    ),
    attemptsCheck: check(
      "operational_jobs_attempts_check",
      sql`${table.attemptCount} >= 0 and ${table.maxAttempts} > 0 and ${table.attemptCount} <= ${table.maxAttempts}`,
    ),
    revisionCheck: check(
      "operational_jobs_revision_check",
      sql`${table.revision} > 0`,
    ),
    timeCheck: check(
      "operational_jobs_time_check",
      sql`${table.deadlineAt} > ${table.createdAt}`,
    ),
    lifecycleCheck: check(
      "operational_jobs_lifecycle_check",
      sql`(
        ${table.status} = 'queued'
        and ${table.leaseOwner} is null
        and ${table.leaseToken} is null
        and ${table.leaseExpiresAt} is null
        and ${table.finishedAt} is null
      ) or (
        ${table.status} in ('running', 'cancel_requested')
        and ${table.leaseOwner} is not null
        and ${table.leaseToken} is not null
        and ${table.leaseExpiresAt} is not null
        and ${table.lastHeartbeatAt} is not null
        and ${table.startedAt} is not null
        and ${table.finishedAt} is null
      ) or (
        ${table.status} in ('succeeded', 'failed', 'canceled')
        and ${table.leaseOwner} is null
        and ${table.leaseToken} is null
        and ${table.leaseExpiresAt} is null
        and ${table.finishedAt} is not null
      )`,
    ),
    cancelCheck: check(
      "operational_jobs_cancel_check",
      sql`${table.status} <> 'cancel_requested' or (${table.cancelRequestedAt} is not null and ${table.cancelRequestedBy} is not null and ${table.cancelReason} is not null)`,
    ),
    terminalEvidenceCheck: check(
      "operational_jobs_terminal_evidence_check",
      sql`(${table.status} <> 'succeeded' or ${table.result} is not null) and (${table.status} <> 'failed' or ${table.lastError} is not null)`,
    ),
    leaseDeadlineCheck: check(
      "operational_jobs_lease_deadline_check",
      sql`${table.leaseExpiresAt} is null or ${table.leaseExpiresAt} <= ${table.deadlineAt}`,
    ),
  }),
);

export const operationalJobAttempts = pgTable(
  "operational_job_attempts",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .references(() => operationalJobs.id, { onDelete: "cascade" })
      .notNull(),
    releaseId: text("release_id"),
    generationId: text("generation_id"),
    attempt: integer("attempt").notNull(),
    status: text("status").$type<OperationalJobAttemptStatus>().notNull(),
    leaseOwner: text("lease_owner").notNull(),
    leaseToken: text("lease_token").notNull().unique(),
    progress: jsonb("progress")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    lastError: jsonb("last_error").$type<Record<string, unknown>>(),
    outputRootKey: text("output_root_key"),
    outputManifest: jsonb("output_manifest").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", {
      withTimezone: true,
    }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outputCleanedAt: timestamp("output_cleaned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    jobScopeFk: foreignKey({
      name: "operational_job_attempts_job_scope_fk",
      columns: [table.jobId, table.releaseId, table.generationId],
      foreignColumns: [
        operationalJobs.id,
        operationalJobs.releaseId,
        operationalJobs.generationId,
      ],
    }).onDelete("cascade"),
    jobAttemptIdx: uniqueIndex("operational_job_attempts_job_attempt_idx").on(
      table.jobId,
      table.attempt,
    ),
    generationStatusIdx: index(
      "operational_job_attempts_generation_status_idx",
    ).on(table.generationId, table.status),
    finishedAtIdx: index("operational_job_attempts_finished_at_idx").on(
      table.finishedAt,
    ),
    cleanupIdx: index("operational_job_attempts_cleanup_idx")
      .on(table.status, table.finishedAt)
      .where(
        sql`${table.outputRootKey} is not null and ${table.outputCleanedAt} is null and ${table.status} in ('failed', 'canceled', 'lease_expired')`,
      ),
    requiredTextCheck: check(
      "operational_job_attempts_required_text_check",
      sql`btrim(${table.id}) <> '' and btrim(${table.jobId}) <> '' and (${table.releaseId} is null or btrim(${table.releaseId}) <> '') and (${table.generationId} is null or btrim(${table.generationId}) <> '') and btrim(${table.leaseOwner}) <> '' and btrim(${table.leaseToken}) <> ''`,
    ),
    attemptCheck: check(
      "operational_job_attempts_attempt_check",
      sql`${table.attempt} > 0`,
    ),
    statusCheck: check(
      "operational_job_attempts_status_check",
      sql`${table.status} in ('running', 'succeeded', 'failed', 'canceled', 'lease_expired')`,
    ),
    jsonShapeCheck: check(
      "operational_job_attempts_json_shape_check",
      sql`jsonb_typeof(${table.progress}) = 'object' and (${table.result} is null or jsonb_typeof(${table.result}) = 'object') and (${table.lastError} is null or jsonb_typeof(${table.lastError}) = 'object') and (${table.outputManifest} is null or jsonb_typeof(${table.outputManifest}) = 'object')`,
    ),
    outputRootCheck: check(
      "operational_job_attempts_output_root_check",
      sql`${table.outputRootKey} is null or (btrim(${table.outputRootKey}) <> '' and left(${table.outputRootKey}, 1) <> '/' and strpos(${table.outputRootKey}, '..') = 0)`,
    ),
    outputCleanupCheck: check(
      "operational_job_attempts_output_cleanup_check",
      sql`${table.outputCleanedAt} is null or (${table.outputRootKey} is not null and ${table.status} in ('failed', 'canceled', 'lease_expired') and ${table.finishedAt} is not null and ${table.outputCleanedAt} >= ${table.finishedAt})`,
    ),
    lifecycleCheck: check(
      "operational_job_attempts_lifecycle_check",
      sql`(
        ${table.status} = 'running'
        and ${table.finishedAt} is null
        and ${table.result} is null
        and ${table.lastError} is null
      ) or (
        ${table.status} = 'succeeded'
        and ${table.finishedAt} is not null
        and ${table.result} is not null
        and ${table.lastError} is null
      ) or (
        ${table.status} in ('failed', 'lease_expired')
        and ${table.finishedAt} is not null
        and ${table.lastError} is not null
      ) or (
        ${table.status} = 'canceled'
        and ${table.finishedAt} is not null
      )`,
    ),
  }),
);

export const operationalJobEvents = pgTable(
  "operational_job_events",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .references(() => operationalJobs.id, { onDelete: "cascade" })
      .notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    kind: text("kind").$type<OperationalJobEventKind>().notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    nextRevision: integer("next_revision").notNull(),
    fromStatus: text("from_status").$type<OperationalJobStatus>(),
    toStatus: text("to_status").$type<OperationalJobStatus>().notNull(),
    attempt: integer("attempt").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason").notNull(),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    correlationId: text("correlation_id").notNull(),
    causationEventId: text("causation_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    causationFk: foreignKey({
      name: "operational_job_events_causation_fk",
      columns: [table.causationEventId],
      foreignColumns: [table.id],
    }).onDelete("restrict"),
    jobRevisionIdx: uniqueIndex("operational_job_events_job_revision_idx").on(
      table.jobId,
      table.nextRevision,
    ),
    correlationIdx: index("operational_job_events_correlation_idx").on(
      table.correlationId,
      table.createdAt,
    ),
    kindCheck: check(
      "operational_job_events_kind_check",
      sql`${table.kind} in ('enqueued', 'claimed', 'stage_recorded', 'retry_scheduled', 'cancel_requested', 'canceled', 'succeeded', 'failed', 'lease_recovered', 'output_cleaned', 'replayed')`,
    ),
    revisionCheck: check(
      "operational_job_events_revision_check",
      sql`${table.expectedRevision} >= 0 and ${table.nextRevision} = ${table.expectedRevision} + 1`,
    ),
    attemptCheck: check(
      "operational_job_events_attempt_check",
      sql`${table.attempt} >= 0`,
    ),
    requiredTextCheck: check(
      "operational_job_events_required_text_check",
      sql`btrim(${table.id}) <> '' and btrim(${table.jobId}) <> '' and btrim(${table.idempotencyKey}) <> '' and btrim(${table.actor}) <> '' and btrim(${table.reason}) <> '' and btrim(${table.correlationId}) <> ''`,
    ),
    detailsShapeCheck: check(
      "operational_job_events_details_shape_check",
      sql`jsonb_typeof(${table.details}) = 'object'`,
    ),
    causationCheck: check(
      "operational_job_events_causation_check",
      sql`${table.causationEventId} is null or ${table.causationEventId} <> ${table.id}`,
    ),
  }),
);

export const gameReleaseChecks = pgTable(
  "game_release_checks",
  {
    id: text("id").primaryKey(),
    releaseId: text("release_id")
      .references(() => gameReleases.id, { onDelete: "cascade" })
      .notNull(),
    generationId: text("generation_id").notNull(),
    jobId: text("job_id"),
    jobAttempt: integer("job_attempt"),
    kind: text("kind").$type<ReleaseCheckKind>().notNull(),
    status: text("status").$type<ReleaseCheckStatus>().notNull(),
    summary: text("summary"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    releaseIdx: index("game_release_checks_release_id_idx").on(table.releaseId),
    generationIdx: index("game_release_checks_generation_id_idx").on(
      table.generationId,
    ),
    kindIdx: index("game_release_checks_kind_idx").on(table.kind),
    statusIdx: index("game_release_checks_status_idx").on(table.status),
    createdAtIdx: index("game_release_checks_created_at_idx").on(
      table.createdAt,
    ),
    jobIdx: index("game_release_checks_job_id_idx").on(table.jobId),
    jobReleaseScopeFk: foreignKey({
      name: "game_release_checks_job_release_scope_fk",
      columns: [table.jobId, table.releaseId],
      foreignColumns: [operationalJobs.id, operationalJobs.releaseId],
    }).onDelete("cascade"),
    jobAttemptGenerationFk: foreignKey({
      name: "game_release_checks_job_attempt_generation_fk",
      columns: [table.jobId, table.jobAttempt],
      foreignColumns: [
        operationalJobAttempts.jobId,
        operationalJobAttempts.attempt,
      ],
    }).onDelete("cascade"),
    generationReleaseScopeFk: foreignKey({
      name: "game_release_checks_generation_release_scope_fk",
      columns: [table.generationId, table.releaseId],
      foreignColumns: [
        gameReleaseGenerations.id,
        gameReleaseGenerations.releaseId,
      ],
    }).onDelete("no action"),
    jobAttemptCheck: check(
      "game_release_checks_job_attempt_check",
      sql`(${table.jobId} is null and ${table.jobAttempt} is null) or (${table.jobId} is not null and ${table.jobAttempt} > 0)`,
    ),
  }),
);

export const gameReleaseReports = pgTable(
  "game_release_reports",
  {
    id: text("id").primaryKey(),
    releaseId: text("release_id")
      .references(() => gameReleases.id, { onDelete: "cascade" })
      .notNull(),
    status: text("status").$type<ReleaseReportStatus>().notNull(),
    source: text("source").$type<ReleaseReportSource>().notNull(),
    reason: text("reason").notNull(),
    details: text("details"),
    reporterEmail: text("reporter_email"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    reviewedAt: timestamp("reviewed_at"),
  },
  (table) => ({
    releaseIdx: index("game_release_reports_release_id_idx").on(
      table.releaseId,
    ),
    statusIdx: index("game_release_reports_status_idx").on(table.status),
    createdAtIdx: index("game_release_reports_created_at_idx").on(
      table.createdAt,
    ),
  }),
);

export const gameMediaAssets = pgTable(
  "game_media_assets",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id")
      .references(() => games.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind").$type<GameMediaKind>().notNull(),
    status: text("status").$type<GameMediaStatus>().notNull(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    checksum: text("checksum"),
    storageKey: text("storage_key").notNull().unique(),
    width: integer("width"),
    height: integer("height"),
    durationSeconds: integer("duration_seconds"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    inactiveAt: timestamp("inactive_at", { withTimezone: true }),
    storageCleanupStartedAt: timestamp("storage_cleanup_started_at", {
      withTimezone: true,
    }),
    storageDeletedAt: timestamp("storage_deleted_at", { withTimezone: true }),
  },
  (table) => ({
    gameIdx: index("game_media_assets_game_id_idx").on(table.gameId),
    kindIdx: index("game_media_assets_kind_idx").on(table.kind),
    statusIdx: index("game_media_assets_status_idx").on(table.status),
    createdAtIdx: index("game_media_assets_created_at_idx").on(table.createdAt),
    cleanupIdx: index("game_media_assets_cleanup_idx")
      .on(table.status, table.inactiveAt, table.createdAt)
      .where(
        sql`${table.storageDeletedAt} is null and ${table.status} in ('uploading', 'failed', 'archived')`,
      ),
    assignmentTargetIdx: uniqueIndex(
      "game_media_assets_assignment_target_idx",
    ).on(table.id, table.gameId, table.kind, table.status),
    storageCleanupCheck: check(
      "game_media_assets_storage_cleanup_check",
      sql`(${table.storageCleanupStartedAt} is null and ${table.storageDeletedAt} is null) or (${table.storageCleanupStartedAt} is not null and ${table.status} in ('failed', 'archived') and (${table.storageDeletedAt} is null or ${table.storageDeletedAt} >= ${table.storageCleanupStartedAt}))`,
    ),
    inactiveAtCheck: check(
      "game_media_assets_inactive_at_check",
      sql`(${table.status} in ('failed', 'archived') and ${table.inactiveAt} is not null) or (${table.status} in ('uploading', 'ready') and ${table.inactiveAt} is null)`,
    ),
  }),
);

export const gameMediaAssignments = pgTable(
  "game_media_assignments",
  {
    gameId: text("game_id")
      .references(() => games.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind").$type<GameMediaKind>().notNull(),
    assetId: text("asset_id").notNull(),
    assetStatus: text("asset_status")
      .$type<GameMediaStatus>()
      .default("ready")
      .notNull(),
    assignedAt: timestamp("assigned_at").defaultNow().notNull(),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.gameId, table.kind] }),
    assetIdx: uniqueIndex("game_media_assignments_asset_id_idx").on(
      table.assetId,
    ),
    readyAssetCheck: check(
      "game_media_assignments_ready_asset_check",
      sql`${table.assetStatus} = 'ready'`,
    ),
    assetIntegrity: foreignKey({
      name: "game_media_assignments_asset_integrity_fk",
      columns: [table.assetId, table.gameId, table.kind, table.assetStatus],
      foreignColumns: [
        gameMediaAssets.id,
        gameMediaAssets.gameId,
        gameMediaAssets.kind,
        gameMediaAssets.status,
      ],
    }).onDelete("cascade"),
  }),
);

export const productTelemetryEvents = pgTable(
  "product_telemetry_events",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull(),
    kind: text("kind").$type<ProductTelemetryStoredEventKind>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    anonymousSessionId: text("anonymous_session_id"),
    surface: text("surface").$type<ProductTelemetrySurface>().notNull(),
    pageKey: text("page_key").notNull(),
    actorClass: text("actor_class")
      .$type<ProductTelemetryActorClass>()
      .notNull(),
    agentFamily: text("agent_family").$type<ProductTelemetryAgentFamily>(),
    referrerSource: text("referrer_source")
      .$type<ProductTelemetryReferrerSource>()
      .notNull(),
    referrerHost: text("referrer_host"),
    campaignSource: text("campaign_source"),
    campaignMedium: text("campaign_medium"),
    campaignName: text("campaign_name"),
    placement: text("placement").$type<ProductTelemetryPlacement>(),
    externalTarget:
      text("external_target").$type<ProductTelemetryExternalTarget>(),
    agentResource:
      text("agent_resource").$type<ProductTelemetryAgentResource>(),
    deploymentEnvironment: text("deployment_environment")
      .$type<ProductTelemetryDeploymentEnvironment>()
      .notNull(),
    deploymentId: text("deployment_id").notNull(),
  },
  (table) => ({
    occurredAtIdx: index("product_telemetry_events_occurred_at_idx").on(
      table.occurredAt,
    ),
    receivedAtIdx: index("product_telemetry_events_received_at_idx").on(
      table.receivedAt,
    ),
    kindIdx: index("product_telemetry_events_kind_idx").on(table.kind),
    surfaceIdx: index("product_telemetry_events_surface_idx").on(table.surface),
    actorClassIdx: index("product_telemetry_events_actor_class_idx").on(
      table.actorClass,
    ),
    deploymentIdx: index("product_telemetry_events_deployment_idx").on(
      table.deploymentEnvironment,
      table.deploymentId,
    ),
  }),
);

export const productTelemetryDailyMetrics = pgTable(
  "product_telemetry_daily_metrics",
  {
    id: text("id").primaryKey(),
    bucketDate: date("bucket_date").notNull(),
    kind: text("kind").$type<ProductTelemetryStoredEventKind>().notNull(),
    surface: text("surface").$type<ProductTelemetrySurface>().notNull(),
    pageKey: text("page_key").notNull(),
    actorClass: text("actor_class")
      .$type<ProductTelemetryActorClass>()
      .notNull(),
    agentFamily: text("agent_family").$type<ProductTelemetryAgentFamily>(),
    referrerSource: text("referrer_source")
      .$type<ProductTelemetryReferrerSource>()
      .notNull(),
    referrerHost: text("referrer_host"),
    campaignSource: text("campaign_source"),
    campaignMedium: text("campaign_medium"),
    campaignName: text("campaign_name"),
    placement: text("placement").$type<ProductTelemetryPlacement>(),
    externalTarget:
      text("external_target").$type<ProductTelemetryExternalTarget>(),
    agentResource:
      text("agent_resource").$type<ProductTelemetryAgentResource>(),
    deploymentEnvironment: text("deployment_environment")
      .$type<ProductTelemetryDeploymentEnvironment>()
      .notNull(),
    deploymentId: text("deployment_id").notNull(),
    eventCount: integer("event_count").default(0).notNull(),
    anonymousSessionCount: integer("anonymous_session_count")
      .default(0)
      .notNull(),
    firstOccurredAt: timestamp("first_occurred_at", {
      withTimezone: true,
    }).notNull(),
    lastOccurredAt: timestamp("last_occurred_at", {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    bucketDateIdx: index("product_telemetry_daily_metrics_bucket_date_idx").on(
      table.bucketDate,
    ),
    kindIdx: index("product_telemetry_daily_metrics_kind_idx").on(table.kind),
    surfaceIdx: index("product_telemetry_daily_metrics_surface_idx").on(
      table.surface,
    ),
    deploymentIdx: index("product_telemetry_daily_metrics_deployment_idx").on(
      table.deploymentEnvironment,
      table.deploymentId,
    ),
  }),
);

export const productTelemetryDailySessionContributions = pgTable(
  "product_telemetry_daily_session_contributions",
  {
    id: text("id").primaryKey(),
    metricId: text("metric_id").notNull(),
    bucketDate: date("bucket_date").notNull(),
    anonymousSessionId: text("anonymous_session_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    metricFk: foreignKey({
      name: "pt_session_contributions_metric_fk",
      columns: [table.metricId],
      foreignColumns: [productTelemetryDailyMetrics.id],
    }).onDelete("cascade"),
    metricSessionIdx: uniqueIndex(
      "pt_session_contributions_metric_session_uidx",
    ).on(table.metricId, table.anonymousSessionId),
    bucketDateIdx: index("pt_session_contributions_bucket_date_idx").on(
      table.bucketDate,
    ),
  }),
);
