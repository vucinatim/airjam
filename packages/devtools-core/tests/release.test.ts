import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as yauzl from "yauzl";
import {
  bundleLocalRelease,
  exportPlatformReleaseGeneration,
  inspectLocalRelease,
  listPlatformReleaseTargets,
  submitPlatformRelease,
  validateLocalRelease,
} from "../src/index.js";

const tempRoots: string[] = [];
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "airjam-release-"));
  tempRoots.push(root);
  return root;
};

const createReleaseFixture = async ({
  controllerPath = "/controller",
  metadata = true,
  css = null,
}: {
  controllerPath?: string;
  metadata?: boolean;
  css?: string | null;
} = {}) => {
  const root = await createTempRoot();
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "dist", "assets"), { recursive: true });

  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "release-fixture",
        version: "1.2.3",
        packageManager: "pnpm@10.19.0",
        scripts: {
          build: 'node -e "process.exit(0)"',
        },
        dependencies: {
          "@air-jam/sdk": "^1.0.0",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await writeFile(
    path.join(root, "src", "airjam.config.ts"),
    `${metadata ? 'export const gameMetadata = { title: "Fixture" };\n' : ""}export const airjam = { controllerPath: "${controllerPath}" };\n`,
    "utf8",
  );

  await writeFile(
    path.join(root, "dist", "index.html"),
    "<!doctype html><html><body>fixture</body></html>\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "dist", "assets", "app.js"),
    'console.log("fixture");\n',
    "utf8",
  );

  if (css) {
    await writeFile(path.join(root, "dist", "assets", "app.css"), css, "utf8");
  }

  return root;
};

const readZipEntries = async (
  archivePath: string,
): Promise<Map<string, Buffer>> =>
  new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }

      if (!zipFile) {
        reject(new Error("Missing zip file handle."));
        return;
      }

      const entries = new Map<string, Buffer>();

      zipFile.readEntry();
      zipFile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipFile.readEntry();
          return;
        }

        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError);
            return;
          }

          if (!stream) {
            reject(new Error(`Missing zip entry stream for ${entry.fileName}`));
            return;
          }

          const chunks: Buffer[] = [];
          stream.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipFile.readEntry();
          });
          stream.on("error", reject);
        });
      });

      zipFile.once("end", () => resolve(entries));
      zipFile.once("error", reject);
    });
  });

const createMonorepoFixture = async (): Promise<string> => {
  const root = await createTempRoot();
  await mkdir(path.join(root, "packages", "sdk"), { recursive: true });
  await mkdir(path.join(root, "packages", "create-airjam"), {
    recursive: true,
  });
  await mkdir(path.join(root, "scripts", "repo"), { recursive: true });

  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "air-jam",
        version: "1.0.0",
        private: true,
        packageManager: "pnpm@10.19.0",
        scripts: {
          build: "pnpm -r build",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(path.join(root, "pnpm-lock.yaml"), "", "utf8");
  await writeFile(path.join(root, "scripts", "repo", "cli.mjs"), "", "utf8");

  return root;
};

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0, tempRoots.length)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.unstubAllGlobals();
});

