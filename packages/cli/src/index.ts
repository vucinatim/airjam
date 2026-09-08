#!/usr/bin/env node

import {
  getDevStatus,
  resetLocalDev,
  startDev,
  stopDev,
} from "@air-jam/devtools-core/dev";
import {
  AirJamPlatformApiError,
  AirJamStoredPlatformSessionError,
  clearStoredPlatformMachineSession,
  getPlatformAuthStoragePath,
  getPlatformMachineProfile,
  loginPlatformWithDeviceFlow,
  logoutPlatformMachineSession,
  readStoredPlatformMachineSession,
} from "@air-jam/devtools-core/platform-auth";
import {
  archivePlatformGameMediaAsset,
  inspectPlatformGameMedia,
  uploadPlatformGameMediaFile,
} from "@air-jam/devtools-core/platform-game-media";
import {
  createPlatformGame,
  inspectPlatformGame,
  listPlatformGames,
  readLocalHostedGameDefaults,
  updatePlatformGame,
} from "@air-jam/devtools-core/platform-games";
import {
  bundleLocalRelease,
  exportPlatformReleaseGeneration,
  finalizePlatformReleaseGeneration,
  inspectLocalRelease,
  inspectPlatformRelease,
  listPlatformReleaseTargets,
  listPlatformReleases,
  publishPlatformRelease,
  submitPlatformRelease,
  uploadPlatformReleaseGeneration,
  validateLocalRelease,
  type AirJamLocalReleaseIssue,
} from "@air-jam/devtools-core/release";
import { formatEnvValidationError, isEnvValidationError } from "@air-jam/env";
import { AIRJAM_PROJECT_MCP_FILE } from "@air-jam/mcp-server/config";
import { Command, type OptionValues } from "commander";
import kleur from "kleur";
import path from "node:path";
import { runGameDevCli } from "../runtime/game-dev.mjs";
import { runSecureInitCli } from "../runtime/secure-dev.mjs";
import { runProjectTopologyCli } from "../runtime/topology.mjs";
import {
  runAiPackDiff,
  runAiPackRepair,
  runAiPackStatus,
  runAiPackUpdate,
} from "./ai-pack";
import { runMcpConfig, runMcpDoctor, runMcpInit } from "./mcp";
import {
  closeSession,
  invokeSessionAction,
  openSession,
  parseJsonObject,
  parseJsonValue,
  readSession,
  runSessionBrokerProcess,
  runSessionBrokerStatus,
  runSessionBrokerStop,
  sendSessionInput,
} from "./session";
import { AIR_JAM_CLI_VERSION } from "./version";

const normalizeRuntimeCliArgv = (argv: string[]) =>
  argv.filter((value) => value !== "--");

const resolveActionOptions = <T extends OptionValues>(value: unknown): T => {
  if (
    value &&
    typeof value === "object" &&
    "opts" in value &&
    typeof (value as { opts?: unknown }).opts === "function"
  ) {
    return (value as Command).opts<T>();
  }

  return value as T;
};

const printReleaseIssues = (issues: AirJamLocalReleaseIssue[]) => {
  for (const issue of issues) {
    const color = issue.severity === "error" ? kleur.red : kleur.yellow;
    const prefix = issue.severity === "error" ? "error" : "warning";
    console.log(color(`- ${prefix}: ${issue.message}`));
    if (issue.path) {
      console.log(kleur.dim(`  path: ${issue.path}`));
    }
  }
};

const printReleaseDoctor = async ({
  dir,
  distDir,
}: {
  dir?: string;
  distDir?: string;
}) => {
  const doctor = await inspectLocalRelease({
    cwd: path.resolve(dir || process.cwd()),
    distDir,
  });

  console.log(
    doctor.canBundle
      ? kleur.green("\n✓ Hosted release doctor passed\n")
      : kleur.red("\n✗ Hosted release doctor failed\n"),
  );
  console.log(`Project: ${kleur.cyan(doctor.projectDir)}`);
  console.log(`Dist: ${kleur.cyan(doctor.distDir)}`);
  console.log(
    `Build script: ${doctor.buildScript ? kleur.cyan("present") : kleur.red("missing")}`,
  );
  console.log(
    `Metadata export: ${doctor.metadataExportLikely ? kleur.cyan("present") : kleur.yellow("missing")}`,
  );
  console.log(
    `Hosted contract: ${kleur.dim(
      `${doctor.hostedContract.hostPath} (host), ${doctor.hostedContract.controllerPath} (controller), ${doctor.hostedContract.manifestPath} manifest`,
    )}`,
  );

  if (doctor.issues.length > 0) {
    console.log("");
    printReleaseIssues(doctor.issues);
  }

  if (!doctor.canBundle) {
    process.exitCode = 1;
  }
};

const runReleaseBundleCommand = async ({
  dir,
  distDir,
  out,
  skipBuild = false,
}: {
  dir?: string;
  distDir?: string;
  out?: string;
  skipBuild?: boolean;
}) => {
  const result = await bundleLocalRelease({
    cwd: path.resolve(dir || process.cwd()),
    distDir,
    out,
    skipBuild,
  });

  if (result.buildResult?.stdout.trim()) {
    console.log(result.buildResult.stdout.trimEnd());
  }
  if (result.buildResult?.stderr.trim()) {
    console.error(result.buildResult.stderr.trimEnd());
  }

  console.log(kleur.green("\n✓ Hosted release bundle created\n"));
  console.log(`Artifact: ${kleur.cyan(result.outputFile)}`);
  console.log(
    kleur.dim(
      `Hosted contract: / (host), /controller (controller), .airjam/release-manifest.json manifest`,
    ),
  );
  console.log(
    kleur.dim(
      `Validated ${result.validation.fileCount} files (${result.validation.extractedSizeBytes} bytes extracted)`,
    ),
  );
};

const runReleaseValidateCommand = async ({
  dir,
  distDir,
  bundle,
  skipBuild = false,
}: {
  dir?: string;
  distDir?: string;
  bundle?: string;
  skipBuild?: boolean;
}) => {
  const validation = await validateLocalRelease({
    cwd: path.resolve(dir || process.cwd()),
    distDir,
    bundlePath: bundle,
    skipBuild,
  });

  console.log(
    validation.ok
      ? kleur.green("\n✓ Hosted release validation passed\n")
      : kleur.red("\n✗ Hosted release validation failed\n"),
  );

  if (validation.source.kind === "bundle") {
    console.log(`Bundle: ${kleur.cyan(validation.source.bundlePath)}`);
  } else {
    console.log(`Project: ${kleur.cyan(validation.source.projectDir)}`);
    console.log(`Dist: ${kleur.cyan(validation.source.distDir)}`);
  }

  console.log(
    kleur.dim(
      `Validated ${validation.fileCount} files (${validation.extractedSizeBytes} bytes extracted)`,
    ),
  );

  if (validation.issues.length > 0) {
    console.log("");
    printReleaseIssues(validation.issues);
  }

  if (!validation.ok) {
    process.exitCode = 1;
  }
};

