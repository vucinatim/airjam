import type {
  ClientToServerEvents,
  ControllerActionRpcPayload,
  ControllerInputEvent,
  ControllerStateSyncRequestPayload,
  HostActionRpcPayload,
  ServerToClientEvents,
} from "@air-jam/sdk/protocol";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, get as httpGet } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Server as SocketIoServer } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";
import {
  AIR_JAM_COMPLETE_EVALUATION_GATES,
  closeGameSession,
  connectController,
  detectProjectContext,
  disconnectController,
  getDevStatus,
  getTopology,
  inspectGame,
  inspectGameAgentContract,
  inspectProject,
  invokeControllerAction,
  invokeGameAction,
  invokeGameSessionAction,
  listGames,
  listVisualCaptureSummaries,
  listVisualScenarios,
  openGameSession,
  readGameSession,
  readGameSnapshot,
  readRuntimeSnapshot,
  readVisualCaptureSummary,
  resetLocalDev,
  runCompleteEvaluation,
  runQualityGate,
  sendControllerInput,
  sendGameSessionInput,
  startDev,
  stopDev,
} from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempRoots: string[] = [];
const fixtureClosers: Array<() => Promise<void>> = [];
const originalFetch = globalThis.fetch;
const originalKnownPortsEnv = process.env.AIRJAM_DEVTOOLS_KNOWN_PORTS;

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "airjam-devtools-"));
  tempRoots.push(root);
  return root;
};

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const getAvailablePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("No test port was allocated.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });

const waitForHttpOk = async (
  port: number,
  timeoutMs = 5_000,
): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const request = httpGet(`http://127.0.0.1:${port}`, (response) => {
        response.resume();
        resolve(true);
      });
      request.on("error", () => resolve(false));
      request.setTimeout(250, () => {
        request.destroy();
        resolve(false);
      });
    });
    if (ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for test HTTP listener on ${port}.`);
};

const waitForHttpClosed = async (
  port: number,
  timeoutMs = 5_000,
): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const open = await new Promise<boolean>((resolve) => {
      const request = httpGet(`http://127.0.0.1:${port}`, (response) => {
        response.resume();
        resolve(true);
      });
      request.on("error", () => resolve(false));
      request.setTimeout(250, () => {
        request.destroy();
        resolve(false);
      });
    });
    if (!open) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for test HTTP listener ${port} to stop.`);
};

const createStandaloneDevFixture = async (): Promise<{
  root: string;
  port: number;
}> => {
  const root = await createTempRoot();
  const port = await getAvailablePort();
  await writeJson(path.join(root, "package.json"), {
    name: "solo-fixture",
    type: "module",
    scripts: {
      dev: "node dev.mjs",
      topology: "node topology.mjs",
    },
    dependencies: {
      "@air-jam/sdk": "^1.0.0",
    },
  });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "airjam.config.ts"),
    'export const airjam = { controllerPath: "/controller", visualScenariosModule: "./game/contracts/visual-scenarios.mjs" };\n',
    "utf8",
  );
  await writeFile(
    path.join(root, "dev.mjs"),
    `import http from "node:http";

const port = ${port};
const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", \`http://127.0.0.1:\${port}\`);
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (url.pathname === "/controller") {
    response.end(\`<!doctype html><html><body><main>controller</main></body></html>\`);
    return;
  }

  response.end(\`<!doctype html>
  <html>
    <body>
      <main>host</main>
    </body>
  </html>\`);
});

server.listen(port, "127.0.0.1");

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`,
    "utf8",
  );
  await writeFile(
    path.join(root, "topology.mjs"),
    `const port = ${port};
console.log(JSON.stringify({
  mode: "standalone-dev",
  secure: false,
  surfaces: {
    host: {
      runtimeMode: "standalone-dev",
      surfaceRole: "host",
      appOrigin: \`http://127.0.0.1:\${port}\`,
      publicHost: \`http://127.0.0.1:\${port}\`
    },
    controller: {
      runtimeMode: "standalone-dev",
      surfaceRole: "controller",
      appOrigin: \`http://127.0.0.1:\${port}\`,
      publicHost: \`http://127.0.0.1:\${port}\`
    }
  }
}, null, 2));
`,
    "utf8",
  );
  await mkdir(path.join(root, "src", "game", "contracts"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "src", "game", "contracts", "visual-scenarios.mjs"),
    `export const visualScenarios = {
  agent: {},
  scenarios: [
    {
      id: "lobby",
      description: "Fixture lobby state",
      run: async () => {},
    },
  ],
};
`,
    "utf8",
  );

  return { root, port };
};

