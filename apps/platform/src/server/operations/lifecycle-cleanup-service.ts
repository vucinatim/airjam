import { db } from "@/db";
import {
  gameMediaAssets,
  gameMediaAssignments,
  gameReleaseGenerations,
  gameReleases,
  games,
  operationalJobs,
} from "@/db/schema";
import {
  calculateSupersededReleaseEligibleAt,
  calculateSupersededReleaseWarningAt,
  SUPERSEDED_RELEASE_RETENTION_MS,
  SUPERSEDED_RELEASE_WARNING_MS,
} from "@/lib/releases/release-retention-policy";
import { buildGameMediaStorageKeys } from "@/server/media/game-media-storage-keys";
import {
  getReleaseStorage,
  type ReleaseStorage,
} from "@/server/releases/release-storage";
import { buildReleaseGenerationStorageKeys } from "@/server/releases/release-storage-keys";
import type { OperationalJobResourceKind } from "@air-jam/database-contract";
import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  not,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  lifecycleCleanupJobContractVersion,
  lifecycleCleanupJobPayloadSchema,
  type LifecycleCleanupRetentionClass,
} from "../jobs/lifecycle-cleanup-job-contract";
import { createOperationalJobInTransaction } from "../jobs/operational-job-commands";
import {
  beginOperationalJobCommand,
  completeOperationalJobCommand,
  hashOperationalJobRequest,
  normalizeRequiredJobText,
  OperationalJobConflictError,
  readCommandJobSnapshots,
  serializeOperationalJobForOperator,
  type JobDatabase,
} from "../jobs/operational-job-internals";
import { getOperationalJobAuthorityTime } from "../jobs/operational-job-service";

export const LIFECYCLE_CLEANUP_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type LifecycleCleanupCandidate = Readonly<{
  creatorId: string;
  gameId: string;
  releaseId: string | null;
  generationId: string | null;
  resourceKind: OperationalJobResourceKind;
  resourceId: string;
  retentionClass: LifecycleCleanupRetentionClass;
  eligibleAt: string;
  storageRootKey: string;
}>;

type LifecycleRetentionTransitionScope = Readonly<{
  creatorId: string;
  gameId: string;
  releaseId: string;
  generationId: string;
}>;

export type LifecycleRetentionTransition = LifecycleRetentionTransitionScope &
  Readonly<
    | {
        transition: "inactive";
        inactiveAt: string;
        warnedAt: null;
        eligibleAt: string;
      }
    | {
        transition: "warned";
        inactiveAt: string;
        warnedAt: string;
        eligibleAt: string;
      }
    | {
        transition: "retention_cleared";
        inactiveAt: null;
        warnedAt: null;
        eligibleAt: null;
      }
  >;

const assertLimit = (limit: number): void => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new OperationalJobConflictError(
      "Lifecycle cleanup limit must be between 1 and 500.",
    );
  }
};

const activeCleanupJobFor = ({
  database,
  resourceKind,
  resourceId,
}: {
  database: JobDatabase;
  resourceKind: OperationalJobResourceKind;
  resourceId: typeof gameReleaseGenerations.id | typeof gameMediaAssets.id;
}) =>
  notExists(
    database
      .select({ id: operationalJobs.id })
      .from(operationalJobs)
      .where(
        and(
          eq(operationalJobs.kind, "lifecycle_cleanup"),
          eq(operationalJobs.resourceKind, resourceKind),
          eq(operationalJobs.resourceId, resourceId),
          inArray(operationalJobs.status, [
            "queued",
            "running",
            "cancel_requested",
          ]),
        ),
      ),
  );

const supersedingRelease = alias(gameReleases, "superseding_game_release");
type RetentionQueryDatabase = Pick<JobDatabase, "select">;

export const buildSupersededUnpublishedReleasePredicate = ({
  database,
}: {
  database: RetentionQueryDatabase;
}) =>
  and(
    eq(gameReleaseGenerations.status, "ready"),
    eq(gameReleaseGenerations.id, gameReleases.promotedGenerationId),
    isNull(gameReleases.publishedAt),
    or(
      and(
        eq(gameReleases.status, "archived"),
        isNotNull(gameReleases.archivedAt),
      ),
      and(
        eq(gameReleases.status, "ready"),
        exists(
          database
            .select({ id: supersedingRelease.id })
            .from(supersedingRelease)
            .where(
              and(
                eq(supersedingRelease.gameId, gameReleases.gameId),
                inArray(supersedingRelease.status, ["ready", "live"]),
                or(
                  gt(supersedingRelease.createdAt, gameReleases.createdAt),
                  and(
                    eq(supersedingRelease.createdAt, gameReleases.createdAt),
                    gt(supersedingRelease.id, gameReleases.id),
                  ),
                ),
              ),
            ),
        ),
      ),
    ),
  );

