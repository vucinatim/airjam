import { createHostedReleaseArtifactManifest } from "@/lib/releases/hosted-release-artifact";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import yazl from "yazl";
import * as schema from "../../db/schema";
import { enqueueOperationalJob } from "../jobs/operational-job-service";
import {
  operationalJobExecutors,
  runOperationalJobWorkerCycle,
} from "../jobs/operational-job-worker";
import { createReleaseGenerationJobPayload } from "../jobs/release-job-contract";
import {
  executeReleaseArtifactJobAttempt,
  requestReleaseUploadTarget,
} from "./release-artifact-service";
import { executeReleaseBrowserJobAttempt } from "./release-browser-job-executor";
import { resetReleaseModerationConfigForTests } from "./release-moderation-config";
import type {
  ReleaseStorage,
  ReleaseStoredObjectHead,
} from "./release-storage";
import { buildReleaseGenerationScreenshotObjectKey } from "./release-storage-keys";

const databaseUrl = process.env.AIR_JAM_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;

const createReleaseArchive = async (): Promise<Buffer> => {
  const archive = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.on("error", reject);
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });

  archive.addBuffer(
    Buffer.from("<!doctype html><main>Air Jam</main>"),
    "index.html",
  );
  archive.addBuffer(
    Buffer.from(
      `${JSON.stringify(createHostedReleaseArtifactManifest())}\n`,
      "utf8",
    ),
    ".airjam/release-manifest.json",
  );
  archive.end();
  return completed;
};

type StoredObject = ReleaseStoredObjectHead & { body: Buffer };

const createMemoryReleaseStorage = () => {
  const objects = new Map<string, StoredObject>();
  const reads: Array<{ key: string; expectedEtag: string | null }> = [];

  const storage: ReleaseStorage = {
    async createArtifactUploadTarget({ key, contentType }) {
      return {
        key,
        method: "PUT",
        url: `https://uploads.example.invalid/${encodeURIComponent(key)}`,
        headers: {
          "content-type": contentType,
          "if-none-match": "*",
        },
        expiresAt: "2042-01-01T00:15:00.000Z",
      };
    },
    async createArtifactDownloadTarget({ key, filename }) {
      return {
        method: "GET",
        url: `https://downloads.example.invalid/${encodeURIComponent(key)}`,
        filename,
        expiresAt: "2042-01-01T00:15:00.000Z",
      };
    },
    async headObject(key) {
      const object = objects.get(key);
      if (!object) return null;
      const { body: _body, ...head } = object;
      return head;
    },
    async readObject(key, options) {
      const object = objects.get(key);
      if (!object) throw new Error(`Missing object ${key}.`);
      reads.push({ key, expectedEtag: options?.expectedEtag ?? null });
      if (options?.expectedEtag && options.expectedEtag !== object.etag) {
        throw new Error("Object ETag changed.");
      }
      return object.body;
    },
    async putObject({ key, body, contentType, cacheControl, writeMode }) {
      if (writeMode !== "create") {
        throw new Error("Memory storage only permits create writes.");
      }
      if (objects.has(key)) {
        throw new Error(`Object already exists: ${key}.`);
      }
      objects.set(key, {
        key,
        body,
        sizeBytes: body.byteLength,
        contentType,
        etag: `\"output-${objects.size + 1}\"`,
        lastModifiedAt: new Date("2042-01-01T00:00:00.000Z"),
        metadata: cacheControl ? { "cache-control": cacheControl } : {},
      });
    },
    async deletePrefix() {
      throw new Error(
        "Immutable generation processing must not delete prefixes.",
      );
    },
  };

  const upload = ({
    key,
    body,
    originalFilename,
    etag,
  }: {
    key: string;
    body: Buffer;
    originalFilename: string;
    etag?: string | null;
  }) => {
    if (objects.has(key)) {
      throw new Error(`Immutable upload key already exists: ${key}.`);
    }
    objects.set(key, {
      key,
      body,
      sizeBytes: body.byteLength,
      contentType: "application/zip",
      etag: etag === undefined ? `\"source-${objects.size + 1}\"` : etag,
      lastModifiedAt: new Date("2042-01-01T00:00:00.000Z"),
      metadata: { "original-filename": originalFilename },
    });
  };

  return { objects, reads, storage, upload };
};

