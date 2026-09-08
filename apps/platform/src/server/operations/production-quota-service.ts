import { db } from "@/db";
import {
  gameMediaAssets,
  gameReleaseChecks,
  gameReleaseGenerations,
  gameReleases,
  games,
  operationalJobs,
  realtimeAdmissionInstances,
  realtimeRoomAdmissionLeases,
  runtimeUsageGameSegments,
} from "@/db/schema";
import {
  operationalQuotaKeyValues,
  realtimeAdmissionInstanceIsLive,
  type OperationalLane,
  type OperationalQuotaKey,
} from "@air-jam/database-contract";
import {
  and,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  min,
  or,
  sql,
  sum,
} from "drizzle-orm";
import { getOperationalBudgetStatus } from "./production-budget-service";
import { getOperationalLaneControl } from "./production-control-service";
import {
  decideOperationalQuotaAdmission,
  OPERATIONAL_QUOTA_POLICIES,
  type OperationalQuotaAdmissionDecision,
  type OperationalQuotaUsageSnapshot,
} from "./production-quota-policy";

const ROLLING_30_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

type QuotaDatabase = Pick<typeof db, "query" | "select">;
type QuotaTransactionalDatabase = Pick<typeof db, "transaction">;

export class OperationalQuotaScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationalQuotaScopeError";
  }
}

const normalizeRequiredText = (
  value: string | undefined,
  label: string,
): string => {
  const normalized = value?.trim() ?? "";
  if (!normalized)
    throw new OperationalQuotaScopeError(`${label} is required.`);
  return normalized;
};

const toSafeNonNegativeInteger = (value: unknown, label: string): number => {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OperationalQuotaScopeError(
      `${label} must resolve to a non-negative safe integer.`,
    );
  }
  return parsed;
};

