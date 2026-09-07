import {
  platformMachineCreateReleaseDraftResultSchema,
  platformMachineFinalizeReleaseUploadResultSchema,
  platformMachineGetReleaseResultSchema,
  platformMachineListOwnedGamesResultSchema,
  platformMachineListReleasesResultSchema,
  platformMachinePublishReleaseResultSchema,
  platformMachineRequestReleaseGenerationExportResultSchema,
  platformMachineRequestReleaseUploadTargetResultSchema,
} from "@air-jam/sdk/platform-machine";
import {
  HOSTED_RELEASE_CONTROLLER_PATH,
  HOSTED_RELEASE_ENTRY_PATH,
  HOSTED_RELEASE_HOST_PATH,
  HOSTED_RELEASE_MANIFEST_PATH,
  createHostedReleaseArtifactManifest,
  hostedReleaseArtifactManifestSchema,
  type HostedReleaseArtifactManifest,
} from "@air-jam/sdk/release";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as yauzl from "yauzl";
import yazl from "yazl";
import { runCommandResult } from "./commands.js";
import { detectProjectContext } from "./context.js";
import {
  pathExists,
  readPackageJson,
  resolveCandidatePath,
  resolveCanonicalPath,
} from "./fs-utils.js";
import {
  requestPlatformMachineApi,
  resolvePlatformMachineAuth,
} from "./platform-auth.js";
import type {
  AirJamLocalReleaseDoctor,
  AirJamLocalReleaseIssue,
  AirJamLocalReleaseValidation,
  AirJamPackageManager,
  BundleLocalReleaseOptions,
  BundleLocalReleaseResult,
  CommandResult,
  ExportPlatformReleaseGenerationOptions,
  ExportPlatformReleaseGenerationResult,
  FinalizePlatformReleaseGenerationOptions,
  InspectLocalReleaseOptions,
  InspectPlatformReleaseOptions,
  ListPlatformReleaseTargetsOptions,
  ListPlatformReleasesOptions,
  PublishPlatformReleaseOptions,
  SubmitPlatformReleaseOptions,
  SubmitPlatformReleaseResult,
  UploadPlatformReleaseGenerationOptions,
  ValidateLocalReleaseOptions,
} from "./types.js";

export type { AirJamLocalReleaseIssue } from "./types.js";

