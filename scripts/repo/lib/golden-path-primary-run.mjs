import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stopChild } from "../../lib/process-child.mjs";
import { resolvePublicPackages } from "../../release/public-packages.mjs";
import {
  prepareGoldenPathCandidateRegistry,
  reserveDistinctLoopbackPorts,
} from "./golden-path-bootstrap.mjs";
import {
  defaultGoldenPathManifestPath,
  readGoldenPathProgram,
  validateGoldenPathProgram,
} from "./golden-path-program.mjs";
import { resolveGoldenPathRailwayStagingTarget } from "./golden-path-staging-target.mjs";
import { repoRoot } from "./paths.mjs";

const evidenceFormat = "air-jam-golden-path-evidence/v1";
const commandMaxBuffer = 64 * 1024 * 1024;
const defaultPrimaryAgentTimeoutMs = 2 * 60 * 60 * 1_000;
const runIdPattern = /^[a-z0-9][a-z0-9-]{5,47}$/u;
const initialQualityCommands = ["typecheck", "lint", "test", "build"];
const agentOwnedIndexPaths = new Set([
  "commands/index.json",
  "sessions/index.json",
  "quality/index.json",
  "visual/index.json",
  "release/index.json",
  "failures/index.json",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const writeJson = (targetPath, value) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`);
};

const writeJsonAtomic = (targetPath, value) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, targetPath);
};

const writeText = (targetPath, value) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, value);
};

const normalizeEvidenceText = (value, { runRoot, registryUrl }) =>
  String(value ?? "")
    .replaceAll(repoRoot, "<repo>")
    .replaceAll(runRoot, "<run>")
    .replaceAll(os.homedir(), "<home>")
    .replaceAll(registryUrl, "<candidate-registry>")
    .replace(/(^|\n)([^\n]*:_authToken=)[^\n]+/gu, "$1$2<redacted>")
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/giu, "$1<redacted>")
    .replace(/([?&](?:token|code|secret|key)=)[^&\s"']+/giu, "$1<redacted>");

const defaultRunId = () => {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "z")
    .toLowerCase();
  return `${timestamp}-${randomBytes(3).toString("hex")}`;
};

const assertRunId = (runId) => {
  if (!runIdPattern.test(runId)) {
    throw new Error(
      "--run-id must be 6-48 lowercase letters, digits, or hyphens and start with a letter or digit.",
    );
  }
};

const substitutePrompt = ({
  source,
  candidateVersion,
  runId,
  stagingUrl,
  evidenceDir,
}) =>
  source
    .replaceAll("{{candidateVersion}}", candidateVersion)
    .replaceAll("{{runId}}", runId)
    .replaceAll("{{stagingPlatformUrl}}", stagingUrl)
    .replaceAll("{{evidenceDir}}", evidenceDir);

const readToolVersion = (command, env) => {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    env,
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  const version = result.stdout?.trim();
  if (result.error || result.status !== 0 || !version) {
    throw new Error(
      `${command} is unavailable in the golden-path toolchain: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}.`,
    );
  }
  return version;
};

const collectToolchain = ({ codexVersion, registryUrl, env }) => ({
  capturedAt: new Date().toISOString(),
  operatingSystem: `${os.platform()} ${os.release()}`,
  architecture: os.arch(),
  node: process.version,
  corepack: readToolVersion("corepack", env),
  pnpm: readToolVersion("pnpm", env),
  git: readToolVersion("git", env),
  codex: codexVersion,
  browserAvailability: "not-attested-by-controller",
  registry: registryUrl,
  packageManagerCache: "run-scoped-empty",
});

const readGitState = (projectDir) => {
  if (!fs.existsSync(path.join(projectDir, ".git"))) return null;
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: projectDir,
    encoding: "utf8",
  });
  const status = spawnSync("git", ["status", "--porcelain=v1"], {
    cwd: projectDir,
    encoding: "utf8",
  });
  return {
    commit: commit.status === 0 ? commit.stdout.trim() : null,
    status:
      status.status === 0
        ? status.stdout.trim().split(/\r?\n/u).filter(Boolean)
        : [],
  };
};

const listEvidenceFiles = (rootDir, currentDir = rootDir) => {
  if (!fs.existsSync(currentDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listEvidenceFiles(rootDir, absolutePath));
    } else if (entry.isFile()) {
      files.push(
        path.relative(rootDir, absolutePath).replaceAll(path.sep, "/"),
      );
    }
  }
  return files.sort();
};

const indexEvidenceFiles = (evidenceDir) =>
  listEvidenceFiles(evidenceDir)
    .filter((relativePath) => relativePath !== "manifest.json")
    .map((relativePath) => {
      const absolutePath = path.join(evidenceDir, relativePath);
      const value = fs.readFileSync(absolutePath);
      return {
        path: relativePath,
        mediaType: relativePath.endsWith(".json")
          ? "application/json"
          : relativePath.endsWith(".ndjson")
            ? "application/x-ndjson"
            : relativePath.endsWith(".md")
              ? "text/markdown"
              : "application/octet-stream",
        bytes: value.byteLength,
        sha256: sha256(value),
      };
    });

export const sanitizeEvidenceTree = ({ evidenceDir, runRoot, registryUrl }) => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const relativePath of listEvidenceFiles(evidenceDir)) {
    const absolutePath = path.join(evidenceDir, relativePath);
    const bytes = fs.readFileSync(absolutePath);
    if (bytes.includes(0)) {
      throw new Error(
        `Golden-path evidence must be text; binary file found at ${relativePath}.`,
      );
    }
    let source;
    try {
      source = decoder.decode(bytes);
    } catch (error) {
      throw new Error(
        `Golden-path evidence must be valid UTF-8 text: ${relativePath}.`,
        { cause: error },
      );
    }
    const sanitized = normalizeEvidenceText(source, { runRoot, registryUrl });
    if (sanitized !== source) fs.writeFileSync(absolutePath, sanitized);
  }
};

export const replaceDirectoryAtomically = ({
  sourceDir,
  targetDir,
  rename = fs.renameSync,
}) => {
  const backupDir = `${targetDir}.previous-${process.pid}`;
  fs.rmSync(backupDir, { recursive: true, force: true });
  const hadTarget = fs.existsSync(targetDir);
  if (hadTarget) rename(targetDir, backupDir);
  try {
    rename(sourceDir, targetDir);
  } catch (error) {
    if (hadTarget && !fs.existsSync(targetDir) && fs.existsSync(backupDir)) {
      try {
        rename(backupDir, targetDir);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Failed to replace or restore retained evidence at ${targetDir}.`,
        );
      }
    }
    throw error;
  }
  fs.rmSync(backupDir, { recursive: true, force: true });
};

