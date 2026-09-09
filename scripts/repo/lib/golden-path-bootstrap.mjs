import crossSpawn from "cross-spawn";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { standaloneGameMcpToolNames } from "../../lib/airjam-mcp-tool-contract.mjs";
import { verifyMcpStdioHandshake } from "../../lib/mcp-stdio-handshake.mjs";
import { stopChild } from "../../lib/process-child.mjs";
import {
  resolvePublicPackages,
  resolveUnifiedPublicVersion,
} from "../../release/public-packages.mjs";
import { repoRoot } from "./paths.mjs";
import { validatePublicReleaseCandidate } from "./public-release-candidate.mjs";

const require = createRequire(import.meta.url);
const commandMaxBuffer = 64 * 1024 * 1024;
const commandTimeoutMs = 10 * 60 * 1_000;
const candidateRegistryWarmAttempts = 2;
const rootPackageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const candidatePackageNames = new Set(
  resolvePublicPackages().map((entry) => entry.packageName),
);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sha512Integrity = (value) =>
  `sha512-${createHash("sha512").update(value).digest("base64")}`;

const normalizeOutput = (value, runRoot) =>
  String(value ?? "")
    .replaceAll(repoRoot, "<repo>")
    .replaceAll(runRoot, "<run>");

const parseCommandJson = (id, output) => {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${id} did not return one valid JSON document.`, {
      cause: error,
    });
  }
};

export const reserveLoopbackPort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a loopback registry port."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });

export const reserveDistinctLoopbackPorts = async (count) => {
  const ports = new Set();
  while (ports.size < count) {
    ports.add(await reserveLoopbackPort());
  }
  return [...ports];
};

export const resolveGoldenPathTemporaryRoot = ({
  environment = process.env,
  systemTemporaryRoot = os.tmpdir(),
} = {}) => {
  const configuredRoot =
    environment.AIRJAM_GOLDEN_PATH_TEMP_ROOT?.trim() ||
    environment.RUNNER_TEMP?.trim() ||
    systemTemporaryRoot;
  fs.mkdirSync(configuredRoot, { recursive: true });
  return fs.realpathSync.native(configuredRoot);
};

const waitForRegistry = async ({ registryUrl, child, readOutput }) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (child.exitCode !== null) {
      throw new Error(
        `Candidate registry exited before becoming healthy.\n${readOutput()}`,
      );
    }
    try {
      const response = await fetch(`${registryUrl}/-/ping`);
      if (response.ok) return;
    } catch {
      // Registry startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for candidate registry.\n${readOutput()}`);
};