const supersededReleaseStillRetainable = (database: JobDatabase) =>
  exists(
    database
      .select({ id: gameReleases.id })
      .from(gameReleases)
      .where(
        and(
          eq(gameReleases.id, gameReleaseGenerations.releaseId),
          buildSupersededUnpublishedReleasePredicate({ database }),
        ),
      ),
  );

const listSupersededReleaseRetentionRows = async ({
  database,
  authorityNow,
  limit,
}: {
  database: JobDatabase;
  authorityNow: Date;
  limit: number;
}) => {
  const retainable = buildSupersededUnpublishedReleasePredicate({ database });
  if (!retainable) {
    throw new Error("Superseded release retention predicate is unavailable.");
  }
  const warningCutoff = new Date(
    authorityNow.getTime() -
      SUPERSEDED_RELEASE_RETENTION_MS +
      SUPERSEDED_RELEASE_WARNING_MS,
  );
  return database
    .select({
      creatorId: games.userId,
      gameId: gameReleases.gameId,
      releaseId: gameReleases.id,
      generationId: gameReleaseGenerations.id,
      inactiveAt: gameReleaseGenerations.storageInactiveAt,
      warnedAt: gameReleaseGenerations.storageRetentionWarnedAt,
      eligibleAt: gameReleaseGenerations.storageRetentionEligibleAt,
      retainable: sql<boolean>`${retainable}`,
    })
    .from(gameReleaseGenerations)
    .innerJoin(
      gameReleases,
      eq(gameReleaseGenerations.releaseId, gameReleases.id),
    )
    .innerJoin(games, eq(gameReleases.gameId, games.id))
    .where(
      and(
        isNull(gameReleaseGenerations.storageCleanupStartedAt),
        isNull(gameReleaseGenerations.storageDeletedAt),
        or(
          and(
            retainable,
            or(
              isNull(gameReleaseGenerations.storageInactiveAt),
              and(
                isNotNull(gameReleaseGenerations.storageInactiveAt),
                isNull(gameReleaseGenerations.storageRetentionWarnedAt),
                lte(gameReleaseGenerations.storageInactiveAt, warningCutoff),
              ),
            ),
          ),
          and(
            or(
              isNotNull(gameReleaseGenerations.storageInactiveAt),
              isNotNull(gameReleaseGenerations.storageRetentionWarnedAt),
              isNotNull(gameReleaseGenerations.storageRetentionEligibleAt),
            ),
            not(retainable),
          ),
        ),
      ),
    )
    .orderBy(asc(gameReleaseGenerations.createdAt))
    .limit(limit);
};

export const planSupersededReleaseRetention = async ({
  database = db,
  now,
  limit = 100,
}: {
  database?: JobDatabase;
  now?: Date;
  limit?: number;
} = {}): Promise<LifecycleRetentionTransition[]> => {
  assertLimit(limit);
  const authorityNow =
    now ?? (await getOperationalJobAuthorityTime({ database }));
  const rows = await listSupersededReleaseRetentionRows({
    database,
    authorityNow,
    limit,
  });
  const transitions: LifecycleRetentionTransition[] = [];

  for (const row of rows) {
    if (!row.retainable) {
      transitions.push({
        creatorId: row.creatorId,
        gameId: row.gameId,
        releaseId: row.releaseId,
        generationId: row.generationId,
        transition: "retention_cleared",
        inactiveAt: null,
        warnedAt: null,
        eligibleAt: null,
      });
      continue;
    }

    const inactiveAt = row.inactiveAt ?? authorityNow;
    const warningDueAt = calculateSupersededReleaseWarningAt(inactiveAt);
    const shouldWarn =
      row.warnedAt === null && warningDueAt.getTime() <= authorityNow.getTime();
    const warnedAt = shouldWarn ? authorityNow : row.warnedAt;
    const eligibleAt =
      row.eligibleAt ??
      calculateSupersededReleaseEligibleAt({
        inactiveAt,
        warnedAt: warnedAt ?? warningDueAt,
      });

    if (!row.inactiveAt) {
      transitions.push({
        creatorId: row.creatorId,
        gameId: row.gameId,
        releaseId: row.releaseId,
        generationId: row.generationId,
        transition: "inactive",
        inactiveAt: inactiveAt.toISOString(),
        warnedAt: null,
        eligibleAt: eligibleAt.toISOString(),
      });
    }
    if (shouldWarn) {
      transitions.push({
        creatorId: row.creatorId,
        gameId: row.gameId,
        releaseId: row.releaseId,
        generationId: row.generationId,
        transition: "warned",
        inactiveAt: inactiveAt.toISOString(),
        warnedAt: warnedAt!.toISOString(),
        eligibleAt: eligibleAt.toISOString(),
      });
    }
  }

  return transitions;
};