describeWithPostgres("immutable release generation authority", () => {
  const client = postgres(databaseUrl!);
  const database = drizzle(client, { schema });
  const suffix = crypto.randomUUID();
  const userId = `generation_user_${suffix}`;
  const gameId = `generation_game_${suffix}`;
  const releaseId = `generation_release_${suffix}`;
  const failedReleaseId = `generation_failed_release_${suffix}`;
  const unfencedReleaseId = `generation_unfenced_release_${suffix}`;
  const concurrentReleaseId = `generation_concurrent_release_${suffix}`;
  const invariantReleaseId = `generation_invariant_release_${suffix}`;
  const evidenceReleaseId = `generation_evidence_release_${suffix}`;
  const otherReleaseId = `generation_other_release_${suffix}`;
  const memory = createMemoryReleaseStorage();

  const releaseInput = (id: string, status: "draft" | "uploading" | "failed") =>
    ({ id, gameId, status }) as Parameters<
      typeof requestReleaseUploadTarget
    >[0]["release"];

  let workerSequence = 0;
  const enqueueGeneration = async (generationId: string) =>
    enqueueOperationalJob({
      database,
      kind: "release_artifact_processing",
      creatorId: userId,
      gameId,
      releaseId: (await database.query.gameReleaseGenerations.findFirst({
        where: (table, { eq }) => eq(table.id, generationId),
      }))!.releaseId,
      generationId,
      idempotencyKey: `generation-test:${generationId}`,
      payload: createReleaseGenerationJobPayload({ generationId }),
      actor: "test:release-generation",
      reason:
        "Prove immutable generation execution through the durable worker.",
    });

  const runArtifactWorker = ({
    storage = memory.storage,
  }: {
    storage?: ReleaseStorage;
  } = {}) =>
    runOperationalJobWorkerCycle({
      kind: "release_artifact_processing",
      workerId: `generation-worker:${workerSequence++}`,
      database,
      executors: {
        ...operationalJobExecutors,
        artifact: (input) =>
          executeReleaseArtifactJobAttempt({ ...input, storage }),
      },
    });

  beforeAll(async () => {
    await database.insert(schema.users).values({
      id: userId,
      name: "Generation authority test",
      email: `${userId}@example.invalid`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await database.insert(schema.games).values({
      id: gameId,
      userId,
      name: "Generation authority test game",
      config: {},
    });
    await database.insert(schema.gameReleases).values([
      { id: releaseId, gameId, sourceKind: "upload", status: "draft" },
      {
        id: failedReleaseId,
        gameId,
        sourceKind: "upload",
        status: "draft",
      },
      {
        id: unfencedReleaseId,
        gameId,
        sourceKind: "upload",
        status: "draft",
      },
      {
        id: concurrentReleaseId,
        gameId,
        sourceKind: "upload",
        status: "draft",
      },
      {
        id: invariantReleaseId,
        gameId,
        sourceKind: "upload",
        status: "draft",
      },
      {
        id: evidenceReleaseId,
        gameId,
        sourceKind: "upload",
        status: "archived",
      },
      {
        id: otherReleaseId,
        gameId,
        sourceKind: "upload",
        status: "archived",
      },
    ]);
  });

  afterAll(async () => {
    await database.delete(schema.games).where(eq(schema.games.id, gameId));
    await database.delete(schema.users).where(eq(schema.users.id, userId));
    await client.end();
  });

  it("abandons replaced upload generations and carries the current one through the durable pipeline", async () => {
    const archive = await createReleaseArchive();
    const first = await requestReleaseUploadTarget({
      release: releaseInput(releaseId, "draft"),
      originalFilename: "first.zip",
      sizeBytes: archive.byteLength,
      actor: "test:release-generation",
      database,
      storage: memory.storage,
    });
    const supersededJob = await enqueueGeneration(first.generation.id);
    const second = await requestReleaseUploadTarget({
      release: releaseInput(releaseId, "uploading"),
      originalFilename: "second.zip",
      sizeBytes: archive.byteLength,
      actor: "test:release-generation",
      database,
      storage: memory.storage,
    });

    expect(first.generation.id).not.toBe(second.generation.id);
    expect(first.upload.headers["if-none-match"]).toBe("*");
    expect(second.generation.sequence).toBe(2);
    expect(second.generation.zipObjectKey).toContain(
      `/generations/${second.generation.id}/source/artifact.zip`,
    );

    const replaced = await database.query.gameReleaseGenerations.findFirst({
      where: (table, { eq }) => eq(table.id, first.generation.id),
    });
    expect(replaced?.status).toBe("abandoned");
    await expect(
      database.query.operationalJobs.findFirst({
        where: (table, { eq }) => eq(table.id, supersededJob.job.id),
      }),
    ).resolves.toMatchObject({
      status: "canceled",
      cancelRequestedBy: "test:release-generation",
    });

    memory.upload({
      key: second.generation.zipObjectKey,
      body: archive,
      originalFilename: second.generation.originalFilename,
    });
    await enqueueGeneration(second.generation.id);
    await expect(runArtifactWorker()).resolves.toMatchObject({
      status: "succeeded",
    });

    const [authoritativeRelease, finalized] = await Promise.all([
      database.query.gameReleases.findFirst({
        where: (table, { eq }) => eq(table.id, releaseId),
      }),
      database.query.gameReleaseGenerations.findFirst({
        where: (table, { eq }) => eq(table.id, second.generation.id),
      }),
    ]);
    expect(authoritativeRelease).toMatchObject({
      status: "checking",
      candidateGenerationId: second.generation.id,
      promotedGenerationId: second.generation.id,
    });
    expect(finalized).toMatchObject({
      id: second.generation.id,
      status: "ready",
      sequence: 2,
    });
    expect(finalized.siteRootKey).toContain(
      `/generations/${second.generation.id}/outputs/`,
    );
    expect(memory.reads).toContainEqual({
      key: second.generation.zipObjectKey,
      expectedEtag: expect.stringMatching(/^"source-/),
    });
    expect(
      [...memory.objects.keys()].filter((key) =>
        key.startsWith(`${finalized.siteRootKey}/`),
      ),
    ).toHaveLength(2);

    const checks = await database.query.gameReleaseChecks.findMany({
      where: (table, { eq }) => eq(table.releaseId, releaseId),
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      generationId: second.generation.id,
      kind: "artifact_validation",
      status: "passed",
    });

    vi.stubEnv("AIRJAM_RELEASES_BROWSER_EXECUTABLE_PATH", "/test/chromium");
    vi.stubEnv("AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN", "test-secret");
    vi.stubEnv("AIRJAM_RELEASES_IMAGE_MODERATION_MODE", "disabled");
    resetReleaseModerationConfigForTests();
    try {
      await expect(
        runOperationalJobWorkerCycle({
          kind: "release_browser_validation",
          workerId: `generation-worker:${workerSequence++}`,
          database,
          executors: {
            ...operationalJobExecutors,
            browser: (input) =>
              executeReleaseBrowserJobAttempt({
                ...input,
                capture: async ({
                  gameId: captureGameId,
                  releaseId: captureReleaseId,
                  generationId,
                  captureId,
                }) => ({
                  generationId,
                  captureId: captureId!,
                  screenshotObjectKey:
                    buildReleaseGenerationScreenshotObjectKey({
                      gameId: captureGameId,
                      releaseId: captureReleaseId,
                      generationId,
                      captureId: captureId!,
                    }),
                  contentType: "image/png",
                  sizeBytes: 4,
                  width: 640,
                  height: 360,
                }),
              }),
          },
        }),
      ).resolves.toMatchObject({ status: "succeeded" });
      const moderationCycle = await runOperationalJobWorkerCycle({
        kind: "release_image_moderation",
        workerId: `generation-worker:${workerSequence++}`,
        database,
      });
      expect(moderationCycle).toMatchObject({ status: "succeeded" });
    } finally {
      vi.unstubAllEnvs();
      resetReleaseModerationConfigForTests();
    }

    await expect(
      database.query.gameReleases.findFirst({
        where: (table, { eq }) => eq(table.id, releaseId),
      }),
    ).resolves.toMatchObject({
      status: "ready",
      candidateGenerationId: null,
      promotedGenerationId: second.generation.id,
    });
    const finalChecks = await database.query.gameReleaseChecks.findMany({
      where: (table, { eq }) => eq(table.releaseId, releaseId),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    });
    expect(finalChecks.map(({ kind }) => kind)).toEqual([
      "artifact_validation",
      "screenshot_capture",
      "image_moderation",
    ]);
    expect(
      finalChecks.every(
        ({ generationId }) => generationId === second.generation.id,
      ),
    ).toBe(true);
  });

  it("fails a generation when first-observed upload facts differ from the declaration", async () => {
    const archive = await createReleaseArchive();
    const requested = await requestReleaseUploadTarget({
      release: releaseInput(failedReleaseId, "draft"),
      originalFilename: "mismatch.zip",
      sizeBytes: archive.byteLength + 1,
      actor: "test:release-generation",
      database,
      storage: memory.storage,
    });
    memory.upload({
      key: requested.generation.zipObjectKey,
      body: archive,
      originalFilename: requested.generation.originalFilename,
    });

    await enqueueGeneration(requested.generation.id);
    await expect(runArtifactWorker()).resolves.toMatchObject({
      status: "failed",
    });

    const [release, generation] = await Promise.all([
      database.query.gameReleases.findFirst({
        where: (table, { eq }) => eq(table.id, failedReleaseId),
      }),
      database.query.gameReleaseGenerations.findFirst({
        where: (table, { eq }) => eq(table.id, requested.generation.id),
      }),
    ]);
    expect(release).toMatchObject({
      status: "failed",
      candidateGenerationId: null,
      promotedGenerationId: null,
    });
    expect(generation?.status).toBe("failed");
  });

  it("fails closed when storage cannot provide an ETag for the source read fence", async () => {
    const archive = await createReleaseArchive();
    const requested = await requestReleaseUploadTarget({
      release: releaseInput(unfencedReleaseId, "draft"),
      originalFilename: "unfenced.zip",
      sizeBytes: archive.byteLength,
      actor: "test:release-generation",
      database,
      storage: memory.storage,
    });
    memory.upload({
      key: requested.generation.zipObjectKey,
      body: archive,
      originalFilename: requested.generation.originalFilename,
      etag: null,
    });

    await enqueueGeneration(requested.generation.id);
    await expect(runArtifactWorker()).resolves.toMatchObject({
      status: "failed",
    });

    const generation = await database.query.gameReleaseGenerations.findFirst({
      where: (table, { eq }) => eq(table.id, requested.generation.id),
    });
    expect(generation?.status).toBe("failed");
  });

  it("does not let another worker claim a legitimate in-flight generation", async () => {
    const archive = await createReleaseArchive();
    const requested = await requestReleaseUploadTarget({
      release: releaseInput(concurrentReleaseId, "draft"),
      originalFilename: "concurrent.zip",
      sizeBytes: archive.byteLength,
      actor: "test:release-generation",
      database,
      storage: memory.storage,
    });
    memory.upload({
      key: requested.generation.zipObjectKey,
      body: archive,
      originalFilename: requested.generation.originalFilename,
    });

    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let confirmReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      confirmReadStarted = resolve;
    });
    const blockingStorage: ReleaseStorage = {
      ...memory.storage,
      async readObject(key, options) {
        confirmReadStarted();
        await readGate;
        return memory.storage.readObject(key, options);
      },
    };

    await enqueueGeneration(requested.generation.id);
    const activeExecution = runArtifactWorker({ storage: blockingStorage });
    await readStarted;

    await expect(runArtifactWorker()).resolves.toMatchObject({
      status: "idle",
    });

    const inFlight = await database.query.gameReleaseGenerations.findFirst({
      where: (table, { eq }) => eq(table.id, requested.generation.id),
    });
    expect(inFlight?.status).toBe("processing");

    releaseRead();
    await expect(activeExecution).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("enforces one active generation and lifecycle-compatible pointers in PostgreSQL", async () => {
    const generationId = `${invariantReleaseId}:candidate`;
    await database.transaction(async (tx) => {
      await tx.insert(schema.gameReleaseGenerations).values({
        id: generationId,
        releaseId: invariantReleaseId,
        sequence: 1,
        status: "awaiting_upload",
        originalFilename: "candidate.zip",
        contentType: "application/zip",
        declaredSizeBytes: 10,
        zipObjectKey: `tests/${suffix}/invariant-candidate.zip`,
      });
      await tx
        .update(schema.gameReleases)
        .set({ status: "uploading", candidateGenerationId: generationId })
        .where(eq(schema.gameReleases.id, invariantReleaseId));
    });

    await expect(
      database.insert(schema.gameReleaseGenerations).values({
        id: `${invariantReleaseId}:second-candidate`,
        releaseId: invariantReleaseId,
        sequence: 2,
        status: "awaiting_upload",
        originalFilename: "second.zip",
        contentType: "application/zip",
        declaredSizeBytes: 10,
        zipObjectKey: `tests/${suffix}/invariant-second.zip`,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    await expect(
      database.transaction(async (tx) => {
        await tx
          .update(schema.gameReleaseGenerations)
          .set({ status: "failed", failedAt: new Date() })
          .where(eq(schema.gameReleaseGenerations.id, generationId));
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "game_release_generation_state_guard",
    });

    await database.transaction(async (tx) => {
      await tx
        .update(schema.gameReleaseGenerations)
        .set({ status: "abandoned", abandonedAt: new Date() })
        .where(eq(schema.gameReleaseGenerations.id, generationId));
      await tx
        .update(schema.gameReleases)
        .set({ status: "archived", candidateGenerationId: null })
        .where(eq(schema.gameReleases.id, invariantReleaseId));
    });
  });

  it("rejects empty ready paths and a promoted pointer to a failed generation", async () => {
    const now = new Date();
    await expect(
      database.insert(schema.gameReleaseGenerations).values({
        id: `${evidenceReleaseId}:empty-ready`,
        releaseId: evidenceReleaseId,
        sequence: 1,
        status: "ready",
        originalFilename: "ready.zip",
        contentType: "application/zip",
        declaredSizeBytes: 10,
        zipObjectKey: `tests/${suffix}/empty-ready.zip`,
        siteRootKey: "",
        observedSizeBytes: 10,
        observedContentType: "application/zip",
        extractedSizeBytes: 10,
        fileCount: 1,
        entryPath: "index.html",
        contentHash: "a".repeat(64),
        uploadObservedAt: now,
        processingStartedAt: now,
        readyAt: now,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    const failedGenerationId = `${evidenceReleaseId}:failed`;
    await database.insert(schema.gameReleaseGenerations).values({
      id: failedGenerationId,
      releaseId: evidenceReleaseId,
      sequence: 1,
      status: "failed",
      originalFilename: "failed.zip",
      contentType: "application/zip",
      declaredSizeBytes: 10,
      zipObjectKey: `tests/${suffix}/failed-generation.zip`,
      failedAt: now,
    });
    await expect(
      database.transaction(async (tx) => {
        await tx
          .update(schema.gameReleases)
          .set({ promotedGenerationId: failedGenerationId })
          .where(eq(schema.gameReleases.id, evidenceReleaseId));
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "game_release_generation_state_guard",
    });
  });

  it("retains generation check evidence on direct deletion and cascades it with the release", async () => {
    const generationId = `${evidenceReleaseId}:ready-evidence`;
    const now = new Date();
    await database.insert(schema.gameReleaseGenerations).values({
      id: generationId,
      releaseId: evidenceReleaseId,
      sequence: 2,
      status: "ready",
      originalFilename: "evidence.zip",
      contentType: "application/zip",
      declaredSizeBytes: 10,
      zipObjectKey: `tests/${suffix}/evidence.zip`,
      siteRootKey: `tests/${suffix}/evidence-site`,
      observedSizeBytes: 10,
      observedContentType: "application/zip",
      extractedSizeBytes: 10,
      fileCount: 1,
      entryPath: "index.html",
      contentHash: "b".repeat(64),
      uploadObservedAt: now,
      processingStartedAt: now,
      readyAt: now,
    });
    await database.insert(schema.gameReleaseChecks).values({
      id: `${evidenceReleaseId}:check`,
      releaseId: evidenceReleaseId,
      generationId,
      kind: "artifact_validation",
      status: "passed",
    });

    await expect(
      database
        .delete(schema.gameReleaseGenerations)
        .where(eq(schema.gameReleaseGenerations.id, generationId)),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    await database
      .delete(schema.gameReleases)
      .where(eq(schema.gameReleases.id, evidenceReleaseId));
    await expect(
      database.query.gameReleaseChecks.findFirst({
        where: (table, { eq }) => eq(table.id, `${evidenceReleaseId}:check`),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a promoted generation pointer from another release", async () => {
    const promoted = await database.query.gameReleases.findFirst({
      where: (table, { eq }) => eq(table.id, releaseId),
    });
    await expect(
      database
        .update(schema.gameReleases)
        .set({ promotedGenerationId: promoted!.promotedGenerationId })
        .where(eq(schema.gameReleases.id, otherReleaseId)),
    ).rejects.toMatchObject({
      cause: {
        code: "23503",
        constraint_name: "game_releases_promoted_generation_fk",
      },
    });
  });
});