const IGNORED_ARCHIVE_PATHS = ["__MACOSX/", ".DS_Store"] as const;
const VENDORED_FONT_ASSET_DIR = "assets/airjam-vendored/fonts";
const REMOTE_FONT_STYLESHEET_HOSTS = new Set(["fonts.googleapis.com"]);
const REMOTE_FONT_ASSET_HOSTS = new Set(["fonts.gstatic.com"]);
const REMOTE_CSS_IMPORT_PATTERN =
  /@import\s*(?:url\(\s*)?(?<quote>["']?)(?<url>https?:\/\/[^"')\s]+)\k<quote>\s*\)?\s*;/g;
const REMOTE_CSS_URL_PATTERN =
  /url\(\s*(?<quote>["']?)(?<url>https?:\/\/[^"')\s]+)\k<quote>\s*\)/g;
const FONT_ASSET_EXTENSION_PATTERN = /\.(woff2?|ttf|otf|eot)(?:[?#].*)?$/i;
const CSS_EXTENSION_PATTERN = /\.css(?:[?#].*)?$/i;
const FONT_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DEFAULT_RELEASE_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const RELEASE_PROCESSING_POLL_INTERVAL_MS = 2_000;

const wait = async (durationMs: number) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const sanitizePathSegment = (value: string): string =>
  value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");

const parsePackageManagerField = (
  value: string | undefined,
): AirJamPackageManager => {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("pnpm@")) {
    return "pnpm";
  }
  if (normalized.startsWith("npm@")) {
    return "npm";
  }
  if (normalized.startsWith("yarn@")) {
    return "yarn";
  }
  if (normalized.startsWith("bun@")) {
    return "bun";
  }
  return "unknown";
};

const resolvePackageManager = async (
  targetDir: string,
): Promise<AirJamPackageManager> => {
  const packageJson = await readPackageJson(targetDir);
  const packageManagerFromField = parsePackageManagerField(
    packageJson?.value.packageManager,
  );

  if (packageManagerFromField !== "unknown") {
    return packageManagerFromField;
  }

  const context = await detectProjectContext({ cwd: targetDir });
  return context.packageManager;
};

const getDefaultReleaseBundlePath = ({
  projectDir,
  packageName,
  packageVersion,
}: {
  projectDir: string;
  packageName?: string | null;
  packageVersion?: string | null;
}): string => {
  const normalizedReleaseLabel = sanitizePathSegment(packageVersion || "dev");
  const normalizedPackageName = sanitizePathSegment(
    packageName || "airjam-game",
  );

  return path.join(
    projectDir,
    ".airjam",
    "releases",
    normalizedReleaseLabel,
    `${normalizedPackageName}-hosted-release.zip`,
  );
};

const readConfiguredControllerPath = async (
  configPath: string | null,
): Promise<string | null> => {
  if (!configPath || !(await pathExists(configPath))) {
    return null;
  }

  const source = await readFile(configPath, "utf8");
  const match = source.match(/controllerPath\s*:\s*["'`](?<path>[^"'`]+)["'`]/);
  return match?.groups?.path?.trim() || null;
};

const getLocalAirJamConfigPath = async (
  projectDir: string,
): Promise<string | null> =>
  resolveCandidatePath(projectDir, [
    "src/airjam.config.ts",
    "src/airjam.config.tsx",
    "src/airjam.config.js",
    "src/airjam.config.mjs",
    "airjam.config.ts",
    "airjam.config.tsx",
    "airjam.config.js",
    "airjam.config.mjs",
  ]);

const collectDirectoryFiles = async (sourceDir: string): Promise<string[]> => {
  const entries = await readdir(sourceDir);
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(sourceDir, entry);
    const entryStats = await stat(absolutePath);

    if (entryStats.isDirectory()) {
      files.push(...(await collectDirectoryFiles(absolutePath)));
      continue;
    }

    files.push(absolutePath);
  }

  return files;
};

const hashContent = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const ensurePosixRelativePath = (fromDir: string, toPath: string): string =>
  path.relative(fromDir, toPath).replace(/\\/g, "/");

const ensureExplicitRelativeUrl = (value: string): string => {
  if (!value || value.startsWith("./") || value.startsWith("../")) {
    return value;
  }

  return `./${value}`;
};

const isRemoteFontStylesheetUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      REMOTE_FONT_STYLESHEET_HOSTS.has(url.hostname) ||
      CSS_EXTENSION_PATTERN.test(url.pathname)
    );
  } catch {
    return false;
  }
};

const isRemoteFontAssetUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      REMOTE_FONT_ASSET_HOSTS.has(url.hostname) ||
      FONT_ASSET_EXTENSION_PATTERN.test(url.pathname)
    );
  } catch {
    return false;
  }
};

const inferFileExtensionFromContentType = (
  contentType: string | null,
): string | null => {
  if (!contentType) {
    return null;
  }

  const normalized = contentType.toLowerCase();
  if (normalized.includes("text/css")) {
    return ".css";
  }
  if (normalized.includes("font/woff2")) {
    return ".woff2";
  }
  if (normalized.includes("font/woff")) {
    return ".woff";
  }
  if (normalized.includes("font/ttf")) {
    return ".ttf";
  }
  if (normalized.includes("font/otf")) {
    return ".otf";
  }
  if (normalized.includes("application/vnd.ms-fontobject")) {
    return ".eot";
  }
  if (normalized.includes("application/octet-stream")) {
    return null;
  }

  return null;
};

const inferFileExtensionFromUrl = (value: string): string | null => {
  try {
    const { pathname } = new URL(value);
    const matched = pathname.match(/\.(woff2?|ttf|otf|eot|css)$/i);
    return matched ? matched[0]!.toLowerCase() : null;
  } catch {
    return null;
  }
};

const fetchRemoteAsset = async (value: string) => {
  const response = await fetch(value, {
    headers: {
      "user-agent": FONT_FETCH_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch remote font asset ${value} (${response.status}).`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    buffer,
    contentType: response.headers.get("content-type"),
  };
};

type VendoredFontState = {
  cssByUrl: Map<string, string>;
  assetByUrl: Map<string, string>;
};

const rewriteCssAsync = async ({
  css,
  replacePattern,
  replacer,
}: {
  css: string;
  replacePattern: RegExp;
  replacer: (match: RegExpExecArray) => Promise<string>;
}): Promise<string> => {
  const pieces: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const pattern = new RegExp(replacePattern.source, replacePattern.flags);

  while ((match = pattern.exec(css)) !== null) {
    const matchedText = match[0];
    const index = match.index;
    pieces.push(css.slice(lastIndex, index));
    pieces.push(await replacer(match));
    lastIndex = index + matchedText.length;
  }

  pieces.push(css.slice(lastIndex));
  return pieces.join("");
};

const vendorRemoteFontAsset = async ({
  assetUrl,
  bundleRoot,
  state,
}: {
  assetUrl: string;
  bundleRoot: string;
  state: VendoredFontState;
}): Promise<string> => {
  const cached = state.assetByUrl.get(assetUrl);
  if (cached) {
    return cached;
  }

  const { buffer, contentType } = await fetchRemoteAsset(assetUrl);
  const extension =
    inferFileExtensionFromContentType(contentType) ||
    inferFileExtensionFromUrl(assetUrl) ||
    ".bin";
  const fileName = `${hashContent(assetUrl)}${extension}`;
  const relativePath = path.posix.join(VENDORED_FONT_ASSET_DIR, fileName);
  const absolutePath = path.join(bundleRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, buffer);
  state.assetByUrl.set(assetUrl, relativePath);
  return relativePath;
};

const vendorRemoteFontStylesheet = async ({
  stylesheetUrl,
  bundleRoot,
  state,
}: {
  stylesheetUrl: string;
  bundleRoot: string;
  state: VendoredFontState;
}): Promise<string> => {
  const cached = state.cssByUrl.get(stylesheetUrl);
  if (cached) {
    return cached;
  }

  const { buffer, contentType } = await fetchRemoteAsset(stylesheetUrl);
  if (contentType && !contentType.toLowerCase().includes("text/css")) {
    throw new Error(
      `Expected remote stylesheet ${stylesheetUrl} to return CSS but received ${contentType}.`,
    );
  }

  const stylesheetText = buffer.toString("utf8");
  const rewrittenCss = await rewriteCssAsync({
    css: stylesheetText,
    replacePattern: REMOTE_CSS_URL_PATTERN,
    replacer: async (match) => {
      const remoteUrl = match.groups?.url?.trim();
      if (!remoteUrl) {
        return match[0];
      }

      const absoluteUrl = new URL(remoteUrl, stylesheetUrl).toString();
      const assetPath = await vendorRemoteFontAsset({
        assetUrl: absoluteUrl,
        bundleRoot,
        state,
      });
      return `url("./${path.posix.basename(assetPath)}")`;
    },
  });

  const relativePath = path.posix.join(
    VENDORED_FONT_ASSET_DIR,
    `${hashContent(stylesheetUrl)}.css`,
  );
  const absolutePath = path.join(bundleRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, rewrittenCss, "utf8");
  state.cssByUrl.set(stylesheetUrl, relativePath);
  return relativePath;
};

const vendorCssFontDependencies = async ({
  bundleRoot,
}: {
  bundleRoot: string;
}): Promise<void> => {
  const files = await collectDirectoryFiles(bundleRoot);
  const cssFiles = files.filter((filePath) => filePath.endsWith(".css"));
  const state: VendoredFontState = {
    cssByUrl: new Map(),
    assetByUrl: new Map(),
  };

  for (const cssFilePath of cssFiles) {
    const originalCss = await readFile(cssFilePath, "utf8");
    const cssDir = path.dirname(cssFilePath);

    let rewrittenCss = await rewriteCssAsync({
      css: originalCss,
      replacePattern: REMOTE_CSS_IMPORT_PATTERN,
      replacer: async (match) => {
        const remoteUrl = match.groups?.url?.trim();
        if (!remoteUrl || !isRemoteFontStylesheetUrl(remoteUrl)) {
          return match[0];
        }

        const vendoredStylesheet = await vendorRemoteFontStylesheet({
          stylesheetUrl: remoteUrl,
          bundleRoot,
          state,
        });
        const relativeImport = ensureExplicitRelativeUrl(
          ensurePosixRelativePath(
            cssDir,
            path.join(bundleRoot, vendoredStylesheet),
          ),
        );
        return `@import url("${relativeImport}");`;
      },
    });

    rewrittenCss = await rewriteCssAsync({
      css: rewrittenCss,
      replacePattern: REMOTE_CSS_URL_PATTERN,
      replacer: async (match) => {
        const remoteUrl = match.groups?.url?.trim();
        if (!remoteUrl || !isRemoteFontAssetUrl(remoteUrl)) {
          return match[0];
        }

        const vendoredAsset = await vendorRemoteFontAsset({
          assetUrl: remoteUrl,
          bundleRoot,
          state,
        });
        const relativeAssetPath = ensureExplicitRelativeUrl(
          ensurePosixRelativePath(cssDir, path.join(bundleRoot, vendoredAsset)),
        );
        return `url("${relativeAssetPath}")`;
      },
    });

    if (rewrittenCss !== originalCss) {
      await writeFile(cssFilePath, rewrittenCss, "utf8");
    }
  }
};

const materializeBundleSourceTree = async ({
  sourceDir,
}: {
  sourceDir: string;
}): Promise<string> => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "airjam-hosted-release-bundle-"),
  );
  const bundleRoot = path.join(tempRoot, "dist");
  const files = await collectDirectoryFiles(sourceDir);

  for (const sourcePath of files) {
    const relativePath = path.relative(sourceDir, sourcePath);
    const targetPath = path.join(bundleRoot, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  }

  await vendorCssFontDependencies({ bundleRoot });
  return bundleRoot;
};

const isIgnoredArchiveEntry = (archivePath: string): boolean =>
  IGNORED_ARCHIVE_PATHS.some(
    (ignoredPath) =>
      archivePath === ignoredPath ||
      archivePath.startsWith(ignoredPath) ||
      archivePath.endsWith(`/${ignoredPath}`),
  );

const hasPathTraversal = (value: string): boolean => {
  const segments = value.split("/");
  return segments.some(
    (segment) => segment.length === 0 || segment === "." || segment === "..",
  );
};

const normalizeArchiveEntryPath = (
  rawPath: string,
): { archivePath: string; isDirectory: boolean } => {
  const canonicalPath = rawPath.replaceAll("\\", "/").trim();
  if (!canonicalPath || canonicalPath.includes("\0")) {
    throw new Error("Release archive contains an invalid empty entry path.");
  }

  const isDirectory = canonicalPath.endsWith("/");
  const normalizedPath = path.posix.normalize(
    isDirectory ? canonicalPath.slice(0, -1) : canonicalPath,
  );

  if (
    !normalizedPath ||
    normalizedPath === "." ||
    path.posix.isAbsolute(normalizedPath) ||
    normalizedPath.startsWith("../") ||
    normalizedPath === ".." ||
    hasPathTraversal(normalizedPath)
  ) {
    throw new Error(
      `Release archive entry escapes the allowed root: ${rawPath}`,
    );
  }

  return {
    archivePath: normalizedPath,
    isDirectory,
  };
};

const getUnixMode = (entry: yauzl.Entry): number | null => {
  const mode = entry.externalFileAttributes >>> 16;
  return mode === 0 ? null : mode;
};

const isZipSymlink = (entry: yauzl.Entry): boolean => {
  const unixMode = getUnixMode(entry);
  if (unixMode === null) {
    return false;
  }

  return (unixMode & 0o170000) === 0o120000;
};

const buildArgsByPackageManager = {
  npm: ["run", "build"],
  pnpm: ["build"],
  yarn: ["build"],
  bun: ["run", "build"],
} satisfies Record<Exclude<AirJamPackageManager, "unknown">, readonly string[]>;

const resolveBuildCommand = (
  packageManager: AirJamPackageManager,
): { command: string; args: string[] } | null => {
  return packageManager === "unknown"
    ? null
    : {
        command: packageManager,
        args: [...buildArgsByPackageManager[packageManager]],
      };
};

const runBuild = async ({
  projectDir,
  packageManager,
}: {
  projectDir: string;
  packageManager: AirJamPackageManager;
}): Promise<CommandResult> => {
  const buildCommand = resolveBuildCommand(packageManager);
  if (!buildCommand) {
    return {
      command: "unknown",
      args: [],
      cwd: projectDir,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "Unknown package manager. Cannot run build script.",
      durationMs: 0,
      ok: false,
    };
  }

  return runCommandResult({
    command: buildCommand.command,
    args: buildCommand.args,
    cwd: projectDir,
  });
};

const createIssue = (
  code: string,
  severity: AirJamLocalReleaseIssue["severity"],
  message: string,
  issuePath: string | null = null,
): AirJamLocalReleaseIssue => ({
  code,
  severity,
  message,
  path: issuePath,
});

const openZipFile = async (archiveBuffer: Buffer): Promise<yauzl.ZipFile> =>
  new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      archiveBuffer,
      {
        lazyEntries: true,
        validateEntrySizes: true,
        strictFileNames: false,
      },
      (error, zipFile) => {
        if (error) {
          reject(error);
          return;
        }

        if (!zipFile) {
          reject(new Error("Could not open release archive."));
          return;
        }

        resolve(zipFile);
      },
    );
  });

const openZipEntryReadStream = async (
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<NodeJS.ReadableStream> =>
  new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      if (!stream) {
        reject(new Error(`Could not open zip entry stream: ${entry.fileName}`));
        return;
      }

      resolve(stream);
    });
  });

const readStreamBuffer = async (
  stream: NodeJS.ReadableStream,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

const resolveArchiveRoot = (
  archivePaths: readonly string[],
): {
  entryPath: typeof HOSTED_RELEASE_ENTRY_PATH;
  wrapperDirectory: string | null;
} => {
  if (archivePaths.includes(HOSTED_RELEASE_ENTRY_PATH)) {
    return {
      entryPath: HOSTED_RELEASE_ENTRY_PATH,
      wrapperDirectory: null,
    };
  }

  const topLevelSegments = new Set(
    archivePaths.map((archivePath) => archivePath.split("/")[0]),
  );

  if (topLevelSegments.size !== 1) {
    throw new Error(
      "Release archive must contain a root index.html or a single top-level wrapper directory.",
    );
  }

  const [wrapperDirectory] = [...topLevelSegments];
  if (
    !archivePaths.includes(`${wrapperDirectory}/${HOSTED_RELEASE_ENTRY_PATH}`)
  ) {
    throw new Error(
      "Release archive wrapper directory must contain index.html at its root.",
    );
  }

  return {
    entryPath: HOSTED_RELEASE_ENTRY_PATH,
    wrapperDirectory,
  };
};

const inspectProjectRelease = async ({
  projectDir,
  distDir,
  packageManager,
}: {
  projectDir: string;
  distDir: string;
  packageManager: AirJamPackageManager;
}): Promise<AirJamLocalReleaseDoctor> => {
  const packageJson = await readPackageJson(projectDir);
  const configPath = await getLocalAirJamConfigPath(projectDir);
  const configSource = configPath
    ? await readFile(configPath, "utf8").catch(() => "")
    : "";
  const controllerPath =
    (await readConfiguredControllerPath(configPath)) ?? null;
  const distExists = await pathExists(distDir);
  const distEntryExists = distExists
    ? await pathExists(path.join(distDir, HOSTED_RELEASE_ENTRY_PATH))
    : false;
  const issues: AirJamLocalReleaseIssue[] = [];

  if (!configPath) {
    issues.push(
      createIssue(
        "missing-config",
        "error",
        "Hosted releases require src/airjam.config.ts so tooling can inspect the game contract.",
      ),
    );
  }

  if (!packageJson?.value.scripts?.build) {
    issues.push(
      createIssue(
        "missing-build-script",
        "error",
        'Hosted releases require a "build" script in package.json.',
        packageJson?.path ?? null,
      ),
    );
  }

  if (controllerPath && controllerPath !== HOSTED_RELEASE_CONTROLLER_PATH) {
    issues.push(
      createIssue(
        "invalid-controller-path",
        "error",
        `Hosted Air Jam bundles require controllerPath to be ${HOSTED_RELEASE_CONTROLLER_PATH}. This project is configured for ${controllerPath}.`,
        configPath,
      ),
    );
  }

  if (!/\bgameMetadata\b/.test(configSource)) {
    issues.push(
      createIssue(
        "missing-game-metadata",
        "warning",
        "No gameMetadata export was detected in airjam.config.ts. Hosted release submission can still bundle locally, but dashboard prefill and catalog metadata will be incomplete.",
        configPath,
      ),
    );
  }

  if (distExists && !distEntryExists) {
    issues.push(
      createIssue(
        "invalid-dist-entry",
        "warning",
        `Current build output is missing ${HOSTED_RELEASE_ENTRY_PATH} at ${distDir}. Run the build before validating or bundling.`,
        distDir,
      ),
    );
  }

  return {
    projectDir,
    packageJsonPath: packageJson?.path ?? null,
    packageName: packageJson?.value.name ?? null,
    packageVersion: packageJson?.value.version ?? null,
    packageManager,
    configPath,
    buildScript: packageJson?.value.scripts?.build ?? null,
    metadataExportLikely: /\bgameMetadata\b/.test(configSource),
    controllerPath,
    distDir,
    distExists,
    distEntryExists,
    recommendedBundlePath: getDefaultReleaseBundlePath({
      projectDir,
      packageName: packageJson?.value.name ?? null,
      packageVersion: packageJson?.value.version ?? null,
    }),
    canBundle: !issues.some((issue) => issue.severity === "error"),
    issues,
    hostedContract: {
      entryPath: HOSTED_RELEASE_ENTRY_PATH,
      manifestPath: HOSTED_RELEASE_MANIFEST_PATH,
      hostPath: HOSTED_RELEASE_HOST_PATH,
      controllerPath: HOSTED_RELEASE_CONTROLLER_PATH,
    },
  };
};

const validateProjectBuildOutput = async ({
  projectDir,
  distDir,
  packageManager,
  skipBuild,
}: {
  projectDir: string;
  distDir: string;
  packageManager: AirJamPackageManager;
  skipBuild: boolean;
}): Promise<{
  buildResult: CommandResult | null;
  validation: AirJamLocalReleaseValidation;
}> => {
  const doctor = await inspectProjectRelease({
    projectDir,
    distDir,
    packageManager,
  });
  const issues = [...doctor.issues];
  let buildResult: CommandResult | null = null;

  if (!skipBuild && doctor.buildScript) {
    buildResult = await runBuild({ projectDir, packageManager });
    if (!buildResult.ok) {
      issues.push(
        createIssue(
          "build-failed",
          "error",
          `Build failed for hosted release validation.\n${buildResult.stderr || buildResult.stdout || "Unknown build failure."}`,
          doctor.packageJsonPath,
        ),
      );
    }
  }

  const distExists = await pathExists(distDir);
  const distEntryExists = distExists
    ? await pathExists(path.join(distDir, HOSTED_RELEASE_ENTRY_PATH))
    : false;

  if (!distExists) {
    issues.push(
      createIssue(
        "missing-dist",
        "error",
        `Build output directory not found at ${distDir}. Run the build first or pass --dist-dir.`,
        distDir,
      ),
    );
  }

  if (distExists && !distEntryExists) {
    issues.push(
      createIssue(
        "missing-dist-entry",
        "error",
        `Hosted bundle build output must contain ${HOSTED_RELEASE_ENTRY_PATH} at ${distDir}.`,
        distDir,
      ),
    );
  }

  let fileCount = 0;
  let extractedSizeBytes = 0;

  if (distExists) {
    const files = await collectDirectoryFiles(distDir);
    fileCount = files.length + 1;

    for (const filePath of files) {
      const fileStats = await stat(filePath);
      extractedSizeBytes += fileStats.size;
    }

    extractedSizeBytes += Buffer.byteLength(
      `${JSON.stringify(createHostedReleaseArtifactManifest(), null, 2)}\n`,
      "utf8",
    );
  }

  return {
    buildResult,
    validation: {
      source: {
        kind: "project",
        projectDir,
        distDir,
        bundlePath: null,
      },
      ok: !issues.some((issue) => issue.severity === "error"),
      issues,
      manifest: createHostedReleaseArtifactManifest(),
      entryPath: distEntryExists ? HOSTED_RELEASE_ENTRY_PATH : null,
      wrapperDirectory: null,
      fileCount,
      extractedSizeBytes,
    },
  };
};

const validateBundleArchive = async (
  bundlePath: string,
): Promise<AirJamLocalReleaseValidation> => {
  const issues: AirJamLocalReleaseIssue[] = [];

  if (!(await pathExists(bundlePath))) {
    return {
      source: {
        kind: "bundle",
        projectDir: null,
        distDir: null,
        bundlePath,
      },
      ok: false,
      issues: [
        createIssue(
          "missing-bundle",
          "error",
          `Hosted release bundle not found at ${bundlePath}.`,
          bundlePath,
        ),
      ],
      manifest: null,
      entryPath: null,
      wrapperDirectory: null,
      fileCount: 0,
      extractedSizeBytes: 0,
    };
  }

  const archiveBuffer = await readFile(bundlePath);
  const zipFile = await openZipFile(archiveBuffer);
  const archivePaths: string[] = [];
  const manifestCandidates = new Map<string, Buffer>();
  let fileCount = 0;
  let extractedSizeBytes = 0;

  await new Promise<void>((resolve, reject) => {
    zipFile.readEntry();

    zipFile.on("entry", (entry) => {
      try {
        if (isZipSymlink(entry)) {
          reject(
            new Error(
              `Release archive cannot contain symbolic links: ${entry.fileName}`,
            ),
          );
          return;
        }

        const normalized = normalizeArchiveEntryPath(entry.fileName);
        if (isIgnoredArchiveEntry(normalized.archivePath)) {
          zipFile.readEntry();
          return;
        }

        if (normalized.isDirectory) {
          zipFile.readEntry();
          return;
        }

        archivePaths.push(normalized.archivePath);
        fileCount += 1;
        extractedSizeBytes += entry.uncompressedSize;

        if (
          normalized.archivePath.endsWith(`/${HOSTED_RELEASE_MANIFEST_PATH}`) ||
          normalized.archivePath === HOSTED_RELEASE_MANIFEST_PATH
        ) {
          void openZipEntryReadStream(zipFile, entry)
            .then(readStreamBuffer)
            .then((buffer) => {
              manifestCandidates.set(normalized.archivePath, buffer);
              zipFile.readEntry();
            })
            .catch(reject);
          return;
        }

        zipFile.readEntry();
      } catch (error) {
        reject(error);
      }
    });

    zipFile.once("end", resolve);
    zipFile.once("error", reject);
  }).finally(() => {
    zipFile.close();
  });

  try {
    const root = resolveArchiveRoot(
      archivePaths.filter((archivePath) => !archivePath.endsWith("/")),
    );
    const manifestPath = root.wrapperDirectory
      ? `${root.wrapperDirectory}/${HOSTED_RELEASE_MANIFEST_PATH}`
      : HOSTED_RELEASE_MANIFEST_PATH;
    const manifestBuffer = manifestCandidates.get(manifestPath);

    if (!manifestBuffer) {
      issues.push(
        createIssue(
          "missing-manifest",
          "error",
          `Release archive must include ${HOSTED_RELEASE_MANIFEST_PATH} for Air Jam hosted releases.`,
          bundlePath,
        ),
      );
    }

    let manifest: HostedReleaseArtifactManifest | null = null;
    if (manifestBuffer) {
      try {
        manifest = hostedReleaseArtifactManifestSchema.parse(
          JSON.parse(manifestBuffer.toString("utf8")) as unknown,
        );
      } catch {
        issues.push(
          createIssue(
            "invalid-manifest",
            "error",
            `Hosted release manifest must match the Air Jam hosted artifact contract at ${HOSTED_RELEASE_MANIFEST_PATH}.`,
            bundlePath,
          ),
        );
      }
    }

    return {
      source: {
        kind: "bundle",
        projectDir: null,
        distDir: null,
        bundlePath,
      },
      ok: !issues.some((issue) => issue.severity === "error"),
      issues,
      manifest,
      entryPath: root.entryPath,
      wrapperDirectory: root.wrapperDirectory,
      fileCount,
      extractedSizeBytes,
    };
  } catch (error) {
    issues.push(
      createIssue(
        "invalid-bundle-layout",
        "error",
        error instanceof Error
          ? error.message
          : "Invalid hosted release archive.",
        bundlePath,
      ),
    );

    return {
      source: {
        kind: "bundle",
        projectDir: null,
        distDir: null,
        bundlePath,
      },
      ok: false,
      issues,
      manifest: null,
      entryPath: null,
      wrapperDirectory: null,
      fileCount,
      extractedSizeBytes,
    };
  }
};

const writeHostedReleaseBundle = async ({
  sourceDir,
  outputFile,
}: {
  sourceDir: string;
  outputFile: string;
}): Promise<void> => {
  const bundleSourceDir = await materializeBundleSourceTree({ sourceDir });

  try {
    const files = await collectDirectoryFiles(bundleSourceDir);
    const zipFile = new yazl.ZipFile();
    await mkdir(path.dirname(outputFile), { recursive: true });
    const output = createWriteStream(outputFile);

    const closePromise = new Promise<void>((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
      zipFile.outputStream.on("error", reject);
    });

    zipFile.outputStream.pipe(output);

    for (const filePath of files) {
      const relativePath = path
        .relative(bundleSourceDir, filePath)
        .replace(/\\/g, "/");
      if (!relativePath || relativePath === HOSTED_RELEASE_MANIFEST_PATH) {
        continue;
      }

      zipFile.addFile(filePath, relativePath);
    }

    zipFile.addBuffer(
      Buffer.from(
        `${JSON.stringify(createHostedReleaseArtifactManifest(), null, 2)}\n`,
        "utf8",
      ),
      HOSTED_RELEASE_MANIFEST_PATH,
    );
    zipFile.end();

    await closePromise;
  } finally {
    await rm(path.dirname(bundleSourceDir), { recursive: true, force: true });
  }
};

export const inspectLocalRelease = async ({
  cwd = process.cwd(),
  distDir,
}: InspectLocalReleaseOptions = {}): Promise<AirJamLocalReleaseDoctor> => {
  const projectDir = await resolveCanonicalPath(cwd);
  const resolvedDistDir = path.resolve(projectDir, distDir || "dist");
  const context = await detectProjectContext({ cwd: projectDir });
  const packageManager = await resolvePackageManager(projectDir);

  if (context.mode === "monorepo" && context.rootDir === projectDir) {
    return {
      projectDir,
      packageJsonPath: context.packageJsonPath,
      packageName: context.packageJson?.name ?? null,
      packageVersion: context.packageJson?.version ?? null,
      packageManager,
      configPath: null,
      buildScript: null,
      metadataExportLikely: false,
      controllerPath: null,
      distDir: resolvedDistDir,
      distExists: await pathExists(resolvedDistDir),
      distEntryExists: await pathExists(
        path.join(resolvedDistDir, HOSTED_RELEASE_ENTRY_PATH),
      ),
      recommendedBundlePath: getDefaultReleaseBundlePath({
        projectDir,
        packageName: context.packageJson?.name ?? null,
        packageVersion: context.packageJson?.version ?? null,
      }),
      canBundle: false,
      issues: [
        createIssue(
          "unsupported-monorepo-project",
          "error",
          "Local hosted release bundling currently supports standalone Air Jam game projects only. Use a generated project directory for doctor/validate/bundle/submit, or use remote release list/inspect/publish tools from the monorepo.",
          context.packageJsonPath,
        ),
      ],
      hostedContract: {
        entryPath: HOSTED_RELEASE_ENTRY_PATH,
        manifestPath: HOSTED_RELEASE_MANIFEST_PATH,
        hostPath: HOSTED_RELEASE_HOST_PATH,
        controllerPath: HOSTED_RELEASE_CONTROLLER_PATH,
      },
    };
  }

  return inspectProjectRelease({
    projectDir,
    distDir: resolvedDistDir,
    packageManager,
  });
};

export const validateLocalRelease = async ({
  cwd = process.cwd(),
  distDir,
  bundlePath,
  skipBuild = false,
}: ValidateLocalReleaseOptions = {}): Promise<AirJamLocalReleaseValidation> => {
  const projectDir = await resolveCanonicalPath(cwd);
  if (bundlePath) {
    return validateBundleArchive(path.resolve(projectDir, bundlePath));
  }

  const resolvedDistDir = path.resolve(projectDir, distDir || "dist");
  const packageManager = await resolvePackageManager(projectDir);
  const { validation } = await validateProjectBuildOutput({
    projectDir,
    distDir: resolvedDistDir,
    packageManager,
    skipBuild,
  });

  return validation;
};

export const bundleLocalRelease = async ({
  cwd = process.cwd(),
  distDir,
  out,
  skipBuild = false,
}: BundleLocalReleaseOptions = {}): Promise<BundleLocalReleaseResult> => {
  const projectDir = await resolveCanonicalPath(cwd);
  const resolvedDistDir = path.resolve(projectDir, distDir || "dist");
  const doctor = await inspectLocalRelease({
    cwd: projectDir,
    distDir: resolvedDistDir,
  });

  if (!doctor.canBundle) {
    const summary = doctor.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `- ${issue.message}`)
      .join("\n");
    throw new Error(`Hosted release bundle cannot be created:\n${summary}`);
  }

  const { buildResult, validation: projectValidation } =
    await validateProjectBuildOutput({
      projectDir,
      distDir: resolvedDistDir,
      packageManager: doctor.packageManager,
      skipBuild,
    });

  if (!projectValidation.ok) {
    const summary = projectValidation.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `- ${issue.message}`)
      .join("\n");
    throw new Error(`Hosted release bundle validation failed:\n${summary}`);
  }

  const outputFile = out
    ? path.resolve(projectDir, out)
    : doctor.recommendedBundlePath;

  await writeHostedReleaseBundle({
    sourceDir: resolvedDistDir,
    outputFile,
  });

  const bundleValidation = await validateBundleArchive(outputFile);
  if (!bundleValidation.ok) {
    const summary = bundleValidation.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `- ${issue.message}`)
      .join("\n");
    throw new Error(`Hosted release bundle validation failed:\n${summary}`);
  }

  return {
    projectDir,
    distDir: resolvedDistDir,
    outputFile,
    built: !skipBuild,
    buildResult,
    validation: bundleValidation,
  };
};