export const applySupersededReleaseRetention = async ({
  database = db,
  now,
  limit = 100,
}: {
  database?: JobDatabase;
  now?: Date;
  limit?: number;
} = {}): Promise<LifecycleRetentionTransition[]> => {
  const transitions = await planSupersededReleaseRetention({
    database,
    now,
    limit,
  });
  const appliedTransitions: LifecycleRetentionTransition[] = [];
  for (const transition of transitions) {
    if (transition.transition === "inactive") {
      const applied = await database
        .update(gameReleaseGenerations)
        .set({ storageInactiveAt: new Date(transition.inactiveAt) })
        .where(
          and(
            eq(gameReleaseGenerations.id, transition.generationId),
            isNull(gameReleaseGenerations.storageInactiveAt),
            isNull(gameReleaseGenerations.storageCleanupStartedAt),
            isNull(gameReleaseGenerations.storageDeletedAt),
            supersededReleaseStillRetainable(database),
          ),
        )
        .returning({
          inactiveAt: gameReleaseGenerations.storageInactiveAt,
        });
      const [appliedClock] = applied;
      if (appliedClock?.inactiveAt) {
        appliedTransitions.push({
          ...transition,
          inactiveAt: appliedClock.inactiveAt.toISOString(),
          eligibleAt: calculateSupersededReleaseEligibleAt({
            inactiveAt: appliedClock.inactiveAt,
            warnedAt: calculateSupersededReleaseWarningAt(
              appliedClock.inactiveAt,
            ),
          }).toISOString(),
        });
      }
      continue;
    }
    if (transition.transition === "retention_cleared") {
      const applied = await database
        .update(gameReleaseGenerations)
        .set({
          storageInactiveAt: null,
          storageRetentionWarnedAt: null,
          storageRetentionEligibleAt: null,
        })
        .where(
          and(
            eq(gameReleaseGenerations.id, transition.generationId),
            isNull(gameReleaseGenerations.storageCleanupStartedAt),
            isNull(gameReleaseGenerations.storageDeletedAt),
            not(supersededReleaseStillRetainable(database)),
          ),
        )
        .returning({ id: gameReleaseGenerations.id });
      if (applied.length > 0) {
        appliedTransitions.push(transition);
      }
      continue;
    }
    const warnedAt = new Date(transition.warnedAt);
    const applied = await database
      .update(gameReleaseGenerations)
      .set({
        storageRetentionWarnedAt: warnedAt,
        storageRetentionEligibleAt: new Date(transition.eligibleAt),
      })
      .where(
        and(
          eq(gameReleaseGenerations.id, transition.generationId),
          eq(
            gameReleaseGenerations.storageInactiveAt,
            new Date(transition.inactiveAt),
          ),
          isNull(gameReleaseGenerations.storageRetentionWarnedAt),
          isNull(gameReleaseGenerations.storageCleanupStartedAt),
          isNull(gameReleaseGenerations.storageDeletedAt),
          supersededReleaseStillRetainable(database),
        ),
      )
      .returning({
        inactiveAt: gameReleaseGenerations.storageInactiveAt,
        warnedAt: gameReleaseGenerations.storageRetentionWarnedAt,
        eligibleAt: gameReleaseGenerations.storageRetentionEligibleAt,
      });
    const [appliedClock] = applied;
    if (
      appliedClock?.inactiveAt &&
      appliedClock.warnedAt &&
      appliedClock.eligibleAt
    ) {
      appliedTransitions.push({
        ...transition,
        inactiveAt: appliedClock.inactiveAt.toISOString(),
        warnedAt: appliedClock.warnedAt.toISOString(),
        eligibleAt: appliedClock.eligibleAt.toISOString(),
      });
    }
  }
  return appliedTransitions;
};

