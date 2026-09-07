import { db } from "@/db";
import {
  gameMediaAssets,
  gameReleaseGenerations,
  gameReleases,
} from "@/db/schema";
import { buildGameMediaStorageKeys } from "@/server/media/game-media-storage-keys";
import {
  getReleaseStorage,
  type ReleaseStorage,
} from "@/server/releases/release-storage";
import { buildReleaseGenerationStorageKeys } from "@/server/releases/release-storage-keys";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  LifecycleCleanupExecutionError,
  lifecycleCleanupJobContractVersion,
  lifecycleCleanupJobPayloadSchema,
  lifecycleCleanupJobProgressSchema,
  lifecycleCleanupJobResultSchema,
  lifecycleCleanupOutputManifestSchema,
  type LifecycleCleanupJobProgress,
  type LifecycleCleanupRetentionClass,
} from "../jobs/lifecycle-cleanup-job-contract";
import { type JobDatabase } from "../jobs/operational-job-internals";
import { completeOperationalJobInTransaction } from "../jobs/operational-job-service";
import { resolveDatabaseAuthorityNow } from "./database-authority";
import {
  buildSupersededUnpublishedReleasePredicate,
  LIFECYCLE_CLEANUP_TERMINAL_RETENTION_MS,
} from "./lifecycle-cleanup-service";

type CleanupAuthority = Readonly<{
  storageRootKey: string;
  alreadyDeletedAt: Date | null;
}>;

const assertRetentionElapsed = ({
  terminalAt,
  authorityNow,
}: {
  terminalAt: Date;
  authorityNow: Date;
}): void => {
  if (
    terminalAt.getTime() + LIFECYCLE_CLEANUP_TERMINAL_RETENTION_MS >
    authorityNow.getTime()
  ) {
    throw new LifecycleCleanupExecutionError({
      code: "resource_no_longer_eligible",
      message: "The resource has not reached its cleanup retention deadline.",
      stage: "revalidating",
      retryable: false,
    });
  }
};