const detectQualityCommand = (command) => {
  const detected = [];
  for (const qualityCommand of initialQualityCommands) {
    const pattern = new RegExp(
      `(?:pnpm(?:\\s+run)?|npm\\s+run|yarn)\\s+${qualityCommand}(?:\\s|$|[;&|])`,
      "u",
    );
    if (pattern.test(command)) detected.push(qualityCommand);
  }
  return detected;
};

export const isControlCheckpointEvent = (event) => {
  if (event.type !== "item.completed") return false;
  if (event.item?.type === "command_execution" && event.item.exit_code === 0) {
    return /(?:^|\s)airjam\s+session\s+close(?:\s|$)/u.test(
      event.item.command ?? "",
    );
  }
  if (event.item?.type !== "mcp_tool_call") return false;
  const item = event.item;
  const successful =
    item.status !== "failed" &&
    item.error == null &&
    item.is_error !== true &&
    item.isError !== true &&
    item.result?.is_error !== true &&
    item.result?.isError !== true;
  return (
    successful &&
    /(?:^|[._])close_game_session$/u.test(item.tool_name ?? item.name ?? "")
  );
};

const permissionProfileName = "airjamGoldenPath";

export const startProjectScopedSessionBroker = ({
  projectDir,
  commandEnv,
  logPath,
  spawnImpl = spawn,
}) => {
  const entryPath = path.join(
    projectDir,
    "node_modules",
    "@air-jam",
    "cli",
    "dist",
    "index.js",
  );
  if (!fs.existsSync(entryPath)) return null;

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a", 0o600);
  try {
    return {
      child: spawnImpl(
        process.execPath,
        [fs.realpathSync(entryPath), "__session-broker", "--dir", projectDir],
        {
          cwd: projectDir,
          env: commandEnv,
          stdio: ["ignore", logFd, logFd],
        },
      ),
      entryPath,
      logPath,
    };
  } finally {
    fs.closeSync(logFd);
  }
};

const tomlInlineStringMap = (value) =>
  `{${Object.entries(value)
    .map(([key, entry]) => `${JSON.stringify(key)}=${JSON.stringify(entry)}`)
    .join(",")}}`;

export const buildCodexPermissionArgs = ({ stagingUrl, runRoot }) => {
  const stagingHostname = new URL(stagingUrl).hostname;
  const networkDomains = {
    "127.0.0.1": "allow",
    localhost: "allow",
    [stagingHostname]: "allow",
  };
  const filesystem = {
    [repoRoot]: "deny",
  };
  const writableRoots = [
    "evidence",
    "state",
    "tmp",
    "cache",
    "npm-cache",
    "pnpm-store",
  ].map((directory) => path.join(runRoot, directory));

  const globalArgs = [
    "--enable",
    "network_proxy",
    "--config",
    'approval_policy="never"',
    "--config",
    `default_permissions=${JSON.stringify(permissionProfileName)}`,
    "--config",
    "allow_login_shell=false",
    "--config",
    `permissions.${permissionProfileName}.extends=\":workspace\"`,
    "--config",
    `permissions.${permissionProfileName}.filesystem=${tomlInlineStringMap(filesystem)}`,
    "--config",
    `permissions.${permissionProfileName}.network.enabled=true`,
    "--config",
    `permissions.${permissionProfileName}.network.mode=\"full\"`,
    "--config",
    `permissions.${permissionProfileName}.network.allow_local_binding=true`,
    "--config",
    `permissions.${permissionProfileName}.network.domains=${tomlInlineStringMap(networkDomains)}`,
    "--config",
    `permissions.${permissionProfileName}.network.unix_sockets=${tomlInlineStringMap({ [path.join(runRoot, "tmp")]: "allow" })}`,
  ];
  const additionalDirectoryArgs = writableRoots.flatMap((root) => [
    "--add-dir",
    root,
  ]);

  return {
    args: [...globalArgs, ...additionalDirectoryArgs],
    globalArgs,
    additionalDirectoryArgs,
    profile: {
      name: permissionProfileName,
      base: ":workspace",
      loginShellAllowed: false,
      deniedReadRoots: ["<repo>"],
      writableRoots: writableRoots.map((root) =>
        normalizeEvidenceText(root, {
          runRoot,
          registryUrl: "<candidate-registry>",
        }),
      ),
      network: {
        managedProxy: true,
        mode: "full",
        allowLocalBinding: true,
        allowedDomains: Object.keys(networkDomains),
        allowedUnixSocketRoots: ["<run>/tmp"],
      },
    },
  };
};