const uploadReleaseBundle = async ({
  bundlePath,
  upload,
}: {
  bundlePath: string;
  upload: {
    method: "PUT";
    url: string;
    headers: Record<string, string>;
  };
}) => {
  const archive = await readFile(bundlePath);
  const response = await fetch(upload.url, {
    method: upload.method,
    headers: upload.headers,
    body: archive,
  });

  if (!response.ok) {
    throw new Error(
      `Release generation upload failed with status ${response.status}.`,
    );
  }
};

export const listPlatformReleaseTargets = async ({
  platformUrl,
  token,
}: ListPlatformReleaseTargetsOptions = {}) => {
  const resolved = await resolvePlatformMachineAuth({ platformUrl, token });

  return requestPlatformMachineApi({
    baseUrl: resolved.baseUrl,
    pathname: "/api/cli/games",
    token: resolved.token,
    schema: platformMachineListOwnedGamesResultSchema,
  });
};

export const listPlatformReleases = async ({
  platformUrl,
  token,
  slugOrId,
}: ListPlatformReleasesOptions) => {
  const resolved = await resolvePlatformMachineAuth({ platformUrl, token });

  return requestPlatformMachineApi({
    baseUrl: resolved.baseUrl,
    pathname: `/api/cli/games/${encodeURIComponent(slugOrId)}/releases`,
    token: resolved.token,
    schema: platformMachineListReleasesResultSchema,
  });
};