const startCandidateRegistry = async ({ runRoot, port }) => {
  const registryDir = path.join(runRoot, "registry");
  fs.mkdirSync(registryDir, { recursive: true });
  const configPath = path.join(registryDir, "config.yaml");
  fs.writeFileSync(
    configPath,
    [
      "storage: ./storage",
      "max_body_size: 120mb",
      "auth:",
      "  htpasswd:",
      "    file: ./htpasswd",
      "uplinks:",
      "  npmjs:",
      "    url: https://registry.npmjs.org/",
      "packages:",
      "  '@air-jam/*':",
      "    access: $all",
      "    publish: $authenticated",
      "  'create-airjam':",
      "    access: $all",
      "    publish: $authenticated",
      "  '**':",
      "    access: $all",
      "    proxy: npmjs",
      "log: { type: stdout, format: pretty, level: warn }",
      "publish:",
      "  allow_offline: false",
      "",
    ].join("\n"),
  );

  const verdaccioPackagePath = require.resolve("verdaccio/package.json");
  const verdaccioPackage = JSON.parse(
    fs.readFileSync(verdaccioPackagePath, "utf8"),
  );
  const binRelative =
    typeof verdaccioPackage.bin === "string"
      ? verdaccioPackage.bin
      : verdaccioPackage.bin?.verdaccio;
  if (!binRelative) {
    throw new Error("The installed Verdaccio package exposes no CLI binary.");
  }
  const binPath = path.resolve(path.dirname(verdaccioPackagePath), binRelative);
  const output = [];
  const child = spawn(
    process.execPath,
    [binPath, "--config", configPath, "--listen", `127.0.0.1:${port}`],
    {
      cwd: registryDir,
      env: {
        ...process.env,
        NO_UPDATE_NOTIFIER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const registryUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForRegistry({
      registryUrl,
      child,
      readOutput: () => output.join("").slice(-8_000),
    });
    return { child, registryUrl };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
};

const configureRunScopedRegistryAuth = async ({
  registryUrl,
  runRoot,
  commandEnv,
}) => {
  const username = "airjam-golden-path";
  const password = randomBytes(24).toString("base64url");
  const response = await fetch(
    `${registryUrl}/-/user/org.couchdb.user:${username}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: username,
        password,
        email: "golden-path@invalid.local",
        type: "user",
        roles: [],
        date: new Date().toISOString(),
      }),
    },
  );
  const result = await response.json();
  if (!response.ok || typeof result.token !== "string") {
    throw new Error(
      `Candidate registry user bootstrap failed with HTTP ${response.status}.`,
    );
  }
  const npmrcPath = path.join(runRoot, "registry", "client.npmrc");
  const registryKey = registryUrl.replace(/^https?:/u, "");
  fs.writeFileSync(
    npmrcPath,
    [
      `registry=${registryUrl}/`,
      `@air-jam:registry=${registryUrl}/`,
      `${registryKey}/:_authToken=${result.token}`,
      "",
    ].join("\n"),
  );
  commandEnv.npm_config_userconfig = npmrcPath;
};

const findPackedTarball = ({ output, packageDir }) => {
  const candidate = output
    .trim()
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  if (!candidate) {
    throw new Error(`Package at ${packageDir} produced no tarball path.`);
  }
  return path.resolve(packageDir, candidate);
};

const packageLockKeyMatches = ({ key, packageName, version }) => {
  const unquotedKey = String(key).replace(/^\//u, "");
  const expected = `${packageName}@${version}`;
  return unquotedKey === expected || unquotedKey.startsWith(`${expected}(`);
};

const importerVersion = (entry) => {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry.version === "string") return entry.version;
  return null;
};

export const assertInstalledCandidateIntegrity = ({
  lockSource,
  packageArtifacts,
}) => {
  const lockfile = parseYaml(lockSource);
  const importer = lockfile?.importers?.["."];
  const packages = lockfile?.packages;
  if (!importer || !packages || typeof packages !== "object") {
    throw new Error(
      "Generated pnpm lockfile has no importer/package provenance.",
    );
  }

  for (const artifact of packageArtifacts) {
    if (artifact.name === "create-airjam") continue;
    const dependency =
      importer.dependencies?.[artifact.name] ??
      importer.devDependencies?.[artifact.name] ??
      importer.optionalDependencies?.[artifact.name];
    const resolvedVersion = importerVersion(dependency)?.split("(", 1)[0];
    if (resolvedVersion !== artifact.version) {
      throw new Error(
        `Generated lockfile resolved ${artifact.name} as ${resolvedVersion ?? "missing"}; expected ${artifact.version}.`,
      );
    }

    const matchingEntries = Object.entries(packages).filter(([key]) =>
      packageLockKeyMatches({
        key,
        packageName: artifact.name,
        version: artifact.version,
      }),
    );
    if (matchingEntries.length === 0) {
      throw new Error(
        `Generated lockfile has no package entry for ${artifact.name}@${artifact.version}.`,
      );
    }
    const integrities = new Set(
      matchingEntries
        .map(([, value]) => value?.resolution?.integrity)
        .filter((value) => typeof value === "string"),
    );
    if (integrities.size !== 1 || !integrities.has(artifact.integrity)) {
      throw new Error(
        `Generated lockfile integrity for ${artifact.name}@${artifact.version} does not match the packed candidate.`,
      );
    }
  }
};

const assertRegistryCandidateIntegrity = async ({
  registryUrl,
  packageArtifacts,
}) => {
  for (const artifact of packageArtifacts) {
    const encodedName = artifact.name.replace("/", "%2f");
    const startedAt = Date.now();
    let metadata;
    let lastError;
    while (Date.now() - startedAt < 5_000) {
      try {
        const response = await fetch(`${registryUrl}/${encodedName}`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        metadata = await response.json();
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!metadata) {
      throw new Error(
        `Candidate registry metadata for ${artifact.name} was unavailable after publication.`,
        { cause: lastError },
      );
    }
    const observed = metadata.versions?.[artifact.version]?.dist?.integrity;
    if (observed !== artifact.integrity) {
      throw new Error(
        `Candidate registry integrity for ${artifact.name}@${artifact.version} does not match the packed tarball.`,
      );
    }
  }
};

export const warmCandidateRegistryDependencies = async ({
  runRoot,
  packageArtifacts,
  run,
}) => {
  const preflightRoot = path.join(runRoot, "registry-preflight");
  let lastError = null;

  try {
    for (
      let attempt = 1;
      attempt <= candidateRegistryWarmAttempts;
      attempt += 1
    ) {
      fs.rmSync(preflightRoot, { recursive: true, force: true });
      fs.mkdirSync(preflightRoot, { recursive: true });
      fs.writeFileSync(
        path.join(preflightRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "airjam-golden-path-registry-preflight",
            private: true,
            version: "0.0.0",
          },
          null,
          2,
        )}\n`,
      );

      try {
        run(
          `registry:warm-dependencies:${attempt}`,
          "pnpm",
          [
            "--store-dir",
            path.join(preflightRoot, "store"),
            "add",
            "--ignore-scripts",
            ...packageArtifacts.map(
              (artifact) => `${artifact.name}@${artifact.version}`,
            ),
          ],
          preflightRoot,
        );
        return;
      } catch (error) {
        lastError = error;
        if (attempt < candidateRegistryWarmAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
  } finally {
    fs.rmSync(preflightRoot, { recursive: true, force: true });
  }

  throw new Error(
    `Candidate registry dependency preflight failed after ${candidateRegistryWarmAttempts} attempts.`,
    { cause: lastError },
  );
};

const assertRegistrySafeProject = ({
  projectDir,
  registryUrl,
  packageArtifacts,
}) => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
  );
  const specs = [
    ...Object.entries(packageJson.dependencies ?? {}),
    ...Object.entries(packageJson.devDependencies ?? {}),
    ...Object.entries(packageJson.pnpm?.overrides ?? {}),
  ];
  for (const [name, spec] of specs) {
    if (typeof spec === "string" && /^(?:file|link|workspace):/u.test(spec)) {
      throw new Error(
        `Generated dependency ${name} uses forbidden spec ${spec}.`,
      );
    }
  }
  for (const packageName of [
    "@air-jam/sdk",
    "@air-jam/server",
    "@air-jam/mcp-server",
    "@air-jam/cli",
  ]) {
    const spec =
      packageJson.dependencies?.[packageName] ??
      packageJson.devDependencies?.[packageName];
    if (typeof spec !== "string") {
      throw new Error(`Generated project is missing ${packageName}.`);
    }
  }

  const modulesState = fs.readFileSync(
    path.join(projectDir, "node_modules", ".modules.yaml"),
    "utf8",
  );
  if (!modulesState.includes(registryUrl)) {
    throw new Error("Generated install did not record the candidate registry.");
  }
  if (modulesState.includes(repoRoot)) {
    throw new Error("Generated install contains a private monorepo path.");
  }
  const lockSource = fs.readFileSync(
    path.join(projectDir, "pnpm-lock.yaml"),
    "utf8",
  );
  if (lockSource.includes(repoRoot)) {
    throw new Error("Generated lockfile contains a private monorepo path.");
  }
  if (lockSource.includes(path.dirname(projectDir))) {
    throw new Error("Generated lockfile contains a run-owned private path.");
  }
  if (
    /^\s*(?:specifier|version):\s+(?:file|link|workspace):/mu.test(lockSource)
  ) {
    throw new Error("Generated lockfile contains a forbidden local spec.");
  }
  assertInstalledCandidateIntegrity({ lockSource, packageArtifacts });
  return packageJson;
};

const inspectInstalledAirJamVersions = (projectDir) => {
  const versions = {};
  for (const packageName of candidatePackageNames) {
    if (packageName === "create-airjam") continue;
    const packagePath = path.join(
      projectDir,
      "node_modules",
      ...packageName.split("/"),
      "package.json",
    );
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    versions[packageName] = packageJson.version;
  }
  return versions;
};

export const prepareGoldenPathCandidateRegistry = async ({
  runRoot,
  port,
  commandEnv,
  run,
  candidateDirectory,
  expectedCommit,
  onProgress = () => {},
}) => {
  const packDir = path.join(runRoot, "packages");
  fs.mkdirSync(packDir, { recursive: true });
  const publicPackages = resolvePublicPackages();
  const tarballs = new Map();
  let packageArtifacts;
  let version;
  let candidate = null;
  if (candidateDirectory) {
    const validated = validatePublicReleaseCandidate(candidateDirectory, {
      expectedCommit,
    });
    version = validated.manifest.version;
    packageArtifacts = validated.packageArtifacts.map(
      ({ tarballPath, ...artifact }) => {
        tarballs.set(artifact.name, tarballPath);
        return artifact;
      },
    );
    candidate = {
      digest: validated.candidateDigest,
    };
  } else {
    version = resolveUnifiedPublicVersion();
    for (const { packageFilter } of publicPackages) {
      run(
        `build:${packageFilter}`,
        "pnpm",
        ["--filter", packageFilter, "build"],
        repoRoot,
      );
    }

    packageArtifacts = [];
    for (const packageDefinition of publicPackages) {
      const packageDir = path.join(
        repoRoot,
        packageDefinition.workingDirectory,
      );
      const output = run(
        `pack:${packageDefinition.packageName}`,
        "pnpm",
        ["pack", "--pack-destination", packDir],
        packageDir,
      );
      const tarballPath = findPackedTarball({ output, packageDir });
      tarballs.set(packageDefinition.packageName, tarballPath);
      const tarball = fs.readFileSync(tarballPath);
      packageArtifacts.push({
        name: packageDefinition.packageName,
        version: packageDefinition.version,
        tarballBytes: tarball.length,
        integrity: sha512Integrity(tarball),
      });
    }
  }

  onProgress("registry:start");
  const registry = await startCandidateRegistry({ runRoot, port });
  try {
    await configureRunScopedRegistryAuth({
      registryUrl: registry.registryUrl,
      runRoot,
      commandEnv,
    });
    for (const packageDefinition of publicPackages) {
      run(`publish:${packageDefinition.packageName}`, "npm", [
        "publish",
        tarballs.get(packageDefinition.packageName),
        "--registry",
        registry.registryUrl,
        "--access",
        "public",
        "--ignore-scripts",
      ]);
    }
    await assertRegistryCandidateIntegrity({
      registryUrl: registry.registryUrl,
      packageArtifacts,
    });
    await warmCandidateRegistryDependencies({
      runRoot,
      packageArtifacts,
      run,
    });
    return {
      registry,
      version,
      packageArtifacts,
      candidate,
    };
  } catch (error) {
    await stopChild(registry.child);
    throw error;
  }
};

export const runGoldenPathBootstrap = async ({
  template = "minimal",
  bootstrapClient = "pnpm-dlx",
  keepWorkspace = false,
  candidateDirectory,
  expectedCommit,
  onProgress = () => {},
} = {}) => {
  if (bootstrapClient !== "pnpm-dlx" && bootstrapClient !== "npx") {
    throw new Error(
      `Unsupported bootstrap client ${bootstrapClient}. Use pnpm-dlx or npx.`,
    );
  }
  // GitHub's Windows os.tmpdir() can resolve through the RUNNER~1 8.3 alias
  // while file-watch events use its long path. Prefer the runner-owned temp
  // root (D:\a\_temp on hosted Windows) and retain an explicit override for
  // other automation hosts. Native realpath then gives every child process one
  // filesystem identity from the start.
  const temporaryRoot = resolveGoldenPathTemporaryRoot();
  const runRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(temporaryRoot, "airjam-golden-path-bootstrap-")),
  );
  const projectName = "signal-relay-bootstrap";
  const projectDir = path.join(runRoot, "workspace", projectName);
  const commands = [];
  let registry;
  let managedDevStarted = false;
  let managedDevProcessId = null;
  let primaryError = null;
  const [port, serverPort, gamePort] = await reserveDistinctLoopbackPorts(3);
  const registryUrl = `http://127.0.0.1:${port}`;
  const commandEnv = {
    ...process.env,
    CI: process.env.CI ?? "1",
    NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    AIR_JAM_SERVER_PORT: String(serverPort),
    VITE_PORT: String(gamePort),
    VITE_AIR_JAM_PUBLIC_HOST: `http://127.0.0.1:${gamePort}`,
    AIRJAM_DEVTOOLS_KNOWN_PORTS: `${serverPort},${gamePort}`,
    npm_config_audit: "false",
    npm_config_cache: path.join(runRoot, "npm-cache"),
    npm_config_registry: registryUrl,
  };
  delete commandEnv.npm_config_reporter;

  const run = (id, command, args, cwd = repoRoot) => {
    onProgress(id);
    const startedAt = Date.now();
    const result = crossSpawn.sync(command, args, {
      cwd,
      encoding: "utf8",
      env: commandEnv,
      maxBuffer: commandMaxBuffer,
      timeout: commandTimeoutMs,
      killSignal: "SIGTERM",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");
    const normalizedStdout = normalizeOutput(stdout, runRoot);
    const normalizedStderr = normalizeOutput(stderr, runRoot);
    commands.push({
      id,
      exitCode: result.status,
      signal: result.signal,
      errorCode: result.error?.code ?? null,
      durationMs: Date.now() - startedAt,
      stdoutSha256: sha256(normalizedStdout),
      stderrSha256: sha256(normalizedStderr),
    });
    if (result.error) {
      throw new Error(`${id} failed: ${result.error.message}`, {
        cause: result.error,
      });
    }
    if (result.status !== 0) {
      throw new Error(
        result.signal
          ? `${id} terminated from signal ${result.signal}.\n${normalizedStdout}\n${normalizedStderr}`
          : `${id} failed with exit code ${result.status}.\n${normalizedStdout}\n${normalizedStderr}`,
      );
    }
    return stdout;
  };

  try {
    const prepared = await prepareGoldenPathCandidateRegistry({
      runRoot,
      port,
      commandEnv,
      run,
      candidateDirectory,
      expectedCommit,
      onProgress,
    });
    registry = prepared.registry;
    const { version, packageArtifacts } = prepared;

    fs.mkdirSync(path.dirname(projectDir), { recursive: true });
    const scaffoldCommand =
      bootstrapClient === "npx"
        ? {
            command: "npx",
            args: [
              "--yes",
              `create-airjam@${version}`,
              projectName,
              "--template",
              template,
            ],
          }
        : {
            command: "pnpm",
            args: [
              "dlx",
              `create-airjam@${version}`,
              projectName,
              "--template",
              template,
            ],
          };
    run(
      "scaffold:create",
      scaffoldCommand.command,
      scaffoldCommand.args,
      path.dirname(projectDir),
    );
    const createAirJamVersion = run(
      "discover:create-airjam-version",
      bootstrapClient === "npx" ? "npx" : "pnpm",
      bootstrapClient === "npx"
        ? ["--yes", `create-airjam@${version}`, "--version"]
        : ["dlx", `create-airjam@${version}`, "--version"],
      path.dirname(projectDir),
    ).trim();
    if (createAirJamVersion !== version) {
      throw new Error(
        `create-airjam reported ${createAirJamVersion}; expected ${version}.`,
      );
    }
    fs.writeFileSync(
      path.join(projectDir, ".env.local"),
      `VITE_PORT=${gamePort}\n`,
      { flag: "wx" },
    );
    const packageJson = assertRegistrySafeProject({
      projectDir,
      registryUrl: registry.registryUrl,
      packageArtifacts,
    });
    if (packageJson.packageManager !== rootPackageJson.packageManager) {
      throw new Error(
        `Generated project packageManager must be ${rootPackageJson.packageManager}.`,
      );
    }
    if (
      typeof packageJson.scripts?.lint !== "string" ||
      packageJson.scripts.lint.trim().length === 0
    ) {
      throw new Error("Generated project must expose a lint script.");
    }
    const requiredScripts = ["dev", "status", "reset:local", "mcp", "lint"];
    for (const script of requiredScripts) {
      if (typeof packageJson.scripts?.[script] !== "string") {
        throw new Error(`Generated project is missing the ${script} script.`);
      }
    }

    run("discover:cli", "pnpm", ["exec", "airjam", "--help"], projectDir);
    const cliVersion = run(
      "discover:cli-version",
      "pnpm",
      ["exec", "airjam", "--version"],
      projectDir,
    ).trim();
    const serverVersion = run(
      "discover:server-version",
      "pnpm",
      ["exec", "air-jam-server", "--version"],
      projectDir,
    ).trim();
    const mcpCliVersion = run(
      "discover:mcp-version",
      "pnpm",
      ["exec", "airjam-mcp", "--version"],
      projectDir,
    ).trim();
    for (const [surface, observedVersion] of [
      ["@air-jam/cli", cliVersion],
      ["@air-jam/server", serverVersion],
      ["@air-jam/mcp-server", mcpCliVersion],
    ]) {
      if (observedVersion !== version) {
        throw new Error(
          `${surface} reported ${observedVersion}; expected ${version}.`,
        );
      }
    }
    run("discover:dev", "pnpm", ["run", "dev", "--", "--help"], projectDir);
    run(
      "discover:session",
      "pnpm",
      ["exec", "airjam", "session", "--help"],
      projectDir,
    );
    run(
      "discover:release",
      "pnpm",
      ["exec", "airjam", "release", "--help"],
      projectDir,
    );
    const doctor = parseCommandJson(
      "discover:mcp-doctor",
      run(
        "discover:mcp-doctor",
        "pnpm",
        ["exec", "airjam", "mcp", "doctor", "--dir", ".", "--json"],
        projectDir,
      ),
    );
    const codexProfile = parseCommandJson(
      "discover:codex-profile",
      run(
        "discover:codex-profile",
        "pnpm",
        [
          "exec",
          "airjam",
          "mcp",
          "config",
          "--profile",
          "codex",
          "--dir",
          ".",
          "--json",
        ],
        projectDir,
      ),
    );
    if (
      doctor.projectMode !== "standalone-game" ||
      !doctor.package?.dependencyPresent ||
      !doctor.portableDeclaration?.present
    ) {
      throw new Error("Generated MCP doctor did not report a ready project.");
    }
    if (
      codexProfile.profile !== "codex" ||
      codexProfile.scope !== "project" ||
      !codexProfile.content?.includes("[mcp_servers.airjam]")
    ) {
      throw new Error("Generated Codex MCP profile is not project-scoped.");
    }
    onProgress("discover:mcp-protocol");
    const mcp = await verifyMcpStdioHandshake({
      cwd: projectDir,
      env: commandEnv,
      clientInfo: {
        name: "airjam-golden-path-bootstrap",
        version: "1.0.0",
      },
      label: "Candidate MCP server",
      requiredToolNames: [
        "airjam.inspect_project",
        "airjam.evaluate",
        "airjam.open_game_session",
        "airjam.read_game_session",
        "airjam.invoke_game_session_action",
        "airjam.capture_game_session_visuals",
        "airjam.close_game_session",
      ],
      expectedToolNames: standaloneGameMcpToolNames,
    });

    managedDevStarted = true;
    const devStarted = parseCommandJson(
      "lifecycle:dev-start",
      run(
        "lifecycle:dev-start",
        "pnpm",
        ["exec", "airjam", "dev", "start", "--dir", "."],
        projectDir,
      ),
    );
    managedDevProcessId = devStarted.process?.id ?? null;
    const devStatus = parseCommandJson(
      "lifecycle:status",
      run(
        "lifecycle:status",
        "pnpm",
        ["exec", "airjam", "status", "--dir", "."],
        projectDir,
      ),
    );
    if (
      typeof managedDevProcessId !== "string" ||
      !Array.isArray(devStatus.processes) ||
      !devStatus.processes.some((entry) => entry.id === managedDevProcessId)
    ) {
      throw new Error(
        "Generated dev start/status did not expose one managed process.",
      );
    }
    const devStopped = parseCommandJson(
      "lifecycle:dev-stop",
      run(
        "lifecycle:dev-stop",
        "pnpm",
        ["exec", "airjam", "dev", "stop", "--dir", "."],
        projectDir,
      ),
    );
    if (
      !Array.isArray(devStopped.stopped) ||
      !devStopped.stopped.some((entry) => entry.id === managedDevProcessId)
    ) {
      throw new Error("Generated dev stop did not close its managed process.");
    }
    managedDevStarted = false;

    run("quality:typecheck", "pnpm", ["typecheck"], projectDir);
    run("quality:lint", "pnpm", ["lint"], projectDir);
    run("quality:test", "pnpm", ["test"], projectDir);
    run("quality:build", "pnpm", ["build"], projectDir);

    const installedVersions = inspectInstalledAirJamVersions(projectDir);
    return {
      ok: true,
      contract: "air-jam-golden-path-bootstrap/v1",
      template,
      bootstrapClient,
      packageVersion: version,
      candidate: prepared.candidate,
      registry: {
        kind: "run-scoped-loopback-verdaccio",
        upstream: "https://registry.npmjs.org/",
        airJamPackagesProxied: false,
        candidateDependencyGraphWarmed: true,
        scaffoldDependencyGraphWarmed: false,
        published: packageArtifacts,
      },
      isolation: {
        forbiddenSpecsAbsent: true,
        monorepoPathsAbsent: true,
        workspaceRetained: keepWorkspace,
      },
      project: {
        name: packageJson.name,
        packageManager: packageJson.packageManager,
        scripts: requiredScripts,
        installedVersions,
      },
      discovery: {
        versions: {
          "create-airjam": createAirJamVersion,
          "@air-jam/cli": cliVersion,
          "@air-jam/server": serverVersion,
          "@air-jam/mcp-server": mcpCliVersion,
        },
        portableMcp: doctor.portableDeclaration.present,
        codexProjectProfile: true,
        mcpServer: mcp.serverInfo,
        mcpTools: mcp.tools,
      },
      lifecycle: {
        managedDevStart: "passed",
        managedDevStatus: "passed",
        managedDevStop: "passed",
      },
      quality: {
        typecheck: "passed",
        lint: "passed",
        tests: "passed",
        build: "passed",
      },
      commands,
      retainedWorkspace: keepWorkspace ? runRoot : null,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (managedDevStarted && fs.existsSync(projectDir)) {
        crossSpawn.sync(
          "pnpm",
          ["exec", "airjam", "dev", "stop", "--dir", "."],
          {
            cwd: projectDir,
            env: commandEnv,
            stdio: "ignore",
            timeout: 60_000,
            killSignal: "SIGKILL",
          },
        );
      }
      if (registry) await stopChild(registry.child);
      fs.rmSync(path.join(runRoot, "registry"), {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
      if (!keepWorkspace) {
        fs.rmSync(runRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 200,
        });
      }
    } catch (cleanupError) {
      if (!primaryError) {
        throw cleanupError;
      }
      const message =
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
      process.stderr.write(
        `[golden-path cleanup] ${normalizeOutput(message, runRoot)}\n`,
      );
    }
  }
};