const runReleaseListCommand = async ({
  platformUrl,
  game,
}: {
  platformUrl?: string;
  game?: string;
}) => {
  if (game?.trim()) {
    const result = await listPlatformReleases({
      platformUrl,
      slugOrId: game.trim(),
    });

    console.log(
      kleur.green(
        `\n✓ Hosted releases for ${result.game.name}${result.game.slug ? ` (${result.game.slug})` : ""}\n`,
      ),
    );

    if (result.releases.length === 0) {
      console.log(kleur.dim("No hosted releases found."));
      return;
    }

    for (const release of result.releases) {
      console.log(
        `${kleur.cyan(release.id)}  ${kleur.yellow(release.status)}  ${release.versionLabel ?? "(untitled)"}  ${kleur.dim(release.createdAt)}`,
      );
    }

    return;
  }

  const result = await listPlatformReleaseTargets({ platformUrl });
  console.log(kleur.green("\n✓ Hosted release targets\n"));

  if (result.games.length === 0) {
    console.log(kleur.dim("No owned hosted games found."));
    return;
  }

  for (const ownedGame of result.games) {
    console.log(
      `${kleur.cyan(ownedGame.id)}  ${ownedGame.slug ? kleur.yellow(ownedGame.slug) : kleur.dim("(no slug)")}  ${ownedGame.name}`,
    );
  }
};

