import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLATFORM_LIVENESS_PATH,
  PLATFORM_READINESS_PATH,
} from "../../apps/platform/src/lib/platform-service-paths.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const EXCLUDED_ROOT_PREFIXES = [".airjam", ".git"];
const EXCLUDED_DIR_NAMES = new Set([
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

const EXCLUDED_FILE_SUFFIXES = [".tsbuildinfo"];
const BIN_WARNING_PATTERN = /Failed to create bin at /;
const PLATFORM_BUILD_ORIGIN = "https://airjam.io";
const PLATFORM_RELEASE_ORIGIN = "https://releases.airjamusercontent.invalid";
const PLATFORM_RUNTIME_SECRET =
  "airjam-hermetic-platform-auth-secret-1234567890";
const HERMETIC_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "COREPACK_HOME",
  "PNPM_HOME",
];

const hermeticBaseEnv = Object.fromEntries(
  HERMETIC_ENV_KEYS.flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]],
  ),
);

const reserveAvailablePort = async () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a worker probe port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const shouldCopyPath = (sourcePath) => {
  const relativePath = path.relative(repoRoot, sourcePath);
  if (!relativePath) {
    return true;
  }

  const segments = relativePath.split(path.sep);
  const firstSegment = segments[0];
  if (EXCLUDED_ROOT_PREFIXES.includes(firstSegment)) {
    return false;
  }

  if (segments.some((segment) => EXCLUDED_DIR_NAMES.has(segment))) {
    return false;
  }

  const basename = path.basename(sourcePath);
  if (basename.startsWith(".env") && basename !== ".env.example") {
    return false;
  }
  return !EXCLUDED_FILE_SUFFIXES.some((suffix) => basename.endsWith(suffix));
};

const run = ({ args, cwd, env = {}, label }) => {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    env: {
      ...hermeticBaseEnv,
      CI: "1",
      NO_UPDATE_NOTIFIER: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      ...env,
    },
    encoding: "utf8",
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (output.trim()) {
    process.stdout.write(output);
  }

  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}.`);
  }

  return output;
};

const requestRaw = ({ host, path: requestPath, port }) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method: "GET",
        headers: { accept: "application/json", host },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            body,
            headers: response.headers,
            status: response.statusCode,
          });
        });
      },
    );
    req.setTimeout(1_000, () =>
      req.destroy(new Error("Standalone platform request timed out.")),
    );
    req.once("error", reject);
    req.end();
  });

const requestJson = async (options) => {
  const response = await requestRaw(options);
  try {
    return { ...response, body: JSON.parse(response.body) };
  } catch {
    throw new Error(
      `Standalone platform returned non-JSON HTTP ${response.status}: ${response.body}`,
    );
  }
};

const waitForStandaloneResponse = async ({
  child,
  getOutput,
  host,
  path: requestPath,
  port,
}) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Standalone platform exited before serving ${requestPath}.\n${getOutput()}`,
      );
    }
    try {
      return await requestJson({ host, path: requestPath, port });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    `Standalone platform did not serve ${requestPath} within 15 seconds.\n${getOutput()}`,
  );
};

const stopChild = async (child) => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) =>
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 3_000),
    ),
  ]);
};

