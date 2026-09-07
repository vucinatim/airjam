import * as schema from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getOperationalJob,
  replayOperationalJob,
} from "../jobs/operational-job-service";
import {
  operationalJobExecutors,
  runOperationalJobWorkerCycle,
} from "../jobs/operational-job-worker";
import { requestOwnedReleaseGenerationExport } from "../releases/release-application-service";
import type {
  ReleaseStorage,
  ReleaseStoredObjectSummary,
} from "../releases/release-storage";
import { executeLifecycleCleanupJobAttempt } from "./lifecycle-cleanup-job-executor";
import {
  inspectLifecycleCleanupCandidates,
  scheduleLifecycleCleanup,
} from "./lifecycle-cleanup-service";

const databaseUrl = process.env.AIR_JAM_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);

describeWithPostgres("lifecycle cleanup PostgreSQL authority", () => {
  const client = postgres(databaseUrl!, { max: 6 });
  const database = drizzle(client, { schema });
  const suffix = crypto.randomUUID();
  const creatorId = `cleanup_creator_${suffix}`;
  const gameId = `cleanup_game_${suffix}`;
  const releaseId = `cleanup_release_${suffix}`;
  const generationId = `cleanup_generation_${suffix}`;
  const mediaId = `cleanup_media_${suffix}`;
  const baseTime = new Date("2020-01-01T00:00:00.000Z");
  const planningTime = new Date();
  const generationRoot = `games/${gameId}/releases/${releaseId}/generations/${generationId}`;
  const mediaRoot = `games/${gameId}/media/thumbnail/${mediaId}`;
  const objectsByPrefix = new Map<string, ReleaseStoredObjectSummary[]>([
    [
      generationRoot,
      [
        {
          key: `${generationRoot}/source/artifact.zip`,
          sizeBytes: 100,
          etag: "generation-etag",
          lastModifiedAt: baseTime,
        },
      ],
    ],
    [
      mediaRoot,
      [
        {
          key: `${mediaRoot}/source.png`,
          sizeBytes: 50,
          etag: "media-etag",
          lastModifiedAt: baseTime,
        },
      ],
    ],
  ]);
  let deletedKeys: string[] = [];
  let listedPrefixes: string[] = [];
  let failNextDelete = false;
  const storage: ReleaseStorage = {
    createArtifactUploadTarget: async () => {
      throw new Error("not used");
    },
    createArtifactDownloadTarget: async ({ key, filename }) => {
      return {
        method: "GET",
        url: `https://downloads.airjam.test/${encodeURIComponent(key)}`,
        filename,
        expiresAt: "2042-01-01T00:15:00.000Z",
      };
    },
    headObject: async (key) => {
      for (const objects of objectsByPrefix.values()) {
        const object = objects.find((candidate) => candidate.key === key);
        if (object) {
          return {
            ...object,
            contentType: "application/zip",
            metadata: {},
          };
        }
      }
      return null;
    },
    readObject: async () => Buffer.alloc(0),
    putObject: async () => undefined,
    listObjects: async (prefix) => {
      listedPrefixes.push(prefix);
      return objectsByPrefix.get(prefix) ?? [];
    },
    deleteObjects: async (keys) => {
      if (failNextDelete) {
        failNextDelete = false;
        const partiallyDeletedKeys = keys.slice(0, 1);
        deletedKeys.push(...partiallyDeletedKeys);
        for (const [prefix, objects] of objectsByPrefix) {
          objectsByPrefix.set(
            prefix,
            objects.filter(
              (object) => !partiallyDeletedKeys.includes(object.key),
            ),
          );
        }
        throw new Error("simulated object-store outage");
      }
      deletedKeys.push(...keys);
      for (const [prefix, objects] of objectsByPrefix) {
        objectsByPrefix.set(
          prefix,
          objects.filter((object) => !keys.includes(object.key)),
        );
      }
    },
    deletePrefix: async () => undefined,
  };
  const executors = {
    ...operationalJobExecutors,
    cleanup: (input: Parameters<typeof executeLifecycleCleanupJobAttempt>[0]) =>
      executeLifecycleCleanupJobAttempt({ ...input, storage }),
  };

  beforeAll(async () => {
    await database.insert(schema.users).values({
      id: creatorId,
      name: "Lifecycle cleanup creator",
      email: `${creatorId}@example.invalid`,
      emailVerified: true,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    await database.insert(schema.games).values({
      id: gameId,
      userId: creatorId,
      name: "Lifecycle cleanup game",
      config: {},
      createdAt: baseTime,
      updatedAt: baseTime,
    });
  });

  beforeEach(async () => {
    await database
      .delete(schema.operationalJobs)
      .where(eq(schema.operationalJobs.creatorId, creatorId));
    await database
      .delete(schema.operationalJobCommands)
      .where(
        inArray(schema.operationalJobCommands.actor, [
          "test:lifecycle-cleanup",
          "test:lifecycle-replay",
        ]),
      );
    await database
      .delete(schema.gameMediaAssets)
      .where(eq(schema.gameMediaAssets.gameId, gameId));
    await database
      .delete(schema.gameReleases)
      .where(eq(schema.gameReleases.gameId, gameId));
    await database.insert(schema.gameReleases).values({
      id: releaseId,
      gameId,
      sourceKind: "upload",
      status: "failed",
      createdAt: baseTime,
      checkedAt: baseTime,
    });
    await database.insert(schema.gameReleaseGenerations).values({
      id: generationId,
      releaseId,
      sequence: 1,
      status: "failed",
      originalFilename: "game.zip",
      contentType: "application/zip",
      declaredSizeBytes: 100,
      zipObjectKey: `${generationRoot}/source/artifact.zip`,
      createdAt: baseTime,
      failedAt: baseTime,
    });
    await database.insert(schema.gameMediaAssets).values({
      id: mediaId,
      gameId,
      kind: "thumbnail",
      status: "archived",
      originalFilename: "thumbnail.png",
      mimeType: "image/png",
      sizeBytes: 50,
      storageKey: `${mediaRoot}/source.png`,
      inactiveAt: baseTime,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    objectsByPrefix.set(generationRoot, [
      {
        key: `${generationRoot}/source/artifact.zip`,
        sizeBytes: 100,
        etag: "generation-etag",
        lastModifiedAt: baseTime,
      },
    ]);
    objectsByPrefix.set(mediaRoot, [
      {
        key: `${mediaRoot}/source.png`,
        sizeBytes: 50,
        etag: "media-etag",
        lastModifiedAt: baseTime,
      },
    ]);
    deletedKeys = [];
    listedPrefixes = [];
    failNextDelete = false;
  });

  afterAll(async () => {
    await database
      .delete(schema.operationalJobs)
      .where(eq(schema.operationalJobs.creatorId, creatorId));
    await database
      .delete(schema.operationalJobCommands)
      .where(
        inArray(schema.operationalJobCommands.actor, [
          "test:lifecycle-cleanup",
          "test:lifecycle-replay",
        ]),
      );
    await database
      .delete(schema.gameMediaAssets)
      .where(eq(schema.gameMediaAssets.gameId, gameId));
    await database
      .delete(schema.gameReleases)
      .where(eq(schema.gameReleases.gameId, gameId));
    await database.delete(schema.games).where(eq(schema.games.id, gameId));
    await database.delete(schema.users).where(eq(schema.users.id, creatorId));
    await client.end();
  });

  it("previews exact bytes, schedules idempotently, and tombstones both resource classes", async () => {
    const preview = await inspectLifecycleCleanupCandidates({
      database,
      storage,
      now: planningTime,
    });
    expect(
      preview.candidates.map((candidate) => ({
        resourceKind: candidate.resourceKind,
        objectCount: candidate.objectCount,
        bytes: candidate.bytes,
      })),
    ).toEqual([
      { resourceKind: "release_generation", objectCount: 1, bytes: 100 },
      { resourceKind: "game_media_asset", objectCount: 1, bytes: 50 },
    ]);

    const scheduled = await scheduleLifecycleCleanup({
      database,
      actor: "test:lifecycle-cleanup",
      reason: "Prove exact lifecycle cleanup.",
      idempotencyKey: `${suffix}:cleanup-batch`,
      now: planningTime,
    });
    const replayed = await scheduleLifecycleCleanup({
      database,
      actor: "test:lifecycle-cleanup",
      reason: "Prove exact lifecycle cleanup.",
      idempotencyKey: `${suffix}:cleanup-batch`,
      now: planningTime,
    });
    expect(scheduled.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    expect(replayed.jobs).toEqual(scheduled.jobs);

    for (let index = 0; index < 2; index += 1) {
      await expect(
        runOperationalJobWorkerCycle({
          kind: "lifecycle_cleanup",
          workerId: `worker:lifecycle:${index}`,
          database,
          executors,
        }),
      ).resolves.toMatchObject({ status: "succeeded" });
    }
    expect(deletedKeys.sort()).toEqual(
      [
        `${generationRoot}/source/artifact.zip`,
        `${mediaRoot}/source.png`,
      ].sort(),
    );
    const [generation, media, jobs] = await Promise.all([
      database.query.gameReleaseGenerations.findFirst({
        where: (table, { eq }) => eq(table.id, generationId),
      }),
      database.query.gameMediaAssets.findFirst({
        where: (table, { eq }) => eq(table.id, mediaId),
      }),
      database.query.operationalJobs.findMany({
        where: (table, { eq }) => eq(table.kind, "lifecycle_cleanup"),
      }),
    ]);
    expect(generation?.storageDeletedAt).toBeInstanceOf(Date);
    expect(media?.storageDeletedAt).toBeInstanceOf(Date);
    expect(jobs.map((job) => job.result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bytesDeleted: 100, objectCount: 1 }),
        expect.objectContaining({ bytesDeleted: 50, objectCount: 1 }),
      ]),
    );
  });

  it("retains a failed deletion manifest and replays cleanup safely", async () => {
    await database
      .update(schema.gameMediaAssets)
      .set({
        storageDeletedAt: planningTime,
        storageCleanupStartedAt: planningTime,
      })
      .where(eq(schema.gameMediaAssets.id, mediaId));
    const scheduled = await scheduleLifecycleCleanup({
      database,
      actor: "test:lifecycle-cleanup",
      reason: "Prove retry-safe cleanup.",
      idempotencyKey: `${suffix}:cleanup-retry`,
      now: planningTime,
    });
    expect(scheduled.jobs).toHaveLength(1);
    failNextDelete = true;
    const first = await runOperationalJobWorkerCycle({
      kind: "lifecycle_cleanup",
      workerId: "worker:lifecycle:retry-one",
      database,
      executors,
    });
    expect(first.status).toBe("retried");
    const jobId = scheduled.jobs[0]!.id;
    const failedAttempt = await getOperationalJob({ database, jobId });
    expect(failedAttempt.attempts[0]?.privateData.hasOutputManifest).toBe(true);
    objectsByPrefix.set(generationRoot, [
      {
        key: `${generationRoot}/late-object.txt`,
        sizeBytes: 25,
        etag: "late-etag",
        lastModifiedAt: planningTime,
      },
    ]);

    const replay = await replayOperationalJob({
      database,
      jobId,
      actor: "test:lifecycle-replay",
      reason: "Explicitly replay terminal cleanup only if needed.",
      idempotencyKey: `${suffix}:not-terminal-yet`,
      now: planningTime,
    }).catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(Error);

    await database
      .update(schema.operationalJobs)
      .set({ availableAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(schema.operationalJobs.id, jobId));
    await expect(
      runOperationalJobWorkerCycle({
        kind: "lifecycle_cleanup",
        workerId: "worker:lifecycle:retry-two",
        database,
        executors,
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(
      listedPrefixes.filter((prefix) => prefix === generationRoot),
    ).toHaveLength(1);
    expect(deletedKeys).not.toContain(`${generationRoot}/late-object.txt`);
    expect(objectsByPrefix.get(generationRoot)).toEqual([
      expect.objectContaining({ key: `${generationRoot}/late-object.txt` }),
    ]);
  });

  it("does not let already-clocked generations starve newer retention work", async () => {
    await database
      .update(schema.gameReleaseGenerations)
      .set({
        storageCleanupStartedAt: planningTime,
        storageDeletedAt: planningTime,
      })
      .where(eq(schema.gameReleaseGenerations.id, generationId));
    await database
      .update(schema.gameMediaAssets)
      .set({
        storageCleanupStartedAt: planningTime,
        storageDeletedAt: planningTime,
      })
      .where(eq(schema.gameMediaAssets.id, mediaId));

    const windowKey = suffix.slice(0, 8);
    const releases = Array.from({ length: 102 }, (_, index) => ({
      id: `window_release_${index}_${windowKey}`,
      gameId,
      sourceKind: "upload" as const,
      status: "archived" as const,
      createdAt: new Date(baseTime.getTime() + index * 60_000),
      checkedAt: new Date(baseTime.getTime() + index * 60_000),
    }));
    const generations = releases.map((release, index) => ({
      id: `window_generation_${index}_${windowKey}`,
      releaseId: release.id,
      sequence: 1,
      status: "ready" as const,
      originalFilename: `${index}.zip`,
      contentType: "application/zip",
      declaredSizeBytes: 1,
      zipObjectKey: `games/${gameId}/releases/${release.id}/generations/window_generation_${index}_${windowKey}/source/artifact.zip`,
      siteRootKey: `games/${gameId}/releases/${release.id}/generations/window_generation_${index}_${windowKey}/site`,
      observedSizeBytes: 1,
      observedContentType: "application/zip",
      extractedSizeBytes: 1,
      fileCount: 1,
      entryPath: "index.html",
      contentHash: index.toString(16).padStart(64, "0"),
      uploadObservedAt: release.createdAt,
      processingStartedAt: release.createdAt,
      readyAt: release.createdAt,
    }));
    await database.insert(schema.gameReleases).values(releases);
    await database.insert(schema.gameReleaseGenerations).values(generations);
    for (let index = 0; index < releases.length; index += 1) {
      await database
        .update(schema.gameReleases)
        .set({
          status: "ready",
          promotedGenerationId: generations[index]!.id,
        })
        .where(eq(schema.gameReleases.id, releases[index]!.id));
    }

    const first = await scheduleLifecycleCleanup({
      database,
      actor: "test:lifecycle-cleanup",
      reason: "Clock the first bounded retention window.",
      idempotencyKey: `${suffix}:cleanup-window-first`,
      now: planningTime,
      limit: 100,
    });
    expect(first.retentionTransitions).toHaveLength(100);
    expect(
      first.retentionTransitions.every(
        (transition) => transition.transition === "inactive",
      ),
    ).toBe(true);

    const second = await scheduleLifecycleCleanup({
      database,
      actor: "test:lifecycle-cleanup",
      reason: "Clock retention work beyond the first bounded window.",
      idempotencyKey: `${suffix}:cleanup-window-second`,
      now: planningTime,
      limit: 100,
    });
    expect(second.retentionTransitions).toEqual([
      expect.objectContaining({
        generationId: generations[100]!.id,
        transition: "inactive",
      }),
    ]);
    const newestSuperseded =
      await database.query.gameReleaseGenerations.findFirst({
        where: (table, { eq }) => eq(table.id, generations[100]!.id),
      });
    expect(newestSuperseded?.storageInactiveAt?.toISOString()).toBe(
      planningTime.toISOString(),
    );
  });

  it("starts historical archived retention at first observation", async () => {
    await database
      .update(schema.gameReleaseGenerations)
      .set({
        status: "ready",
        failedAt: null,
        siteRootKey: `${generationRoot}/site`,
        observedSizeBytes: 100,
        observedContentType: "application/zip",
        extractedSizeBytes: 100,
        fileCount: 1,
        entryPath: "index.html",
        contentHash: "c".repeat(64),
        uploadObservedAt: baseTime,
        processingStartedAt: baseTime,
        readyAt: baseTime,
        storageCleanupStartedAt: null,
        storageDeletedAt: null,
      })
      .where(eq(schema.gameReleaseGenerations.id, generationId));
    await database
      .update(schema.gameReleases)
      .set({
        status: "archived",
        promotedGenerationId: generationId,
        archivedAt: baseTime,
      })
      .where(eq(schema.gameReleases.id, releaseId));
    await database
      .update(schema.gameMediaAssets)
      .set({
        storageCleanupStartedAt: planningTime,
        storageDeletedAt: planningTime,
      })
      .where(eq(schema.gameMediaAssets.id, mediaId));

    const scheduled = await scheduleLifecycleCleanup({
      database,
      actor: "test:lifecycle-cleanup",
      reason: "Observe a historical archived release conservatively.",
      idempotencyKey: `${suffix}:cleanup-historical-first-observation`,
      now: planningTime,
    });
    expect(scheduled.retentionTransitions).toEqual([
      expect.objectContaining({
        generationId,
        transition: "inactive",
        inactiveAt: planningTime.toISOString(),
        warnedAt: null,
      }),
    ]);
    expect(scheduled.jobs).toHaveLength(0);
  });

  it("clears retention state when a generation is no longer superseded", async () => {
    await database
      .update(schema.gameReleaseGenerations)
      .set({
        status: "ready",
        failedAt: null,
        siteRootKey: `${generationRoot}/site`,
        observedSizeBytes: 100,
        observedContentType: "application/zip",
        extractedSizeBytes: 100,
        fileCount: 1,
        entryPath: "index.html",
        contentHash: "d".repeat(64),
        uploadObservedAt: baseTime,
        processingStartedAt: baseTime,
        readyAt: baseTime,
        storageInactiveAt: baseTime,
        storageRetentionWarnedAt: planningTime,
        storageRetentionEligibleAt: new Date(
          planningTime.getTime() + 7 * 24 * 60 * 60 * 1_000,
        ),
      })
      .where(eq(schema.gameReleaseGenerations.id, generationId));
    await database
      .update(schema.gameReleases)
      .set({
        status: "ready",
        promotedGenerationId: generationId,
        checkedAt: baseTime,
      })
      .where(eq(schema.gameReleases.id, releaseId));
    await database
      .update(schema.gameMediaAssets)
      .set({
        storageCleanupStartedAt: planningTime,
        storageDeletedAt: planningTime,
      })
      .where(eq(schema.gameMediaAssets.id, mediaId));

    const scheduled = await scheduleLifecycleCleanup({
      database,
      actor: "test:lifecycle-cleanup",
      reason: "Clear stale retention state from active storage.",
      idempotencyKey: `${suffix}:cleanup-retention-cleared`,
      now: planningTime,
    });
    expect(scheduled.retentionTransitions).toEqual([
      expect.objectContaining({
        generationId,
        transition: "retention_cleared",
        inactiveAt: null,
        warnedAt: null,
        eligibleAt: null,
      }),
    ]);
    const generation = await database.query.gameReleaseGenerations.findFirst({
      where: (table, { eq }) => eq(table.id, generationId),
    });
    expect(generation?.storageInactiveAt).toBeNull();
    expect(generation?.storageRetentionWarnedAt).toBeNull();
    expect(generation?.storageRetentionEligibleAt).toBeNull();
  });

  it("warns for seven days before reclaiming a superseded unpublished release", async () => {
    await database
      .update(schema.gameReleaseGenerations)
      .set({
        storageCleanupStartedAt: planningTime,
        storageDeletedAt: planningTime,
      })
      .where(eq(schema.gameReleaseGenerations.id, generationId));
    await database
      .update(schema.gameMediaAssets)
      .set({
        storageCleanupStartedAt: planningTime,
        storageDeletedAt: planningTime,
      })
      .where(eq(schema.gameMediaAssets.id, mediaId));

    const oldReleaseId = `cleanup_old_release_${suffix}`;
    const oldGenerationId = `cleanup_old_generation_${suffix}`;
    const newReleaseId = `cleanup_new_release_${suffix}`;
    const newGenerationId = `cleanup_new_generation_${suffix}`;
    const oldRoot = `games/${gameId}/releases/${oldReleaseId}/generations/${oldGenerationId}`;
    const inactiveTime = new Date(
      planningTime.getTime() - 180 * 24 * 60 * 60 * 1_000,
    );
    const newerTime = new Date(inactiveTime.getTime() + 24 * 60 * 60 * 1_000);
    const warningTime = new Date(
      planningTime.getTime() - 7 * 24 * 60 * 60 * 1_000,
    );
    const eligibleTime = planningTime;

    await database.insert(schema.gameReleases).values([
      {
        id: oldReleaseId,
        gameId,
        sourceKind: "upload",
        status: "archived",
        createdAt: inactiveTime,
      },
      {
        id: newReleaseId,
        gameId,
        sourceKind: "upload",
        status: "archived",
        createdAt: newerTime,
      },
    ]);
    await database.insert(schema.gameReleaseGenerations).values([
      {
        id: oldGenerationId,
        releaseId: oldReleaseId,
        sequence: 1,
        status: "ready",
        originalFilename: "old.zip",
        contentType: "application/zip",
        declaredSizeBytes: 75,
        zipObjectKey: `${oldRoot}/source/artifact.zip`,
        siteRootKey: `${oldRoot}/site`,
        observedSizeBytes: 75,
        observedContentType: "application/zip",
        extractedSizeBytes: 100,
        fileCount: 1,
        entryPath: "index.html",
        contentHash: "a".repeat(64),
        uploadObservedAt: inactiveTime,
        processingStartedAt: inactiveTime,
        readyAt: inactiveTime,
        storageInactiveAt: inactiveTime,
      },
      {
        id: newGenerationId,
        releaseId: newReleaseId,
        sequence: 1,
        status: "ready",
        originalFilename: "new.zip",
        contentType: "application/zip",
        declaredSizeBytes: 80,
        zipObjectKey: `games/${gameId}/releases/${newReleaseId}/generations/${newGenerationId}/source/artifact.zip`,
        siteRootKey: `games/${gameId}/releases/${newReleaseId}/generations/${newGenerationId}/site`,
        observedSizeBytes: 80,
        observedContentType: "application/zip",
        extractedSizeBytes: 110,
        fileCount: 1,
        entryPath: "index.html",
        contentHash: "b".repeat(64),
        uploadObservedAt: newerTime,
        processingStartedAt: newerTime,
        readyAt: newerTime,
      },
    ]);
    await database
      .update(schema.gameReleases)
      .set({
        status: "ready",
        promotedGenerationId: oldGenerationId,
        checkedAt: inactiveTime,
      })
      .where(eq(schema.gameReleases.id, oldReleaseId));
    await database
      .update(schema.gameReleases)
      .set({
        status: "ready",
        promotedGenerationId: newGenerationId,
        checkedAt: newerTime,
      })
      .where(eq(schema.gameReleases.id, newReleaseId));
    objectsByPrefix.set(oldRoot, [
      {
        key: `${oldRoot}/source/artifact.zip`,
        sizeBytes: 75,
        etag: "old-etag",
        lastModifiedAt: inactiveTime,
      },
    ]);

    const warned = await scheduleLifecycleCleanup({
      database,
      actor: "test:lifecycle-cleanup",
      reason: "Warn before reclaiming superseded unpublished storage.",
      idempotencyKey: `${suffix}:cleanup-warning`,
      now: warningTime,
    });
    expect(warned.jobs).toHaveLength(0);
    expect(warned.retentionTransitions).toEqual([
      expect.objectContaining({
        generationId: oldGenerationId,
        transition: "warned",
        warnedAt: warningTime.toISOString(),
        eligibleAt: eligibleTime.toISOString(),
      }),
    ]);

    const scheduled = await scheduleLifecycleCleanup({
      database,
      actor: "test:lifecycle-cleanup",
      reason: "Reclaim warned superseded unpublished storage.",
      idempotencyKey: `${suffix}:cleanup-superseded`,
      now: eligibleTime,
    });
    expect(scheduled.jobs).toEqual([
      expect.objectContaining({
        kind: "lifecycle_cleanup",
        resourceId: oldGenerationId,
      }),
    ]);
    expect(scheduled.candidates).toEqual([
      expect.objectContaining({
        retentionClass: "superseded_unpublished_release_180d",
        generationId: oldGenerationId,
      }),
    ]);

    await expect(
      runOperationalJobWorkerCycle({
        kind: "lifecycle_cleanup",
        workerId: "worker:lifecycle:superseded",
        database,
        executors,
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    const [generation, release] = await Promise.all([
      database.query.gameReleaseGenerations.findFirst({
        where: (table, { eq }) => eq(table.id, oldGenerationId),
      }),
      database.query.gameReleases.findFirst({
        where: (table, { eq }) => eq(table.id, oldReleaseId),
      }),
    ]);
    expect(generation?.storageDeletedAt).toBeInstanceOf(Date);
    expect(release?.status).toBe("archived");
    expect(deletedKeys).toContain(`${oldRoot}/source/artifact.zip`);
  });

  it("lets the creator export a warned generation and renews its retention window", async () => {
    const exportReleaseId = `cleanup_export_release_${suffix}`;
    const exportGenerationId = `cleanup_export_generation_${suffix}`;
    const exportRoot = `games/${gameId}/releases/${exportReleaseId}/generations/${exportGenerationId}`;
    const eligibleAt = new Date(
      baseTime.getTime() + 180 * 24 * 60 * 60 * 1_000,
    );
    const warnedAt = new Date(eligibleAt.getTime() - 7 * 24 * 60 * 60 * 1_000);
    await database.insert(schema.gameReleases).values({
      id: exportReleaseId,
      gameId,
      sourceKind: "upload",
      status: "archived",
      createdAt: baseTime,
      checkedAt: baseTime,
      archivedAt: baseTime,
    });
    await database.insert(schema.gameReleaseGenerations).values({
      id: exportGenerationId,
      releaseId: exportReleaseId,
      sequence: 1,
      status: "ready",
      originalFilename: "export-me.zip",
      contentType: "application/zip",
      declaredSizeBytes: 90,
      zipObjectKey: `${exportRoot}/source/artifact.zip`,
      siteRootKey: `${exportRoot}/site`,
      observedSizeBytes: 90,
      observedContentType: "application/zip",
      observedEtag: "export-etag",
      extractedSizeBytes: 120,
      fileCount: 1,
      entryPath: "index.html",
      contentHash: "c".repeat(64),
      uploadObservedAt: baseTime,
      processingStartedAt: baseTime,
      readyAt: baseTime,
      storageInactiveAt: baseTime,
      storageRetentionWarnedAt: warnedAt,
      storageRetentionEligibleAt: eligibleAt,
    });
    await database
      .update(schema.gameReleases)
      .set({ promotedGenerationId: exportGenerationId })
      .where(eq(schema.gameReleases.id, exportReleaseId));
    objectsByPrefix.set(exportRoot, [
      {
        key: `${exportRoot}/source/artifact.zip`,
        sizeBytes: 90,
        etag: "export-etag",
        lastModifiedAt: baseTime,
      },
    ]);

    await expect(
      requestOwnedReleaseGenerationExport({
        actor: { userId: "another_creator" },
        releaseId: exportReleaseId,
        generationId: exportGenerationId,
        database,
        storage,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    objectsByPrefix.delete(exportRoot);
    await expect(
      requestOwnedReleaseGenerationExport({
        actor: { userId: creatorId },
        releaseId: exportReleaseId,
        generationId: exportGenerationId,
        database,
        storage,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const unavailable = await database.query.gameReleaseGenerations.findFirst({
      where: (table, { eq }) => eq(table.id, exportGenerationId),
    });
    expect(unavailable).toMatchObject({
      storageInactiveAt: baseTime,
      storageRetentionWarnedAt: warnedAt,
      storageRetentionEligibleAt: eligibleAt,
    });
    objectsByPrefix.set(exportRoot, [
      {
        key: `${exportRoot}/source/artifact.zip`,
        sizeBytes: 90,
        etag: "export-etag",
        lastModifiedAt: baseTime,
      },
    ]);

    const exported = await requestOwnedReleaseGenerationExport({
      actor: { userId: creatorId },
      releaseId: exportReleaseId,
      generationId: exportGenerationId,
      database,
      storage,
    });

    expect(exported.download).toMatchObject({
      method: "GET",
      filename: "export-me.zip",
    });
    expect(exported).not.toHaveProperty("zipObjectKey");
    const refreshed = await database.query.gameReleaseGenerations.findFirst({
      where: (table, { eq }) => eq(table.id, exportGenerationId),
    });
    expect(refreshed?.storageInactiveAt?.getTime()).toBeGreaterThan(
      eligibleAt.getTime(),
    );
    expect(refreshed?.storageRetentionWarnedAt).toBeNull();
    expect(refreshed?.storageRetentionEligibleAt).toBeNull();
  });

  it("schedules and replays cleanup through the canonical repo CLI", () => {
    const runCli = () =>
      JSON.parse(
        execFileSync(
          "pnpm",
          [
            "--silent",
            "run",
            "repo",
            "--",
            "platform",
            "operations",
            "lifecycle",
            "cleanup",
            "--actor",
            "test:lifecycle-cleanup",
            "--reason",
            "Prove the canonical agent cleanup path.",
            "--idempotency-key",
            `${suffix}:cleanup-cli`,
            "--apply",
            "--json",
          ],
          {
            cwd: repoRoot,
            encoding: "utf8",
            env: { ...process.env, DATABASE_URL: databaseUrl! },
          },
        ),
      ) as Record<string, unknown>;

    const first = runCli();
    expect(first).toMatchObject({
      command: "lifecycle-cleanup",
      applied: true,
      result: {
        replayed: false,
        candidates: [
          {
            resourceKind: "release_generation",
            privateData: { hasStorageRootKey: true },
          },
          {
            resourceKind: "game_media_asset",
            privateData: { hasStorageRootKey: true },
          },
        ],
        jobs: [
          { kind: "lifecycle_cleanup", resourceKind: "release_generation" },
          { kind: "lifecycle_cleanup", resourceKind: "game_media_asset" },
        ],
      },
    });
    expect(JSON.stringify(first)).not.toContain(generationRoot);
    expect(JSON.stringify(first)).not.toContain(mediaRoot);
    expect(runCli()).toMatchObject({
      result: { replayed: true },
    });
  });
});