export const listLifecycleCleanupCandidates = async ({
  database = db,
  now,
  limit = 100,
}: {
  database?: JobDatabase;
  now?: Date;
  limit?: number;
} = {}): Promise<LifecycleCleanupCandidate[]> => {
  assertLimit(limit);
  const authorityNow =
    now ?? (await getOperationalJobAuthorityTime({ database }));
  const cutoff = new Date(
    authorityNow.getTime() - LIFECYCLE_CLEANUP_TERMINAL_RETENTION_MS,
  );
  const [generationRows, supersededRows, mediaRows] = await Promise.all([
    database
      .select({
        creatorId: games.userId,
        gameId: gameReleases.gameId,
        releaseId: gameReleases.id,
        generationId: gameReleaseGenerations.id,
        failedAt: gameReleaseGenerations.failedAt,
        abandonedAt: gameReleaseGenerations.abandonedAt,
      })
      .from(gameReleaseGenerations)
      .innerJoin(
        gameReleases,
        eq(gameReleaseGenerations.releaseId, gameReleases.id),
      )
      .innerJoin(games, eq(gameReleases.gameId, games.id))
      .where(
        and(
          inArray(gameReleaseGenerations.status, ["failed", "abandoned"]),
          isNull(gameReleaseGenerations.storageDeletedAt),
          or(
            lte(gameReleaseGenerations.failedAt, cutoff),
            lte(gameReleaseGenerations.abandonedAt, cutoff),
          ),
          sql`${gameReleaseGenerations.id} is distinct from ${gameReleases.candidateGenerationId}`,
          sql`${gameReleaseGenerations.id} is distinct from ${gameReleases.promotedGenerationId}`,
          activeCleanupJobFor({
            database,
            resourceKind: "release_generation",
            resourceId: gameReleaseGenerations.id,
          }),
        ),
      )
      .limit(limit),
    database
      .select({
        creatorId: games.userId,
        gameId: gameReleases.gameId,
        releaseId: gameReleases.id,
        generationId: gameReleaseGenerations.id,
        eligibleAt: gameReleaseGenerations.storageRetentionEligibleAt,
      })
      .from(gameReleaseGenerations)
      .innerJoin(
        gameReleases,
        eq(gameReleaseGenerations.releaseId, gameReleases.id),
      )
      .innerJoin(games, eq(gameReleases.gameId, games.id))
      .where(
        and(
          buildSupersededUnpublishedReleasePredicate({ database }),
          isNotNull(gameReleaseGenerations.storageInactiveAt),
          isNotNull(gameReleaseGenerations.storageRetentionWarnedAt),
          isNotNull(gameReleaseGenerations.storageRetentionEligibleAt),
          lte(gameReleaseGenerations.storageRetentionEligibleAt, authorityNow),
          isNull(gameReleaseGenerations.storageCleanupStartedAt),
          isNull(gameReleaseGenerations.storageDeletedAt),
          activeCleanupJobFor({
            database,
            resourceKind: "release_generation",
            resourceId: gameReleaseGenerations.id,
          }),
        ),
      )
      .limit(limit),
    database
      .select({
        creatorId: games.userId,
        gameId: gameMediaAssets.gameId,
        assetId: gameMediaAssets.id,
        kind: gameMediaAssets.kind,
        originalFilename: gameMediaAssets.originalFilename,
        status: gameMediaAssets.status,
        createdAt: gameMediaAssets.createdAt,
        inactiveAt: gameMediaAssets.inactiveAt,
      })
      .from(gameMediaAssets)
      .innerJoin(games, eq(gameMediaAssets.gameId, games.id))
      .leftJoin(
        gameMediaAssignments,
        eq(gameMediaAssignments.assetId, gameMediaAssets.id),
      )
      .where(
        and(
          inArray(gameMediaAssets.status, ["uploading", "failed", "archived"]),
          isNull(gameMediaAssets.storageDeletedAt),
          or(
            and(
              eq(gameMediaAssets.status, "uploading"),
              lte(gameMediaAssets.createdAt, cutoff),
            ),
            and(
              inArray(gameMediaAssets.status, ["failed", "archived"]),
              lte(gameMediaAssets.inactiveAt, cutoff),
            ),
          ),
          isNull(gameMediaAssignments.assetId),
          activeCleanupJobFor({
            database,
            resourceKind: "game_media_asset",
            resourceId: gameMediaAssets.id,
          }),
        ),
      )
      .limit(limit),
  ]);

  const generations: LifecycleCleanupCandidate[] = generationRows.map((row) => {
    const terminalAt = row.failedAt ?? row.abandonedAt;
    if (!terminalAt) {
      throw new Error("Terminal release generation had no terminal timestamp.");
    }
    return {
      creatorId: row.creatorId,
      gameId: row.gameId,
      releaseId: row.releaseId,
      generationId: row.generationId,
      resourceKind: "release_generation",
      resourceId: row.generationId,
      retentionClass: "terminal_release_generation_24h",
      eligibleAt: new Date(
        terminalAt.getTime() + LIFECYCLE_CLEANUP_TERMINAL_RETENTION_MS,
      ).toISOString(),
      storageRootKey: buildReleaseGenerationStorageKeys({
        gameId: row.gameId,
        releaseId: row.releaseId,
        generationId: row.generationId,
      }).generationRootKey,
    };
  });
  const media: LifecycleCleanupCandidate[] = mediaRows.map((row) => {
    const inactiveAt =
      row.status === "uploading" ? row.createdAt : row.inactiveAt;
    if (!inactiveAt) {
      throw new Error("Inactive media asset had no inactivity timestamp.");
    }
    return {
      creatorId: row.creatorId,
      gameId: row.gameId,
      releaseId: null,
      generationId: null,
      resourceKind: "game_media_asset",
      resourceId: row.assetId,
      retentionClass: "inactive_game_media_24h",
      eligibleAt: new Date(
        inactiveAt.getTime() + LIFECYCLE_CLEANUP_TERMINAL_RETENTION_MS,
      ).toISOString(),
      storageRootKey: buildGameMediaStorageKeys({
        gameId: row.gameId,
        kind: row.kind,
        assetId: row.assetId,
        originalFilename: row.originalFilename,
      }).assetRootKey,
    };
  });

  const superseded: LifecycleCleanupCandidate[] = supersededRows.map((row) => {
    if (!row.eligibleAt) {
      throw new Error(
        "Superseded release generation had no retention eligibility timestamp.",
      );
    }
    return {
      creatorId: row.creatorId,
      gameId: row.gameId,
      releaseId: row.releaseId,
      generationId: row.generationId,
      resourceKind: "release_generation",
      resourceId: row.generationId,
      retentionClass: "superseded_unpublished_release_180d",
      eligibleAt: row.eligibleAt.toISOString(),
      storageRootKey: buildReleaseGenerationStorageKeys({
        gameId: row.gameId,
        releaseId: row.releaseId,
        generationId: row.generationId,
      }).generationRootKey,
    };
  });

  return [...generations, ...superseded, ...media]
    .sort((left, right) => left.eligibleAt.localeCompare(right.eligibleAt))
    .slice(0, limit);
};

