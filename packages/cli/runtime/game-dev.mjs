import crossSpawn from "cross-spawn";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  createProcessGroup,
  detectLocalIpv4,
  hasFlag,
  isPortOpen,
  loadEnvFile,
  waitForPort,
} from "./dev-utils.mjs";
import {
  loadCreateAirJamRuntimeEnv,
  resolveLocalBackendOrigin,
} from "./runtime-env.mjs";
import {
  buildStandaloneGameTopology,
  serializeResolvedTopology,
} from "./runtime-topology.mjs";
import {
  buildSecureGameEnv,
  DEFAULT_GAME_PORT,
  loadSecureDevState,
  parseGameDevArgs,
  SECURE_MODE_TUNNEL,
} from "./secure-dev.mjs";

const START_TIMEOUT_MS = 20_000;
const PREVIEW_MANAGED_SERVER_LOG_RELATIVE_PATH = path.join(
  ".airjam",
  "preview-managed-server.log",
);
const PREVIEW_MANAGED_SERVER_STATE_RELATIVE_PATH = path.join(
  ".airjam",
  "preview-managed-server.json",
);

const holdProcessOpen = async () => {
  await new Promise(() => {
    setInterval(() => {}, 1 << 30);
  });
};

const usage = () => {
  console.log(
    "Usage: airjam dev [--secure] [--secure-mode=local|tunnel] [--preview-managed] [--web-only] [--server-only] [--allow-existing-game]",
  );
  console.log("");
  console.log("Modes:");
  console.log(
    "  default               Start local server + game (recommended)",
  );
  console.log("  --secure              Start secure local game dev");
  console.log(
    "  --secure-mode=tunnel  Use Cloudflare tunnel fallback instead of local-only secure host",
  );
  console.log(
    "  --preview-managed     Start background server + foreground Vite for preview/browser launch tools",
  );
  console.log("  --web-only            Start only the game app");
  console.log("  --server-only         Start only the local Air Jam server");
  console.log(
    "  --allow-existing-game Reuse an already-running Vite server on the game port",
  );
  console.log("");
  console.log("Network isolation:");
  console.log("  VITE_PORT                    Game app port (default: 5173)");
  console.log("  AIR_JAM_SERVER_PORT          Local server port (default: 4000)");
  console.log("  VITE_AIR_JAM_PUBLIC_HOST     Explicit host/controller origin");
};

const getDefaultPublicHost = (env, gamePort) => {
  const explicitPublicHost = env.VITE_AIR_JAM_PUBLIC_HOST;
  if (explicitPublicHost) {
    return explicitPublicHost;
  }

  const detectedIp = detectLocalIpv4();
  if (!detectedIp) {
    console.warn(
      "[dev] Could not detect LAN IP. Falling back to localhost in QR links.",
    );
    console.warn(
      "[dev] Set VITE_AIR_JAM_PUBLIC_HOST manually for phone testing.",
    );
    return `http://localhost:${gamePort}`;
  }

  return `http://${detectedIp}:${gamePort}`;
};

const readListeningPid = (port) => {
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .trim()
      .split("\n")
      .find(Boolean);
    const pid = Number.parseInt(output ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const readProcessSummary = (pid) => {
  if (!pid) {
    return null;
  }

  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const etimesOutput = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "etimes="],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    const ageSeconds = Number.parseInt(etimesOutput, 10);
    return {
      pid,
      command: command || null,
      ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : null,
    };
  } catch {
    return { pid, command: null, ageSeconds: null };
  }
};

const formatProcessSummary = (summary) => {
  if (!summary) {
    return "unknown process";
  }

  const age =
    typeof summary.ageSeconds === "number"
      ? `, age ${Math.floor(summary.ageSeconds / 60)}m${summary.ageSeconds % 60}s`
      : "";
  const command = summary.command ? `, command: ${summary.command}` : "";
  return `pid ${summary.pid}${age}${command}`;
};

const startServerIfNeeded = async (processGroup, serverPort, env) => {
  const hasExistingServer = await isPortOpen(serverPort);
  if (hasExistingServer) {
    const summary = readProcessSummary(readListeningPid(serverPort));
    console.warn(
      `[dev] Reusing existing server on :${serverPort} (${formatProcessSummary(summary)}). If this looks stale, run "pnpm exec airjam reset local".`,
    );
    return false;
  }

  processGroup.run("server", "pnpm", ["exec", "air-jam-server"], {
    env: {
      ...process.env,
      ...env,
      PORT: String(serverPort),
    },
  });
  await waitForPort(serverPort, START_TIMEOUT_MS);
  return true;
};