const createControllerSocketFixture = async ({
  replayStaleDefaultSyncAfterHostAction = false,
  embeddedArcadeIdentity = null,
}: {
  replayStaleDefaultSyncAfterHostAction?: boolean;
  embeddedArcadeIdentity?: {
    epoch: number;
    gameId: string;
  } | null;
} = {}): Promise<{
  root: string;
  joinUrl: string;
  receivedInputs: ControllerInputEvent[];
  receivedActions: ControllerActionRpcPayload[];
  receivedHostActions: HostActionRpcPayload[];
  receivedStateSyncRequests: ControllerStateSyncRequestPayload[];
  receivedLeaves: { roomId: string; controllerId: string }[];
  setStorePayload: (
    storeDomain: string,
    payload: Record<string, unknown>,
  ) => void;
}> => {
  const root = await createTempRoot();
  await writeJson(path.join(root, "package.json"), {
    name: "socket-fixture",
    type: "module",
    scripts: {
      topology: "node topology.mjs",
    },
    dependencies: {
      "@air-jam/sdk": "^1.0.0",
    },
  });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "airjam.config.ts"),
    'import { agentContract } from "./game/contracts/agent";\nexport const airjam = { controllerPath: "/controller", agent: agentContract, visualScenariosModule: "./game/contracts/visual-scenarios.mjs" };\n',
    "utf8",
  );
  await mkdir(path.join(root, "src", "game", "contracts"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "src", "game", "contracts", "agent.ts"),
    `export const agentContract = {
  stores: {
    default: {},
  },
  snapshotDescription: "Fixture game snapshot for devtools tests.",
  projectSnapshot: ({ stores, controllerId }) => {
    const state = stores.default ?? {};
    return {
      phase: state.phase ?? null,
      score: state.score ?? null,
      controllerId,
    };
  },
  actions: {
    set_score: {
      target: {
        kind: "participant",
        actionName: "setScore",
        storeDomain: "default",
      },
      description: "Set the score from a numeric payload.",
      input: {
        parse: (payload) => {
          const score = Number(payload);
          if (!Number.isFinite(score)) {
            throw new Error("expected a finite number payload");
          }
          return score;
        },
        metadata: {
          payload: {
            kind: "number",
            description: "The score to send.",
          },
        },
      },
      toPayload: (score) => ({
          score,
      }),
      resultDescription: "The score action is routed to the host.",
    },
    finish_match: {
      target: {
        kind: "host",
        actionName: "finishMatch",
        storeDomain: "default",
      },
      description: "Finish the active match immediately.",
      input: {
        parse: () => undefined,
        metadata: {
          payload: {
            kind: "none",
            description: null,
          },
        },
      },
      resultDescription: "The fixture snapshot moves to ended.",
    },
  },
};
`,
    "utf8",
  );
  await mkdir(path.join(root, "visual"), { recursive: true });
  await writeFile(
    path.join(root, "visual", "scenarios.mjs"),
    `export const visualScenarios = {
  agent: {},
  scenarios: [
    {
      id: "lobby",
      description: "Socket fixture lobby state",
      run: async () => {},
    },
  ],
};
`,
    "utf8",
  );

  const receivedInputs: ControllerInputEvent[] = [];
  const receivedActions: ControllerActionRpcPayload[] = [];
  const receivedHostActions: HostActionRpcPayload[] = [];
  const receivedStateSyncRequests: ControllerStateSyncRequestPayload[] = [];
  const receivedLeaves: { roomId: string; controllerId: string }[] = [];
  const embeddedGameStoreDomain = embeddedArcadeIdentity
    ? `aj.embedded.game:${embeddedArcadeIdentity.epoch}:${embeddedArcadeIdentity.gameId}`
    : null;
  const storePayloads = new Map<string, Record<string, unknown>>([
    [embeddedGameStoreDomain ?? "default", { phase: "lobby", score: 3 }],
    ["scoreboard", { home: 3, away: 1 }],
    ...(embeddedArcadeIdentity
      ? [
          [
            "arcade.surface",
            {
              epoch: embeddedArcadeIdentity.epoch,
              kind: "game",
              gameId: embeddedArcadeIdentity.gameId,
            },
          ] as const,
        ]
      : []),
  ]);
  const storeRevisions = new Map<string, number>(
    Array.from(storePayloads.keys(), (storeDomain) => [storeDomain, 0]),
  );

  const httpServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body>controller fixture</body></html>");
  });
  const io = new SocketIoServer<ClientToServerEvents, ServerToClientEvents>(
    httpServer,
    {
      cors: {
        origin: "*",
      },
    },
  );

  io.on("connection", (socket) => {
    socket.on("controller:join", (payload, callback) => {
      callback({
        ok: true,
        controllerId: payload.controllerId,
        roomId: payload.roomId,
      });
      socket.emit("server:welcome", {
        controllerId: payload.controllerId,
        roomId: payload.roomId,
        player: {
          id: payload.controllerId,
          label: payload.nickname ?? payload.controllerId,
          avatarId: payload.avatarId,
        },
        players: [
          {
            id: payload.controllerId,
            label: payload.nickname ?? payload.controllerId,
            avatarId: payload.avatarId,
          },
        ],
      });
      socket.emit("server:state", {
        roomId: payload.roomId,
        state: {
          orientation: "landscape",
          runtimeState: "playing",
          stateVersion: 1,
        },
      });
    });

    socket.on("controller:input", (payload) => {
      receivedInputs.push(payload);
    });

    (
      socket as unknown as {
        on: (
          event: string,
          listener: (
            payload: {
              roomId: string;
              actionName: string;
              payload: ControllerActionRpcPayload["payload"];
              storeDomain: string;
            },
            callback?: (ack: {
              ok: true;
              status: "accepted";
              source: "host";
            }) => void,
          ) => void,
        ) => void;
      }
    ).on("controller:action_rpc", (payload, callback) => {
      receivedActions.push(payload);
      callback?.({
        ok: true,
        status: "accepted",
        source: "host",
      });
    });

    (
      socket as unknown as {
        on: (
          event: string,
          listener: (
            payload: HostActionRpcPayload,
            callback?: (ack: {
              ok: true;
              status: "accepted";
              source: "host";
            }) => void,
          ) => void,
        ) => void;
      }
    ).on("controller:host_action_rpc", (payload, callback) => {
      receivedHostActions.push(payload);
      if (payload.actionName === "finishMatch") {
        const targetStoreDomain = payload.storeDomain;
        const previousTargetStore = {
          ...(storePayloads.get(targetStoreDomain) ?? {}),
        };
        const previousTargetRevision =
          storeRevisions.get(targetStoreDomain) ?? 0;
        storePayloads.set(targetStoreDomain, {
          ...previousTargetStore,
          phase: "ended",
        });
        storeRevisions.set(targetStoreDomain, previousTargetRevision + 1);
        if (
          replayStaleDefaultSyncAfterHostAction &&
          targetStoreDomain === "default"
        ) {
          setTimeout(() => {
            socket.emit("airjam:state_sync", {
              roomId: payload.roomId,
              storeDomain: "default",
              data: previousTargetStore,
              revision: previousTargetRevision,
            });
          }, 50);
        }
      }
      callback?.({
        ok: true,
        status: "accepted",
        source: "host",
      });
    });

    socket.on("controller:state_sync_request", (payload) => {
      receivedStateSyncRequests.push(payload);
      const data = storePayloads.get(payload.storeDomain);
      if (!data) {
        return;
      }

      socket.emit("airjam:state_sync", {
        roomId: payload.roomId,
        storeDomain: payload.storeDomain,
        data,
        revision: storeRevisions.get(payload.storeDomain) ?? 0,
        ...(payload.requestId ? { requestId: payload.requestId } : {}),
      });
    });

    (
      socket as unknown as {
        on: (
          event: string,
          listener: (
            payload: { roomId: string; controllerId: string },
            callback: (ack: { ok: true }) => void,
          ) => void,
        ) => void;
      }
    ).on("controller:leave", (payload, callback) => {
      receivedLeaves.push(payload);
      socket.emit("server:controllerLeft", {
        controllerId: payload.controllerId,
      });
      callback({ ok: true });
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve controller socket fixture port."));
        return;
      }
      resolve(address.port);
    });
  });

  await writeFile(
    path.join(root, "topology.mjs"),
    `const port = ${port};
console.log(JSON.stringify({
  mode: "standalone-dev",
  secure: false,
  surfaces: {
    host: {
      runtimeMode: "standalone-dev",
      surfaceRole: "host",
      appOrigin: \`http://127.0.0.1:\${port}\`,
      publicHost: \`http://127.0.0.1:\${port}\`
    },
    controller: {
      runtimeMode: "standalone-dev",
      surfaceRole: "controller",
      appOrigin: \`http://127.0.0.1:\${port}\`,
      publicHost: \`http://127.0.0.1:\${port}\`
    }
  }
}, null, 2));
`,
    "utf8",
  );

  fixtureClosers.push(async () => {
    await new Promise<void>((resolve, reject) => {
      io.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  return {
    root,
    joinUrl: `http://127.0.0.1:${port}/controller?room=ROOM1&aj_controller_cap=cap_fixture`,
    receivedInputs,
    receivedActions,
    receivedHostActions,
    receivedStateSyncRequests,
    receivedLeaves,
    setStorePayload: (storeDomain, payload) => {
      storePayloads.set(storeDomain, payload);
      storeRevisions.set(
        storeDomain,
        (storeRevisions.get(storeDomain) ?? 0) + 1,
      );
    },
  };
};

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalKnownPortsEnv === undefined) {
    delete process.env.AIRJAM_DEVTOOLS_KNOWN_PORTS;
  } else {
    process.env.AIRJAM_DEVTOOLS_KNOWN_PORTS = originalKnownPortsEnv;
  }
  while (fixtureClosers.length > 0) {
    const close = fixtureClosers.pop();
    await close?.();
  }
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("detectProjectContext", () => {
  it("detects the Air Jam monorepo from the repository root", async () => {
    const context = await detectProjectContext({
      cwd: path.resolve(__dirname, "../../.."),
    });

    expect(context.mode).toBe("monorepo");
    expect(context.packageJson?.name).toBe("air-jam");
    expect(context.workspaceRoot).toBe(context.rootDir);
    expect(context.reasons.join(" ")).toContain("monorepo");
  });

  it("detects the Air Jam monorepo from a nested repo game directory", async () => {
    const repoRoot = path.resolve(__dirname, "../../..");
    const canonicalRepoRoot = await realpath(repoRoot);
    const context = await detectProjectContext({
      cwd: path.join(repoRoot, "games", "pong"),
    });

    expect(context.mode).toBe("monorepo");
    expect(context.rootDir).toBe(canonicalRepoRoot);
    expect(context.workspaceRoot).toBe(canonicalRepoRoot);
    expect(context.packageManager).toBe("pnpm");
  });

  it("detects a standalone game fixture", async () => {
    const root = await createTempRoot();
    await writeJson(path.join(root, "package.json"), {
      name: "space-race",
      type: "module",
      scripts: {
        dev: "airjam dev",
        test: "vitest run",
      },
      dependencies: {
        "@air-jam/sdk": "^1.0.0",
      },
    });
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src", "airjam.config.ts"),
      'export const gameMetadata = {}; export const airjam = { controllerPath: "/controller" };\n',
      "utf8",
    );

    const context = await detectProjectContext({ cwd: root });

    expect(context.mode).toBe("standalone-game");
    expect(context.rootDir).toBe(await realpath(root));
    expect(context.workspaceRoot).toBeNull();
    expect(context.packageJson?.name).toBe("space-race");
  });
});

describe("inspectProject", () => {
  it("returns capabilities and Air Jam packages for a standalone project", async () => {
    const root = await createTempRoot();
    await writeJson(path.join(root, "package.json"), {
      name: "solo-game",
      scripts: {
        build: "vite build",
      },
      dependencies: {
        "@air-jam/sdk": "^1.0.0",
      },
      devDependencies: {
        "@air-jam/mcp-server": "^1.0.0",
      },
    });
    await writeFile(path.join(root, "AGENTS.md"), "# Agents\n", "utf8");

    const project = await inspectProject({ cwd: root });

    expect(project.context.mode).toBe("standalone-game");
    expect(project.capabilities).toEqual([
      "project",
      "games",
      "logs",
      "runtime",
      "quality",
      "ai-pack",
    ]);
    expect(project.airJamPackages["@air-jam/sdk"]).toBe("^1.0.0");
    expect(project.airJamPackages["@air-jam/mcp-server"]).toBe("^1.0.0");
    expect(project.files.agents).toBe(
      path.join(await realpath(root), "AGENTS.md"),
    );
  });
});

describe("listGames and inspectGame", () => {
  it("lists repo games from the monorepo manifests", async () => {
    const games = await listGames({ cwd: path.resolve(__dirname, "../../..") });

    expect(games.map((game) => game.id)).toContain("air-capture");
    expect(games.map((game) => game.id)).toContain("pong");
    expect(games.every((game) => game.manifestPath)).toBe(true);
  });

  it("inspects a repo game without loading its TypeScript config", async () => {
    const game = await inspectGame({
      cwd: path.resolve(__dirname, "../../.."),
      gameId: "pong",
    });

    expect(game.id).toBe("pong");
    expect(game.configPath).toMatch(/src\/airjam\.config\.ts$/);
    expect(game.metadataExportLikely).toBe(true);
    expect(game.controllerPathLikely).toBe("/controller");
    expect(game).not.toHaveProperty("visual");
    expect(game.qualityGates).toContain("typecheck");
    expect(game.qualityGates).toContain("release-check");
  });

  it("lists the current game in standalone mode", async () => {
    const root = await createTempRoot();
    await writeJson(path.join(root, "package.json"), {
      name: "solo-game",
      scripts: {
        typecheck: "tsc --noEmit",
        test: "vitest run",
      },
      dependencies: {
        "@air-jam/sdk": "^1.0.0",
      },
    });
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src", "airjam.config.ts"),
      'export const airjam = { controllerPath: "/phone" };\n',
      "utf8",
    );

    const games = await listGames({ cwd: root });
    const game = await inspectGame({ cwd: root });

    expect(games).toHaveLength(1);
    expect(game.id).toBe("solo-game");
    expect(game.controllerPathLikely).toBe("/phone");
    expect(game.qualityGates).toEqual(["typecheck", "test"]);
  });
});

