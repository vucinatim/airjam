import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./release-application-service", () => ({
  finalizeOwnedReleaseUpload: vi.fn(),
  requestOwnedReleaseGenerationExport: vi.fn(),
  requestOwnedReleaseUploadTarget: vi.fn(),
}));

import { OperationalAdmissionDeniedError } from "@/server/operations/production-control-service";
import {
  platformMachineFinalizeReleaseUploadResultSchema,
  platformMachineRequestReleaseGenerationExportResultSchema,
  platformMachineRequestReleaseUploadTargetResultSchema,
} from "@air-jam/sdk/platform-machine";
import {
  finalizeReleaseUploadForMachine,
  requestReleaseGenerationExportForMachine,
  requestReleaseUploadTargetForMachine,
} from "./machine-release";
import {
  finalizeOwnedReleaseUpload,
  requestOwnedReleaseGenerationExport,
  requestOwnedReleaseUploadTarget,
} from "./release-application-service";

const now = new Date("2026-04-25T10:01:00.000Z");
const generation = {
  id: "generation_1",
  releaseId: "rel_1",
  sequence: 1,
  status: "awaiting_upload" as const,
  originalFilename: "game.zip",
  contentType: "application/zip",
  declaredSizeBytes: 100,
  observedSizeBytes: null,
  observedContentType: null,
  observedEtag: null,
  observedLastModifiedAt: null,
  extractedSizeBytes: null,
  fileCount: null,
  entryPath: null,
  contentHash: null,
  createdAt: now,
  uploadObservedAt: null,
  processingStartedAt: null,
  readyAt: null,
  failedAt: null,
  abandonedAt: null,
  storageRetention: {
    state: "active" as const,
    inactiveAt: null,
    warnedAt: null,
    eligibleAt: null,
    cleanupStartedAt: null,
    deletedAt: null,
  },
};

const job = {
  id: "job_1",
  kind: "release_artifact_processing" as const,
  status: "queued" as const,
  releaseId: "rel_1",
  generationId: generation.id,
  correlationId: "correlation_1",
  attemptCount: 0,
  maxAttempts: 3,
  progressStage: null,
  progressMessage: null,
  lastErrorCode: null,
  lastErrorRetryable: null,
  availableAt: now,
  deadlineAt: new Date("2026-04-25T11:01:00.000Z"),
  createdAt: now,
  startedAt: null,
  finishedAt: null,
  updatedAt: now,
};

const makeRelease = () => ({
  id: "rel_1",
  gameId: "game_1",
  sourceKind: "upload" as const,
  status: "uploading" as const,
  candidateGenerationId: generation.id,
  promotedGenerationId: null,
  versionLabel: null,
  createdAt: now,
  uploadedAt: null,
  checkedAt: null,
  publishedAt: null,
  quarantinedAt: null,
  archivedAt: null,
  candidateGeneration: generation,
  promotedGeneration: null,
  generations: [generation],
  checks: [],
  jobs: [job],
  reports: [],
  game: {
    id: "game_1",
    slug: "pong",
    name: "Pong",
    description: null,
    url: null,
    arcadeVisibility: "hidden" as const,
    userId: "user_1",
    config: {},
    createdAt: new Date("2026-04-25T09:00:00.000Z"),
    updatedAt: new Date("2026-04-25T09:30:00.000Z"),
  },
});

describe("machine release finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the durable queued job instead of executing release work inline", async () => {
    vi.mocked(finalizeOwnedReleaseUpload).mockResolvedValueOnce({
      release: makeRelease() as never,
      generation: generation as never,
      job,
    });

    const result = await finalizeReleaseUploadForMachine({
      releaseId: "rel_1",
      generationId: generation.id,
      userId: "user_1",
    });

    expect(result.release.status).toBe("uploading");
    expect(result.generation.id).toBe(generation.id);
    expect(result.job).toMatchObject({
      id: job.id,
      kind: "release_artifact_processing",
      status: "queued",
      generationId: generation.id,
    });
    expect(() =>
      platformMachineFinalizeReleaseUploadResultSchema.parse(result),
    ).not.toThrow();
  });

  it("returns a public generation beside the redacted upload target", async () => {
    vi.mocked(requestOwnedReleaseUploadTarget).mockResolvedValueOnce({
      release: makeRelease() as never,
      generation: generation as never,
      upload: {
        method: "PUT",
        url: "https://uploads.airjam.test/generation.zip",
        headers: { "content-type": "application/zip" },
        expiresAt: "2026-04-25T10:10:00.000Z",
      },
    });

    const result = await requestReleaseUploadTargetForMachine({
      releaseId: "rel_1",
      userId: "user_1",
      originalFilename: "game.zip",
      sizeBytes: 100,
    });

    expect(result.generation.id).toBe(generation.id);
    expect(result.upload).not.toHaveProperty("key");
    expect(JSON.stringify(result)).not.toContain("private-generation");
    expect(() =>
      platformMachineRequestReleaseUploadTargetResultSchema.parse(result),
    ).not.toThrow();
  });

  it("returns a signed export target without exposing its storage key", async () => {
    vi.mocked(requestOwnedReleaseGenerationExport).mockResolvedValueOnce({
      generation: generation as never,
      download: {
        method: "GET",
        url: "https://downloads.airjam.test/game.zip",
        filename: "game.zip",
        expiresAt: "2026-04-25T10:10:00.000Z",
      },
    });

    const result = await requestReleaseGenerationExportForMachine({
      releaseId: "rel_1",
      generationId: generation.id,
      userId: "user_1",
    });

    expect(result.generation.id).toBe(generation.id);
    expect(result.download.method).toBe("GET");
    expect(JSON.stringify(result)).not.toContain("zipObjectKey");
    expect(() =>
      platformMachineRequestReleaseGenerationExportResultSchema.parse(result),
    ).not.toThrow();
  });

  it("preserves structured lane denial for machine callers", async () => {
    const decision = {
      contractVersion: 1 as const,
      decisionId: "decision-1",
      lane: "release_processing" as const,
      controlStatus: "available" as const,
      mode: "paused" as const,
      outcome: "denied" as const,
      reason: "lane_paused" as const,
      retryAfterSeconds: 90,
      controlRevision: 2,
    };
    vi.mocked(finalizeOwnedReleaseUpload).mockRejectedValueOnce(
      new OperationalAdmissionDeniedError(decision),
    );

    await expect(
      finalizeReleaseUploadForMachine({
        releaseId: "rel_1",
        generationId: generation.id,
        userId: "user_1",
      }),
    ).rejects.toMatchObject({
      code: "rate_limited",
      status: 503,
      retryAfterSeconds: 90,
      details: { decision },
    });
  });
});