export const inspectPlatformRelease = async ({
  platformUrl,
  token,
  releaseId,
}: InspectPlatformReleaseOptions) => {
  const resolved = await resolvePlatformMachineAuth({ platformUrl, token });

  return requestPlatformMachineApi({
    baseUrl: resolved.baseUrl,
    pathname: `/api/cli/releases/${encodeURIComponent(releaseId)}`,
    token: resolved.token,
    schema: platformMachineGetReleaseResultSchema,
  });
};

export const publishPlatformRelease = async ({
  platformUrl,
  token,
  releaseId,
}: PublishPlatformReleaseOptions) => {
  const resolved = await resolvePlatformMachineAuth({ platformUrl, token });

  return requestPlatformMachineApi({
    baseUrl: resolved.baseUrl,
    pathname: `/api/cli/releases/${encodeURIComponent(releaseId)}/publish`,
    method: "POST",
    token: resolved.token,
    schema: platformMachinePublishReleaseResultSchema,
  });
};

export const uploadPlatformReleaseGeneration = async ({
  platformUrl,
  token,
  releaseId,
  cwd = process.cwd(),
  bundlePath,
}: UploadPlatformReleaseGenerationOptions) => {
  const resolved = await resolvePlatformMachineAuth({ platformUrl, token });
  const effectiveBundlePath = path.resolve(cwd, bundlePath);
  const archive = await stat(effectiveBundlePath);
  if (!archive.isFile()) {
    throw new Error(`Release bundle is not a file: ${effectiveBundlePath}`);
  }

  const uploadTarget = await requestPlatformMachineApi({
    baseUrl: resolved.baseUrl,
    pathname: `/api/cli/releases/${encodeURIComponent(releaseId)}/upload-target`,
    method: "POST",
    token: resolved.token,
    body: {
      originalFilename: path.basename(effectiveBundlePath),
      sizeBytes: archive.size,
    },
    schema: platformMachineRequestReleaseUploadTargetResultSchema,
  });

  await uploadReleaseBundle({
    bundlePath: effectiveBundlePath,
    upload: uploadTarget.upload,
  });

  return { ...uploadTarget, bundlePath: effectiveBundlePath };
};