describe("visual capture summaries", () => {
  it("reads an existing repo visual capture summary", async () => {
    const capture = await readVisualCaptureSummary({
      cwd: path.resolve(__dirname, "../../.."),
      gameId: "pong",
    });

    expect(capture.gameId).toBe("pong");
    expect(capture.summary.scenarios.length).toBeGreaterThan(0);
  });

  it("lists available repo visual capture summaries", async () => {
    const captures = await listVisualCaptureSummaries({
      cwd: path.resolve(__dirname, "../../.."),
    });

    expect(captures.map((capture) => capture.gameId)).toContain("pong");
  });
});

describe("runQualityGate", () => {
  it("rejects repo-only gates in standalone mode", async () => {
    const root = await createTempRoot();
    await writeJson(path.join(root, "package.json"), {
      name: "solo-game",
      dependencies: {
        "@air-jam/sdk": "^1.0.0",
      },
    });

    await expect(
      runQualityGate({ cwd: root, gate: "release-check" }),
    ).rejects.toThrow(/only available in the Air Jam monorepo/);
  });
});

describe("runCompleteEvaluation", () => {
  it("runs the canonical four game gates and reports one stable result", async () => {
    const root = await createTempRoot();
    const passingScript = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;
    await writeJson(path.join(root, "package.json"), {
      name: "evaluation-fixture",
      dependencies: { "@air-jam/sdk": "^1.0.0" },
      scripts: {
        typecheck: passingScript,
        lint: passingScript,
        test: passingScript,
        build: passingScript,
      },
    });

    const evaluation = await runCompleteEvaluation({ cwd: root });

    expect(evaluation.contract).toBe("air-jam-complete-evaluation/v1");
    expect(evaluation.status).toBe("passed");
    expect(evaluation.gates.map(({ gate }) => gate)).toEqual(
      AIR_JAM_COMPLETE_EVALUATION_GATES,
    );
    expect(evaluation.gates.every(({ result }) => result.ok)).toBe(true);
  });
});

