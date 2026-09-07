import { db } from "@/db";
import {
  gameReleaseChecks,
  gameReleaseGenerations,
  gameReleaseReports,
  gameReleases,
  games,
  operationalJobs,
} from "@/db/schema";
import { PlatformApplicationError } from "@/server/application-error";
import type {
  AuthenticatedPlatformActor,
  OperationsPlatformActor,
} from "@/server/auth/application-actor";
import { assertOperationsActor } from "@/server/auth/application-actor";
import {
  resolveOwnedGame,
  type OwnedGameReference,
} from "@/server/games/owned-game-access";
import { enqueueOperationalJob } from "@/server/jobs/operational-job-service";
import { createReleaseGenerationJobPayload } from "@/server/jobs/release-job-contract";
import { assertOperationalLaneAccepting } from "@/server/operations/production-control-service";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { assertOwnedRelease } from "./assert-owned-release";
import { assertReleaseExists } from "./assert-release-exists";
import {
  isReleaseOperationalJobRecord,
  listReleaseDetailsByGame,
  projectReleaseCheck,
  projectReleaseGeneration,
  projectReleaseJob,
} from "./get-release-details";
import { requestReleaseUploadTarget } from "./release-artifact-service";
import {
  archiveRelease,
  publishRelease,
  quarantineRelease,
} from "./release-status-service";
import { getReleaseStorage } from "./release-storage";

const reloadOwnedRelease = async ({
  actor,
  releaseId,
}: {
  actor: AuthenticatedPlatformActor;
  releaseId: string;
}) => {
  try {
    return await assertOwnedRelease(releaseId, actor.userId);
  } catch {
    throw new PlatformApplicationError({
      code: "not_found",
      message: "Release not found or unauthorized.",
    });
  }
};

export const listOwnedGameReleases = async ({
  actor,
  gameReference,
}: {
  actor: AuthenticatedPlatformActor;
  gameReference: OwnedGameReference;
}) => {
  const game = await resolveOwnedGame({ actor, reference: gameReference });
  const releases = await listReleaseDetailsByGame(game);

  return { game, releases };
};

export const getOwnedRelease = reloadOwnedRelease;

export const createOwnedDraftRelease = async ({
  actor,
  gameReference,
  versionLabel,
}: {
  actor: AuthenticatedPlatformActor;
  gameReference: OwnedGameReference;
  versionLabel?: string;
}) => {
  const game = await resolveOwnedGame({ actor, reference: gameReference });
  await assertOperationalLaneAccepting({ lane: "release_submission" });
  const [release] = await db
    .insert(gameReleases)
    .values({
      id: crypto.randomUUID(),
      gameId: game.id,
      sourceKind: "upload",
      status: "draft",
      versionLabel: versionLabel?.trim() || null,
    })
    .returning();

  if (!release) {
    throw new Error("Draft release could not be created.");
  }

  return reloadOwnedRelease({ actor, releaseId: release.id });
};

export const requestOwnedReleaseUploadTarget = async ({
  actor,
  releaseId,
  originalFilename,
  sizeBytes,
}: {
  actor: AuthenticatedPlatformActor;
  releaseId: string;
  originalFilename: string;
  sizeBytes: number;
}) => {
  const release = await reloadOwnedRelease({ actor, releaseId });
  await assertOperationalLaneAccepting({ lane: "artifact_ingestion" });
  const result = await requestReleaseUploadTarget({
    release,
    originalFilename,
    sizeBytes,
    actor: `creator:${actor.userId}`,
  });

  return {
    release: await reloadOwnedRelease({ actor, releaseId }),
    generation: projectReleaseGeneration(result.generation),
    upload: {
      method: result.upload.method,
      url: result.upload.url,
      headers: result.upload.headers,
      expiresAt: result.upload.expiresAt,
    },
  };
};

export const finalizeOwnedReleaseUpload = async ({
  actor,
  releaseId,
  generationId,
}: {
  actor: AuthenticatedPlatformActor;
  releaseId: string;
  generationId: string;
}) => {
  const release = await reloadOwnedRelease({ actor, releaseId });
  const generation = release.generations.find(
    (candidate) => candidate.id === generationId,
  );
  if (!generation) {
    throw new PlatformApplicationError({
      code: "not_found",
      message: "Release generation not found or unauthorized.",
    });
  }

  const existingJob = release.jobs.find(
    (job) =>
      job.kind === "release_artifact_processing" &&
      job.generationId === generationId,
  );
  if (existingJob) {
    return { release, generation, job: existingJob };
  }

  if (
    release.status !== "uploading" ||
    release.candidateGenerationId !== generationId ||
    generation.status !== "awaiting_upload"
  ) {
    throw new PlatformApplicationError({
      code: "conflict",
      message: "Only the current awaiting-upload generation can be finalized.",
    });
  }

  await assertOperationalLaneAccepting({ lane: "release_processing" });
  const enqueued = await enqueueOperationalJob({
    kind: "release_artifact_processing",
    creatorId: actor.userId,
    gameId: release.gameId,
    releaseId,
    generationId,
    idempotencyKey: `release-finalize:${releaseId}:${generationId}`,
    payload: createReleaseGenerationJobPayload({ generationId }),
    actor: `creator:${actor.userId}`,
    reason: "Creator finalized an immutable release generation upload.",
  });
  const updatedRelease = await reloadOwnedRelease({ actor, releaseId });
  const job = updatedRelease.jobs.find(
    (candidate) => candidate.id === enqueued.job.id,
  );
  if (!job) {
    throw new Error("Enqueued release processing job was not observable.");
  }

  return {
    release: updatedRelease,
    generation:
      updatedRelease.generations.find(
        (candidate) => candidate.id === generationId,
      ) ?? generation,
    job,
  };
};