export const buildGoldenPathCommandEnv = ({
  stagingUrl,
  runRoot,
  registryUrl,
  gamePort,
  serverPort,
  sourceEnv = process.env,
}) => {
  const safePath = [
    ...(sourceEnv.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(
      path.delimiter,
    ),
    path.dirname(process.execPath),
  ]
    .filter(
      (entry) =>
        entry &&
        (!entry.startsWith(os.homedir()) ||
          entry === path.dirname(process.execPath)) &&
        fs.existsSync(entry),
    )
    .sort((left, right) => {
      const runtimeBin = path.dirname(process.execPath);
      if (left === runtimeBin && right !== runtimeBin) return -1;
      if (right === runtimeBin && left !== runtimeBin) return 1;
      return 0;
    })
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .join(path.delimiter);

  return {
    PATH: safePath,
    HOME: os.homedir(),
    USER: sourceEnv.USER ?? os.userInfo().username,
    LOGNAME: sourceEnv.LOGNAME ?? os.userInfo().username,
    SHELL: sourceEnv.SHELL ?? "/bin/zsh",
    TMPDIR: path.join(runRoot, "tmp"),
    LANG: sourceEnv.LANG ?? "en_US.UTF-8",
    TERM: sourceEnv.TERM ?? "dumb",
    AIRJAM_PLATFORM_URL: stagingUrl,
    AIRJAM_STATE_DIR: path.join(runRoot, "state"),
    AIRJAM_DEVTOOLS_KNOWN_PORTS: `${serverPort},${gamePort}`,
    AIR_JAM_SERVER_PORT: String(serverPort),
    VITE_PORT: String(gamePort),
    VITE_AIR_JAM_PUBLIC_HOST: `http://127.0.0.1:${gamePort}`,
    CI: sourceEnv.CI ?? "1",
    NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    COREPACK_HOME: path.join(runRoot, "cache", "corepack"),
    XDG_CACHE_HOME: path.join(runRoot, "cache"),
    npm_config_audit: "false",
    npm_config_cache: path.join(runRoot, "npm-cache"),
    npm_config_registry: registryUrl,
    pnpm_config_store_dir: path.join(runRoot, "pnpm-store"),
  };
};

export const probeGoldenPathIsolation = ({
  commandEnv,
  codexPermissions,
  registryUrl,
  runRoot,
  workspaceDir,
}) => {
  const probePath = path.join(workspaceDir, ".airjam-isolation-write-probe");
  const commonArgs = [
    "sandbox",
    ...codexPermissions.globalArgs,
    "--permission-profile",
    permissionProfileName,
    "--cd",
    workspaceDir,
    "--include-managed-config",
    "--allow-unix-socket",
    path.join(runRoot, "tmp"),
  ];
  const probes = [
    {
      id: "deny-private-repository-read",
      expected: "denied",
      script: `require("node:fs").readFileSync(${JSON.stringify(path.join(repoRoot, "package.json"))})`,
    },
    {
      id: "allow-workspace-write",
      expected: "allowed",
      script: `require("node:fs").writeFileSync(${JSON.stringify(probePath)}, "probe")`,
    },
    {
      id: "deny-undeclared-network",
      expected: "denied",
      script:
        'fetch("https://example.com").then(() => process.exit(0), () => process.exit(1))',
    },
    {
      id: "allow-candidate-registry-network",
      expected: "allowed",
      script: `fetch(${JSON.stringify(`${registryUrl}/-/ping`)}).then(() => process.exit(0), () => process.exit(1))`,
    },
  ];
  const records = probes.map((probe) => {
    const result = spawnSync(
      "codex",
      [...commonArgs, "--", process.execPath, "-e", probe.script],
      {
        cwd: workspaceDir,
        encoding: "utf8",
        env: commandEnv,
        maxBuffer: commandMaxBuffer,
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const allowed = !result.error && result.status === 0;
    return {
      id: probe.id,
      expected: probe.expected,
      observed: allowed ? "allowed" : "denied",
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdout: normalizeEvidenceText(result.stdout, { runRoot, registryUrl }),
      stderr: normalizeEvidenceText(result.stderr, { runRoot, registryUrl }),
    };
  });
  fs.rmSync(probePath, { force: true });
  const mismatches = records.filter(
    (record) => record.expected !== record.observed,
  );
  return {
    verified: mismatches.length === 0,
    records,
    mismatches: mismatches.map(({ id, expected, observed }) => ({
      id,
      expected,
      observed,
    })),
  };
};

const injectDeclaredFault = ({
  projectDir,
  evidenceDir,
  runRoot,
  registryUrl,
}) => {
  const rulesPath = path.join(projectDir, "src", "game", "domain", "rules.ts");
  if (!fs.existsSync(rulesPath)) return null;
  const before = fs.readFileSync(rulesPath, "utf8");
  const match = before.match(/export const WIN_SCORE\s*=\s*3\s*;/u);
  if (!match) return null;
  const after = before.replace(match[0], "export const WIN_SCORE = 2;");
  fs.writeFileSync(rulesPath, after);
  const record = {
    id: "declared-win-score-fault",
    classification: "harness",
    injectedAt: new Date().toISOString(),
    target:
      "<run>/workspace/" +
      path.basename(projectDir) +
      "/src/game/domain/rules.ts",
    beforeSha256: sha256(
      normalizeEvidenceText(before, { runRoot, registryUrl }),
    ),
    afterSha256: sha256(normalizeEvidenceText(after, { runRoot, registryUrl })),
    mutation: "WIN_SCORE:3->2",
  };
  writeJson(
    path.join(evidenceDir, "failures", "declared-win-score-fault.json"),
    record,
  );
  return record;
};

const readAgentEvidenceIndex = ({ evidenceDir, relativePath, runId }) => {
  const absolutePath = path.join(evidenceDir, relativePath);
  if (!fs.existsSync(absolutePath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      value.contract !== evidenceFormat ||
      value.runId !== runId ||
      !Array.isArray(value.records)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
};

const readBlockedTerminalRecord = ({ evidenceDir, runId }) => {
  const index = readAgentEvidenceIndex({
    evidenceDir,
    relativePath: "failures/index.json",
    runId,
  });
  return (
    index?.records.find(
      (entry) =>
        entry?.result === "blocked" &&
        typeof entry.firstFailingStage === "string" &&
        typeof entry.responsibleSurface === "string" &&
        typeof entry.observation === "string" &&
        typeof entry.expected === "string" &&
        ["product", "client", "environment", "harness", "external"].includes(
          entry.classification,
        ) &&
        Array.isArray(entry.stagesNotAttempted) &&
        entry.stagesNotAttempted.length > 0,
    ) ?? null
  );
};

export const verifyPrimaryRun = ({
  program,
  evidenceDir,
  projectDir,
  runId,
  fault,
  codexExitCode,
  controllerQuality,
  projectCleanup = [],
  releaseVerification = null,
  runRoot,
  registryUrl,
}) => {
  const failures = [];
  const notEvaluated = [];
  for (const relativePath of program.evidenceBundle.requiredPaths) {
    if (
      relativePath === "manifest.json" ||
      relativePath === "verifier/report.json"
    ) {
      continue;
    }
    if (!fs.existsSync(path.join(evidenceDir, relativePath))) {
      failures.push({ code: "missing_evidence", path: relativePath });
    } else if (
      agentOwnedIndexPaths.has(relativePath) &&
      !readAgentEvidenceIndex({ evidenceDir, relativePath, runId })
    ) {
      failures.push({ code: "invalid_evidence_index", path: relativePath });
    }
  }
  if (codexExitCode !== 0)
    failures.push({ code: "primary_agent_failed", exitCode: codexExitCode });

  const blockedRecord = readBlockedTerminalRecord({ evidenceDir, runId });
  const evidenceIntegrityFailed = failures.some((failure) =>
    [
      "missing_evidence",
      "invalid_evidence_index",
      "primary_agent_failed",
    ].includes(failure.code),
  );
  if (blockedRecord && !evidenceIntegrityFailed) {
    notEvaluated.push(
      ...blockedRecord.stagesNotAttempted.map((stage) => ({
        code: "stage_not_evaluated",
        stage,
        path: "failures/index.json",
      })),
    );
    return {
      contract: evidenceFormat,
      scope: "codex-primary",
      verifiedAt: new Date().toISOString(),
      result: "blocked",
      failures: [
        {
          code: "agent_reported_blocker",
          stage: blockedRecord.firstFailingStage,
          surface: blockedRecord.responsibleSurface,
          classification: blockedRecord.classification,
          observation: blockedRecord.observation,
          expected: blockedRecord.expected,
          path: "failures/index.json",
        },
      ],
      notEvaluated,
      note: "This verifier certifies a complete retained Codex primary attempt that stopped at a classified blocker. Claude Desktop remains independently owned by G2-04.",
    };
  }

  if (!fs.existsSync(projectDir)) {
    failures.push({ code: "missing_project", path: "workspace" });
  }
  const rulesPath = path.join(projectDir, "src", "game", "domain", "rules.ts");
  const rulesSource = fs.existsSync(rulesPath)
    ? fs.readFileSync(rulesPath, "utf8")
    : "";
  if (!/export const WIN_SCORE\s*=\s*3\s*;/u.test(rulesSource)) {
    failures.push({
      code: "win_score_not_repaired",
      path: "src/game/domain/rules.ts",
    });
  }

  if (!fault)
    failures.push({
      code: "declared_fault_not_injected",
      path: "failures/index.json",
    });
  for (const qualityCommand of initialQualityCommands) {
    if (!controllerQuality.has(qualityCommand)) {
      failures.push({
        code: "controller_quality_failed",
        command: qualityCommand,
        path: "commands/controller.json",
      });
    }
  }
  for (const cleanup of projectCleanup) {
    if (!cleanup.ok) {
      failures.push({
        code: "project_cleanup_failed",
        command: cleanup.id,
        path: "commands/controller.json",
      });
    }
  }

  if (
    releaseVerification?.status !== "ready" ||
    releaseVerification?.arcadeVisibility !== "hidden" ||
    releaseVerification?.productionAllowed !== false
  )
    failures.push({
      code: "hidden_release_not_controller_verified",
      path: "release/index.json",
    });

  const invalidFailureCodes = new Set([
    "missing_evidence",
    "invalid_evidence_index",
  ]);
  const result = failures.some((failure) =>
    invalidFailureCodes.has(failure.code),
  )
    ? "invalid"
    : failures.length === 0
      ? "passed"
      : "failed";

  return {
    contract: evidenceFormat,
    scope: "codex-primary",
    verifiedAt: new Date().toISOString(),
    result,
    failures,
    notEvaluated,
    note: "This verifier certifies only the Codex primary lane. Claude Desktop remains independently owned by G2-04.",
  };
};

export const runGoldenPathPrimary = async ({
  runId = defaultRunId(),
  railwayProjectId,
  railwayEnvironmentId,
  keepWorkspace = true,
  model,
  primaryAgentTimeoutMs = defaultPrimaryAgentTimeoutMs,
  onProgress = () => {},
} = {}) => {
  assertRunId(runId);
  if (!Number.isInteger(primaryAgentTimeoutMs) || primaryAgentTimeoutMs <= 0) {
    throw new Error("Primary-agent timeout must be a positive integer.");
  }
  onProgress("staging:attest");
  const stagingTarget = await resolveGoldenPathRailwayStagingTarget({
    projectId: railwayProjectId,
    environmentId: railwayEnvironmentId,
  });
  const normalizedStagingUrl = stagingTarget.url;
  const programState = readGoldenPathProgram(defaultGoldenPathManifestPath);
  validateGoldenPathProgram(programState);

  const artifactRoot = path.join(
    repoRoot,
    ".airjam",
    "golden-path-runs",
    runId,
  );
  if (fs.existsSync(artifactRoot))
    throw new Error(`Golden-path run already exists: ${runId}`);
  const runRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `airjam-golden-path-${runId}-`)),
  );
  const workspaceDir = path.join(runRoot, "workspace");
  const projectName = `signal-relay-${runId}`;
  const projectDir = path.join(workspaceDir, projectName);
  const evidenceDir = path.join(runRoot, "evidence");
  const retainedEvidenceDir = path.join(artifactRoot, "evidence");
  const workspaceRelativeToRepo = path.relative(repoRoot, workspaceDir);
  const workspaceOutsideRepo =
    workspaceRelativeToRepo.startsWith("..") &&
    !path.isAbsolute(workspaceRelativeToRepo);
  if (!workspaceOutsideRepo) {
    throw new Error(
      "The golden-path workspace must be outside the Air Jam monorepo.",
    );
  }
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(retainedEvidenceDir, { recursive: true });
  for (const directory of [
    "state",
    "tmp",
    "cache",
    "npm-cache",
    "pnpm-store",
  ]) {
    fs.mkdirSync(path.join(runRoot, directory), { recursive: true });
  }

  const syncEvidence = () => {
    if (!fs.existsSync(evidenceDir)) return;
    const snapshotDir = path.join(
      artifactRoot,
      `.evidence-snapshot-${process.pid}`,
    );
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    fs.cpSync(evidenceDir, snapshotDir, {
      recursive: true,
      force: true,
    });
    sanitizeEvidenceTree({
      evidenceDir: snapshotDir,
      runRoot,
      registryUrl,
    });
    replaceDirectoryAtomically({
      sourceDir: snapshotDir,
      targetDir: retainedEvidenceDir,
    });
  };
  const bestEffortSyncEvidence = () => {
    try {
      syncEvidence();
    } catch {
      // A concurrent agent write can make an interruption snapshot transiently
      // unreadable. Explicit lifecycle checkpoints remain strict.
    }
  };
  const writeDurableControllerState = (state, details = {}) => {
    writeJsonAtomic(path.join(artifactRoot, "controller.json"), {
      contract: evidenceFormat,
      runId,
      state,
      updatedAt: new Date().toISOString(),
      ...details,
    });
  };
  writeDurableControllerState("preparing");

  const [registryPort, serverPort, gamePort] =
    await reserveDistinctLoopbackPorts(3);
  const registryUrl = `http://127.0.0.1:${registryPort}`;
  const commandEnv = buildGoldenPathCommandEnv({
    stagingUrl: normalizedStagingUrl,
    runRoot,
    registryUrl,
    gamePort,
    serverPort,
  });
  const startedAt = new Date().toISOString();
  const controllerCommands = [];
  const runControllerCommand = (
    id,
    command,
    args,
    cwd = repoRoot,
    { throwOnFailure = true } = {},
  ) => {
    onProgress(id);
    const startedAt = new Date();
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      env: commandEnv,
      maxBuffer: commandMaxBuffer,
      timeout: 10 * 60 * 1_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = normalizeEvidenceText(result.stdout, {
      runRoot,
      registryUrl,
    });
    const stderr = normalizeEvidenceText(result.stderr, {
      runRoot,
      registryUrl,
    });
    const record = {
      id,
      actor: "run-controller",
      executable: command,
      arguments: args,
      workingDirectory: normalizeEvidenceText(cwd, { runRoot, registryUrl }),
      environmentNames: Object.keys(commandEnv).filter((name) =>
        /^(?:AIRJAM|CI$|NO_|FORCE_COLOR|npm_config_)/u.test(name),
      ),
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr),
    };
    controllerCommands.push(record);
    if (throwOnFailure && (result.error || result.status !== 0)) {
      throw new Error(
        `${id} failed${
          result.error
            ? ` to execute: ${result.error.message}`
            : ` with exit code ${result.status}`
        }.\n${stdout}\n${stderr}`,
      );
    }
    const outcome = {
      ok: !result.error && result.status === 0,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
    return throwOnFailure ? outcome.stdout : outcome;
  };

  let registry;
  let codexChild;
  let controllerSessionBroker;
  let controllerSessionBrokerLaunch;
  let fault = null;
  let codexExitCode = null;
  let interruptedSignal = null;
  let registryRemoved = false;
  let credentialsRemoved = false;
  let packagesRemoved = false;
  const projectCleanup = [];
  const signalCodexProcessGroup = (signal) => {
    if (!codexChild || codexChild.exitCode !== null) return;
    try {
      process.kill(-codexChild.pid, signal);
    } catch {
      codexChild.kill(signal);
    }
  };
  const handleSignal = (signal) => {
    interruptedSignal = signal;
    writeDurableControllerState("interrupted", { signal });
    bestEffortSyncEvidence();
    signalCodexProcessGroup("SIGTERM");
  };
  const handleSigint = () => handleSignal("SIGINT");
  const handleSigterm = () => handleSignal("SIGTERM");
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
  const completedInitialQuality = new Set();
  const controllerQuality = new Set();
  let completedInitialControl = false;
  let checkpointObservationRevision = 0;
  let lastValidatedCheckpointRevision = 0;
  const transcriptPath = path.join(evidenceDir, "transcript", "events.ndjson");
  writeText(transcriptPath, "");
  syncEvidence();

  try {
    const prepared = await prepareGoldenPathCandidateRegistry({
      runRoot,
      port: registryPort,
      commandEnv,
      run: runControllerCommand,
      onProgress,
    });
    registry = prepared.registry;

    const promptTemplate = fs.readFileSync(
      path.join(repoRoot, programState.promptTemplate),
      "utf8",
    );
    const agentPrompt = substitutePrompt({
      source: promptTemplate,
      candidateVersion: prepared.version,
      runId,
      stagingUrl: normalizedStagingUrl,
      evidenceDir,
    });
    writeText(
      path.join(evidenceDir, "inputs", "prompt.md"),
      normalizeEvidenceText(agentPrompt, { runRoot, registryUrl }),
    );
    writeJson(path.join(evidenceDir, "inputs", "scenario.json"), programState);
    const codexVersionResult = spawnSync("codex", ["--version"], {
      encoding: "utf8",
      env: commandEnv,
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    if (codexVersionResult.error || codexVersionResult.status !== 0) {
      throw new Error(
        `Codex CLI is unavailable in the isolated toolchain: ${codexVersionResult.error?.message ?? codexVersionResult.stderr?.trim() ?? `exit ${codexVersionResult.status}`}.`,
      );
    }
    const codexVersion = codexVersionResult.stdout?.trim();
    if (!codexVersion) {
      throw new Error(
        "Codex CLI returned no version in the isolated toolchain.",
      );
    }
    const codexPermissions = buildCodexPermissionArgs({
      stagingUrl: normalizedStagingUrl,
      runRoot,
    });
    const isolationProbe = probeGoldenPathIsolation({
      commandEnv,
      codexPermissions,
      registryUrl,
      runRoot,
      workspaceDir,
    });
    writeJson(
      path.join(evidenceDir, "environment", "toolchain.json"),
      collectToolchain({
        codexVersion,
        registryUrl: "<candidate-registry>",
        env: commandEnv,
      }),
    );
    writeJson(path.join(evidenceDir, "environment", "isolation.json"), {
      runId,
      workspace: "<run>/workspace",
      evidenceDirectory: "<run>/evidence",
      stateDirectory: "<run>/state",
      temporaryDirectory: "<run>/tmp",
      candidateRegistry: "<candidate-registry>",
      airJamUpstreamFallback: false,
      stagingPlatform: normalizedStagingUrl,
      stagingProvider: stagingTarget,
      requestedProductionAllowed: false,
      requestedArcadeVisibility: "hidden",
      platformReleaseVerification: null,
      privateRepositoryContextProvided: false,
      workspaceOutsideAirJamMonorepo: workspaceOutsideRepo,
      inheritedCredentialEnvironment: false,
      childAirJamRepositoryReadAccess:
        isolationProbe.records.find(
          (record) => record.id === "deny-private-repository-read",
        )?.observed === "allowed",
      workspaceWriteAccess:
        isolationProbe.records.find(
          (record) => record.id === "allow-workspace-write",
        )?.observed === "allowed",
      networkAllowlist: codexPermissions.profile.network.allowedDomains,
      candidateRegistryNetworkAccess:
        isolationProbe.records.find(
          (record) => record.id === "allow-candidate-registry-network",
        )?.observed === "allowed",
      undeclaredNetworkAccess:
        isolationProbe.records.find(
          (record) => record.id === "deny-undeclared-network",
        )?.observed === "allowed",
      verified: isolationProbe.verified,
      maintainerEditsAfterStart: ["declared-win-score-fault-only"],
    });
    writeJson(
      path.join(evidenceDir, "environment", "isolation-probe.json"),
      isolationProbe,
    );
    writeJson(path.join(evidenceDir, "project", "git", "initial.json"), {
      capturedAt: new Date().toISOString(),
      state: "empty-workspace-before-primary-agent",
    });

    writeJson(
      path.join(evidenceDir, "environment", "codex-permissions.json"),
      codexPermissions.profile,
    );
    syncEvidence();
    if (!isolationProbe.verified) {
      throw new Error(
        `Golden-path isolation preflight failed: ${JSON.stringify(isolationProbe.mismatches)}`,
      );
    }

    const codexArgs = [
      "--strict-config",
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      ...codexPermissions.args,
      "--cd",
      workspaceDir,
      "--json",
      ...(model ? ["--model", model] : []),
      agentPrompt,
    ];
    onProgress("primary-agent:start");
    writeDurableControllerState("primary-agent-running");
    codexChild = spawn("codex", codexArgs, {
      cwd: workspaceDir,
      detached: true,
      env: commandEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let primaryAgentTimedOut = false;
    let forceKillTimer = null;
    const primaryAgentTimer = setTimeout(() => {
      primaryAgentTimedOut = true;
      signalCodexProcessGroup("SIGTERM");
      forceKillTimer = setTimeout(
        () => signalCodexProcessGroup("SIGKILL"),
        5_000,
      );
    }, primaryAgentTimeoutMs);
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const appendTranscript = (entry) => {
      const record = `${JSON.stringify(entry)}\n`;
      fs.appendFileSync(transcriptPath, record);
      const retainedTranscriptPath = path.join(
        retainedEvidenceDir,
        "transcript",
        "events.ndjson",
      );
      fs.mkdirSync(path.dirname(retainedTranscriptPath), { recursive: true });
      fs.appendFileSync(retainedTranscriptPath, record);
    };
    const ensureControllerSessionBroker = () => {
      if (controllerSessionBrokerLaunch) return;
      const launched = startProjectScopedSessionBroker({
        projectDir,
        commandEnv,
        logPath: path.join(
          evidenceDir,
          "environment",
          "controller-session-broker.log",
        ),
      });
      if (!launched) return;

      controllerSessionBrokerLaunch = launched;
      controllerSessionBroker = launched.child;
      const record = {
        owner: "run-controller",
        scope: "isolated-project-only",
        projectDir: "<run>/workspace/project",
        entrypoint: "installed-@air-jam/cli",
        pid: launched.child.pid,
        startedAt: new Date().toISOString(),
        logPath: "environment/controller-session-broker.log",
      };
      writeJson(
        path.join(evidenceDir, "environment", "session-broker.json"),
        record,
      );
      onProgress("session-broker:controller-owned");
      bestEffortSyncEvidence();
    };
    const processLine = (line) => {
      if (!line.trim()) return;
      const normalized = normalizeEvidenceText(line, { runRoot, registryUrl });
      let event;
      try {
        event = JSON.parse(normalized);
      } catch {
        appendTranscript({ type: "primary-agent.stdout", text: normalized });
        return;
      }
      appendTranscript(event);
      // Chromium cannot bootstrap from inside Codex's macOS Seatbelt profile.
      // Start the existing project-scoped broker from the run controller as
      // soon as the installed candidate CLI exists. The agent still owns all
      // session operations through the public CLI/MCP contract, while the
      // broker remains pinned to this isolated project directory.
      ensureControllerSessionBroker();
      if (
        event.type === "item.completed" &&
        event.item?.type === "command_execution" &&
        event.item.exit_code === 0
      ) {
        const qualityCommands = detectQualityCommand(event.item.command ?? "");
        for (const id of qualityCommands) {
          if (!fault) {
            completedInitialQuality.add(id);
            checkpointObservationRevision += 1;
          }
        }
      }
      if (!fault && isControlCheckpointEvent(event)) {
        completedInitialControl = true;
        checkpointObservationRevision += 1;
      }
      if (
        !fault &&
        completedInitialControl &&
        initialQualityCommands.every((id) => completedInitialQuality.has(id)) &&
        checkpointObservationRevision > lastValidatedCheckpointRevision
      ) {
        lastValidatedCheckpointRevision = checkpointObservationRevision;
        signalCodexProcessGroup("SIGSTOP");
        try {
          const initialControllerQuality = new Set();
          for (const qualityCommand of initialQualityCommands) {
            const result = runControllerCommand(
              `checkpoint:quality:${qualityCommand}`,
              "pnpm",
              ["run", qualityCommand],
              projectDir,
              { throwOnFailure: false },
            );
            if (result.ok) initialControllerQuality.add(qualityCommand);
          }
          if (
            initialQualityCommands.every((id) =>
              initialControllerQuality.has(id),
            )
          ) {
            fault = injectDeclaredFault({
              projectDir,
              evidenceDir,
              runRoot,
              registryUrl,
            });
            if (fault) {
              onProgress("controller:fault-injected");
              syncEvidence();
              appendTranscript({
                type: "controller.fault-injected",
                faultId: fault.id,
                timestamp: fault.injectedAt,
              });
            }
          }
        } finally {
          signalCodexProcessGroup("SIGCONT");
        }
      }
    };
    codexChild.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      while (stdoutBuffer.includes("\n")) {
        const newline = stdoutBuffer.indexOf("\n");
        processLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
      }
    });
    codexChild.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
      while (stderrBuffer.includes("\n")) {
        const newline = stderrBuffer.indexOf("\n");
        const line = stderrBuffer.slice(0, newline);
        stderrBuffer = stderrBuffer.slice(newline + 1);
        if (line.trim()) {
          appendTranscript({
            type: "primary-agent.stderr",
            text: normalizeEvidenceText(line, { runRoot, registryUrl }),
          });
        }
      }
    });
    codexExitCode = await new Promise((resolve, reject) => {
      codexChild.once("error", reject);
      codexChild.once("exit", (code) => resolve(code ?? 1));
    }).finally(() => {
      clearTimeout(primaryAgentTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    });
    if (primaryAgentTimedOut) {
      throw new Error(
        `Primary Codex agent exceeded its ${primaryAgentTimeoutMs}ms wall-clock limit.`,
      );
    }
    if (stdoutBuffer.trim()) processLine(stdoutBuffer);
    if (stderrBuffer.trim()) {
      appendTranscript({
        type: "primary-agent.stderr",
        text: normalizeEvidenceText(stderrBuffer, { runRoot, registryUrl }),
      });
    }
    onProgress(`primary-agent:exit:${codexExitCode}`);
    if (interruptedSignal) {
      fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: "controller.interrupted",
          signal: interruptedSignal,
          timestamp: new Date().toISOString(),
        })}\n`,
      );
    }

    if (fault && codexExitCode === 0) {
      for (const qualityCommand of initialQualityCommands) {
        const result = runControllerCommand(
          `verify:quality:${qualityCommand}`,
          "pnpm",
          ["run", qualityCommand],
          projectDir,
          { throwOnFailure: false },
        );
        if (result.ok) controllerQuality.add(qualityCommand);
      }
    }

    if (fs.existsSync(projectDir)) {
      for (const [id, args] of [
        [
          "cleanup:session-broker",
          ["exec", "airjam", "session", "broker", "stop", "--dir", "."],
        ],
        [
          "cleanup:dev-processes",
          ["exec", "airjam", "dev", "stop", "--dir", "."],
        ],
      ]) {
        const result = runControllerCommand(id, "pnpm", args, projectDir, {
          throwOnFailure: false,
        });
        projectCleanup.push({ id, ok: result.ok });
      }
    }

    if (registry) {
      await stopChild(registry.child);
      registry = null;
    }
    fs.rmSync(path.join(runRoot, "registry"), { recursive: true, force: true });
    registryRemoved = !fs.existsSync(path.join(runRoot, "registry"));
    fs.rmSync(path.join(runRoot, "state"), { recursive: true, force: true });
    credentialsRemoved = !fs.existsSync(path.join(runRoot, "state"));
    fs.rmSync(path.join(runRoot, "packages"), { recursive: true, force: true });
    packagesRemoved = !fs.existsSync(path.join(runRoot, "packages"));

    writeJson(path.join(evidenceDir, "commands", "controller.json"), {
      records: controllerCommands,
    });
    writeJson(path.join(evidenceDir, "project", "git", "final.json"), {
      capturedAt: new Date().toISOString(),
      project: projectName,
      git: readGitState(projectDir),
    });
    const report = verifyPrimaryRun({
      program: programState,
      evidenceDir,
      projectDir,
      runId,
      fault,
      codexExitCode,
      controllerQuality,
      projectCleanup,
      releaseVerification: null,
      runRoot,
      registryUrl,
    });
    writeJson(path.join(evidenceDir, "verifier", "report.json"), report);
    sanitizeEvidenceTree({ evidenceDir, runRoot, registryUrl });
    const manifest = {
      format: evidenceFormat,
      runId,
      scenarioId: programState.id,
      candidateVersions: Object.fromEntries(
        resolvePublicPackages().map((entry) => [
          entry.packageName,
          entry.version,
        ]),
      ),
      clients: { primary: { profile: "codex", version: codexVersion } },
      staging: {
        ...stagingTarget,
        requestedProductionAllowed: false,
        requestedArcadeVisibility: "hidden",
        verification: null,
      },
      startedAt,
      endedAt: new Date().toISOString(),
      terminalResult: report.result,
      primaryAgentExitCode: codexExitCode,
      declaredFault: fault,
      projectGit: readGitState(projectDir),
      cleanup: {
        registry: registryRemoved ? "removed" : "not-removed",
        credentials: credentialsRemoved ? "removed" : "not-removed",
        packages: packagesRemoved ? "removed" : "not-removed",
        projectProcesses: projectCleanup,
        workspace: keepWorkspace ? "retained" : "scheduled-for-removal",
        evidence: "retained",
      },
      files: indexEvidenceFiles(evidenceDir),
    };
    writeJson(path.join(evidenceDir, "manifest.json"), manifest);
    syncEvidence();
    writeDurableControllerState("complete", {
      terminalResult: report.result,
      primaryAgentExitCode: codexExitCode,
    });
    return {
      ok: report.result === "passed",
      contract: evidenceFormat,
      runId,
      result: report.result,
      failures: report.failures,
      evidenceDirectory: retainedEvidenceDir,
      workspace: keepWorkspace ? workspaceDir : null,
      primaryAgentExitCode: codexExitCode,
      declaredFaultInjected: Boolean(fault),
    };
  } catch (error) {
    bestEffortSyncEvidence();
    writeDurableControllerState(interruptedSignal ? "interrupted" : "failed", {
      ...(interruptedSignal ? { signal: interruptedSignal } : {}),
      error: normalizeEvidenceText(
        error instanceof Error ? error.message : String(error),
        { runRoot, registryUrl },
      ),
    });
    throw error;
  } finally {
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
    if (codexChild && codexChild.exitCode === null) {
      await stopChild(codexChild, { processGroup: true });
    }
    if (controllerSessionBroker && controllerSessionBroker.exitCode === null) {
      await stopChild(controllerSessionBroker);
    }
    if (registry) await stopChild(registry.child);
    if (fs.existsSync(evidenceDir)) {
      bestEffortSyncEvidence();
    }
    fs.rmSync(path.join(runRoot, "registry"), { recursive: true, force: true });
    fs.rmSync(path.join(runRoot, "state"), { recursive: true, force: true });
    fs.rmSync(path.join(runRoot, "packages"), { recursive: true, force: true });
    fs.rmSync(evidenceDir, { recursive: true, force: true });
    if (!keepWorkspace) {
      fs.rmSync(runRoot, { recursive: true, force: true });
    }
  }
};