const beginCleanup = async ({
  database,
  resourceKind,
  resourceId,
  gameId,
  releaseId,
  retentionClass,
}: {
  database: JobDatabase;
  resourceKind: "release_generation" | "game_media_asset";
  resourceId: string;
  gameId: string;
  releaseId: string | null;
  retentionClass: LifecycleCleanupRetentionClass;
}): Promise<CleanupAuthority> =>
  database.transaction(async (tx) => {
    const authorityNow = await resolveDatabaseAuthorityNow(tx);
    if (resourceKind === "release_generation") {
      if (!releaseId) {
        throw new LifecycleCleanupExecutionError({
          code: "resource_not_found",
          message: "Release cleanup scope is incomplete.",
          stage: "revalidating",
          retryable: false,
        });
      }
      const [generation] = await tx
        .select()
        .from(gameReleaseGenerations)
        .where(
          and(
            eq(gameReleaseGenerations.id, resourceId),
            eq(gameReleaseGenerations.releaseId, releaseId),
          ),
        )
        .for("update");
      const [release] = await tx
        .select()
        .from(gameReleases)
        .where(
          and(eq(gameReleases.id, releaseId), eq(gameReleases.gameId, gameId)),
        )
        .for("update");
      if (!generation || !release) {
        throw new LifecycleCleanupExecutionError({
          code: "resource_not_found",
          message: "Release generation no longer exists in its cleanup scope.",
          stage: "revalidating",
          retryable: false,
        });
      }
      const storageRootKey = buildReleaseGenerationStorageKeys({
        gameId,
        releaseId,
        generationId: generation.id,
      }).generationRootKey;
      if (generation.storageDeletedAt) {
        return {
          storageRootKey,
          alreadyDeletedAt: generation.storageDeletedAt,
        };
      }
      if (retentionClass === "terminal_release_generation_24h") {
        if (
          !["failed", "abandoned"].includes(generation.status) ||
          release.candidateGenerationId === generation.id ||
          release.promotedGenerationId === generation.id
        ) {
          throw new LifecycleCleanupExecutionError({
            code: "resource_no_longer_eligible",
            message:
              "Release generation is active, promoted, or no longer terminal.",
            stage: "revalidating",
            retryable: false,
          });
        }
        const terminalAt = generation.failedAt ?? generation.abandonedAt;
        if (!terminalAt) {
          throw new LifecycleCleanupExecutionError({
            code: "resource_no_longer_eligible",
            message: "Terminal release generation has no terminal timestamp.",
            stage: "revalidating",
            retryable: false,
          });
        }
        assertRetentionElapsed({ terminalAt, authorityNow });
      } else if (retentionClass === "superseded_unpublished_release_180d") {
        const [retentionAuthority] = await tx
          .select({ id: gameReleaseGenerations.id })
          .from(gameReleaseGenerations)
          .innerJoin(
            gameReleases,
            eq(gameReleaseGenerations.releaseId, gameReleases.id),
          )
          .where(
            and(
              eq(gameReleaseGenerations.id, generation.id),
              buildSupersededUnpublishedReleasePredicate({ database: tx }),
            ),
          )
          .limit(1);
        if (
          !retentionAuthority ||
          !generation.storageInactiveAt ||
          !generation.storageRetentionWarnedAt ||
          !generation.storageRetentionEligibleAt ||
          generation.storageRetentionEligibleAt.getTime() >
            authorityNow.getTime()
        ) {
          throw new LifecycleCleanupExecutionError({
            code: "resource_no_longer_eligible",
            message:
              "Superseded release storage is active, published, or has not completed its warning window.",
            stage: "revalidating",
            retryable: false,
          });
        }
        if (release.status === "ready") {
          await tx
            .update(gameReleases)
            .set({ status: "archived", archivedAt: authorityNow })
            .where(
              and(
                eq(gameReleases.id, release.id),
                eq(gameReleases.status, "ready"),
              ),
            );
        }
      } else {
        throw new LifecycleCleanupExecutionError({
          code: "resource_no_longer_eligible",
          message: "Release cleanup retention class is invalid.",
          stage: "revalidating",
          retryable: false,
        });
      }
      if (!generation.storageCleanupStartedAt) {
        await tx
          .update(gameReleaseGenerations)
          .set({ storageCleanupStartedAt: authorityNow })
          .where(
            and(
              eq(gameReleaseGenerations.id, generation.id),
              isNull(gameReleaseGenerations.storageCleanupStartedAt),
            ),
          );
      }
      return { storageRootKey, alreadyDeletedAt: null };
    }

    const [asset] = await tx
      .select()
      .from(gameMediaAssets)
      .where(
        and(
          eq(gameMediaAssets.id, resourceId),
          eq(gameMediaAssets.gameId, gameId),
        ),
      )
      .for("update");
    if (!asset) {
      throw new LifecycleCleanupExecutionError({
        code: "resource_not_found",
        message: "Game media asset no longer exists in its cleanup scope.",
        stage: "revalidating",
        retryable: false,
      });
    }
    const storageRootKey = buildGameMediaStorageKeys({
      gameId,
      kind: asset.kind,
      assetId: asset.id,
      originalFilename: asset.originalFilename,
    }).assetRootKey;
    if (asset.storageDeletedAt) {
      return { storageRootKey, alreadyDeletedAt: asset.storageDeletedAt };
    }
    const assignment = await tx.query.gameMediaAssignments.findFirst({
      where: (table, { eq }) => eq(table.assetId, asset.id),
    });
    if (
      assignment ||
      !["uploading", "failed", "archived"].includes(asset.status)
    ) {
      throw new LifecycleCleanupExecutionError({
        code: "resource_no_longer_eligible",
        message: "Media asset is assigned or no longer inactive.",
        stage: "revalidating",
        retryable: false,
      });
    }
    const inactiveAt =
      asset.status === "uploading" ? asset.createdAt : asset.inactiveAt;
    if (!inactiveAt) {
      throw new LifecycleCleanupExecutionError({
        code: "resource_no_longer_eligible",
        message: "Inactive media asset has no inactivity timestamp.",
        stage: "revalidating",
        retryable: false,
      });
    }
    assertRetentionElapsed({ terminalAt: inactiveAt, authorityNow });
    await tx
      .update(gameMediaAssets)
      .set({
        status: asset.status === "uploading" ? "failed" : asset.status,
        inactiveAt:
          asset.status === "uploading" ? authorityNow : asset.inactiveAt,
        storageCleanupStartedAt: asset.storageCleanupStartedAt ?? authorityNow,
        updatedAt: authorityNow,
      })
      .where(eq(gameMediaAssets.id, asset.id));
    return { storageRootKey, alreadyDeletedAt: null };
  });