describe("dev lifecycle and topology", () => {
  it("resolves monorepo topology through the shared runtime CLI", async () => {
    const repoRoot = path.resolve(__dirname, "../../..");

    const topology = await getTopology({
      cwd: repoRoot,
      gameId: "pong",
      mode: "arcade-test",
    });

    expect(topology.projectMode).toBe("monorepo");
    expect(topology.gameId).toBe("pong");
    expect(topology.topologyMode).toBe("arcade-built");
    expect(topology.urls.hostUrl).toContain("/arcade/local-pong");
    expect(topology.urls.localBuildUrl).toContain("/airjam-local-builds/pong");
  });

  it("starts, reports, and stops a managed standalone dev process", async () => {
    const { root, port } = await createStandaloneDevFixture();

    const started = await startDev({ cwd: root });

    try {
      expect(started.reusedExistingProcess).toBe(false);
      expect(started.process.mode).toBe("standalone-dev");
      expect(started.topology.urls.hostUrl).toBe(`http://127.0.0.1:${port}`);
      expect(started.topology.urls.controllerBaseUrl).toBe(
        `http://127.0.0.1:${port}/controller`,
      );

      const status = await getDevStatus({ cwd: root });
      expect(status.processes).toHaveLength(1);
      expect(status.processes[0]?.id).toBe(started.process.id);
      expect(status.knownPorts).toEqual(expect.arrayContaining([4000, 5173]));
      expect(Array.isArray(status.unmanagedProcesses)).toBe(true);

      const topology = await getTopology({ cwd: root });
      expect(topology.process?.id).toBe(started.process.id);
      expect(topology.urls.hostUrl).toBe(`http://127.0.0.1:${port}`);
    } finally {
      await stopDev({ cwd: root, processId: started.process.id });
    }

    const statusAfterStop = await getDevStatus({ cwd: root });
    expect(statusAfterStop.processes).toHaveLength(0);
    await waitForHttpClosed(port);
  });

  it("reports an early managed runtime exit without waiting for the topology timeout", async () => {
    const { root } = await createStandaloneDevFixture();
    await writeFile(
      path.join(root, "dev.mjs"),
      'console.error("fixture managed runtime failed");\nprocess.exit(7);\n',
      "utf8",
    );

    const startedAt = Date.now();
    await expect(startDev({ cwd: root })).rejects.toThrow(
      /Managed dev supervisor exited with code 7[\s\S]*fixture managed runtime failed/,
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    const status = await getDevStatus({ cwd: root });
    expect(status.processes).toHaveLength(0);
  });

  it("reports and resets unmanaged known-port local dev listeners", async () => {
    const root = await createTempRoot();
    const port = await getAvailablePort();
    process.env.AIRJAM_DEVTOOLS_KNOWN_PORTS = String(port);
    await writeJson(path.join(root, "package.json"), {
      name: "unmanaged-dev-listener-fixture",
      dependencies: {
        "@air-jam/sdk": "^1.0.0",
      },
    });
    const scriptPath = path.join(root, "fixture-vite-listener.mjs");
    await writeFile(
      scriptPath,
      `import http from "node:http";
const port = Number(process.argv[2]);
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ok");
});
server.listen(port, "127.0.0.1");
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`,
      "utf8",
    );

    const child = spawn(process.execPath, [scriptPath, String(port)], {
      cwd: root,
      detached: true,
      stdio: "ignore",
    });
    fixtureClosers.push(async () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    });

    await waitForHttpOk(port);

    const status = await getDevStatus({ cwd: root });
    expect(status.knownPorts).toEqual([port]);
    expect(status.unmanagedProcesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pid: child.pid,
          ports: [port],
          managed: false,
        }),
      ]),
    );

    const reset = await resetLocalDev({ cwd: root });
    expect(reset.knownPorts).toEqual([port]);
    expect(reset.stoppedUnmanaged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pid: child.pid,
          ports: [port],
        }),
      ]),
    );
  });
});

