import { PlatformApplicationError } from "@/server/application-error";
import { buildHostedReleaseAssetUrl } from "@/server/releases/release-public-url";
import type { PlatformMachineReleaseSummary } from "@air-jam/sdk/platform-machine";
import {
  PlatformMachineAuthError,
  rethrowOperationalAdmissionForMachine,
} from "../auth/machine-auth-errors";
import { serializeOwnedGameForMachine } from "../games/machine-game";
import { getReleaseDetails } from "./get-release-details";
import {
  createOwnedDraftRelease,
  finalizeOwnedReleaseUpload,
  getOwnedRelease,
  listOwnedGameReleases,
  publishOwnedRelease,
  requestOwnedReleaseGenerationExport,
  requestOwnedReleaseUploadTarget,
} from "./release-application-service";

type ReleaseDetails = NonNullable<
  Awaited<ReturnType<typeof getReleaseDetails>>
>;

const serializeReleaseGenerationForMachine = (
  generation: ReleaseDetails["generations"][number],
) => ({
  id: generation.id,
  releaseId: generation.releaseId,
  sequence: generation.sequence,
  status: generation.status,
  originalFilename: generation.originalFilename,
  contentType: generation.contentType,
  declaredSizeBytes: generation.declaredSizeBytes,
  observedSizeBytes: generation.observedSizeBytes,
  observedContentType: generation.observedContentType,
  observedEtag: generation.observedEtag,
  observedLastModifiedAt:
    generation.observedLastModifiedAt?.toISOString() ?? null,
  extractedSizeBytes: generation.extractedSizeBytes,
  fileCount: generation.fileCount,
  entryPath: generation.entryPath,
  contentHash: generation.contentHash,
  createdAt: generation.createdAt.toISOString(),
  uploadObservedAt: generation.uploadObservedAt?.toISOString() ?? null,
  processingStartedAt: generation.processingStartedAt?.toISOString() ?? null,
  readyAt: generation.readyAt?.toISOString() ?? null,
  failedAt: generation.failedAt?.toISOString() ?? null,
  abandonedAt: generation.abandonedAt?.toISOString() ?? null,
  storageRetention: {
    state: generation.storageRetention.state,
    inactiveAt: generation.storageRetention.inactiveAt?.toISOString() ?? null,
    warnedAt: generation.storageRetention.warnedAt?.toISOString() ?? null,
    eligibleAt: generation.storageRetention.eligibleAt?.toISOString() ?? null,
    cleanupStartedAt:
      generation.storageRetention.cleanupStartedAt?.toISOString() ?? null,
    deletedAt: generation.storageRetention.deletedAt?.toISOString() ?? null,
  },
});

export const serializeReleaseForMachine = (release: ReleaseDetails) => {
  const candidateGeneration = release.candidateGeneration
    ? serializeReleaseGenerationForMachine(release.candidateGeneration)
    : null;
  const promotedGeneration = release.promotedGeneration
    ? serializeReleaseGenerationForMachine(release.promotedGeneration)
    : null;
  const publicGeneration =
    release.status === "live" &&
    release.game.arcadeVisibility === "listed" &&
    promotedGeneration
      ? promotedGeneration
      : null;

  return {
    id: release.id,
    gameId: release.gameId,
    sourceKind: release.sourceKind,
    status: release.status,
    candidateGenerationId: release.candidateGenerationId,
    promotedGenerationId: release.promotedGenerationId,
    versionLabel: release.versionLabel,
    createdAt: release.createdAt.toISOString(),
    uploadedAt: release.uploadedAt?.toISOString() ?? null,
    checkedAt: release.checkedAt?.toISOString() ?? null,
    publishedAt: release.publishedAt?.toISOString() ?? null,
    quarantinedAt: release.quarantinedAt?.toISOString() ?? null,
    archivedAt: release.archivedAt?.toISOString() ?? null,
    game: serializeOwnedGameForMachine(release.game),
    candidateGeneration,
    promotedGeneration,
    generations: release.generations.map(serializeReleaseGenerationForMachine),
    checks: release.checks.map((check) => ({
      id: check.id,
      releaseId: check.releaseId,
      generationId: check.generationId,
      kind: check.kind,
      status: check.status,
      summary: check.summary ?? null,
      createdAt: check.createdAt.toISOString(),
    })),
    jobs: release.jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      releaseId: job.releaseId,
      generationId: job.generationId,
      correlationId: job.correlationId,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      progressStage: job.progressStage,
      progressMessage: job.progressMessage,
      lastErrorCode: job.lastErrorCode,
      lastErrorRetryable: job.lastErrorRetryable,
      availableAt: job.availableAt.toISOString(),
      deadlineAt: job.deadlineAt.toISOString(),
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      updatedAt: job.updatedAt.toISOString(),
    })),
    reports: release.reports.map((report) => ({
      id: report.id,
      releaseId: report.releaseId,
      status: report.status,
      source: report.source,
      reason: report.reason,
      details: report.details ?? null,
      reporterEmail: report.reporterEmail ?? null,
      createdAt: report.createdAt.toISOString(),
      reviewedAt: report.reviewedAt?.toISOString() ?? null,
    })),
    hostUrl: publicGeneration
      ? buildHostedReleaseAssetUrl({
          gameId: release.gameId,
          releaseId: release.id,
          generationId: publicGeneration.id,
          assetPath: "/",
        })
      : null,
    controllerUrl: publicGeneration
      ? buildHostedReleaseAssetUrl({
          gameId: release.gameId,
          releaseId: release.id,
          generationId: publicGeneration.id,
          assetPath: "/controller",
        })
      : null,
  } satisfies PlatformMachineReleaseSummary;
};