export const executeLifecycleCleanupJobAttempt = async ({
  jobId,
  leaseToken,
  workerId,
  creatorId: _creatorId,
  gameId,
  releaseId,
  payload: rawPayload,
  reportProgress,
  database = db,
  storage = getReleaseStorage(),
}: {
  jobId: string;
  leaseToken: string;
  workerId: string;
  creatorId: string;
  gameId: string;
  releaseId: string | null;
  payload: Record<string, unknown>;
  reportProgress: (
    progress: LifecycleCleanupJobProgress,
    output?: { outputManifest?: Record<string, unknown> },
  ) => Promise<void>;
  database?: JobDatabase;
  storage?: ReleaseStorage;
}) => {
  const payload = lifecycleCleanupJobPayloadSchema.parse(rawPayload);
  await reportProgress(
    lifecycleCleanupJobProgressSchema.parse({
      contractVersion: lifecycleCleanupJobContractVersion,
      stage: "revalidating",
      message: "Revalidating lifecycle state under database authority.",
    }),
  );
  const authority = await beginCleanup({
    database,
    resourceKind: payload.resourceKind,
    resourceId: payload.resourceId,
    gameId,
    releaseId,
    retentionClass: payload.retentionClass,
  });

  if (authority.alreadyDeletedAt) {
    const result = lifecycleCleanupJobResultSchema.parse({
      contractVersion: lifecycleCleanupJobContractVersion,
      resourceKind: payload.resourceKind,
      resourceId: payload.resourceId,
      retentionClass: payload.retentionClass,
      disposition: "already_deleted",
      storageRootKey: authority.storageRootKey,
      objects: [],
      objectCount: 0,
      bytesDeleted: 0,
      storageDeletedAt: authority.alreadyDeletedAt.toISOString(),
    });
    await database.transaction((tx) =>
      completeOperationalJobInTransaction({
        tx,
        jobId,
        leaseToken,
        result,
        workerId,
        reason: "Lifecycle cleanup resource was already deleted.",
      }),
    );
    return result;
  }

  await reportProgress(
    lifecycleCleanupJobProgressSchema.parse({
      contractVersion: lifecycleCleanupJobContractVersion,
      stage: "inventorying",
      message: "Building the exact immutable object deletion manifest.",
    }),
  );
  const manifestAttempt = await database.query.operationalJobAttempts.findFirst(
    {
      where: (table, { and, eq, isNotNull }) =>
        and(eq(table.jobId, jobId), isNotNull(table.outputManifest)),
      orderBy: (table, { desc }) => [desc(table.attempt)],
    },
  );
  let manifest;
  if (manifestAttempt?.outputManifest) {
    manifest = lifecycleCleanupOutputManifestSchema.parse(
      manifestAttempt.outputManifest,
    ).objects;
  } else {
    let objects;
    try {
      objects = await storage.listObjects(authority.storageRootKey);
    } catch (error) {
      throw new LifecycleCleanupExecutionError({
        code: "storage_inventory_failed",
        message:
          error instanceof Error
            ? error.message
            : "Storage inventory failed before cleanup.",
        stage: "inventorying",
        retryable: true,
      });
    }
    manifest = lifecycleCleanupOutputManifestSchema.parse({
      objects: objects.map((object) => ({
        key: object.key,
        sizeBytes: object.sizeBytes,
        etag: object.etag,
      })),
    }).objects;
  }
  if (
    manifest.some(
      (object) =>
        object.key !== authority.storageRootKey &&
        !object.key.startsWith(`${authority.storageRootKey}/`),
    )
  ) {
    throw new LifecycleCleanupExecutionError({
      code: "storage_inventory_failed",
      message:
        "Cleanup manifest exceeded its object bound or escaped the resource root.",
      stage: "inventorying",
      retryable: false,
    });
  }
  const bytes = manifest.reduce((total, object) => total + object.sizeBytes, 0);
  await reportProgress(
    lifecycleCleanupJobProgressSchema.parse({
      contractVersion: lifecycleCleanupJobContractVersion,
      stage: "deleting",
      message: "Deleting only the objects captured in the immutable manifest.",
      objectCount: manifest.length,
      bytes,
    }),
    {
      outputManifest: lifecycleCleanupOutputManifestSchema.parse({
        objects: manifest,
      }),
    },
  );
  try {
    await storage.deleteObjects(manifest.map((object) => object.key));
  } catch (error) {
    throw new LifecycleCleanupExecutionError({
      code: "storage_delete_failed",
      message:
        error instanceof Error
          ? error.message
          : "Storage object deletion failed.",
      stage: "deleting",
      retryable: true,
    });
  }

  await reportProgress(
    lifecycleCleanupJobProgressSchema.parse({
      contractVersion: lifecycleCleanupJobContractVersion,
      stage: "committing",
      message: "Committing the storage tombstone and terminal job result.",
      objectCount: manifest.length,
      bytes,
    }),
  );
  return database.transaction(async (tx) => {
    const authorityNow = await resolveDatabaseAuthorityNow(tx);
    if (payload.resourceKind === "release_generation") {
      const [updated] = await tx
        .update(gameReleaseGenerations)
        .set({ storageDeletedAt: authorityNow })
        .where(
          and(
            eq(gameReleaseGenerations.id, payload.resourceId),
            isNull(gameReleaseGenerations.storageDeletedAt),
            sql`${gameReleaseGenerations.storageCleanupStartedAt} is not null`,
          ),
        )
        .returning();
      if (!updated) {
        throw new LifecycleCleanupExecutionError({
          code: "cleanup_commit_failed",
          message: "Release storage tombstone lost its cleanup fence.",
          stage: "committing",
          retryable: true,
        });
      }
    } else {
      const [updated] = await tx
        .update(gameMediaAssets)
        .set({ storageDeletedAt: authorityNow, updatedAt: authorityNow })
        .where(
          and(
            eq(gameMediaAssets.id, payload.resourceId),
            isNull(gameMediaAssets.storageDeletedAt),
            sql`${gameMediaAssets.storageCleanupStartedAt} is not null`,
          ),
        )
        .returning();
      if (!updated) {
        throw new LifecycleCleanupExecutionError({
          code: "cleanup_commit_failed",
          message: "Media storage tombstone lost its cleanup fence.",
          stage: "committing",
          retryable: true,
        });
      }
    }
    const result = lifecycleCleanupJobResultSchema.parse({
      contractVersion: lifecycleCleanupJobContractVersion,
      resourceKind: payload.resourceKind,
      resourceId: payload.resourceId,
      retentionClass: payload.retentionClass,
      disposition: "deleted",
      storageRootKey: authority.storageRootKey,
      objects: manifest,
      objectCount: manifest.length,
      bytesDeleted: bytes,
      storageDeletedAt: authorityNow.toISOString(),
    });
    await completeOperationalJobInTransaction({
      tx,
      jobId,
      leaseToken,
      result,
      workerId,
      reason: "Lifecycle cleanup committed its exact deletion manifest.",
      now: authorityNow,
    });
    return result;
  });
};