describe("local release tooling", () => {
  it("inspects hosted release readiness from project config", async () => {
    const root = await createReleaseFixture();

    const doctor = await inspectLocalRelease({ cwd: root });

    expect(doctor.canBundle).toBe(true);
    expect(doctor.metadataExportLikely).toBe(true);
    expect(doctor.distEntryExists).toBe(true);
    expect(doctor.recommendedBundlePath).toContain(
      ".airjam/releases/1.2.3/release-fixture-hosted-release.zip",
    );
    expect(doctor.configPath).toBe(
      path.join(await realpath(root), "src", "airjam.config.ts"),
    );
  });

  it("reports invalid hosted controller paths", async () => {
    const root = await createReleaseFixture({
      controllerPath: "/play",
      metadata: false,
    });

    const doctor = await inspectLocalRelease({ cwd: root });

    expect(doctor.canBundle).toBe(false);
    expect(doctor.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-controller-path",
          severity: "error",
        }),
        expect.objectContaining({
          code: "missing-game-metadata",
          severity: "warning",
        }),
      ]),
    );
  });

  it("rejects monorepo roots for local hosted release tooling", async () => {
    const root = await createMonorepoFixture();

    const doctor = await inspectLocalRelease({ cwd: root });

    expect(doctor.canBundle).toBe(false);
    expect(doctor.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsupported-monorepo-project",
          severity: "error",
        }),
      ]),
    );
  });

  it("allows nested repo games inside the monorepo to bundle locally", async () => {
    const gameRoot = path.join(repoRoot, "games", "pong");
    const doctor = await inspectLocalRelease({ cwd: gameRoot });

    expect(doctor.canBundle).toBe(true);
    expect(doctor.packageManager).toBe("pnpm");
    expect(doctor.packageJsonPath).toBe(path.join(gameRoot, "package.json"));
    expect(doctor.configPath).toBe(
      path.join(gameRoot, "src", "airjam.config.ts"),
    );
  });

  it("bundles and validates a hosted release archive", async () => {
    const root = await createReleaseFixture();

    const bundled = await bundleLocalRelease({
      cwd: root,
      skipBuild: true,
    });

    expect(bundled.outputFile).toContain(
      ".airjam/releases/1.2.3/release-fixture-hosted-release.zip",
    );
    expect(bundled.validation.ok).toBe(true);

    const validation = await validateLocalRelease({
      cwd: root,
      bundlePath: bundled.outputFile,
    });

    expect(validation.ok).toBe(true);
    expect(validation.fileCount).toBe(3);
    expect(validation.manifest).toEqual({
      schemaVersion: 1,
      kind: "airjam-hosted-release",
      routes: {
        host: "/",
        controller: "/controller",
      },
    });
  });

  it("vendors remote font stylesheets and font assets into the hosted release bundle", async () => {
    const root = await createReleaseFixture({
      css: '@import"https://fonts.googleapis.com/css2?family=Chewy&display=swap";\n.title { font-family: "Chewy", sans-serif; }\n',
    });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (
        url === "https://fonts.googleapis.com/css2?family=Chewy&display=swap"
      ) {
        return new Response(
          '@font-face{font-family:"Chewy";src:url(https://fonts.gstatic.com/s/chewy/v1/chewy.woff2) format("woff2");}\n',
          {
            status: 200,
            headers: {
              "content-type": "text/css; charset=utf-8",
            },
          },
        );
      }

      if (url === "https://fonts.gstatic.com/s/chewy/v1/chewy.woff2") {
        return new Response(Buffer.from("font-bytes"), {
          status: 200,
          headers: {
            "content-type": "font/woff2",
          },
        });
      }

      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const bundled = await bundleLocalRelease({
      cwd: root,
      skipBuild: true,
    });
    const entries = await readZipEntries(bundled.outputFile);
    const cssEntry = entries.get("assets/app.css");

    expect(cssEntry?.toString("utf8")).not.toContain("fonts.googleapis.com");
    expect(cssEntry?.toString("utf8")).toMatch(
      /@import url\("\.\/airjam-vendored\/fonts\/[a-f0-9]{16}\.css"\);/,
    );

    const vendoredCssEntry = [...entries.keys()].find((entry) =>
      /^assets\/airjam-vendored\/fonts\/[a-f0-9]{16}\.css$/.test(entry),
    );
    const vendoredFontEntry = [...entries.keys()].find((entry) =>
      /^assets\/airjam-vendored\/fonts\/[a-f0-9]{16}\.woff2$/.test(entry),
    );

    expect(vendoredCssEntry).toBeTruthy();
    expect(vendoredFontEntry).toBeTruthy();
    expect(entries.get(vendoredFontEntry!)?.toString("utf8")).toBe(
      "font-bytes",
    );
    expect(entries.get(vendoredCssEntry!)?.toString("utf8")).not.toContain(
      "fonts.gstatic.com",
    );
  });

  it("lists owned hosted release targets through the agent API", async () => {
    const fetchMock = vi.fn(async (input) => {
      expect(String(input)).toBe("https://platform.airjam.test/api/cli/games");

      return new Response(
        JSON.stringify({
          games: [
            {
              id: "game_1",
              slug: "pong",
              name: "Pong",
              description: null,
              url: null,
              arcadeVisibility: "hidden",
              sourceUrl: null,
              templateId: "pong",
              createdAt: "2026-04-25T10:00:00.000Z",
              updatedAt: "2026-04-25T11:00:00.000Z",
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listPlatformReleaseTargets({
      platformUrl: "https://platform.airjam.test",
      token: "agent-token",
    });

    expect(result.games).toHaveLength(1);
    expect(result.games[0]?.slug).toBe("pong");
  });

  it("exports an exact immutable hosted generation without overwriting", async () => {
    const root = await createTempRoot();
    const archive = Buffer.from("immutable release archive");
    const generation = {
      id: "gen_export",
      releaseId: "rel_export",
      sequence: 3,
      status: "ready" as const,
      originalFilename: "air-jam-v1.zip",
      contentType: "application/zip",
      declaredSizeBytes: archive.length,
      observedSizeBytes: archive.length,
      observedContentType: "application/zip",
      observedEtag: '"etag-export"',
      observedLastModifiedAt: "2026-04-25T10:05:00.000Z",
      extractedSizeBytes: 100,
      fileCount: 4,
      entryPath: "index.html",
      contentHash: "content-hash",
      createdAt: "2026-04-25T10:01:00.000Z",
      uploadObservedAt: "2026-04-25T10:05:00.000Z",
      processingStartedAt: "2026-04-25T10:05:30.000Z",
      readyAt: "2026-04-25T10:06:00.000Z",
      failedAt: null,
      abandonedAt: null,
      storageRetention: {
        state: "warned" as const,
        inactiveAt: "2025-10-25T10:06:00.000Z",
        warnedAt: "2026-04-18T10:06:00.000Z",
        eligibleAt: "2026-04-25T10:06:00.000Z",
        cleanupStartedAt: null,
        deletedAt: null,
      },
    };
    const fetchMock = vi.fn(async (input, init) => {
      const url = String(input);
      if (
        url ===
        "https://platform.airjam.test/api/cli/releases/rel_export/generations/gen_export/export"
      ) {
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({
            generation,
            download: {
              method: "GET",
              url: "https://downloads.airjam.test/air-jam-v1.zip",
              filename: "air-jam-v1.zip",
              expiresAt: "2026-04-25T11:00:00.000Z",
            },
          }),
          { status: 200 },
        );
      }
      if (url === "https://downloads.airjam.test/air-jam-v1.zip") {
        expect(init?.method).toBe("GET");
        return new Response(archive, { status: 200 });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await exportPlatformReleaseGeneration({
      platformUrl: "https://platform.airjam.test",
      token: "agent-token",
      releaseId: "rel_export",
      generationId: "gen_export",
      cwd: root,
    });

    expect(result.outputFile).toBe(path.join(root, "air-jam-v1.zip"));
    expect(await readFile(result.outputFile)).toEqual(archive);
    await expect(
      exportPlatformReleaseGeneration({
        platformUrl: "https://platform.airjam.test",
        token: "agent-token",
        releaseId: "rel_export",
        generationId: "gen_export",
        cwd: root,
      }),
    ).rejects.toThrow(/already exists|EEXIST/u);
  });

  it("submits and publishes a hosted release through the agent API", async () => {
    const root = await createReleaseFixture();
    const bundled = await bundleLocalRelease({
      cwd: root,
      skipBuild: true,
    });
    const game = {
      id: "game_1",
      slug: "pong",
      name: "Pong",
      description: null,
      url: null,
      arcadeVisibility: "hidden",
      sourceUrl: null,
      templateId: "pong",
      createdAt: "2026-04-25T09:00:00.000Z",
      updatedAt: "2026-04-25T09:30:00.000Z",
    };
    const generation = ({
      status,
    }: {
      status: "awaiting_upload" | "processing" | "ready";
    }) => ({
      id: "gen_1",
      releaseId: "rel_1",
      sequence: 1,
      status,
      originalFilename: path.basename(bundled.outputFile),
      contentType: "application/zip",
      declaredSizeBytes: 123,
      observedSizeBytes: status === "awaiting_upload" ? null : 123,
      observedContentType:
        status === "awaiting_upload" ? null : "application/zip",
      observedEtag: status === "awaiting_upload" ? null : '"etag-1"',
      observedLastModifiedAt:
        status === "awaiting_upload" ? null : "2026-04-25T10:05:00.000Z",
      extractedSizeBytes: status === "ready" ? 456 : null,
      fileCount: status === "ready" ? 3 : null,
      entryPath: status === "ready" ? "index.html" : null,
      contentHash: status === "ready" ? "hash" : null,
      createdAt: "2026-04-25T10:01:00.000Z",
      uploadObservedAt:
        status === "awaiting_upload" ? null : "2026-04-25T10:05:00.000Z",
      processingStartedAt:
        status === "awaiting_upload" ? null : "2026-04-25T10:05:30.000Z",
      readyAt: status === "ready" ? "2026-04-25T10:06:00.000Z" : null,
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
    });
    const processingJob = ({ status }: { status: "queued" | "succeeded" }) => ({
      id: "job_1",
      kind: "release_artifact_processing" as const,
      status,
      releaseId: "rel_1",
      generationId: "gen_1",
      correlationId: "release:rel_1:generation:gen_1",
      attemptCount: status === "succeeded" ? 1 : 0,
      maxAttempts: 3,
      progressStage: status === "succeeded" ? "completed" : null,
      progressMessage: null,
      lastErrorCode: null,
      lastErrorRetryable: null,
      availableAt: "2026-04-25T10:05:00.000Z",
      deadlineAt: "2026-04-25T10:15:00.000Z",
      createdAt: "2026-04-25T10:05:00.000Z",
      startedAt: status === "succeeded" ? "2026-04-25T10:05:10.000Z" : null,
      finishedAt: status === "succeeded" ? "2026-04-25T10:06:00.000Z" : null,
      updatedAt: "2026-04-25T10:06:00.000Z",
    });
    const release = ({
      status,
      generation: releaseGeneration = null,
      promoted = false,
      jobs = [],
    }: {
      status: "draft" | "uploading" | "checking" | "ready" | "live";
      generation?: ReturnType<typeof generation> | null;
      promoted?: boolean;
      jobs?: Array<ReturnType<typeof processingJob>>;
    }) => ({
      id: "rel_1",
      gameId: "game_1",
      sourceKind: "upload",
      status,
      candidateGenerationId: releaseGeneration?.id ?? null,
      promotedGenerationId: promoted ? (releaseGeneration?.id ?? null) : null,
      versionLabel: "v1",
      createdAt: "2026-04-25T10:00:00.000Z",
      uploadedAt: releaseGeneration?.uploadObservedAt ?? null,
      checkedAt: releaseGeneration?.readyAt ?? null,
      publishedAt: promoted ? "2026-04-25T10:07:00.000Z" : null,
      quarantinedAt: null,
      archivedAt: null,
      game,
      candidateGeneration: releaseGeneration,
      promotedGeneration: promoted ? releaseGeneration : null,
      generations: releaseGeneration ? [releaseGeneration] : [],
      checks: [],
      jobs,
      reports: [],
      hostUrl:
        status === "ready" || status === "live"
          ? "https://cdn.airjam.test/games/game_1/releases/rel_1/"
          : null,
      controllerUrl:
        status === "ready" || status === "live"
          ? "https://cdn.airjam.test/games/game_1/releases/rel_1/controller"
          : null,
    });
    const awaitingGeneration = generation({ status: "awaiting_upload" });
    const processingGeneration = generation({ status: "processing" });
    const readyGeneration = generation({ status: "ready" });
    const queuedJob = processingJob({ status: "queued" });
    const succeededJob = processingJob({ status: "succeeded" });
    let inspectionCount = 0;

    const fetchMock = vi.fn(async (input, init) => {
      const url = String(input);

      if (url === "https://platform.airjam.test/api/cli/releases") {
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({
            release: release({ status: "draft" }),
          }),
          { status: 200 },
        );
      }

      if (
        url ===
        "https://platform.airjam.test/api/cli/releases/rel_1/upload-target"
      ) {
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({
            release: release({
              status: "uploading",
              generation: awaitingGeneration,
            }),
            generation: awaitingGeneration,
            upload: {
              method: "PUT",
              url: "https://uploads.airjam.test/release.zip",
              headers: {
                "content-type": "application/zip",
                "if-none-match": "*",
              },
              expiresAt: "2026-04-25T11:00:00.000Z",
            },
          }),
          { status: 200 },
        );
      }

      if (url === "https://uploads.airjam.test/release.zip") {
        expect(init?.method).toBe("PUT");
        expect(init?.body).toBeInstanceOf(Uint8Array);
        expect(init?.headers).toEqual({
          "content-type": "application/zip",
          "if-none-match": "*",
        });
        return new Response(null, { status: 200 });
      }

      if (
        url ===
        "https://platform.airjam.test/api/cli/releases/rel_1/generations/gen_1/finalize"
      ) {
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({
            release: release({
              status: "checking",
              generation: processingGeneration,
              jobs: [queuedJob],
            }),
            generation: processingGeneration,
            job: queuedJob,
          }),
          { status: 200 },
        );
      }

      if (url === "https://platform.airjam.test/api/cli/releases/rel_1") {
        expect(init?.method).toBe("GET");
        inspectionCount += 1;
        if (inspectionCount === 1) {
          return new Response(
            JSON.stringify({
              release: release({
                status: "checking",
                generation: readyGeneration,
                promoted: true,
                jobs: [succeededJob],
              }),
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            release: release({
              status: "ready",
              generation: readyGeneration,
              promoted: true,
              jobs: [succeededJob],
            }),
          }),
          { status: 200 },
        );
      }

      if (
        url === "https://platform.airjam.test/api/cli/releases/rel_1/publish"
      ) {
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({
            release: release({
              status: "live",
              generation: readyGeneration,
              promoted: true,
            }),
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitPlatformRelease({
      platformUrl: "https://platform.airjam.test",
      token: "agent-token",
      slugOrId: "pong",
      versionLabel: "v1",
      bundlePath: bundled.outputFile,
      processingPollIntervalMs: 1,
      publish: true,
    });

    expect(result.createdRelease.status).toBe("draft");
    expect(result.createdGeneration).toEqual(awaitingGeneration);
    expect(result.submittedRelease.status).toBe("checking");
    expect(result.submittedGeneration).toEqual(processingGeneration);
    expect(result.processingJob).toEqual(queuedJob);
    expect(result.processedRelease?.status).toBe("ready");
    expect(result.publishedRelease?.status).toBe("live");
    expect(inspectionCount).toBe(2);
  });
});