export const scheduleLifecycleCleanup = async ({
  database = db,
  actor: rawActor,
  reason: rawReason,
  idempotencyKey: rawIdempotencyKey,
  now,
  limit = 100,
}: {
  database?: JobDatabase;
  actor: string;
  reason: string;
  idempotencyKey: string;
  now?: Date;
  limit?: number;
}) => {
  const actor = normalizeRequiredJobText(rawActor, "Actor");
  const reason = normalizeRequiredJobText(rawReason, "Reason");
  const idempotencyKey = normalizeRequiredJobText(
    rawIdempotencyKey,
    "Idempotency key",
  );
  assertLimit(limit);
  const authorityNow =
    now ?? (await getOperationalJobAuthorityTime({ database }));
  const request = {
    contractVersion: lifecycleCleanupJobContractVersion,
    operation: "schedule_cleanup",
    actor,
    reason,
    limit,
  };
  const requestHash = hashOperationalJobRequest(request);
  const existing = await database.query.operationalJobCommands.findFirst({
    where: (table, { eq }) => eq(table.idempotencyKey, idempotencyKey),
  });
  if (existing) {
    if (
      existing.kind !== "schedule_cleanup" ||
      existing.requestHash !== requestHash ||
      !existing.result ||
      !existing.completedAt
    ) {
      throw new OperationalJobConflictError(
        "Cleanup idempotency key was already used by a different or incomplete command.",
      );
    }
    return {
      candidates: (existing.result.candidates ??
        []) as unknown as LifecycleCleanupCandidate[],
      retentionTransitions: (existing.result.retentionTransitions ??
        []) as unknown as LifecycleRetentionTransition[],
      jobs: readCommandJobSnapshots(existing),
      replayed: true,
    } as const;
  }
  const retentionTransitions = await applySupersededReleaseRetention({
    database,
    now: authorityNow,
    limit,
  });
  const candidates = await listLifecycleCleanupCandidates({
    database,
    now: authorityNow,
    limit,
  });
  return database.transaction(async (tx) => {
    const commandState = await beginOperationalJobCommand({
      tx,
      kind: "schedule_cleanup",
      idempotencyKey,
      requestHash,
      actor,
      reason,
      request,
      testNow: authorityNow,
    });
    if (commandState.replayed) {
      return {
        candidates: (commandState.command.result?.candidates ??
          []) as unknown as LifecycleCleanupCandidate[],
        retentionTransitions: (commandState.command.result
          ?.retentionTransitions ??
          []) as unknown as LifecycleRetentionTransition[],
        jobs: readCommandJobSnapshots(commandState.command),
        replayed: true,
      } as const;
    }
    const jobs = [];
    for (const candidate of candidates) {
      const payload = lifecycleCleanupJobPayloadSchema.parse({
        contractVersion: lifecycleCleanupJobContractVersion,
        resourceKind: candidate.resourceKind,
        resourceId: candidate.resourceId,
        retentionClass: candidate.retentionClass,
        eligibleAt: candidate.eligibleAt,
        plannedAt: authorityNow.toISOString(),
      });
      const job = await createOperationalJobInTransaction({
        tx,
        commandId: commandState.command.id,
        commandKind: "schedule_cleanup",
        kind: "lifecycle_cleanup",
        creatorId: candidate.creatorId,
        gameId: candidate.gameId,
        releaseId: candidate.releaseId,
        generationId: candidate.generationId,
        resourceKind: candidate.resourceKind,
        resourceId: candidate.resourceId,
        payload,
        priority: 0,
        correlationId: crypto.randomUUID(),
        replayOfJobId: null,
        requestHash,
        actor,
        reason,
        testNow: authorityNow,
      });
      jobs.push(job);
    }
    const snapshots = jobs.map(serializeOperationalJobForOperator);
    await completeOperationalJobCommand({
      tx,
      commandId: commandState.command.id,
      result: { candidates, retentionTransitions, jobs: snapshots },
      now: authorityNow,
    });
    return {
      candidates,
      retentionTransitions,
      jobs: snapshots,
      replayed: false,
    } as const;
  });
};