const withStandalonePlatform = async ({
  callback,
  releaseOrigin,
  runtimeEntry,
  runtimeOrigin,
  standaloneRoot,
}) => {
  const port = await reserveAvailablePort();
  let output = "";
  const child = spawn(process.execPath, [runtimeEntry], {
    cwd: standaloneRoot,
    env: {
      ...hermeticBaseEnv,
      ...(releaseOrigin
        ? { AIRJAM_RELEASES_PUBLIC_ORIGIN: releaseOrigin }
        : {}),
      BETTER_AUTH_SECRET: PLATFORM_RUNTIME_SECRET,
      BETTER_AUTH_URL: runtimeOrigin,
      DATABASE_URL: "postgres://airjam:airjam@127.0.0.1:1/airjam",
      HOSTNAME: "127.0.0.1",
      NEXT_PUBLIC_AIR_JAM_PUBLIC_HOST: runtimeOrigin,
      NEXT_PUBLIC_APP_URL: runtimeOrigin,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
      PORT: String(port),
      RAILWAY_ENVIRONMENT_NAME: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  try {
    await callback({ child, getOutput: () => output, port });
  } finally {
    await stopChild(child);
  }
};

const main = async () => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "airjam-platform-deploy-"),
  );
  const checkoutRoot = path.join(tempRoot, "repo");

  try {
    await cp(repoRoot, checkoutRoot, {
      recursive: true,
      filter: shouldCopyPath,
      force: true,
    });

    const installOutput = run({
      args: ["corepack", "pnpm", "install", "--frozen-lockfile"],
      cwd: checkoutRoot,
      label: "Hermetic platform install",
    });

    if (BIN_WARNING_PATTERN.test(installOutput)) {
      throw new Error(
        "Hermetic platform install emitted workspace bin warnings. Ensure workspace bin entrypoints exist before build.",
      );
    }

    run({
      args: ["corepack", "pnpm", "--filter", "platform", "build"],
      cwd: checkoutRoot,
      env: {
        BETTER_AUTH_SECRET: PLATFORM_RUNTIME_SECRET,
        BETTER_AUTH_URL: PLATFORM_BUILD_ORIGIN,
        NEXT_PUBLIC_AIR_JAM_PUBLIC_HOST: PLATFORM_BUILD_ORIGIN,
        NEXT_PUBLIC_APP_URL: PLATFORM_BUILD_ORIGIN,
      },
      label: "Hermetic platform build",
    });

    const standaloneServerEntry = path.join(
      checkoutRoot,
      "apps/platform/.next/standalone/apps/platform/server.js",
    );

    if (!fs.existsSync(standaloneServerEntry)) {
      throw new Error(
        "Hermetic platform build did not emit .next/standalone/server.js.",
      );
    }

    const runtimeEntry = path.join(
      checkoutRoot,
      "apps/platform/.next/standalone/apps/platform/run-platform.mjs",
    );
    if (!fs.existsSync(runtimeEntry)) {
      throw new Error(
        "Hermetic platform build did not emit the bundled runtime entry.",
      );
    }

    const standaloneRoot = path.join(
      checkoutRoot,
      "apps/platform/.next/standalone",
    );
    const platformRailwayConfig = JSON.parse(
      fs.readFileSync(
        path.join(checkoutRoot, "apps/platform/railway.json"),
        "utf8",
      ),
    );
    const platformLivenessPath = platformRailwayConfig.deploy?.healthcheckPath;
    if (
      platformRailwayConfig.deploy?.startCommand !==
        "node /app/apps/platform/run-platform.mjs" ||
      platformLivenessPath !== PLATFORM_LIVENESS_PATH
    ) {
      throw new Error(
        `Platform Railway config must target its bundled entry and canonical liveness path ${PLATFORM_LIVENESS_PATH}.`,
      );
    }

    await withStandalonePlatform({
      runtimeEntry: standaloneServerEntry,
      runtimeOrigin: PLATFORM_BUILD_ORIGIN,
      standaloneRoot,
      callback: async ({ child, getOutput, port }) => {
        const liveness = await waitForStandaloneResponse({
          child,
          getOutput,
          host: "healthcheck.railway.app",
          path: platformLivenessPath,
          port,
        });
        if (
          liveness.status !== 200 ||
          liveness.body?.ok !== true ||
          liveness.body?.service !== "platform" ||
          (typeof liveness.body === "object" &&
            liveness.body !== null &&
            "boundaries" in liveness.body)
        ) {
          throw new Error(
            `Standalone Railway liveness probe returned an invalid contract: ${JSON.stringify(liveness)}`,
          );
        }

        const canonicalRedirect = await requestRaw({
          host: "www.airjam.io",
          path: "/docs?source=deploy-check",
          port,
        });
        if (
          canonicalRedirect.status !== 308 ||
          canonicalRedirect.headers.location !==
            "https://airjam.io/docs?source=deploy-check"
        ) {
          throw new Error(
            `Standalone platform did not preserve its canonical host redirect: ${JSON.stringify(canonicalRedirect)}`,
          );
        }

        const readiness = await waitForStandaloneResponse({
          child,
          getOutput,
          host: new URL(PLATFORM_BUILD_ORIGIN).host,
          path: PLATFORM_READINESS_PATH,
          port,
        });
        if (
          readiness.status !== 503 ||
          readiness.body?.ok !== false ||
          readiness.body?.boundaries?.platformRequestPolicy
            ?.platformPublicOrigin !== PLATFORM_BUILD_ORIGIN ||
          readiness.body?.boundaries?.platformRequestPolicy
            ?.isRailwayPreviewEnvironment !== false ||
          !readiness.body?.boundaries?.platformRequestPolicy?.platformRequestHosts?.includes(
            new URL(PLATFORM_BUILD_ORIGIN).host,
          ) ||
          readiness.body?.boundaries?.hostedReleaseOrigin?.status !== "disabled"
        ) {
          throw new Error(
            `Standalone platform coupled liveness to missing release readiness: ${JSON.stringify(readiness)}`,
          );
        }
      },
    });

    await withStandalonePlatform({
      releaseOrigin: PLATFORM_RELEASE_ORIGIN,
      runtimeEntry: standaloneServerEntry,
      runtimeOrigin: PLATFORM_BUILD_ORIGIN,
      standaloneRoot,
      callback: async ({ child, getOutput, port }) => {
        const readiness = await waitForStandaloneResponse({
          child,
          getOutput,
          host: new URL(PLATFORM_BUILD_ORIGIN).host,
          path: PLATFORM_READINESS_PATH,
          port,
        });
        if (
          readiness.status !== 503 ||
          readiness.body?.ok !== false ||
          readiness.body?.boundaries?.platformRequestPolicy
            ?.platformPublicOrigin !== PLATFORM_BUILD_ORIGIN ||
          readiness.body?.boundaries?.hostedReleaseOrigin?.status !== "ready" ||
          readiness.body?.boundaries?.databaseSchema?.status !== "unavailable" ||
          readiness.body?.boundaries?.databaseSchema?.compatible !== false
        ) {
          throw new Error(
            `Standalone platform readiness did not preserve the built origin and fail closed without schema authority: ${JSON.stringify(readiness)}`,
          );
        }
      },
    });

    const driftedRuntimeOrigin = "https://runtime-drift.airjam.invalid";
    await withStandalonePlatform({
      releaseOrigin: PLATFORM_RELEASE_ORIGIN,
      runtimeEntry: standaloneServerEntry,
      runtimeOrigin: driftedRuntimeOrigin,
      standaloneRoot,
      callback: async ({ child, getOutput, port }) => {
        const readiness = await waitForStandaloneResponse({
          child,
          getOutput,
          host: new URL(driftedRuntimeOrigin).host,
          path: PLATFORM_READINESS_PATH,
          port,
        });
        if (
          readiness.status !== 503 ||
          readiness.body?.ok !== false ||
          readiness.body?.boundaries?.hostedReleaseOrigin?.status !==
            "invalid" ||
          !readiness.body?.boundaries?.hostedReleaseOrigin?.reason?.includes(
            "baked into the release response policy",
          )
        ) {
          throw new Error(
            `Standalone platform did not reject build/runtime origin drift: ${JSON.stringify(readiness)}`,
          );
        }
      },
    });

    const workerRuntimeEntry = path.join(
      checkoutRoot,
      "apps/platform/.next/standalone/apps/platform/run-operational-job-worker.mjs",
    );
    if (!fs.existsSync(workerRuntimeEntry)) {
      throw new Error(
        "Hermetic platform build did not emit the bundled operational-job worker entry.",
      );
    }

    const workerPlaywrightPackage = path.join(
      checkoutRoot,
      "apps/platform/.next/standalone/apps/platform/node_modules/playwright-core/package.json",
    );
    if (!fs.existsSync(workerPlaywrightPackage)) {
      throw new Error(
        "Hermetic platform build did not package the worker's Playwright runtime dependency.",
      );
    }

    const workerRailwayConfig = JSON.parse(
      fs.readFileSync(
        path.join(checkoutRoot, "apps/platform/railway.worker.json"),
        "utf8",
      ),
    );
    if (
      workerRailwayConfig.deploy?.startCommand !==
        "node /app/apps/platform/run-operational-job-worker.mjs" ||
      workerRailwayConfig.deploy?.healthcheckPath !== "/ready"
    ) {
      throw new Error(
        "Operational-job worker Railway config does not target its bundled entry and readiness contract.",
      );
    }

    const migrationProbe = spawnSync("node", [runtimeEntry], {
      cwd: checkoutRoot,
      env: {
        ...hermeticBaseEnv,
        DATABASE_URL: "postgres://airjam:airjam@127.0.0.1:1/airjam",
        RAILWAY_ENVIRONMENT_NAME: "air-jam-hermetic-preview",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    const migrationProbeOutput = `${migrationProbe.stdout ?? ""}${migrationProbe.stderr ?? ""}`;

    if (migrationProbe.status === 0) {
      throw new Error(
        "Bundled runtime migration probe unexpectedly connected to the closed test port.",
      );
    }
    if (
      migrationProbe.error ||
      !migrationProbeOutput.includes("ECONNREFUSED")
    ) {
      process.stdout.write(migrationProbeOutput);
      throw new Error(
        "Bundled runtime entry did not load its migration dependencies before reaching the closed test database.",
      );
    }
    if (migrationProbeOutput.includes("ERR_MODULE_NOT_FOUND")) {
      process.stdout.write(migrationProbeOutput);
      throw new Error(
        "Bundled runtime entry still has a missing migration dependency.",
      );
    }

    const workerProbePort = await reserveAvailablePort();
    const workerProbe = spawnSync("node", [workerRuntimeEntry], {
      cwd: checkoutRoot,
      env: {
        ...hermeticBaseEnv,
        DATABASE_URL: "postgres://airjam:airjam@127.0.0.1:1/airjam",
        PORT: String(workerProbePort),
        AIRJAM_PLATFORM_WORKER_POLL_MS: "10000",
        AIRJAM_PLATFORM_WORKER_REPAIR_MS: "10000",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      encoding: "utf8",
      timeout: 3_000,
    });
    const workerProbeOutput = `${workerProbe.stdout ?? ""}${workerProbe.stderr ?? ""}`;
    if (workerProbeOutput.includes("ERR_MODULE_NOT_FOUND")) {
      process.stdout.write(workerProbeOutput);
      throw new Error(
        "Bundled operational-job worker entry has a missing runtime dependency.",
      );
    }
    if (!workerProbeOutput.includes('"event":"worker.started"')) {
      process.stdout.write(workerProbeOutput);
      throw new Error(
        "Bundled operational-job worker did not reach its health-serving runtime boundary.",
      );
    }

    process.stdout.write("✓ Hermetic platform deploy contract passed\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

await main();