describe("visual scenarios", () => {
  it("does not publish visual scenarios for repo games by default", async () => {
    await expect(
      listVisualScenarios({
        cwd: path.resolve(__dirname, "../../.."),
        gameId: "pong",
      }),
    ).rejects.toThrow(/No visual scenarios published/);
  });

  it("lists explicitly published visual scenarios for an internal fixture", async () => {
    const root = await createTempRoot();
    await writeJson(path.join(root, "package.json"), {
      name: "published-visual-fixture",
      type: "module",
      dependencies: {
        "@air-jam/sdk": "^1.0.0",
      },
    });
    await mkdir(path.join(root, "src", "game", "contracts"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "src", "airjam.config.ts"),
      'export const airjam = { metadata: { slug: "published-visual-fixture" }, controllerPath: "/controller", visualScenariosModule: "./game/contracts/visual-scenarios" };\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "game", "contracts", "visual-scenarios.ts"),
      "export const visualScenarios = { agent: {}, scenarios: [{ id: 'lobby', description: 'Lobby state', run: async () => {} }] };\n",
      "utf8",
    );

    const scenarios = await listVisualScenarios({
      cwd: root,
    });

    expect(scenarios.gameId).toBe("published-visual-fixture");
    expect(scenarios.scenarioModulePath).toMatch(
      /game\/contracts\/visual-scenarios(?:\.ts)?$/,
    );
    expect(scenarios.scenarios.map((scenario) => scenario.scenarioId)).toEqual([
      "lobby",
    ]);
  });

  it("does not fall back to visual scenario files when config does not publish them", async () => {
    const root = await createTempRoot();
    await writeJson(path.join(root, "package.json"), {
      name: "unpublished-visual-fixture",
      type: "module",
      dependencies: {
        "@air-jam/sdk": "^1.0.0",
      },
    });
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "visual"), { recursive: true });
    await writeFile(
      path.join(root, "src", "airjam.config.ts"),
      'export const airjam = { controllerPath: "/controller" };\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "visual", "scenarios.ts"),
      "export const visualScenarios = { agent: {}, scenarios: [] };\n",
      "utf8",
    );

    await expect(listVisualScenarios({ cwd: root })).rejects.toThrow(
      /No visual scenarios published/,
    );
  });
});