export const inspectLifecycleCleanupCandidates = async ({
  database = db,
  storage,
  now,
  limit = 100,
}: {
  database?: JobDatabase;
  storage?: ReleaseStorage;
  now?: Date;
  limit?: number;
} = {}) => {
  const authorityNow =
    now ?? (await getOperationalJobAuthorityTime({ database }));
  const retentionTransitions = await planSupersededReleaseRetention({
    database,
    now: authorityNow,
    limit,
  });
  const candidates = await listLifecycleCleanupCandidates({
    database,
    now: authorityNow,
    limit,
  });
  if (candidates.length === 0) {
    return {
      observedAt: authorityNow.toISOString(),
      retentionTransitions,
      candidates: [],
    } as const;
  }
  const releaseStorage = storage ?? getReleaseStorage();
  const inspected = [];
  for (const candidate of candidates) {
    const objects = await releaseStorage.listObjects(candidate.storageRootKey);
    if (
      objects.length > 10_000 ||
      objects.some(
        (object) =>
          object.key !== candidate.storageRootKey &&
          !object.key.startsWith(`${candidate.storageRootKey}/`),
      )
    ) {
      throw new OperationalJobConflictError(
        "Lifecycle cleanup inventory violated its object safety bound.",
      );
    }
    inspected.push({
      ...candidate,
      objects,
      objectCount: objects.length,
      bytes: objects.reduce((total, object) => total + object.sizeBytes, 0),
    });
  }
  return {
    observedAt: authorityNow.toISOString(),
    retentionTransitions,
    candidates: inspected,
  } as const;
};
