import { describe, expect, it } from "vitest";
import {
  lifecycleCleanupJobContractVersion,
  lifecycleCleanupJobPayloadSchema,
  lifecycleCleanupJobResultSchema,
  serializeLifecycleCleanupExecutionError,
} from "./lifecycle-cleanup-job-contract";

describe("lifecycle cleanup job contract", () => {
  it("binds each resource kind to its canonical retention class", () => {
    expect(
      lifecycleCleanupJobPayloadSchema.parse({
        contractVersion: lifecycleCleanupJobContractVersion,
        resourceKind: "release_generation",
        resourceId: "generation-1",
        retentionClass: "terminal_release_generation_24h",
        eligibleAt: "2026-08-29T00:00:00.000Z",
        plannedAt: "2026-08-30T00:00:00.000Z",
      }),
    ).toMatchObject({ resourceId: "generation-1" });
    expect(
      lifecycleCleanupJobPayloadSchema.parse({
        contractVersion: lifecycleCleanupJobContractVersion,
        resourceKind: "release_generation",
        resourceId: "generation-2",
        retentionClass: "superseded_unpublished_release_180d",
        eligibleAt: "2026-08-29T00:00:00.000Z",
        plannedAt: "2026-08-30T00:00:00.000Z",
      }),
    ).toMatchObject({ resourceId: "generation-2" });
    expect(() =>
      lifecycleCleanupJobPayloadSchema.parse({
        contractVersion: lifecycleCleanupJobContractVersion,
        resourceKind: "game_media_asset",
        resourceId: "asset-1",
        retentionClass: "terminal_release_generation_24h",
        eligibleAt: "2026-08-29T00:00:00.000Z",
        plannedAt: "2026-08-30T00:00:00.000Z",
      }),
    ).toThrow(/inactive_game_media_24h/u);
  });

  it("rejects cleanup plans created before eligibility", () => {
    expect(() =>
      lifecycleCleanupJobPayloadSchema.parse({
        contractVersion: lifecycleCleanupJobContractVersion,
        resourceKind: "game_media_asset",
        resourceId: "asset-1",
        retentionClass: "inactive_game_media_24h",
        eligibleAt: "2026-08-31T00:00:00.000Z",
        plannedAt: "2026-08-30T00:00:00.000Z",
      }),
    ).toThrow(/retention deadline/u);
  });

  it("requires exact manifest totals in terminal results", () => {
    const result = {
      contractVersion: lifecycleCleanupJobContractVersion,
      resourceKind: "game_media_asset" as const,
      resourceId: "asset-1",
      retentionClass: "inactive_game_media_24h" as const,
      disposition: "deleted" as const,
      storageRootKey: "games/game-1/media/thumbnail/asset-1",
      objects: [{ key: "object-1", sizeBytes: 42, etag: null }],
      objectCount: 1,
      bytesDeleted: 42,
      storageDeletedAt: "2026-08-30T00:00:00.000Z",
    };
    expect(lifecycleCleanupJobResultSchema.parse(result)).toEqual(result);
    expect(() =>
      lifecycleCleanupJobResultSchema.parse({ ...result, bytesDeleted: 41 }),
    ).toThrow(/immutable deletion manifest/u);
  });

  it("serializes unknown failures as retryable typed errors", () => {
    expect(
      serializeLifecycleCleanupExecutionError({
        error: new Error("storage unavailable"),
        stage: "inventorying",
      }),
    ).toEqual({
      contractVersion: lifecycleCleanupJobContractVersion,
      code: "unexpected_cleanup_error",
      message: "Lifecycle cleanup failed unexpectedly.",
      stage: "inventorying",
      retryable: true,
    });
  });
});