export const requestOwnedReleaseGenerationExport = async ({
  actor,
  releaseId,
  generationId,
  database = db,
  storage = getReleaseStorage(),
}: {
  actor: AuthenticatedPlatformActor;
  releaseId: string;
  generationId: string;
  database?: typeof db;
  storage?: ReturnType<typeof getReleaseStorage>;
}) => {
  const [ownedGeneration] = await database
    .select({ generation: gameReleaseGenerations })
    .from(gameReleaseGenerations)
    .innerJoin(
      gameReleases,
      eq(gameReleaseGenerations.releaseId, gameReleases.id),
    )
    .innerJoin(games, eq(gameReleases.gameId, games.id))
    .where(
      and(
        eq(gameReleaseGenerations.id, generationId),
        eq(gameReleaseGenerations.releaseId, releaseId),
        eq(games.userId, actor.userId),
      ),
    );

  if (!ownedGeneration) {
    throw new PlatformApplicationError({
      code: "not_found",
      message: "Release generation not found or unauthorized.",
    });
  }

  if (
    ownedGeneration.generation.storageCleanupStartedAt ||
    ownedGeneration.generation.storageDeletedAt
  ) {
    throw new PlatformApplicationError({
      code: "conflict",
      message: "This release generation is no longer available for export.",
    });
  }

  const storedObject = await storage.headObject(
    ownedGeneration.generation.zipObjectKey,
  );
  if (!storedObject) {
    throw new PlatformApplicationError({
      code: "conflict",
      message: "The release archive is unavailable in storage.",
    });
  }
  const expectedSize =
    ownedGeneration.generation.observedSizeBytes ??
    ownedGeneration.generation.declaredSizeBytes;
  if (
    storedObject.sizeBytes !== expectedSize ||
    (ownedGeneration.generation.observedEtag !== null &&
      storedObject.etag !== ownedGeneration.generation.observedEtag)
  ) {
    throw new PlatformApplicationError({
      code: "conflict",
      message: "The release archive no longer matches its immutable record.",
    });
  }

  const download = await storage.createArtifactDownloadTarget({
    key: ownedGeneration.generation.zipObjectKey,
    filename: ownedGeneration.generation.originalFilename,
  });

  const generation = await database.transaction(async (tx) => {
    const [record] = await tx
      .select()
      .from(gameReleaseGenerations)
      .where(
        and(
          eq(gameReleaseGenerations.id, generationId),
          eq(gameReleaseGenerations.releaseId, releaseId),
        ),
      )
      .for("update");

    if (!record) {
      throw new PlatformApplicationError({
        code: "not_found",
        message: "Release generation not found or unauthorized.",
      });
    }

    const [ownedRelease] = await tx
      .select({ id: gameReleases.id })
      .from(gameReleases)
      .innerJoin(games, eq(gameReleases.gameId, games.id))
      .where(
        and(eq(gameReleases.id, releaseId), eq(games.userId, actor.userId)),
      );

    if (!ownedRelease) {
      throw new PlatformApplicationError({
        code: "not_found",
        message: "Release generation not found or unauthorized.",
      });
    }

    if (record.storageCleanupStartedAt || record.storageDeletedAt) {
      throw new PlatformApplicationError({
        code: "conflict",
        message: "This release generation is no longer available for export.",
      });
    }

    if (record.storageInactiveAt) {
      const [refreshed] = await tx
        .update(gameReleaseGenerations)
        .set({
          storageInactiveAt: sql`clock_timestamp()`,
          storageRetentionWarnedAt: null,
          storageRetentionEligibleAt: null,
        })
        .where(eq(gameReleaseGenerations.id, record.id))
        .returning();
      return refreshed ?? record;
    }

    return record;
  });

  return {
    generation: projectReleaseGeneration(generation),
    download,
  };
};

export const publishOwnedRelease = async ({
  actor,
  releaseId,
}: {
  actor: AuthenticatedPlatformActor;
  releaseId: string;
}) => {
  await reloadOwnedRelease({ actor, releaseId });
  await publishRelease({ releaseId });
  return reloadOwnedRelease({ actor, releaseId });
};