export const finalizePlatformReleaseGeneration = async ({
  platformUrl,
  token,
  releaseId,
  generationId,
}: FinalizePlatformReleaseGenerationOptions) => {
  const resolved = await resolvePlatformMachineAuth({ platformUrl, token });

  return requestPlatformMachineApi({
    baseUrl: resolved.baseUrl,
    pathname: `/api/cli/releases/${encodeURIComponent(releaseId)}/generations/${encodeURIComponent(generationId)}/finalize`,
    method: "POST",
    token: resolved.token,
    schema: platformMachineFinalizeReleaseUploadResultSchema,
  });
};

export const exportPlatformReleaseGeneration = async ({
  platformUrl,
  token,
  releaseId,
  generationId,
  cwd = process.cwd(),
  out,
}: ExportPlatformReleaseGenerationOptions): Promise<ExportPlatformReleaseGenerationResult> => {
  const resolved = await resolvePlatformMachineAuth({ platformUrl, token });
  const target = await requestPlatformMachineApi({
    baseUrl: resolved.baseUrl,
    pathname: `/api/cli/releases/${encodeURIComponent(releaseId)}/generations/${encodeURIComponent(generationId)}/export`,
    method: "POST",
    token: resolved.token,
    schema: platformMachineRequestReleaseGenerationExportResultSchema,
  });
  const expectedSize =
    target.generation.observedSizeBytes ?? target.generation.declaredSizeBytes;
  const outputFile = path.resolve(cwd, out ?? target.download.filename);
  await mkdir(path.dirname(outputFile), { recursive: true });
  const destination = await open(outputFile, "wx");
  let sizeBytes = 0;
  let completed = false;
  try {
    const response = await fetch(target.download.url, {
      method: target.download.method,
    });
    if (!response.ok) {
      throw new Error(
        `Release generation export failed with status ${response.status}.`,
      );
    }
    if (!response.body) {
      throw new Error("Release generation export returned no response body.");
    }

    const reader = response.body.getReader();
    let streamFinished = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          streamFinished = true;
          break;
        }
        const bytes = Buffer.from(chunk.value);
        sizeBytes += bytes.length;
        if (sizeBytes > expectedSize) {
          throw new Error(
            `Release generation export size mismatch: expected ${expectedSize} bytes, received more than ${expectedSize} bytes.`,
          );
        }
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await destination.write(
            bytes,
            offset,
            bytes.length - offset,
          );
          if (bytesWritten === 0) {
            throw new Error(
              "Release generation export could not make progress writing the archive.",
            );
          }
          offset += bytesWritten;
        }
      }
    } finally {
      if (!streamFinished) {
        await reader.cancel().catch(() => undefined);
      }
      reader.releaseLock();
    }
    if (sizeBytes !== expectedSize) {
      throw new Error(
        `Release generation export size mismatch: expected ${expectedSize} bytes, received ${sizeBytes}.`,
      );
    }
    await destination.sync();
    completed = true;
  } finally {
    await destination.close();
    if (!completed) {
      await rm(outputFile, { force: true });
    }
  }

  return {
    ...target,
    outputFile,
    sizeBytes,
  };
};