const startGameIfNeeded = async (
  processGroup,
  { gamePort, env, allowExistingGame },
) => {
  const hasExistingGame = await isPortOpen(gamePort);
  if (hasExistingGame) {
    if (allowExistingGame) {
      console.log(`[dev] Reusing existing game on :${gamePort}`);
      return false;
    }

    throw new Error(
      `Port ${gamePort} is already in use. Stop the existing Vite dev server and retry.`,
    );
  }

  processGroup.run("game", "pnpm", ["exec", "vite"], {
    env: {
      ...process.env,
      ...env,
    },
  });
  await waitForPort(gamePort, START_TIMEOUT_MS);
  return true;
};

const ensurePreviewManagedServer = async ({ cwd, serverPort, env }) => {
  const hasExistingServer = await isPortOpen(serverPort);
  if (hasExistingServer) {
    const summary = readProcessSummary(readListeningPid(serverPort));
    console.warn(
      `[dev] Reusing existing preview-managed server on :${serverPort} (${formatProcessSummary(summary)}). If this looks stale, run "pnpm exec airjam reset local".`,
    );
    return false;
  }

  const airJamDir = path.join(cwd, ".airjam");
  fs.mkdirSync(airJamDir, { recursive: true });

  const logFile = path.join(cwd, PREVIEW_MANAGED_SERVER_LOG_RELATIVE_PATH);
  const stateFile = path.join(cwd, PREVIEW_MANAGED_SERVER_STATE_RELATIVE_PATH);
  const logFd = fs.openSync(logFile, "a");
  const child = crossSpawn("pnpm", ["exec", "air-jam-server"], {
    cwd,
    env: {
      ...process.env,
      ...env,
      PORT: String(serverPort),
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();
  fs.closeSync(logFd);

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        pid: child.pid,
        port: serverPort,
        startedAt: new Date().toISOString(),
        logFile,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(
    `[dev] Started preview-managed background server on :${serverPort}`,
  );
  console.log(`[dev] Background server log: ${logFile}`);
  return true;
};

const runForegroundGame = ({ cwd, env }) =>
  new Promise((resolve, reject) => {
    const child = crossSpawn("pnpm", ["exec", "vite"], {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        ...env,
      },
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      resolve(code ?? 0);
    });

    process.on("SIGINT", () => child.kill("SIGINT"));
    process.on("SIGTERM", () => child.kill("SIGTERM"));
  });

const readPreviewProxyTargetPort = (publicPort) => {
  try {
    const lsofOutput = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${publicPort}`, "-sTCP:LISTEN", "-Fp"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const pidMatch = lsofOutput.match(/^p(\d+)$/m);
    if (!pidMatch) {
      return null;
    }

    const command = execFileSync("ps", ["-p", pidMatch[1], "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const proxyMatch = command.match(/preview-proxy\.mjs\s+(\d+)\s+(\d+)\b/);
    if (!proxyMatch) {
      return null;
    }

    const proxyPublicPort = Number(proxyMatch[1]);
    const proxyTargetPort = Number(proxyMatch[2]);
    if (
      !Number.isInteger(proxyPublicPort) ||
      !Number.isInteger(proxyTargetPort) ||
      proxyPublicPort !== publicPort
    ) {
      return null;
    }

    return proxyTargetPort;
  } catch {
    return null;
  }
};

const resolvePreviewManagedPorts = async ({ port }) => {
  const publicPort = port;
  const publicPortInUse = await isPortOpen(publicPort);
  if (!publicPortInUse) {
    return {
      publicPort,
      vitePort: publicPort,
      usesPreviewProxy: false,
    };
  }

  const proxyTargetPort = readPreviewProxyTargetPort(publicPort);
  if (!proxyTargetPort) {
    throw new Error(
      `Port ${publicPort} is already in use. Close the existing process or choose a different VITE_PORT before running preview-managed dev.`,
    );
  }

  const targetPortInUse = await isPortOpen(proxyTargetPort);
  if (targetPortInUse) {
    throw new Error(
      `Preview proxy port ${publicPort} is already forwarding to ${proxyTargetPort}, but that target port is also busy. Close the existing preview stack and retry.`,
    );
  }

  return {
    publicPort,
    vitePort: proxyTargetPort,
    usesPreviewProxy: true,
  };
};

export const validateGameDevMode = ({ args }) => {
  if (args.webOnly && args.serverOnly) {
    throw new Error("Cannot combine --web-only and --server-only.");
  }
  if (args.previewManaged && args.webOnly) {
    throw new Error("Cannot combine --preview-managed and --web-only.");
  }
  if (args.previewManaged && args.serverOnly) {
    throw new Error("Cannot combine --preview-managed and --server-only.");
  }
  if (args.previewManaged && args.allowExistingGame) {
    throw new Error(
      "Cannot combine --preview-managed and --allow-existing-game.",
    );
  }
  if (args.previewManaged && args.secure) {
    throw new Error(
      "Preview-managed mode does not support --secure. Use the normal `pnpm run dev` flow instead.",
    );
  }
};

export const runGameDevCli = async ({
  cwd = process.cwd(),
  argv = process.argv.slice(2),
  env = process.env,
} = {}) => {
  loadEnvFile(path.join(cwd, ".env"), env);
  loadEnvFile(path.join(cwd, ".env.local"), env);
  const runtimeEnv = loadCreateAirJamRuntimeEnv({
    env,
    boundary: "create-airjam.dev",
  });
  const serverPort = runtimeEnv.AIR_JAM_SERVER_PORT;
  const backendOrigin = resolveLocalBackendOrigin(runtimeEnv);
  const secureRootDir = runtimeEnv.AIR_JAM_SECURE_ROOT
    ? path.resolve(cwd, runtimeEnv.AIR_JAM_SECURE_ROOT)
    : cwd;

  const help = hasFlag(argv, "--help") || hasFlag(argv, "-h");
  if (help) {
    usage();
    return;
  }

  const args = parseGameDevArgs(argv, runtimeEnv);
  validateGameDevMode({ args });

  const requestedGamePort = args.port || DEFAULT_GAME_PORT;
  const previewManagedPorts = args.previewManaged
    ? await resolvePreviewManagedPorts({ port: requestedGamePort })
    : null;
  const publicGamePort = previewManagedPorts?.publicPort ?? requestedGamePort;
  const viteGamePort = previewManagedPorts?.vitePort ?? requestedGamePort;

  const processGroup = createProcessGroup();
  processGroup.registerSignalHandlers();

  try {
    let secureState = null;
    if (args.secure) {
      secureState = loadSecureDevState({
        cwd: secureRootDir,
        mode: args.secureMode,
        env: runtimeEnv,
        gamePort: args.port,
      });
      console.log(`[dev] Secure mode: ${secureState.mode}`);
      console.log(`[dev] Public host: ${secureState.publicHost}`);
    }
    validateGameDevMode({ args });

    const gameEnv = args.secure
      ? buildSecureGameEnv({
          secureState,
          webOnly: args.webOnly,
          env: runtimeEnv,
          backendOrigin,
        })
      : {
          VITE_AIR_JAM_RUNTIME_TOPOLOGY: serializeResolvedTopology(
            buildStandaloneGameTopology({
              surfaceRole: "host",
              publicHost: getDefaultPublicHost(env, publicGamePort),
              backendOrigin,
            }),
          ),
          VITE_AIR_JAM_PUBLIC_HOST: getDefaultPublicHost(env, publicGamePort),
          VITE_AIR_JAM_SERVER_URL: backendOrigin,
          AIR_JAM_DEV_PROXY_BACKEND_URL: backendOrigin,
          VITE_PORT: String(viteGamePort),
          ...(args.webOnly && runtimeEnv.VITE_AIR_JAM_SERVER_URL
            ? {
                VITE_AIR_JAM_SERVER_URL: runtimeEnv.VITE_AIR_JAM_SERVER_URL,
              }
            : {}),
        };

    if (args.previewManaged) {
      await ensurePreviewManagedServer({
        cwd,
        serverPort,
        env: runtimeEnv,
      });
      if (previewManagedPorts?.usesPreviewProxy) {
        console.log(
          `[dev] Detected browser preview proxy on :${publicGamePort}; binding Vite to :${viteGamePort} behind it.`,
        );
      }
      console.log(
        "[dev] Preview-managed mode: foreground Vite is ready for browser/preview launch tools.",
      );
      const exitCode = await runForegroundGame({
        cwd,
        env: gameEnv,
      });
      process.exit(exitCode);
    }

    let startedServer = false;
    if (!args.webOnly) {
      startedServer = await startServerIfNeeded(
        processGroup,
        serverPort,
        runtimeEnv,
      );
    } else {
      console.log(
        "[dev] Web-only mode: skipping local Air Jam server startup.",
      );
    }

    let startedGame = false;
    if (!args.serverOnly) {
      startedGame = await startGameIfNeeded(processGroup, {
        gamePort: viteGamePort,
        env: gameEnv,
        allowExistingGame: args.allowExistingGame,
      });
    }

    if (args.secure && secureState.mode === SECURE_MODE_TUNNEL) {
      processGroup.run("cloudflared", "cloudflared", [
        "tunnel",
        "--config",
        path.join(secureRootDir, ".cloudflared/config.yml"),
        "run",
        secureState.tunnelName,
      ]);

      console.log(`Cloudflare tunnel: ${secureState.tunnelName}`);
    }

    if (!startedServer && !startedGame) {
      await holdProcessOpen();
    }
  } catch (error) {
    processGroup.shutdown(1);
    throw error;
  }
};