const dateValue = (value: unknown): Date | null => {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const assertOwnedGame = async ({
  database,
  creatorId,
  gameId,
}: {
  database: QuotaDatabase;
  creatorId: string;
  gameId: string;
}): Promise<void> => {
  const game = await database.query.games.findFirst({
    columns: { id: true },
    where: (table, { and, eq }) =>
      and(eq(table.id, gameId), eq(table.userId, creatorId)),
  });
  if (!game) {
    throw new OperationalQuotaScopeError(
      "Game was not found in the requested creator scope.",
    );
  }
};

const availableUsage = ({
  key,
  scopeId,
  observedAt,
  current,
  resetAt = null,
}: {
  key: OperationalQuotaKey;
  scopeId: string;
  observedAt: Date;
  current: number;
  resetAt?: Date | null;
}): OperationalQuotaUsageSnapshot => {
  const policy = OPERATIONAL_QUOTA_POLICIES[key];
  return {
    key,
    scope: { kind: policy.scopeKind, id: scopeId },
    authorityStatus: "available",
    authorityReason: null,
    current,
    limit: policy.limit,
    remaining: Math.max(policy.limit - current, 0),
    unit: policy.unit,
    window: policy.window,
    observedAt: observedAt.toISOString(),
    resetAt: resetAt?.toISOString() ?? null,
  };
};

const loadManagedStorageBytes = async ({
  database,
  creatorId,
  gameId,
}: {
  database: QuotaDatabase;
  creatorId: string;
  gameId?: string;
}): Promise<number> => {
  const gameScope = gameId
    ? and(eq(games.userId, creatorId), eq(games.id, gameId))
    : eq(games.userId, creatorId);
  const [mediaRows, generationRows] = await Promise.all([
    database
      .select({ bytes: sum(gameMediaAssets.sizeBytes) })
      .from(gameMediaAssets)
      .innerJoin(games, eq(gameMediaAssets.gameId, games.id))
      .where(and(gameScope, isNull(gameMediaAssets.storageDeletedAt))),
    database
      .select({
        bytes: sql<number>`coalesce(sum(greatest(${gameReleaseGenerations.declaredSizeBytes}, coalesce(${gameReleaseGenerations.observedSizeBytes}, 0)) + coalesce(${gameReleaseGenerations.extractedSizeBytes}, 0)), 0)`,
      })
      .from(gameReleaseGenerations)
      .innerJoin(
        gameReleases,
        eq(gameReleaseGenerations.releaseId, gameReleases.id),
      )
      .innerJoin(games, eq(gameReleases.gameId, games.id))
      .where(and(gameScope, isNull(gameReleaseGenerations.storageDeletedAt))),
  ]);
  return toSafeNonNegativeInteger(
    toSafeNonNegativeInteger(mediaRows[0]?.bytes, "Managed media bytes") +
      toSafeNonNegativeInteger(
        generationRows[0]?.bytes,
        "Managed release generation bytes",
      ),
    "Total managed storage bytes",
  );
};

const loadReleaseSubmissionUsage = async ({
  database,
  creatorId,
  since,
}: {
  database: QuotaDatabase;
  creatorId: string;
  since: Date;
}) => {
  const rows = await database
    .select({ total: count(), oldestAt: min(gameReleases.createdAt) })
    .from(gameReleases)
    .innerJoin(games, eq(gameReleases.gameId, games.id))
    .where(
      and(eq(games.userId, creatorId), gte(gameReleases.createdAt, since)),
    );
  return {
    current: toSafeNonNegativeInteger(rows[0]?.total, "Release submissions"),
    oldestAt: dateValue(rows[0]?.oldestAt),
  };
};

const loadBrowserValidationUsage = async ({
  database,
  creatorId,
  since,
}: {
  database: QuotaDatabase;
  creatorId: string;
  since: Date;
}) => {
  const rows = await database
    .select({ total: count(), oldestAt: min(gameReleaseChecks.createdAt) })
    .from(gameReleaseChecks)
    .innerJoin(gameReleases, eq(gameReleaseChecks.releaseId, gameReleases.id))
    .innerJoin(games, eq(gameReleases.gameId, games.id))
    .where(
      and(
        eq(games.userId, creatorId),
        eq(gameReleaseChecks.kind, "screenshot_capture"),
        gte(gameReleaseChecks.createdAt, since),
      ),
    );
  return {
    current: toSafeNonNegativeInteger(rows[0]?.total, "Browser validations"),
    oldestAt: dateValue(rows[0]?.oldestAt),
  };
};

const loadRoomSeconds = async ({
  database,
  creatorId,
  since,
  now,
}: {
  database: QuotaDatabase;
  creatorId: string;
  since: Date;
  now: Date;
}): Promise<number> => {
  const nowTimestamp = now.toISOString();
  const sinceTimestamp = since.toISOString();
  const rows = await database
    .select({
      seconds: sql<number>`coalesce(sum(greatest(0, extract(epoch from (least(coalesce(${runtimeUsageGameSegments.endedAt}, cast(${nowTimestamp} as timestamp)), cast(${nowTimestamp} as timestamp)) - greatest(${runtimeUsageGameSegments.startedAt}, cast(${sinceTimestamp} as timestamp)))))), 0)::bigint`,
    })
    .from(runtimeUsageGameSegments)
    .innerJoin(games, eq(runtimeUsageGameSegments.gameId, games.id))
    .where(
      and(
        eq(games.userId, creatorId),
        lt(runtimeUsageGameSegments.startedAt, now),
        or(
          isNull(runtimeUsageGameSegments.endedAt),
          gt(runtimeUsageGameSegments.endedAt, since),
        ),
      ),
    );
  return toSafeNonNegativeInteger(rows[0]?.seconds, "Room seconds");
};

const loadConcurrentReleaseJobs = async ({
  database,
  creatorId,
  now,
}: {
  database: QuotaDatabase;
  creatorId: string;
  now: Date;
}): Promise<number> => {
  const [row] = await database
    .select({ current: count() })
    .from(operationalJobs)
    .where(
      and(
        eq(operationalJobs.creatorId, creatorId),
        inArray(operationalJobs.status, ["running", "cancel_requested"]),
        gt(operationalJobs.leaseExpiresAt, now),
        gt(operationalJobs.deadlineAt, now),
      ),
    );
  return toSafeNonNegativeInteger(row?.current, "Concurrent release jobs");
};

const loadConcurrentRooms = async ({
  database,
  creatorId,
  gameId,
  now,
}: {
  database: QuotaDatabase;
  creatorId: string;
  gameId?: string;
  now: Date;
}): Promise<number> => {
  const [row] = await database
    .select({ current: count() })
    .from(realtimeRoomAdmissionLeases)
    .innerJoin(
      realtimeAdmissionInstances,
      and(
        eq(
          realtimeRoomAdmissionLeases.instanceId,
          realtimeAdmissionInstances.instanceId,
        ),
        realtimeAdmissionInstanceIsLive(
          realtimeAdmissionInstances.expiresAt,
          now,
        ),
      ),
    )
    .where(
      gameId
        ? and(
            eq(realtimeRoomAdmissionLeases.creatorId, creatorId),
            eq(realtimeRoomAdmissionLeases.gameId, gameId),
          )
        : eq(realtimeRoomAdmissionLeases.creatorId, creatorId),
    );
  return toSafeNonNegativeInteger(row?.current, "Concurrent rooms");
};

const loadOperationalQuotaUsageForValidatedScope = async ({
  database,
  key,
  creatorId,
  gameId,
  now,
}: {
  database: QuotaDatabase;
  key: OperationalQuotaKey;
  creatorId: string;
  gameId?: string;
  now: Date;
}): Promise<OperationalQuotaUsageSnapshot> => {
  const policy = OPERATIONAL_QUOTA_POLICIES[key];
  if (policy.scopeKind === "game" && !gameId) {
    throw new OperationalQuotaScopeError(`Quota ${key} requires a game ID.`);
  }
  const scopeId = policy.scopeKind === "game" ? gameId! : creatorId;
  const rollingSince = new Date(now.getTime() - ROLLING_30_DAYS_MS);
  const utcDayStart = startOfUtcDay(now);
  const nextUtcDay = new Date(utcDayStart.getTime() + 24 * 60 * 60 * 1_000);

  switch (key) {
    case "creator_games": {
      const rows = await database
        .select({ total: count() })
        .from(games)
        .where(eq(games.userId, creatorId));
      return availableUsage({
        key,
        scopeId,
        observedAt: now,
        current: toSafeNonNegativeInteger(rows[0]?.total, "Creator games"),
      });
    }
    case "creator_listed_games": {
      const rows = await database
        .select({ total: count() })
        .from(games)
        .where(
          and(
            eq(games.userId, creatorId),
            eq(games.arcadeVisibility, "listed"),
          ),
        );
      return availableUsage({
        key,
        scopeId,
        observedAt: now,
        current: toSafeNonNegativeInteger(rows[0]?.total, "Listed games"),
      });
    }
    case "creator_managed_storage_bytes":
    case "game_managed_storage_bytes":
      return availableUsage({
        key,
        scopeId,
        observedAt: now,
        current: await loadManagedStorageBytes({
          database,
          creatorId,
          gameId: policy.scopeKind === "game" ? gameId : undefined,
        }),
      });
    case "creator_release_submissions_30d": {
      const usage = await loadReleaseSubmissionUsage({
        database,
        creatorId,
        since: rollingSince,
      });
      return availableUsage({
        key,
        scopeId,
        observedAt: now,
        current: usage.current,
        resetAt: usage.oldestAt
          ? new Date(usage.oldestAt.getTime() + ROLLING_30_DAYS_MS)
          : null,
      });
    }
    case "creator_release_submissions_day": {
      const usage = await loadReleaseSubmissionUsage({
        database,
        creatorId,
        since: utcDayStart,
      });
      return availableUsage({
        key,
        scopeId,
        observedAt: now,
        current: usage.current,
        resetAt: nextUtcDay,
      });
    }
    case "creator_browser_validations_30d": {
      const usage = await loadBrowserValidationUsage({
        database,
        creatorId,
        since: rollingSince,
      });
      return availableUsage({
        key,
        scopeId,
        observedAt: now,
        current: usage.current,
        resetAt: usage.oldestAt
          ? new Date(usage.oldestAt.getTime() + ROLLING_30_DAYS_MS)
          : null,
      });
    }
    case "creator_browser_validations_day": {
      const usage = await loadBrowserValidationUsage({
        database,
        creatorId,
        since: utcDayStart,
      });
      return availableUsage({
        key,
        scopeId,
        observedAt: now,
        current: usage.current,
        resetAt: nextUtcDay,
      });
    }
    case "creator_room_seconds_30d":
      return availableUsage({
        key,
        scopeId,
        observedAt: now,
        current: await loadRoomSeconds({
          database,
          creatorId,
          since: rollingSince,
          now,
        }),
      });
    case "creator_concurrent_release_jobs":
      return availableUsage({
        key,
        scopeId,
        observedAt: now,
        current: await loadConcurrentReleaseJobs({
          database,
          creatorId,
          now,
        }),
      });
    case "creator_concurrent_rooms":
    case "game_concurrent_rooms":
      return availableUsage({
        key,
        scopeId,
        observedAt: now,
        current: await loadConcurrentRooms({
          database,
          creatorId,
          gameId: key === "game_concurrent_rooms" ? gameId : undefined,
          now,
        }),
      });
  }
};

export const loadOperationalQuotaUsage = async ({
  database = db,
  key,
  creatorId: rawCreatorId,
  gameId: rawGameId,
  now = new Date(),
}: {
  database?: QuotaDatabase;
  key: OperationalQuotaKey;
  creatorId: string;
  gameId?: string;
  now?: Date;
}): Promise<OperationalQuotaUsageSnapshot> => {
  const creatorId = normalizeRequiredText(rawCreatorId, "Creator ID");
  const gameId = rawGameId?.trim() || undefined;
  if (gameId) await assertOwnedGame({ database, creatorId, gameId });
  return loadOperationalQuotaUsageForValidatedScope({
    database,
    key,
    creatorId,
    gameId,
    now,
  });
};

export const listOperationalQuotaUsage = async ({
  database = db,
  creatorId,
  gameId,
  now = new Date(),
}: {
  database?: QuotaDatabase;
  creatorId: string;
  gameId?: string;
  now?: Date;
}): Promise<OperationalQuotaUsageSnapshot[]> => {
  const normalizedCreatorId = normalizeRequiredText(creatorId, "Creator ID");
  const normalizedGameId = gameId?.trim() || undefined;
  if (normalizedGameId) {
    await assertOwnedGame({
      database,
      creatorId: normalizedCreatorId,
      gameId: normalizedGameId,
    });
  }
  const keys = operationalQuotaKeyValues.filter(
    (key) =>
      OPERATIONAL_QUOTA_POLICIES[key].scopeKind === "creator" ||
      Boolean(normalizedGameId),
  );
  return Promise.all(
    keys.map((key) =>
      loadOperationalQuotaUsageForValidatedScope({
        database,
        key,
        creatorId: normalizedCreatorId,
        gameId: normalizedGameId,
        now,
      }),
    ),
  );
};

export const decideOperationalQuotaAdmissionWithDatabase = async ({
  database = db,
  key,
  lane,
  creatorId,
  gameId,
  requestedAmount,
  decisionId,
}: {
  database?: QuotaTransactionalDatabase;
  key: OperationalQuotaKey;
  lane: OperationalLane;
  creatorId: string;
  gameId?: string;
  requestedAmount: number;
  decisionId?: string;
}): Promise<OperationalQuotaAdmissionDecision> =>
  database.transaction(
    async (transaction) => {
      const rows = await transaction.execute(
        sql<{
          observedAt: Date | string;
        }>`select transaction_timestamp() as "observedAt"`,
      );
      const value = rows[0]?.observedAt;
      const observedAt =
        value instanceof Date ? value : new Date(String(value ?? ""));
      if (Number.isNaN(observedAt.getTime())) {
        throw new OperationalQuotaScopeError(
          "PostgreSQL did not return the quota decision clock.",
        );
      }
      const [usage, control, budget] = await Promise.all([
        loadOperationalQuotaUsage({
          database: transaction,
          key,
          creatorId,
          gameId,
          now: observedAt,
        }),
        getOperationalLaneControl({ database: transaction, lane }),
        getOperationalBudgetStatus({
          database: transaction,
          asOf: observedAt,
        }),
      ]);
      return decideOperationalQuotaAdmission({
        lane,
        usage,
        requestedAmount,
        control,
        budget,
        decisionId,
      });
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