export const waitForPlatformReleaseGeneration = async ({
  platformUrl,
  token,
  releaseId,
  generationId,
  timeoutMs = DEFAULT_RELEASE_PROCESSING_TIMEOUT_MS,
  pollIntervalMs = RELEASE_PROCESSING_POLL_INTERVAL_MS,
}: FinalizePlatformReleaseGenerationOptions & {
  timeoutMs?: number;
  pollIntervalMs?: number;
}) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Release processing timeout must be a positive integer.");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error(
      "Release processing poll interval must be a positive integer.",
    );
  }

  const deadline = Date.now() + timeoutMs;
  while (true) {
    const inspected = await inspectPlatformRelease({
      platformUrl,
      token,
      releaseId,
    });
    const generation = inspected.release.generations.find(
      (candidate) => candidate.id === generationId,
    );
    if (!generation) {
      throw new Error(
        `Release ${releaseId} no longer contains generation ${generationId}.`,
      );
    }
    if (
      generation.status === "ready" &&
      (inspected.release.status === "ready" ||
        inspected.release.status === "live") &&
      inspected.release.promotedGenerationId === generationId
    ) {
      return inspected.release;
    }
    if (
      generation.status === "failed" ||
      generation.status === "abandoned" ||
      inspected.release.status === "failed" ||
      inspected.release.status === "quarantined" ||
      inspected.release.status === "archived"
    ) {
      const failedJob = inspected.release.jobs.find(
        (job) =>
          job.generationId === generationId &&
          (job.status === "failed" || job.status === "canceled"),
      );
      const errorSuffix = failedJob?.lastErrorCode
        ? ` (${failedJob.lastErrorCode})`
        : "";
      throw new Error(
        `Release generation ${generationId} ended with release ${inspected.release.status} and generation ${generation.status}${errorSuffix}. Inspect release ${releaseId} for its checks and job history.`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for release generation ${generationId}. Processing remains durable; inspect release ${releaseId} to continue.`,
      );
    }
    await wait(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
};

export const submitPlatformRelease = async ({
  platformUrl,
  token,
  slugOrId,
  versionLabel,
  cwd = process.cwd(),
  distDir,
  bundlePath,
  skipBuild = false,
  waitForProcessing = false,
  processingTimeoutMs = DEFAULT_RELEASE_PROCESSING_TIMEOUT_MS,
  processingPollIntervalMs = RELEASE_PROCESSING_POLL_INTERVAL_MS,
  publish = false,
}: SubmitPlatformReleaseOptions): Promise<SubmitPlatformReleaseResult> => {
  const resolved = await resolvePlatformMachineAuth({ platformUrl, token });
  const effectiveBundlePath = bundlePath
    ? path.resolve(cwd, bundlePath)
    : (
        await bundleLocalRelease({
          cwd,
          distDir,
          skipBuild,
        })
      ).outputFile;

  const createdDraft = await requestPlatformMachineApi({
    baseUrl: resolved.baseUrl,
    pathname: "/api/cli/releases",
    method: "POST",
    token: resolved.token,
    body: {
      slugOrId,
      ...(versionLabel?.trim() ? { versionLabel: versionLabel.trim() } : {}),
    },
    schema: platformMachineCreateReleaseDraftResultSchema,
  });

  const uploadTarget = await uploadPlatformReleaseGeneration({
    platformUrl: resolved.baseUrl,
    token: resolved.token,
    releaseId: createdDraft.release.id,
    bundlePath: effectiveBundlePath,
  });

  const submitted = await finalizePlatformReleaseGeneration({
    platformUrl: resolved.baseUrl,
    token: resolved.token,
    releaseId: createdDraft.release.id,
    generationId: uploadTarget.generation.id,
  });

  const shouldWaitForProcessing = waitForProcessing || publish;
  const processedRelease = shouldWaitForProcessing
    ? await waitForPlatformReleaseGeneration({
        platformUrl: resolved.baseUrl,
        token: resolved.token,
        releaseId: createdDraft.release.id,
        generationId: uploadTarget.generation.id,
        timeoutMs: processingTimeoutMs,
        pollIntervalMs: processingPollIntervalMs,
      })
    : null;

  let publishedRelease = null;
  if (publish) {
    if (processedRelease?.status !== "ready") {
      throw new Error(
        `Release ${createdDraft.release.id} is ${processedRelease?.status ?? submitted.release.status} and cannot be published.`,
      );
    }

    const published = await requestPlatformMachineApi({
      baseUrl: resolved.baseUrl,
      pathname: `/api/cli/releases/${encodeURIComponent(createdDraft.release.id)}/publish`,
      method: "POST",
      token: resolved.token,
      schema: platformMachinePublishReleaseResultSchema,
    });
    publishedRelease = published.release;
  }

  return {
    bundlePath: effectiveBundlePath,
    createdRelease: createdDraft.release,
    createdGeneration: uploadTarget.generation,
    submittedRelease: submitted.release,
    submittedGeneration: submitted.generation,
    processingJob: submitted.job,
    processedRelease,
    publishedRelease,
  };
};