const toMachineNotFoundError = (message: string) =>
  new PlatformMachineAuthError({
    code: "not_found",
    message,
    status: 404,
  });

const toMachineConflictError = (message: string) =>
  new PlatformMachineAuthError({
    code: "conflict",
    message,
    status: 409,
  });

const toMachineValidationError = (message: string) =>
  new PlatformMachineAuthError({
    code: "validation_failed",
    message,
    status: 400,
  });

const rethrowMachineNotFound = (error: unknown, message: string): void => {
  if (error instanceof PlatformApplicationError && error.code === "not_found") {
    throw toMachineNotFoundError(message);
  }
};

export const assertOwnedReleaseForMachine = async ({
  releaseId,
  userId,
}: {
  releaseId: string;
  userId: string;
}) => {
  try {
    return await getOwnedRelease({ actor: { userId }, releaseId });
  } catch {
    throw toMachineNotFoundError(`No owned release matched "${releaseId}".`);
  }
};

export const listOwnedReleasesForMachine = async ({
  slugOrId,
  userId,
}: {
  slugOrId: string;
  userId: string;
}) => {
  try {
    const { game, releases } = await listOwnedGameReleases({
      actor: { userId },
      gameReference: { kind: "slug-or-id", slugOrId },
    });

    return {
      game: serializeOwnedGameForMachine(game),
      releases: releases.map(serializeReleaseForMachine),
    };
  } catch (error) {
    rethrowMachineNotFound(error, `No owned game matched "${slugOrId}".`);
    throw error;
  }
};

export const createDraftReleaseForMachine = async ({
  slugOrId,
  userId,
  versionLabel,
}: {
  slugOrId: string;
  userId: string;
  versionLabel?: string;
}) => {
  try {
    const release = await createOwnedDraftRelease({
      actor: { userId },
      gameReference: { kind: "slug-or-id", slugOrId },
      versionLabel,
    });
    return serializeReleaseForMachine(release);
  } catch (error) {
    rethrowOperationalAdmissionForMachine(error);
    rethrowMachineNotFound(error, `No owned game matched "${slugOrId}".`);
    throw toMachineConflictError(
      error instanceof Error
        ? error.message
        : "Draft release could not be created.",
    );
  }
};

export const requestReleaseUploadTargetForMachine = async ({
  releaseId,
  userId,
  originalFilename,
  sizeBytes,
}: {
  releaseId: string;
  userId: string;
  originalFilename: string;
  sizeBytes: number;
}) => {
  try {
    const result = await requestOwnedReleaseUploadTarget({
      actor: { userId },
      releaseId,
      originalFilename,
      sizeBytes,
    });

    return {
      release: serializeReleaseForMachine(result.release),
      generation: serializeReleaseGenerationForMachine(result.generation),
      upload: result.upload,
    };
  } catch (error) {
    rethrowOperationalAdmissionForMachine(error);
    rethrowMachineNotFound(error, `No owned release matched "${releaseId}".`);
    throw toMachineValidationError(
      error instanceof Error
        ? error.message
        : "Invalid release upload request.",
    );
  }
};

export const finalizeReleaseUploadForMachine = async ({
  releaseId,
  generationId,
  userId,
}: {
  releaseId: string;
  generationId: string;
  userId: string;
}) => {
  try {
    const result = await finalizeOwnedReleaseUpload({
      actor: { userId },
      releaseId,
      generationId,
    });
    return {
      release: serializeReleaseForMachine(result.release),
      generation: serializeReleaseGenerationForMachine(result.generation),
      job: {
        ...result.job,
        availableAt: result.job.availableAt.toISOString(),
        deadlineAt: result.job.deadlineAt.toISOString(),
        createdAt: result.job.createdAt.toISOString(),
        startedAt: result.job.startedAt?.toISOString() ?? null,
        finishedAt: result.job.finishedAt?.toISOString() ?? null,
        updatedAt: result.job.updatedAt.toISOString(),
      },
    };
  } catch (error) {
    rethrowOperationalAdmissionForMachine(error);
    rethrowMachineNotFound(error, `No owned release matched "${releaseId}".`);
    throw toMachineConflictError(
      error instanceof Error
        ? error.message
        : "Release upload could not be finalized.",
    );
  }
};

export const requestReleaseGenerationExportForMachine = async ({
  releaseId,
  generationId,
  userId,
}: {
  releaseId: string;
  generationId: string;
  userId: string;
}) => {
  try {
    const result = await requestOwnedReleaseGenerationExport({
      actor: { userId },
      releaseId,
      generationId,
    });
    return {
      generation: serializeReleaseGenerationForMachine(result.generation),
      download: result.download,
    };
  } catch (error) {
    rethrowMachineNotFound(
      error,
      `No owned release generation matched "${generationId}".`,
    );
    throw toMachineConflictError(
      error instanceof Error
        ? error.message
        : "Release generation could not be exported.",
    );
  }
};

export const publishReleaseForMachine = async ({
  releaseId,
  userId,
}: {
  releaseId: string;
  userId: string;
}) => {
  try {
    const release = await publishOwnedRelease({
      actor: { userId },
      releaseId,
    });
    return serializeReleaseForMachine(release);
  } catch (error) {
    rethrowMachineNotFound(error, `No owned release matched "${releaseId}".`);
    throw toMachineConflictError(
      error instanceof Error
        ? error.message
        : "Release could not be published.",
    );
  }
};