describe("virtual controller runtime control", () => {
  it("connects a virtual controller, sends input, invokes actions, reads synced runtime state, and disconnects", async () => {
    const fixture = await createControllerSocketFixture();

    const connected = await connectController({
      cwd: fixture.root,
      controllerJoinUrl: fixture.joinUrl,
      nickname: "DevCtrl",
      avatarId: "aj-2",
    });

    expect(connected.roomId).toBe("ROOM1");
    expect(connected.connected).toBe(true);
    expect(connected.controllerState?.runtimeState).toBe("playing");
    expect(connected.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: connected.controllerId,
          label: "DevCtrl",
          avatarId: "aj-2",
        }),
      ]),
    );

    const inputResult = await sendControllerInput({
      controllerSessionId: connected.controllerSessionId,
      input: {
        buttons: {
          confirm: true,
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(inputResult.controllerId).toBe(connected.controllerId);
    expect(fixture.receivedInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          roomId: "ROOM1",
          controllerId: connected.controllerId,
          input: {
            buttons: {
              confirm: true,
            },
          },
        }),
      ]),
    );

    const actionResult = await invokeControllerAction({
      controllerSessionId: connected.controllerSessionId,
      actionName: "joinTeam",
      storeDomain: "default",
      payload: {
        team: "blue",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(actionResult.actionName).toBe("joinTeam");
    expect(actionResult.acknowledgement).toEqual({
      ok: true,
      status: "accepted",
      source: "host",
    });
    expect(fixture.receivedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          roomId: "ROOM1",
          actionName: "joinTeam",
          storeDomain: "default",
          payload: {
            team: "blue",
          },
        }),
      ]),
    );

    const runtimeSnapshot = await readRuntimeSnapshot({
      controllerSessionId: connected.controllerSessionId,
      storeDomains: ["default", "scoreboard"],
      requestSync: true,
      timeoutMs: 1_000,
    });
    expect(runtimeSnapshot.requestedStoreDomains).toEqual([
      "default",
      "scoreboard",
    ]);
    expect(runtimeSnapshot.missingStoreDomains).toEqual([]);
    expect(runtimeSnapshot.storeSnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storeDomain: "default",
          data: {
            phase: "lobby",
            score: 3,
          },
        }),
        expect.objectContaining({
          storeDomain: "scoreboard",
          data: {
            home: 3,
            away: 1,
          },
        }),
      ]),
    );
    expect(fixture.receivedStateSyncRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          roomId: "ROOM1",
          storeDomain: "default",
        }),
        expect.objectContaining({
          roomId: "ROOM1",
          storeDomain: "scoreboard",
        }),
      ]),
    );

    const disconnected = await disconnectController({
      controllerSessionId: connected.controllerSessionId,
    });
    expect(disconnected.disconnected).toBe(true);
    expect(disconnected.session.connected).toBe(false);
    expect(fixture.receivedLeaves).toEqual([
      expect.objectContaining({
        roomId: "ROOM1",
        controllerId: connected.controllerId,
      }),
    ]);

    await expect(
      readRuntimeSnapshot({
        controllerSessionId: connected.controllerSessionId,
      }),
    ).rejects.toThrow(/Unknown Air Jam controller session/);
  });
});