export const archiveOwnedRelease = async ({
  actor,
  releaseId,
}: {
  actor: AuthenticatedPlatformActor;
  releaseId: string;
}) => {
  await reloadOwnedRelease({ actor, releaseId });
  await archiveRelease({ releaseId });
  return reloadOwnedRelease({ actor, releaseId });
};

export const listReleasesForOperations = async ({
  actor,
}: {
  actor: OperationsPlatformActor;
}) => {
  assertOperationsActor(actor);
  const releases = await db.query.gameReleases.findMany({
    where: (table, { notInArray }) => notInArray(table.status, ["draft"]),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
    limit: 100,
  });

  if (releases.length === 0) {
    return [];
  }

  const releaseIds = releases.map((release) => release.id);
  const [generations, checks, reports, jobs, releaseGames] = await Promise.all([
    db
      .select()
      .from(gameReleaseGenerations)
      .where(inArray(gameReleaseGenerations.releaseId, releaseIds))
      .orderBy(desc(gameReleaseGenerations.sequence)),
    db
      .select()
      .from(gameReleaseChecks)
      .where(inArray(gameReleaseChecks.releaseId, releaseIds))
      .orderBy(desc(gameReleaseChecks.createdAt)),
    db
      .select()
      .from(gameReleaseReports)
      .where(inArray(gameReleaseReports.releaseId, releaseIds))
      .orderBy(desc(gameReleaseReports.createdAt)),
    db
      .select()
      .from(operationalJobs)
      .where(inArray(operationalJobs.releaseId, releaseIds))
      .orderBy(desc(operationalJobs.createdAt)),
    db
      .select({
        id: games.id,
        name: games.name,
        slug: games.slug,
        userId: games.userId,
      })
      .from(games)
      .where(
        inArray(
          games.id,
          releases.map((release) => release.gameId),
        ),
      ),
  ]);

  const ownerIds = Array.from(new Set(releaseGames.map((game) => game.userId)));
  const releaseOwners =
    ownerIds.length === 0
      ? []
      : await db.query.users.findMany({
          where: (table, { inArray }) => inArray(table.id, ownerIds),
        });

  const generationsByReleaseId = new Map<
    string,
    ReturnType<typeof projectReleaseGeneration>[]
  >();
  const checksByReleaseId = new Map<string, (typeof checks)[number][]>();
  const reportsByReleaseId = new Map<string, (typeof reports)[number][]>();
  const jobsByReleaseId = new Map<
    string,
    ReturnType<typeof projectReleaseJob>[]
  >();
  const gameById = new Map(releaseGames.map((game) => [game.id, game]));
  const ownerById = new Map(
    releaseOwners.map((owner) => [
      owner.id,
      {
        id: owner.id,
        name: owner.name,
        email: owner.email,
        role: owner.role,
      },
    ]),
  );

  for (const generation of generations) {
    const releaseGenerations =
      generationsByReleaseId.get(generation.releaseId) ?? [];
    releaseGenerations.push(projectReleaseGeneration(generation));
    generationsByReleaseId.set(generation.releaseId, releaseGenerations);
  }

  for (const check of checks) {
    const releaseChecks = checksByReleaseId.get(check.releaseId) ?? [];
    releaseChecks.push(check);
    checksByReleaseId.set(check.releaseId, releaseChecks);
  }

  for (const report of reports) {
    const releaseReports = reportsByReleaseId.get(report.releaseId) ?? [];
    releaseReports.push(report);
    reportsByReleaseId.set(report.releaseId, releaseReports);
  }

  for (const job of jobs) {
    if (!isReleaseOperationalJobRecord(job)) continue;
    const releaseJobs = jobsByReleaseId.get(job.releaseId) ?? [];
    releaseJobs.push(projectReleaseJob(job));
    jobsByReleaseId.set(job.releaseId, releaseJobs);
  }

  return releases.map((release) => {
    const game = gameById.get(release.gameId);
    const releaseGenerations = generationsByReleaseId.get(release.id) ?? [];
    const generationById = new Map(
      releaseGenerations.map((generation) => [generation.id, generation]),
    );
    return {
      ...release,
      game: game
        ? { ...game, owner: ownerById.get(game.userId) ?? null }
        : null,
      generations: releaseGenerations,
      candidateGeneration: release.candidateGenerationId
        ? (generationById.get(release.candidateGenerationId) ?? null)
        : null,
      promotedGeneration: release.promotedGenerationId
        ? (generationById.get(release.promotedGenerationId) ?? null)
        : null,
      checks: (checksByReleaseId.get(release.id) ?? []).map(
        projectReleaseCheck,
      ),
      jobs: jobsByReleaseId.get(release.id) ?? [],
      reports: reportsByReleaseId.get(release.id) ?? [],
    };
  });
};

export const quarantineReleaseForOperations = async ({
  actor,
  releaseId,
}: {
  actor: OperationsPlatformActor;
  releaseId: string;
}) => {
  assertOperationsActor(actor);
  await assertReleaseExists(releaseId);
  await quarantineRelease({ releaseId });
  return assertReleaseExists(releaseId);
};