const printHostedGame = ({
  game,
  heading,
}: {
  game: {
    id: string;
    slug: string | null;
    name: string;
    description: string | null;
    url: string | null;
    arcadeVisibility: "hidden" | "listed";
    sourceUrl: string | null;
    templateId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  heading: string;
}) => {
  console.log(kleur.green(`\n✓ ${heading}\n`));
  console.log(`ID: ${kleur.cyan(game.id)}`);
  console.log(`Name: ${kleur.cyan(game.name)}`);
  console.log(`Slug: ${kleur.cyan(game.slug ?? "(none)")}`);
  console.log(`Arcade visibility: ${kleur.cyan(game.arcadeVisibility)}`);
  console.log(`Description: ${kleur.cyan(game.description ?? "(none)")}`);
  console.log(`Preview URL: ${kleur.cyan(game.url ?? "(none)")}`);
  console.log(`Source URL: ${kleur.cyan(game.sourceUrl ?? "(none)")}`);
  console.log(`Template ID: ${kleur.cyan(game.templateId ?? "(none)")}`);
  console.log(`Created: ${kleur.cyan(game.createdAt)}`);
  console.log(`Updated: ${kleur.cyan(game.updatedAt)}`);
};

const GAME_MEDIA_KIND_LABEL: Record<
  "thumbnail" | "cover" | "preview_video",
  string
> = {
  thumbnail: "Thumbnail",
  cover: "Cover",
  preview_video: "Preview Video",
};

const formatBytes = (value: number): string => {
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const normalizeGameMediaKind = (
  value: string,
): "thumbnail" | "cover" | "preview_video" => {
  const normalized = value.trim();
  if (normalized === "thumbnail" || normalized === "cover") {
    return normalized;
  }
  if (normalized === "preview_video" || normalized === "preview-video") {
    return "preview_video";
  }

  throw new Error(
    `Unsupported media kind "${value}". Use thumbnail, cover, or preview_video.`,
  );
};

const printHostedGameMedia = ({
  result,
  heading,
}: {
  result: Awaited<ReturnType<typeof inspectPlatformGameMedia>>;
  heading: string;
}) => {
  console.log(kleur.green(`\n✓ ${heading}\n`));
  console.log(`Game: ${kleur.cyan(result.game.name)}`);
  console.log(`ID: ${kleur.cyan(result.game.id)}`);
  console.log(`Slug: ${kleur.cyan(result.game.slug ?? "(none)")}`);

  for (const kind of ["thumbnail", "cover", "preview_video"] as const) {
    const assets = result.assets.filter((asset) => asset.kind === kind);
    const activeAsset = assets.find((asset) => asset.isActive) ?? null;

    console.log("");
    console.log(kleur.bold(GAME_MEDIA_KIND_LABEL[kind]));
    console.log(
      `Active: ${kleur.cyan(activeAsset?.id ?? "(none)")}${activeAsset?.publicUrl ? `  ${kleur.dim(activeAsset.publicUrl)}` : ""}`,
    );

    if (assets.length === 0) {
      console.log(kleur.dim("  No uploaded assets."));
      continue;
    }

    for (const asset of assets) {
      console.log(
        `  ${asset.isActive ? kleur.green("●") : kleur.dim("○")} ${kleur.cyan(asset.id)}  ${kleur.yellow(asset.status)}  ${asset.originalFilename}  ${kleur.dim(formatBytes(asset.sizeBytes))}`,
      );
    }
  }
};

const resolveCreateGameInput = async ({
  dir,
  name,
  slug,
  description,
  previewUrl,
  sourceUrl,
  templateId,
  arcadeVisibility,
}: {
  dir?: string;
  name?: string;
  slug?: string;
  description?: string;
  previewUrl?: string;
  sourceUrl?: string;
  templateId?: string;
  arcadeVisibility?: "hidden" | "listed";
}) => {
  const localDefaults = dir
    ? await readLocalHostedGameDefaults({
        cwd: path.resolve(dir),
      })
    : null;

  const resolvedName =
    name?.trim() ||
    localDefaults?.metadata.name ||
    localDefaults?.template.name ||
    null;
  if (!resolvedName) {
    throw new Error(
      "Game name is required. Pass --name or point --dir at a game with declared metadata.",
    );
  }

  const resolvedSlug = slug?.trim() || localDefaults?.metadata.slug;
  const resolvedDescription =
    description !== undefined
      ? description.trim() || undefined
      : localDefaults?.metadata.description ||
        localDefaults?.template.description;
  const resolvedSourceUrl = sourceUrl?.trim() || localDefaults?.sourceUrl;
  const resolvedTemplateId = templateId?.trim() || localDefaults?.template.id;

  return {
    input: {
      name: resolvedName,
      ...(resolvedSlug ? { slug: resolvedSlug } : {}),
      ...(resolvedDescription ? { description: resolvedDescription } : {}),
      ...(previewUrl?.trim() ? { url: previewUrl.trim() } : {}),
      ...(resolvedSourceUrl ? { sourceUrl: resolvedSourceUrl } : {}),
      ...(resolvedTemplateId ? { templateId: resolvedTemplateId } : {}),
      ...(arcadeVisibility ? { arcadeVisibility } : {}),
    },
    localDefaults,
  };
};

const runGameListCommand = async ({
  platformUrl,
}: {
  platformUrl?: string;
}) => {
  const result = await listPlatformGames({ platformUrl });

  console.log(kleur.green("\n✓ Hosted games\n"));

  if (result.games.length === 0) {
    console.log(kleur.dim("No owned hosted games found."));
    return;
  }

  for (const game of result.games) {
    console.log(
      `${kleur.cyan(game.id)}  ${game.slug ? kleur.yellow(game.slug) : kleur.dim("(no slug)")}  ${game.name}  ${kleur.dim(game.arcadeVisibility)}`,
    );
  }
};

const runGameInspectCommand = async ({
  platformUrl,
  game,
}: {
  platformUrl?: string;
  game: string;
}) => {
  const result = await inspectPlatformGame({
    platformUrl,
    slugOrId: game,
  });

  printHostedGame({
    game: result.game,
    heading: "Hosted game",
  });
};

const runGameCreateCommand = async ({
  platformUrl,
  dir,
  name,
  slug,
  description,
  previewUrl,
  sourceUrl,
  templateId,
  arcadeVisibility,
}: {
  platformUrl?: string;
  dir?: string;
  name?: string;
  slug?: string;
  description?: string;
  previewUrl?: string;
  sourceUrl?: string;
  templateId?: string;
  arcadeVisibility?: "hidden" | "listed";
}) => {
  const { input } = await resolveCreateGameInput({
    dir,
    name,
    slug,
    description,
    previewUrl,
    sourceUrl,
    templateId,
    arcadeVisibility,
  });

  const result = await createPlatformGame({
    platformUrl,
    input,
  });

  printHostedGame({
    game: result.game,
    heading: "Hosted game created",
  });
};

const resolveUpdateGamePatch = ({
  name,
  slug,
  description,
  clearDescription = false,
  previewUrl,
  clearPreviewUrl = false,
  sourceUrl,
  clearSourceUrl = false,
  templateId,
  clearTemplateId = false,
  arcadeVisibility,
}: {
  name?: string;
  slug?: string;
  description?: string;
  clearDescription?: boolean;
  previewUrl?: string;
  clearPreviewUrl?: boolean;
  sourceUrl?: string;
  clearSourceUrl?: boolean;
  templateId?: string;
  clearTemplateId?: boolean;
  arcadeVisibility?: "hidden" | "listed";
}) => {
  if (description !== undefined && clearDescription) {
    throw new Error(
      "Use either --description or --clear-description, not both.",
    );
  }
  if (previewUrl !== undefined && clearPreviewUrl) {
    throw new Error(
      "Use either --preview-url or --clear-preview-url, not both.",
    );
  }
  if (sourceUrl !== undefined && clearSourceUrl) {
    throw new Error("Use either --source-url or --clear-source-url, not both.");
  }
  if (templateId !== undefined && clearTemplateId) {
    throw new Error(
      "Use either --template-id or --clear-template-id, not both.",
    );
  }

  const patch = {
    ...(name?.trim() ? { name: name.trim() } : {}),
    ...(slug?.trim() ? { slug: slug.trim() } : {}),
    ...(description !== undefined
      ? { description: description.trim() || null }
      : clearDescription
        ? { description: null }
        : {}),
    ...(previewUrl !== undefined
      ? { url: previewUrl.trim() || null }
      : clearPreviewUrl
        ? { url: null }
        : {}),
    ...(sourceUrl !== undefined
      ? { sourceUrl: sourceUrl.trim() || null }
      : clearSourceUrl
        ? { sourceUrl: null }
        : {}),
    ...(templateId !== undefined
      ? { templateId: templateId.trim() || null }
      : clearTemplateId
        ? { templateId: null }
        : {}),
    ...(arcadeVisibility ? { arcadeVisibility } : {}),
  };

  if (Object.keys(patch).length === 0) {
    throw new Error("No hosted game changes were provided.");
  }

  return patch;
};

const runGameUpdateCommand = async ({
  platformUrl,
  game,
  name,
  slug,
  description,
  clearDescription,
  previewUrl,
  clearPreviewUrl,
  sourceUrl,
  clearSourceUrl,
  templateId,
  clearTemplateId,
  arcadeVisibility,
}: {
  platformUrl?: string;
  game: string;
  name?: string;
  slug?: string;
  description?: string;
  clearDescription?: boolean;
  previewUrl?: string;
  clearPreviewUrl?: boolean;
  sourceUrl?: string;
  clearSourceUrl?: boolean;
  templateId?: string;
  clearTemplateId?: boolean;
  arcadeVisibility?: "hidden" | "listed";
}) => {
  const result = await updatePlatformGame({
    platformUrl,
    slugOrId: game,
    input: resolveUpdateGamePatch({
      name,
      slug,
      description,
      clearDescription,
      previewUrl,
      clearPreviewUrl,
      sourceUrl,
      clearSourceUrl,
      templateId,
      clearTemplateId,
      arcadeVisibility,
    }),
  });

  printHostedGame({
    game: result.game,
    heading: "Hosted game updated",
  });
};

const runGameMediaInspectCommand = async ({
  platformUrl,
  game,
}: {
  platformUrl?: string;
  game: string;
}) => {
  const result = await inspectPlatformGameMedia({
    platformUrl,
    slugOrId: game,
  });

  printHostedGameMedia({
    result,
    heading: "Hosted game media",
  });
};

const runGameMediaUploadCommand = async ({
  platformUrl,
  game,
  thumbnail,
  cover,
  previewVideo,
}: {
  platformUrl?: string;
  game: string;
  thumbnail?: string;
  cover?: string;
  previewVideo?: string;
}) => {
  const uploads = [
    ...(thumbnail ? [{ kind: "thumbnail" as const, filePath: thumbnail }] : []),
    ...(cover ? [{ kind: "cover" as const, filePath: cover }] : []),
    ...(previewVideo
      ? [{ kind: "preview_video" as const, filePath: previewVideo }]
      : []),
  ];

  if (uploads.length === 0) {
    throw new Error(
      "No media files were provided. Pass at least one of --thumbnail, --cover, or --preview-video.",
    );
  }

  console.log(kleur.green("\n✓ Uploading hosted game media\n"));

  for (const upload of uploads) {
    const result = await uploadPlatformGameMediaFile({
      platformUrl,
      slugOrId: game,
      kind: upload.kind,
      filePath: upload.filePath,
    });
    console.log(
      `${kleur.cyan(GAME_MEDIA_KIND_LABEL[upload.kind])}: ${kleur.cyan(result.assigned.asset.id)}  ${kleur.dim(result.filePath)}`,
    );
  }

  const inspected = await inspectPlatformGameMedia({
    platformUrl,
    slugOrId: game,
  });
  printHostedGameMedia({
    result: inspected,
    heading: "Hosted game media updated",
  });
};

const runGameMediaClearCommand = async ({
  platformUrl,
  game,
  kind,
}: {
  platformUrl?: string;
  game: string;
  kind: "thumbnail" | "cover" | "preview_video";
}) => {
  const current = await inspectPlatformGameMedia({
    platformUrl,
    slugOrId: game,
  });
  const activeAsset = current.assets.find(
    (asset) => asset.kind === kind && asset.isActive,
  );

  if (!activeAsset) {
    console.log(
      kleur.yellow(
        `\nNo active ${GAME_MEDIA_KIND_LABEL[kind].toLowerCase()} to clear.\n`,
      ),
    );
    return;
  }

  await archivePlatformGameMediaAsset({
    platformUrl,
    slugOrId: game,
    assetId: activeAsset.id,
  });

  const inspected = await inspectPlatformGameMedia({
    platformUrl,
    slugOrId: game,
  });
  printHostedGameMedia({
    result: inspected,
    heading: `${GAME_MEDIA_KIND_LABEL[kind]} cleared`,
  });
};

const runReleaseInspectCommand = async ({
  platformUrl,
  releaseId,
}: {
  platformUrl?: string;
  releaseId: string;
}) => {
  const result = await inspectPlatformRelease({
    platformUrl,
    releaseId,
  });
  const release = result.release;

  console.log(kleur.green("\n✓ Hosted release\n"));
  console.log(`Release: ${kleur.cyan(release.id)}`);
  console.log(`Game: ${kleur.cyan(release.game.name)}`);
  console.log(`Status: ${kleur.cyan(release.status)}`);
  console.log(`Version: ${kleur.cyan(release.versionLabel ?? "(untitled)")}`);
  console.log(`Created: ${kleur.cyan(release.createdAt)}`);
  if (release.hostUrl) {
    console.log(`Host URL: ${kleur.cyan(release.hostUrl)}`);
  }
  if (release.controllerUrl) {
    console.log(`Controller URL: ${kleur.cyan(release.controllerUrl)}`);
  }
  const formatGeneration = (generation: (typeof release.generations)[number]) =>
    `${kleur.cyan(generation.id)} (#${generation.sequence}, ${kleur.yellow(generation.status)})`;
  console.log(
    `Candidate generation: ${release.candidateGeneration ? formatGeneration(release.candidateGeneration) : kleur.dim("none")}`,
  );
  console.log(
    `Promoted generation: ${release.promotedGeneration ? formatGeneration(release.promotedGeneration) : kleur.dim("none")}`,
  );
  if (release.generations.length > 0) {
    console.log("");
    console.log(kleur.dim("Generation history:"));
    for (const generation of release.generations) {
      const observedSize = generation.observedSizeBytes
        ? `, ${generation.observedSizeBytes} bytes observed`
        : "";
      console.log(
        `- ${formatGeneration(generation)}: ${generation.originalFilename} (${generation.declaredSizeBytes} bytes declared${observedSize})`,
      );
    }
  }
  if (release.checks.length > 0) {
    console.log("");
    console.log(kleur.dim("Checks:"));
    for (const check of release.checks) {
      console.log(
        `- ${check.kind}: ${check.status} [generation ${check.generationId}]${check.summary ? ` (${check.summary})` : ""}`,
      );
    }
  }
};

const runReleaseSubmitCommand = async ({
  platformUrl,
  game,
  versionLabel,
  dir,
  distDir,
  bundle,
  skipBuild = false,
  waitForProcessing = false,
  processingTimeoutSeconds,
  publish = false,
}: {
  platformUrl?: string;
  game: string;
  versionLabel?: string;
  dir?: string;
  distDir?: string;
  bundle?: string;
  skipBuild?: boolean;
  waitForProcessing?: boolean;
  processingTimeoutSeconds?: number;
  publish?: boolean;
}) => {
  const resolvedCwd = path.resolve(dir || process.cwd());
  if (
    processingTimeoutSeconds !== undefined &&
    (!Number.isSafeInteger(processingTimeoutSeconds) ||
      processingTimeoutSeconds < 1)
  ) {
    throw new Error("--processing-timeout must be a positive integer.");
  }
  let result;

  try {
    result = await submitPlatformRelease({
      platformUrl,
      slugOrId: game,
      versionLabel,
      cwd: resolvedCwd,
      distDir,
      bundlePath: bundle,
      skipBuild,
      waitForProcessing,
      ...(processingTimeoutSeconds === undefined
        ? {}
        : { processingTimeoutMs: processingTimeoutSeconds * 1_000 }),
      publish,
    });
  } catch (error) {
    if (error instanceof AirJamPlatformApiError && error.code === "not_found") {
      let createHint =
        'Run `airjam game create --name "Your Game" --slug your-game` first.';

      try {
        const localDefaults = await readLocalHostedGameDefaults({
          cwd: resolvedCwd,
        });
        const hintedSlug = localDefaults.metadata.slug ?? game;
        createHint = `Run \`airjam game create --dir ${resolvedCwd}${platformUrl ? ` --platform-url ${platformUrl}` : ""}\` to register this local game first, then retry with \`--game ${hintedSlug}\`.`;
      } catch {
        // Best-effort hint only.
      }

      throw new Error(`No owned hosted game matched "${game}". ${createHint}`);
    }

    throw error;
  }

  console.log(kleur.green("\n✓ Hosted release submitted\n"));
  console.log(`Bundle: ${kleur.cyan(result.bundlePath)}`);
  console.log(`Draft: ${kleur.cyan(result.createdRelease.id)}`);
  console.log(
    `Created generation: ${kleur.cyan(result.createdGeneration.id)} (#${result.createdGeneration.sequence})`,
  );
  console.log(
    `Submitted generation: ${kleur.cyan(result.submittedGeneration.id)} (${kleur.yellow(result.submittedGeneration.status)})`,
  );
  console.log(
    `Processing job: ${kleur.cyan(result.processingJob.id)} (${kleur.yellow(result.processingJob.status)})`,
  );
  console.log(
    `Release status: ${kleur.yellow(result.submittedRelease.status)}`,
  );
  if (result.processedRelease) {
    console.log(
      `Processing complete: ${kleur.cyan(result.processedRelease.id)} (${kleur.yellow(result.processedRelease.status)})`,
    );
  } else {
    console.log(
      kleur.dim(
        `Inspect with: airjam release inspect --release ${result.submittedRelease.id}`,
      ),
    );
  }
  if (result.publishedRelease) {
    console.log(
      `Published: ${kleur.cyan(result.publishedRelease.id)} (${kleur.yellow(result.publishedRelease.status)})`,
    );
  }
};

const runReleaseUploadCommand = async ({
  platformUrl,
  releaseId,
  dir,
  bundle,
}: {
  platformUrl?: string;
  releaseId: string;
  dir?: string;
  bundle: string;
}) => {
  const result = await uploadPlatformReleaseGeneration({
    platformUrl,
    releaseId,
    cwd: path.resolve(dir || process.cwd()),
    bundlePath: bundle,
  });

  console.log(kleur.green("\n✓ Hosted release generation uploaded\n"));
  console.log(`Bundle: ${kleur.cyan(result.bundlePath)}`);
  console.log(`Release: ${kleur.cyan(result.release.id)}`);
  console.log(
    `Generation: ${kleur.cyan(result.generation.id)} (#${result.generation.sequence}, ${kleur.yellow(result.generation.status)})`,
  );
  console.log(
    kleur.dim(
      `Resume with: airjam release finalize --release ${result.release.id} --generation ${result.generation.id}`,
    ),
  );
};

const runReleaseFinalizeCommand = async ({
  platformUrl,
  releaseId,
  generationId,
}: {
  platformUrl?: string;
  releaseId: string;
  generationId: string;
}) => {
  const result = await finalizePlatformReleaseGeneration({
    platformUrl,
    releaseId,
    generationId,
  });

  console.log(kleur.green("\n✓ Hosted release processing queued\n"));
  console.log(`Release: ${kleur.cyan(result.release.id)}`);
  console.log(`Release status: ${kleur.yellow(result.release.status)}`);
  console.log(
    `Generation: ${kleur.cyan(result.generation.id)} (${kleur.yellow(result.generation.status)})`,
  );
  console.log(
    `Processing job: ${kleur.cyan(result.job.id)} (${kleur.yellow(result.job.status)})`,
  );
  console.log(
    kleur.dim(
      `Inspect with: airjam release inspect --release ${result.release.id}`,
    ),
  );
};

const runReleaseExportCommand = async ({
  platformUrl,
  releaseId,
  generationId,
  dir,
  out,
}: {
  platformUrl?: string;
  releaseId: string;
  generationId: string;
  dir?: string;
  out?: string;
}) => {
  const result = await exportPlatformReleaseGeneration({
    platformUrl,
    releaseId,
    generationId,
    cwd: path.resolve(dir || process.cwd()),
    out,
  });

  console.log(kleur.green("\n✓ Hosted release generation exported\n"));
  console.log(`Release: ${kleur.cyan(releaseId)}`);
  console.log(
    `Generation: ${kleur.cyan(result.generation.id)} (#${result.generation.sequence})`,
  );
  console.log(`Archive: ${kleur.cyan(result.outputFile)}`);
  console.log(`Size: ${kleur.cyan(`${result.sizeBytes} bytes`)}`);
};

const runReleasePublishCommand = async ({
  platformUrl,
  releaseId,
}: {
  platformUrl?: string;
  releaseId: string;
}) => {
  const result = await publishPlatformRelease({
    platformUrl,
    releaseId,
  });

  console.log(kleur.green("\n✓ Hosted release published\n"));
  console.log(`Release: ${kleur.cyan(result.release.id)}`);
  console.log(`Status: ${kleur.cyan(result.release.status)}`);
  if (result.release.hostUrl) {
    console.log(`Host URL: ${kleur.cyan(result.release.hostUrl)}`);
  }
};

const runAuthLoginCommand = async ({
  platformUrl,
  clientName,
}: {
  platformUrl?: string;
  clientName?: string;
}) => {
  console.log(kleur.cyan("\nStarting Air Jam platform login...\n"));

  const result = await loginPlatformWithDeviceFlow({
    platformUrl,
    clientName,
    onPrompt: async (authorization) => {
      console.log(
        `Verification URL: ${kleur.cyan(authorization.verificationUrl)}`,
      );
      console.log(`Approval code: ${kleur.cyan(authorization.userCode)}`);
      console.log(
        kleur.dim(
          "Sign in on the dashboard, approve the CLI request, and this command will finish automatically.\n",
        ),
      );
    },
  });

  console.log(kleur.green("\n✓ Logged in to the Air Jam platform\n"));
  console.log(`Platform: ${kleur.cyan(result.authenticated.platformBaseUrl)}`);
  console.log(`User: ${kleur.cyan(result.authenticated.user.name)}`);
  console.log(`Email: ${kleur.cyan(result.authenticated.user.email)}`);
  console.log(`Session file: ${kleur.dim(getPlatformAuthStoragePath())}`);
};

const runAuthWhoAmICommand = async ({
  platformUrl,
}: {
  platformUrl?: string;
}) => {
  const storedSession = await readStoredPlatformMachineSession();
  if (!storedSession) {
    console.log(kleur.red("No stored Air Jam platform session was found."));
    console.log(kleur.dim(`Expected at ${getPlatformAuthStoragePath()}`));
    process.exitCode = 1;
    return;
  }

  const profile = await getPlatformMachineProfile({ platformUrl });

  console.log(kleur.green("\n✓ Air Jam platform session is valid\n"));
  console.log(`Platform: ${kleur.cyan(profile.platformBaseUrl)}`);
  console.log(`User: ${kleur.cyan(profile.user.name)}`);
  console.log(`Email: ${kleur.cyan(profile.user.email)}`);
  console.log(`Role: ${kleur.cyan(profile.user.role)}`);
  console.log(`Expires: ${kleur.cyan(profile.session.expiresAt)}`);
  console.log(`Session file: ${kleur.dim(getPlatformAuthStoragePath())}`);
};

const runAuthLogoutCommand = async ({
  platformUrl,
}: {
  platformUrl?: string;
}) => {
  let storedSession;
  try {
    storedSession = await readStoredPlatformMachineSession();
  } catch (error) {
    if (!(error instanceof AirJamStoredPlatformSessionError)) throw error;
    await clearStoredPlatformMachineSession();
    console.log(
      kleur.yellow(
        "Removed an unreadable local Air Jam session. Its remote token could not be revoked.",
      ),
    );
    return;
  }
  if (!storedSession) {
    console.log(kleur.yellow("No stored Air Jam platform session was found."));
    return;
  }

  await logoutPlatformMachineSession({ platformUrl });
  console.log(kleur.green("\n✓ Logged out of the Air Jam platform\n"));
};

const buildProgram = () => {
  const program = new Command();

  program
    .name("airjam")
    .description("Operate Air Jam game projects")
    .version(AIR_JAM_CLI_VERSION)
    .action(() => {
      program.outputHelp();
    });

  const aiPackCommand = program
    .command("ai-pack")
    .description("Inspect or update provenance-backed AI pack assets");

  aiPackCommand
    .command("status")
    .description("Show AI pack status for a project")
    .option("--dir <path>", "Project directory to inspect")
    .option("--json", "Print one machine-readable JSON document", false)
    .action(async (options: unknown) => {
      await runAiPackStatus(
        resolveActionOptions<{
          dir?: string;
          json?: boolean;
        }>(options),
      );
    });

  aiPackCommand
    .command("diff")
    .description("Show AI pack file differences for a project")
    .option("--dir <path>", "Project directory to inspect")
    .option("--json", "Print one machine-readable JSON document", false)
    .action(async (options: unknown) => {
      await runAiPackDiff(
        resolveActionOptions<{
          dir?: string;
          json?: boolean;
        }>(options),
      );
    });

  aiPackCommand
    .command("update")
    .description("Update managed AI pack assets for a project")
    .option("--dir <path>", "Project directory to inspect")
    .option("--json", "Print one machine-readable JSON document", false)
    .action(async (options: unknown) => {
      await runAiPackUpdate(
        resolveActionOptions<{
          dir?: string;
          json?: boolean;
        }>(options),
      );
    });

  aiPackCommand
    .command("repair")
    .description("Restore same-version managed files from the installed CLI")
    .option("--dir <path>", "Project directory to repair")
    .option("--json", "Print one machine-readable JSON document", false)
    .action(async (options: unknown) => {
      await runAiPackRepair(
        resolveActionOptions<{
          dir?: string;
          json?: boolean;
        }>(options),
      );
    });

  aiPackCommand.action(() => {
    aiPackCommand.outputHelp();
  });

  const gameCommand = program
    .command("game")
    .description("Manage hosted Air Jam game records on the platform");

  gameCommand
    .command("list")
    .description("List owned hosted games")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .action(async (options: unknown) => {
      await runGameListCommand(
        resolveActionOptions<{
          platformUrl?: string;
        }>(options),
      );
    });

  gameCommand
    .command("inspect")
    .description("Inspect one owned hosted game")
    .requiredOption("--game <slug-or-id>", "Owned hosted game slug or ID")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .action(async (options: unknown) => {
      const resolved = resolveActionOptions<{
        platformUrl?: string;
        game: string;
      }>(options);

      await runGameInspectCommand({
        platformUrl: resolved.platformUrl,
        game: resolved.game,
      });
    });

  gameCommand
    .command("create")
    .description("Create a hosted game record for release publishing")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .option(
      "--dir <path>",
      "Local game project directory for metadata defaults",
    )
    .option("--name <name>", "Hosted game display name")
    .option("--slug <slug>", "Hosted game slug")
    .option("--description <text>", "Catalog description/tagline")
    .option("--preview-url <url>", "Private creator preview URL")
    .option("--source-url <url>", "Source repository URL")
    .option("--template-id <id>", "Template ID shown for developer actions")
    .option(
      "--arcade-visibility <visibility>",
      "Initial arcade visibility (hidden or listed)",
    )
    .action(async (options: unknown) => {
      const resolved = resolveActionOptions<{
        platformUrl?: string;
        dir?: string;
        name?: string;
        slug?: string;
        description?: string;
        previewUrl?: string;
        sourceUrl?: string;
        templateId?: string;
        arcadeVisibility?: "hidden" | "listed";
      }>(options);

      await runGameCreateCommand({
        platformUrl: resolved.platformUrl,
        dir: resolved.dir,
        name: resolved.name,
        slug: resolved.slug,
        description: resolved.description,
        previewUrl: resolved.previewUrl,
        sourceUrl: resolved.sourceUrl,
        templateId: resolved.templateId,
        arcadeVisibility: resolved.arcadeVisibility,
      });
    });

  gameCommand
    .command("update")
    .description("Update core hosted game metadata")
    .requiredOption("--game <slug-or-id>", "Owned hosted game slug or ID")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .option("--name <name>", "Hosted game display name")
    .option("--slug <slug>", "Hosted game slug")
    .option("--description <text>", "Catalog description/tagline")
    .option("--clear-description", "Clear the catalog description", false)
    .option("--preview-url <url>", "Private creator preview URL")
    .option("--clear-preview-url", "Clear the private preview URL", false)
    .option("--source-url <url>", "Source repository URL")
    .option("--clear-source-url", "Clear the source repository URL", false)
    .option("--template-id <id>", "Template ID shown for developer actions")
    .option("--clear-template-id", "Clear the template ID", false)
    .option(
      "--arcade-visibility <visibility>",
      "Arcade visibility (hidden or listed)",
    )
    .action(async (options: unknown) => {
      const resolved = resolveActionOptions<{
        platformUrl?: string;
        game: string;
        name?: string;
        slug?: string;
        description?: string;
        clearDescription?: boolean;
        previewUrl?: string;
        clearPreviewUrl?: boolean;
        sourceUrl?: string;
        clearSourceUrl?: boolean;
        templateId?: string;
        clearTemplateId?: boolean;
        arcadeVisibility?: "hidden" | "listed";
      }>(options);

      await runGameUpdateCommand({
        platformUrl: resolved.platformUrl,
        game: resolved.game,
        name: resolved.name,
        slug: resolved.slug,
        description: resolved.description,
        clearDescription: resolved.clearDescription,
        previewUrl: resolved.previewUrl,
        clearPreviewUrl: resolved.clearPreviewUrl,
        sourceUrl: resolved.sourceUrl,
        clearSourceUrl: resolved.clearSourceUrl,
        templateId: resolved.templateId,
        clearTemplateId: resolved.clearTemplateId,
        arcadeVisibility: resolved.arcadeVisibility,
      });
    });

  const gameMediaCommand = gameCommand
    .command("media")
    .description("Manage hosted game media assets");

  gameMediaCommand
    .command("inspect")
    .description("Inspect hosted media for one owned game")
    .requiredOption("--game <slug-or-id>", "Owned hosted game slug or ID")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .action(async (options: unknown) => {
      const resolved = resolveActionOptions<{
        platformUrl?: string;
        game: string;
      }>(options);

      await runGameMediaInspectCommand({
        platformUrl: resolved.platformUrl,
        game: resolved.game,
      });
    });

  gameMediaCommand
    .command("upload")
    .description("Upload and assign hosted media for one owned game")
    .requiredOption("--game <slug-or-id>", "Owned hosted game slug or ID")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .option("--thumbnail <path>", "Thumbnail image file")
    .option("--cover <path>", "Cover image file")
    .option("--preview-video <path>", "Preview video file")
    .action(async (options: unknown) => {
      const resolved = resolveActionOptions<{
        platformUrl?: string;
        game: string;
        thumbnail?: string;
        cover?: string;
        previewVideo?: string;
      }>(options);

      await runGameMediaUploadCommand({
        platformUrl: resolved.platformUrl,
        game: resolved.game,
        thumbnail: resolved.thumbnail,
        cover: resolved.cover,
        previewVideo: resolved.previewVideo,
      });
    });

  gameMediaCommand
    .command("clear")
    .description("Archive the currently active hosted media asset for one slot")
    .requiredOption("--game <slug-or-id>", "Owned hosted game slug or ID")
    .requiredOption(
      "--kind <kind>",
      "Media slot to clear (thumbnail, cover, or preview_video)",
    )
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .action(async (options: unknown) => {
      const resolved = resolveActionOptions<{
        platformUrl?: string;
        game: string;
        kind: string;
      }>(options);

      await runGameMediaClearCommand({
        platformUrl: resolved.platformUrl,
        game: resolved.game,
        kind: normalizeGameMediaKind(resolved.kind),
      });
    });

  gameMediaCommand.action(() => {
    gameMediaCommand.outputHelp();
  });

  gameCommand.action(() => {
    gameCommand.outputHelp();
  });

  const releaseCommand = program
    .command("release")
    .description("Work with hosted release bundles");

  releaseCommand
    .command("doctor")
    .description(
      "Inspect whether a project is ready for hosted release bundling",
    )
    .option("--dir <path>", "Project directory to inspect")
    .option("--dist-dir <path>", "Built static output directory")
    .action(async (options: unknown) => {
      await printReleaseDoctor(
        resolveActionOptions<{
          dir?: string;
          distDir?: string;
        }>(options),
      );
    });

  releaseCommand
    .command("bundle")
    .description("Create a hosted release zip from a built game project")
    .option("--dir <path>", "Project directory to bundle")
    .option("--dist-dir <path>", "Built static output directory")
    .option("--out <path>", "Output zip file path")
    .option(
      "--skip-build",
      "Reuse the existing dist directory without building",
      false,
    )
    .action(async (options: unknown) => {
      await runReleaseBundleCommand(
        resolveActionOptions<{
          dir?: string;
          distDir?: string;
          out?: string;
          skipBuild?: boolean;
        }>(options),
      );
    });

  releaseCommand
    .command("validate")
    .description(
      "Validate hosted release inputs or an existing hosted release zip",
    )
    .option("--dir <path>", "Project directory to inspect")
    .option("--dist-dir <path>", "Built static output directory")
    .option("--bundle <path>", "Existing hosted release zip to validate")
    .option(
      "--skip-build",
      "Reuse the existing dist directory without building",
      false,
    )
    .action(async (options: unknown) => {
      await runReleaseValidateCommand(
        resolveActionOptions<{
          dir?: string;
          distDir?: string;
          bundle?: string;
          skipBuild?: boolean;
        }>(options),
      );
    });

  releaseCommand
    .command("list")
    .description("List owned hosted games or releases for one hosted game")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .option("--game <slug-or-id>", "List releases for one owned hosted game")
    .action(async (options: unknown) => {
      await runReleaseListCommand(
        resolveActionOptions<{
          platformUrl?: string;
          game?: string;
        }>(options),
      );
    });

  releaseCommand
    .command("inspect")
    .description("Inspect one hosted release from the Air Jam platform")
    .requiredOption("--release <id>", "Hosted release ID to inspect")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .action(async (options: unknown) => {
      const resolved = resolveActionOptions<{
        platformUrl?: string;
        release: string;
      }>(options);
      await runReleaseInspectCommand({
        platformUrl: resolved.platformUrl,
        releaseId: resolved.release,
      });
    });

  releaseCommand
    .command("submit")
    .description("Bundle a game and submit it as a hosted release draft")
    .requiredOption("--game <slug-or-id>", "Owned hosted game slug or ID")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .option("--version-label <label>", "Optional hosted release version label")
    .option("--dir <path>", "Project directory to bundle")
    .option("--dist-dir <path>", "Built static output directory")
    .option("--bundle <path>", "Existing hosted release zip to submit")
    .option(
      "--skip-build",
      "Reuse the existing dist directory without building",
      false,
    )
    .option(
      "--wait",
      "Wait for durable processing to reach a terminal generation state",
      false,
    )
    .option(
      "--processing-timeout <seconds>",
      "Maximum processing wait; the durable job continues after a timeout",
      (value) => Number(value),
    )
    .option(
      "--publish",
      "Wait for successful processing and publish the ready release",
      false,
    )
    .action(async (options: unknown) => {
      const resolved = resolveActionOptions<{
        platformUrl?: string;
        game: string;
        versionLabel?: string;
        dir?: string;
        distDir?: string;
        bundle?: string;
        skipBuild?: boolean;
        wait?: boolean;
        processingTimeout?: number;
        publish?: boolean;
      }>(options);

      await runReleaseSubmitCommand({
        platformUrl: resolved.platformUrl,
        game: resolved.game,
        versionLabel: resolved.versionLabel,
        dir: resolved.dir,
        distDir: resolved.distDir,
        bundle: resolved.bundle,
        skipBuild: resolved.skipBuild,
        waitForProcessing: resolved.wait,
        processingTimeoutSeconds: resolved.processingTimeout,
        publish: resolved.publish,
      });
    });

  releaseCommand
    .command("upload")
    .description("Upload a bundle as a new immutable generation")
    .requiredOption("--release <id>", "Hosted release ID")
    .requiredOption("--bundle <path>", "Existing hosted release zip")
    .option("--dir <path>", "Directory used to resolve the bundle path")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .action(async (options: unknown) => {
      const resolved = resolveActionOptions<{
        platformUrl?: string;
        release: string;
        dir?: string;
        bundle: string;
      }>(options);
      await runReleaseUploadCommand({
        platformUrl: resolved.platformUrl,
        releaseId: resolved.release,
        dir: resolved.dir,
        bundle: resolved.bundle,
      });
    });

  releaseCommand
    .command("finalize")
    .description("Finalize one exact immutable release generation")
    .requiredOption("--release <id>", "Hosted release ID")
    .requiredOption("--generation <id>", "Immutable generation ID")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .action(async (options: unknown) => {
      const resolved = resolveActionOptions<{
        platformUrl?: string;
        release: string;
        generation: string;
      }>(options);
      await runReleaseFinalizeCommand({
        platformUrl: resolved.platformUrl,
        releaseId: resolved.release,
        generationId: resolved.generation,
      });
    });

  releaseCommand
    .command("publish")
    .description("Publish one ready hosted release")
    .requiredOption("--release <id>", "Hosted release ID to publish")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .action(async (options: unknown) => {
      const resolved = resolveActionOptions<{
        platformUrl?: string;
        release: string;
      }>(options);
      await runReleasePublishCommand({
        platformUrl: resolved.platformUrl,
        releaseId: resolved.release,
      });
    });

  releaseCommand
    .command("export")
    .description("Download one exact immutable hosted release generation")
    .requiredOption("--release <id>", "Hosted release ID")
    .requiredOption("--generation <id>", "Immutable generation ID")
    .option("--dir <path>", "Directory used to resolve the output path")
    .option("--out <path>", "Output archive path; refuses to overwrite")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .action(async (options: unknown) => {
      const resolved = resolveActionOptions<{
        platformUrl?: string;
        release: string;
        generation: string;
        dir?: string;
        out?: string;
      }>(options);
      await runReleaseExportCommand({
        platformUrl: resolved.platformUrl,
        releaseId: resolved.release,
        generationId: resolved.generation,
        dir: resolved.dir,
        out: resolved.out,
      });
    });

  releaseCommand.action(() => {
    releaseCommand.outputHelp();
  });

  const authCommand = program
    .command("auth")
    .description("Authenticate the local Air Jam CLI with the hosted platform");

  authCommand
    .command("login")
    .description("Start browser-assisted Air Jam CLI login")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .option("--client-name <name>", "Optional machine-readable client label")
    .action(async (options: unknown) => {
      await runAuthLoginCommand(
        resolveActionOptions<{
          platformUrl?: string;
          clientName?: string;
        }>(options),
      );
    });

  authCommand
    .command("whoami")
    .description("Inspect the current stored Air Jam platform session")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .action(async (options: unknown) => {
      await runAuthWhoAmICommand(
        resolveActionOptions<{
          platformUrl?: string;
        }>(options),
      );
    });

  authCommand
    .command("logout")
    .description("Revoke the current stored Air Jam platform session")
    .option("--platform-url <url>", "Hosted Air Jam platform base URL")
    .action(async (options: unknown) => {
      await runAuthLogoutCommand(
        resolveActionOptions<{
          platformUrl?: string;
        }>(options),
      );
    });

  authCommand.action(() => {
    authCommand.outputHelp();
  });

  const mcpCommand = program
    .command("mcp")
    .description("Inspect or initialize project-local Air Jam MCP setup");

  mcpCommand
    .command("doctor")
    .description("Inspect the current project's Air Jam MCP setup")
    .option("--dir <path>", "Project directory to inspect")
    .option("--json", "Print one machine-readable JSON document", false)
    .action(async (options: unknown) => {
      await runMcpDoctor(
        resolveActionOptions<{
          dir?: string;
          json?: boolean;
        }>(options),
      );
    });

  mcpCommand
    .command("init")
    .description(`Write ${AIRJAM_PROJECT_MCP_FILE} for the current project`)
    .option("--dir <path>", "Project directory to inspect")
    .option("--force", "Overwrite an existing project-local MCP config", false)
    .option("--json", "Print one machine-readable JSON document", false)
    .action(async (options: unknown) => {
      await runMcpInit(
        resolveActionOptions<{
          dir?: string;
          force?: boolean;
          json?: boolean;
        }>(options),
      );
    });

  mcpCommand
    .command("config")
    .description("Render a portable, Codex, or Claude Desktop MCP profile")
    .option("--dir <path>", "Project directory to inspect")
    .option(
      "--profile <profile>",
      "Profile to render (portable, codex, or claude-desktop)",
      "portable",
    )
    .option("--json", "Print the rendered profile metadata as JSON", false)
    .action(async (options: unknown) => {
      const resolved = resolveActionOptions<{
        dir?: string;
        profile?: "portable" | "codex" | "claude-desktop";
        json?: boolean;
      }>(options);
      await runMcpConfig(resolved);
    });

  mcpCommand.action(() => {
    mcpCommand.outputHelp();
  });

  const sessionCommand = program
    .command("session")
    .description(
      "Operate persistent semantic game sessions through stable JSON contracts",
    );

  sessionCommand
    .command("open")
    .description("Open a persistent semantic game session")
    .option("--dir <path>", "Project directory")
    .option("--game <id>", "Game ID in a monorepo")
    .option(
      "--mode <mode>",
      "Dev mode (standalone-dev, arcade-dev, or arcade-test)",
    )
    .option("--secure", "Use secure local topology", false)
    .option("--room <id>", "Existing room ID")
    .option("--controller-url <url>", "Existing controller join URL")
    .option("--timeout-ms <ms>", "Connection timeout in milliseconds", Number)
    .action(async (options: unknown) => {
      const input = resolveActionOptions<{
        dir?: string;
        game?: string;
        mode?: "standalone-dev" | "arcade-dev" | "arcade-test";
        secure?: boolean;
        room?: string;
        controllerUrl?: string;
        timeoutMs?: number;
      }>(options);
      const result = await openSession({
        dir: input.dir,
        gameId: input.game,
        mode: input.mode,
        secure: input.secure,
        roomId: input.room,
        controllerJoinUrl: input.controllerUrl,
        timeoutMs: input.timeoutMs,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  sessionCommand
    .command("read")
    .description("Read runtime and semantic state from a persistent session")
    .argument("<session-id>", "Game session ID")
    .option("--dir <path>", "Project directory")
    .option("--no-sync", "Read without requesting a fresh semantic snapshot")
    .option("--timeout-ms <ms>", "Snapshot timeout in milliseconds", Number)
    .action(async (sessionId: string, options: unknown) => {
      const input = resolveActionOptions<{
        dir?: string;
        sync?: boolean;
        timeoutMs?: number;
      }>(options);
      const result = await readSession({
        dir: input.dir,
        gameSessionId: sessionId,
        requestSync: input.sync,
        timeoutMs: input.timeoutMs,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  sessionCommand
    .command("input")
    .description("Send validated controller input through a persistent session")
    .argument("<session-id>", "Game session ID")
    .requiredOption("--input <json>", "Controller input JSON object")
    .option("--dir <path>", "Project directory")
    .action(async (sessionId: string, options: unknown) => {
      const input = resolveActionOptions<{ dir?: string; input: string }>(
        options,
      );
      const result = await sendSessionInput({
        dir: input.dir,
        gameSessionId: sessionId,
        input: parseJsonObject(input.input),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  sessionCommand
    .command("invoke")
    .description("Invoke one published semantic action")
    .argument("<session-id>", "Game session ID")
    .argument("<action-id>", "Published action ID, including its lane prefix")
    .option("--payload <json>", "JSON payload or plain string payload")
    .option("--dir <path>", "Project directory")
    .option("--timeout-ms <ms>", "Action timeout in milliseconds", Number)
    .action(async (sessionId: string, actionId: string, options: unknown) => {
      const input = resolveActionOptions<{
        dir?: string;
        payload?: string;
        timeoutMs?: number;
      }>(options);
      const result = await invokeSessionAction({
        dir: input.dir,
        gameSessionId: sessionId,
        actionId,
        ...(input.payload !== undefined
          ? { payload: parseJsonValue(input.payload) }
          : {}),
        timeoutMs: input.timeoutMs,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  sessionCommand
    .command("close")
    .description("Close a persistent semantic game session")
    .argument("<session-id>", "Game session ID")
    .option("--dir <path>", "Project directory")
    .action(async (sessionId: string, options: unknown) => {
      const input = resolveActionOptions<{ dir?: string }>(options);
      const result = await closeSession({
        dir: input.dir,
        gameSessionId: sessionId,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  const sessionBrokerCommand = sessionCommand
    .command("broker")
    .description("Inspect or stop the project-local semantic session broker");

  sessionBrokerCommand
    .command("status")
    .description("Inspect broker health")
    .option("--dir <path>", "Project directory")
    .action(async (options: unknown) => {
      const result = await runSessionBrokerStatus(
        resolveActionOptions<{ dir?: string }>(options),
      );
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  sessionBrokerCommand
    .command("stop")
    .description("Close active sessions and stop the broker")
    .option("--dir <path>", "Project directory")
    .action(async (options: unknown) => {
      const result = await runSessionBrokerStop(
        resolveActionOptions<{ dir?: string }>(options),
      );
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  sessionCommand.action(() => sessionCommand.outputHelp());

  program
    .command("__session-broker", { hidden: true })
    .requiredOption("--dir <path>", "Project directory")
    .action(async (options: unknown) => {
      const input = resolveActionOptions<{ dir: string }>(options);
      await runSessionBrokerProcess(input.dir);
    });

  program
    .command("status")
    .description("Show local Air Jam dev process and known-port status")
    .option("--dir <path>", "Project directory to inspect")
    .action(async (options: unknown) => {
      const input = resolveActionOptions<{ dir?: string }>(options);
      const status = await getDevStatus({ cwd: input.dir });
      console.log(JSON.stringify(status, null, 2));
    });

  const resetCommand = program
    .command("reset")
    .description("Reset local Air Jam development state");

  resetCommand
    .command("local")
    .description(
      "Stop managed dev processes and stale known-port Air Jam local listeners",
    )
    .option("--dir <path>", "Project directory to reset")
    .action(async (options: unknown) => {
      const input = resolveActionOptions<{ dir?: string }>(options);
      const result = await resetLocalDev({ cwd: input.dir });
      console.log(JSON.stringify(result, null, 2));
    });

  const devCommand = program
    .command("dev")
    .description("Run project-local Air Jam game development")
    .argument("[passthrough...]", "Additional runtime flags")
    .allowExcessArguments(true)
    .allowUnknownOption(false)
    .option("--secure", "Start secure local game dev", false)
    .option(
      "--secure-mode <mode>",
      "Secure mode to use when --secure is enabled (local or tunnel)",
    )
    .option(
      "--preview-managed",
      "Advanced/internal: start foreground Vite with a background server",
      false,
    )
    .option("--web-only", "Start only the game app", false)
    .option("--server-only", "Start only the local Air Jam server", false)
    .option(
      "--allow-existing-game",
      "Reuse an already-running Vite server on the game port",
      false,
    )
    .addHelpText(
      "after",
      [
        "",
        "Network isolation:",
        "  VITE_PORT=<port>                 Game app port (default: 5173)",
        "  AIR_JAM_SERVER_PORT=<port>       Local server port (default: 4000)",
        "  VITE_AIR_JAM_PUBLIC_HOST=<url>   Explicit host/controller origin",
        "",
        "Set all three when parallel agents or local projects need isolated dev stacks.",
      ].join("\n"),
    )
    .action(async () => {
      await runGameDevCli({
        argv: normalizeRuntimeCliArgv(process.argv.slice(3)),
      });
    });

  devCommand
    .command("start")
    .description("Start a managed Air Jam dev process and return JSON")
    .option("--dir <path>", "Project directory to start")
    .option("--game <id>", "Game ID in a monorepo")
    .option(
      "--mode <mode>",
      "Dev mode (standalone-dev, arcade-dev, or arcade-test)",
      "standalone-dev",
    )
    .option("--secure", "Use secure local topology", false)
    .action(async (options: unknown) => {
      const input = resolveActionOptions<{
        dir?: string;
        game?: string;
        mode?: "standalone-dev" | "arcade-dev" | "arcade-test";
        secure?: boolean;
      }>(options);
      const result = await startDev({
        cwd: input.dir,
        gameId: input.game,
        mode: input.mode,
        secure: input.secure,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  devCommand
    .command("stop")
    .description("Stop managed Air Jam dev processes and return JSON")
    .option("--dir <path>", "Project directory to stop")
    .option("--process <id>", "Managed process ID")
    .option(
      "--mode <mode>",
      "Stop only one dev mode (standalone-dev, arcade-dev, or arcade-test)",
    )
    .action(async (options: unknown) => {
      const input = resolveActionOptions<{
        dir?: string;
        process?: string;
        mode?: "standalone-dev" | "arcade-dev" | "arcade-test";
      }>(options);
      const result = await stopDev({
        cwd: input.dir,
        processId: input.process,
        mode: input.mode,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });

  program
    .command("secure:init")
    .description("Initialize local secure Air Jam game development")
    .argument("[passthrough...]", "Additional runtime flags")
    .allowExcessArguments(true)
    .allowUnknownOption(false)
    .option("--mode <mode>", "Secure mode to configure (local or tunnel)")
    .option("--hostname <hostname>", "Tunnel hostname for secure tunnel mode")
    .option("--tunnel <name>", "Cloudflare tunnel name for secure tunnel mode")
    .action(async () => {
      await runSecureInitCli({
        argv: normalizeRuntimeCliArgv(process.argv.slice(3)),
      });
    });

  program
    .command("topology")
    .description(
      "Print the resolved project runtime topology for the current game",
    )
    .allowUnknownOption(false)
    .requiredOption(
      "--mode <mode>",
      "Topology mode to inspect (standalone-dev, self-hosted-production, hosted-release)",
    )
    .option(
      "--secure",
      "Resolve standalone local topology using trusted local HTTPS",
      false,
    )
    .addHelpText(
      "after",
      "\nTopology honors VITE_PORT, AIR_JAM_SERVER_PORT, VITE_AIR_JAM_SERVER_URL, and VITE_AIR_JAM_PUBLIC_HOST.\n",
    )
    .action(async () => {
      await runProjectTopologyCli({
        argv: normalizeRuntimeCliArgv(process.argv.slice(3)),
      });
    });

  return program;
};

async function main() {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  if (isEnvValidationError(err)) {
    console.error(
      formatEnvValidationError(err, {
        docsHint:
          "Fix the listed env values in .env.local (or CI/deployment env) and retry.",
      }),
    );
    process.exit(1);
    return;
  }

  console.error(kleur.red("Error:"), err);
  process.exit(1);
});