describe("agent contracts", () => {
  it("inspects a repo agent contract", async () => {
    const contract = await inspectGameAgentContract({
      cwd: path.resolve(__dirname, "../../.."),
      gameId: "last-band-standing",
    });

    expect(contract.hasContract).toBe(true);
    expect(contract.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: "set_ready",
          target: expect.objectContaining({
            actionName: "setReady",
          }),
        }),
        expect.objectContaining({
          actionId: "submit_guess",
          target: expect.objectContaining({
            actionName: "submitGuess",
          }),
        }),
      ]),
    );
  });

  it("inspects a second repo agent contract", async () => {
    const contract = await inspectGameAgentContract({
      cwd: path.resolve(__dirname, "../../.."),
      gameId: "pong",
    });

    expect(contract.hasContract).toBe(true);
    expect(contract.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: "join_team",
          target: expect.objectContaining({
            actionName: "joinTeam",
          }),
        }),
        expect.objectContaining({
          actionId: "award_point",
          target: expect.objectContaining({
            actionName: "scorePoint",
          }),
        }),
      ]),
    );
  });

  it("projects a game snapshot and invokes semantic game actions through a controller session", async () => {
    const fixture = await createControllerSocketFixture();

    const connected = await connectController({
      cwd: fixture.root,
      gameId: "socket-fixture",
      controllerJoinUrl: fixture.joinUrl,
      nickname: "AgentCtrl",
    });

    const projected = await readGameSnapshot({
      controllerSessionId: connected.controllerSessionId,
      requestSync: true,
      timeoutMs: 1_000,
    });
    expect(projected.snapshotStoreDomains).toEqual(["default"]);
    expect(projected.snapshot).toMatchObject({
      phase: "lobby",
      score: 3,
      controllerId: connected.controllerId,
    });

    const invoked = await invokeGameAction({
      controllerSessionId: connected.controllerSessionId,
      actionId: "set_score",
      payload: 7,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(invoked.actionId).toBe("set_score");
    expect(invoked.actionName).toBe("setScore");
    expect(invoked.storeDomain).toBe("default");
    expect(invoked.acknowledgement).toEqual({
      ok: true,
      status: "accepted",
      source: "host",
    });
    expect(fixture.receivedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionName: "setScore",
          storeDomain: "default",
          payload: {
            score: 7,
          },
        }),
      ]),
    );

    await disconnectController({
      controllerSessionId: connected.controllerSessionId,
    });
  }, 20_000);

  it("does not infer an agent contract from a file that config does not publish", async () => {
    const root = await createTempRoot();
    await writeJson(path.join(root, "package.json"), {
      name: "unpublished-agent-fixture",
      type: "module",
      dependencies: {
        "@air-jam/sdk": "^1.0.0",
      },
    });
    await mkdir(path.join(root, "src", "game", "contracts"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "src", "airjam.config.ts"),
      'export const airjam = { controllerPath: "/controller" };\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "game", "contracts", "agent.ts"),
      `export const agentContract = {
  stores: {
    default: {},
  },
  projectSnapshot: ({ stores }) => stores.default ?? {},
  actions: {},
};\n`,
      "utf8",
    );

    const contract = await inspectGameAgentContract({ cwd: root });

    expect(contract.hasContract).toBe(false);
    expect(contract.actions).toEqual([]);
  });
});

describe("game sessions", () => {
  it("opens a semantic game session through the built package entry", async () => {
    const fixture = await createControllerSocketFixture();
    const builtModule = await import(
      `${pathToFileURL(path.join(__dirname, "../dist/index.js")).href}?built-session-smoke`
    );

    const session = await builtModule.openGameSession({
      cwd: fixture.root,
      gameId: "socket-fixture",
      controllerJoinUrl: fixture.joinUrl,
      nickname: "BuiltCtrl",
    });

    expect(session.gameId).toBe("socket-fixture");
    expect(session.hasAgentContract).toBe(true);
    expect(session.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: "player:set_score",
          lane: "player",
        }),
      ]),
    );

    await builtModule.closeGameSession({
      gameSessionId: session.gameSessionId,
    });
  });

  it("infers the standalone game id when opening a semantic session without an explicit gameId", async () => {
    const fixture = await createControllerSocketFixture();

    const session = await openGameSession({
      cwd: fixture.root,
      controllerJoinUrl: fixture.joinUrl,
      nickname: "ImplicitGameCtrl",
    });

    expect(session.gameId).toBe("socket-fixture");
    expect(session.hasAgentContract).toBe(true);
    expect(session.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: "player:set_score",
          lane: "player",
        }),
      ]),
    );

    await closeGameSession({
      gameSessionId: session.gameSessionId,
    });
  });

  it("opens a semantic game session and routes game actions through one high-level handle", async () => {
    const fixture = await createControllerSocketFixture();

    const session = await openGameSession({
      cwd: fixture.root,
      gameId: "socket-fixture",
      controllerJoinUrl: fixture.joinUrl,
      nickname: "AgentCtrl",
    });

    expect(session.gameId).toBe("socket-fixture");
    expect(session.hasAgentContract).toBe(true);
    expect(session.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: "player:set_score",
          lane: "player",
        }),
      ]),
    );

    const inspection = await readGameSession({
      gameSessionId: session.gameSessionId,
      requestSync: true,
      timeoutMs: 1_000,
    });
    expect(inspection.gameSnapshot?.snapshot).toMatchObject({
      phase: "lobby",
      score: 3,
    });

    const inputResult = await sendGameSessionInput({
      gameSessionId: session.gameSessionId,
      input: {
        moveX: 1,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(inputResult.input).toMatchObject({ moveX: 1 });
    expect(fixture.receivedInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: {
            moveX: 1,
          },
        }),
      ]),
    );

    const invocation = await invokeGameSessionAction({
      gameSessionId: session.gameSessionId,
      actionId: "player:set_score",
      payload: 9,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(invocation.actionId).toBe("player:set_score");
    expect(invocation.lane).toBe("player");
    expect(fixture.receivedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionName: "setScore",
          storeDomain: "default",
          payload: {
            score: 9,
          },
        }),
      ]),
    );

    const closed = await closeGameSession({
      gameSessionId: session.gameSessionId,
    });
    expect(closed.closed).toBe(true);
    expect(closed.session.connected).toBe(false);
  });

  it("discovers the active Arcade game and maps its logical default store to the embedded runtime domain", async () => {
    const embeddedStoreDomain = "aj.embedded.game:7:socket-fixture";
    const fixture = await createControllerSocketFixture({
      embeddedArcadeIdentity: {
        epoch: 7,
        gameId: "socket-fixture",
      },
    });

    const session = await openGameSession({
      cwd: fixture.root,
      gameId: "stale-topology-game",
      mode: "arcade-dev",
      controllerJoinUrl: fixture.joinUrl,
      nickname: "ArcadeAgentCtrl",
      timeoutMs: 1_000,
    });

    expect(session.gameId).toBe("socket-fixture");

    const inspection = await readGameSession({
      gameSessionId: session.gameSessionId,
      requestSync: true,
      timeoutMs: 1_000,
    });
    expect(inspection.gameSnapshot).toMatchObject({
      gameId: "socket-fixture",
      snapshotStoreDomains: ["default"],
      runtimeStoreDomains: [embeddedStoreDomain],
      storeDomainBindings: [
        {
          contractStoreDomain: "default",
          runtimeStoreDomain: embeddedStoreDomain,
        },
      ],
      snapshot: {
        phase: "lobby",
        score: 3,
      },
    });

    await invokeGameSessionAction({
      gameSessionId: session.gameSessionId,
      actionId: "player:set_score",
      payload: 9,
      timeoutMs: 1_000,
    });
    expect(fixture.receivedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionName: "setScore",
          storeDomain: embeddedStoreDomain,
        }),
      ]),
    );

    const hostInvocation = await invokeGameSessionAction({
      gameSessionId: session.gameSessionId,
      actionId: "host:finish_match",
      timeoutMs: 1_000,
    });
    expect(hostInvocation.invocation).toEqual(
      expect.objectContaining({
        storeDomain: embeddedStoreDomain,
        acknowledgement: expect.objectContaining({
          ok: true,
          status: "accepted",
          source: "host",
        }),
        snapshotAfter: expect.objectContaining({
          snapshot: expect.objectContaining({
            phase: "ended",
          }),
        }),
      }),
    );

    await closeGameSession({
      gameSessionId: session.gameSessionId,
    });
  });

  it("rejects Arcade semantic sessions that do not expose an active surface instead of using a stale game ID", async () => {
    const fixture = await createControllerSocketFixture();

    await expect(
      openGameSession({
        cwd: fixture.root,
        gameId: "stale-topology-game",
        mode: "arcade-dev",
        controllerJoinUrl: fixture.joinUrl,
        nickname: "ArcadeAgentCtrl",
        timeoutMs: 50,
      }),
    ).rejects.toThrow('did not expose a valid "arcade.surface" snapshot');
    expect(fixture.receivedLeaves).toHaveLength(1);
  });

  it("exposes and invokes semantic host actions through the game contract", async () => {
    const fixture = await createControllerSocketFixture();

    const session = await openGameSession({
      cwd: fixture.root,
      gameId: "socket-fixture",
      controllerJoinUrl: fixture.joinUrl,
      nickname: "AgentHostCtrl",
    });

    expect(session.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: "host:finish_match",
          lane: "host",
          source: "semantic-game",
        }),
      ]),
    );

    const invocation = await invokeGameSessionAction({
      gameSessionId: session.gameSessionId,
      actionId: "host:finish_match",
      timeoutMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(invocation.actionId).toBe("host:finish_match");
    expect(invocation.lane).toBe("host");
    expect(invocation.invocation).toEqual(
      expect.objectContaining({
        lane: "host",
        actionName: "finishMatch",
        acknowledgement: expect.objectContaining({
          ok: true,
          status: "accepted",
          source: "host",
        }),
        acknowledgementObservation: "host-acknowledged",
        outcome: "accepted",
        snapshotBefore: expect.objectContaining({
          snapshot: expect.objectContaining({
            phase: "lobby",
          }),
        }),
        snapshotAfter: expect.objectContaining({
          snapshot: expect.objectContaining({
            phase: "ended",
          }),
        }),
      }),
    );
    expect(fixture.receivedHostActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionName: "finishMatch",
          storeDomain: "default",
        }),
      ]),
    );

    await closeGameSession({
      gameSessionId: session.gameSessionId,
    });
  });

  it("keeps request-synced game reads fresh even if an older state sync arrives later", async () => {
    const fixture = await createControllerSocketFixture({
      replayStaleDefaultSyncAfterHostAction: true,
    });

    const session = await openGameSession({
      cwd: fixture.root,
      gameId: "socket-fixture",
      controllerJoinUrl: fixture.joinUrl,
      nickname: "FreshnessCtrl",
    });

    const invocation = await invokeGameSessionAction({
      gameSessionId: session.gameSessionId,
      actionId: "host:finish_match",
      timeoutMs: 5_000,
    });

    expect(invocation.invocation.snapshotAfter).not.toBeNull();
    expect(invocation.invocation.snapshotAfter?.snapshot).toEqual(
      expect.objectContaining({
        phase: "ended",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    const inspection = await readGameSession({
      gameSessionId: session.gameSessionId,
      requestSync: true,
      timeoutMs: 5_000,
    });

    expect(inspection.gameSnapshot?.snapshot).toEqual(
      expect.objectContaining({
        phase: "ended",
      }),
    );

    await closeGameSession({
      gameSessionId: session.gameSessionId,
    });
  });
});
