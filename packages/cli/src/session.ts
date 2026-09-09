import { inspectProject } from "@air-jam/devtools-core/context";
import {
  readGameSessionBrokerState,
  requestGameSessionBroker,
  resolveGameSessionBrokerStatePath,
  runGameSessionBroker,
  type AirJamGameSessionBrokerHealth,
  type AirJamGameSessionBrokerOperation,
  type AirJamGameSessionBrokerState,
} from "@air-jam/devtools-core/game-session-broker";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";

const BROKER_START_TIMEOUT_MS = 10_000;

const resolveProjectDir = async (dir?: string): Promise<string> => {
  const project = await inspectProject({ cwd: dir });
  return project.context.rootDir;
};

const readHealth = async (
  state: AirJamGameSessionBrokerState,
): Promise<AirJamGameSessionBrokerHealth | null> =>
  requestGameSessionBroker<AirJamGameSessionBrokerHealth>({
    state,
    request: { operation: "health" },
  }).catch(() => null);

const ensureBroker = async (
  projectDir: string,
): Promise<AirJamGameSessionBrokerState> => {
  const existing = await readGameSessionBrokerState(projectDir);
  if (existing && (await readHealth(existing))) {
    return existing;
  }

  await unlink(resolveGameSessionBrokerStatePath(projectDir)).catch(
    () => undefined,
  );
  const entryPath = process.argv[1];
  if (!entryPath) {
    throw new Error("Cannot resolve the current airjam CLI entrypoint.");
  }
  const logDir = path.join(projectDir, ".airjam", "logs");
  mkdirSync(logDir, { recursive: true });
  const logFd = openSync(
    path.join(logDir, "game-session-broker.log"),
    "a",
    0o600,
  );
  try {
    const child = spawn(
      process.execPath,
      [entryPath, "__session-broker", "--dir", projectDir],
      {
        cwd: projectDir,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      },
    );
    child.unref();
  } finally {
    closeSync(logFd);
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < BROKER_START_TIMEOUT_MS) {
    const state = await readGameSessionBrokerState(projectDir);
    if (state && (await readHealth(state))) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `Air Jam game session broker did not start. Inspect ${path.join(logDir, "game-session-broker.log")}.`,
  );
};

const request = async <TResult>({
  dir,
  operation,
}: {
  dir?: string;
  operation: AirJamGameSessionBrokerOperation;
}): Promise<TResult> => {
  const projectDir = await resolveProjectDir(dir);
  const state = await ensureBroker(projectDir);
  return requestGameSessionBroker<TResult>({ state, request: operation });
};

export const parseJsonValue = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const parseJsonObject = (value: string): Record<string, unknown> => {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
};

export const runSessionBrokerProcess = async (dir: string): Promise<void> => {
  await runGameSessionBroker({ projectDir: path.resolve(dir) });
};

export const runSessionBrokerStatus = async ({
  dir,
}: {
  dir?: string;
}): Promise<unknown> => {
  const projectDir = await resolveProjectDir(dir);
  const state = await readGameSessionBrokerState(projectDir);
  if (!state) {
    return { running: false, projectDir };
  }
  const health = await readHealth(state);
  return health
    ? { running: true, ...health }
    : { running: false, projectDir, staleState: true, pid: state.pid };
};

export const runSessionBrokerStop = async ({
  dir,
}: {
  dir?: string;
}): Promise<unknown> => {
  const projectDir = await resolveProjectDir(dir);
  const state = await readGameSessionBrokerState(projectDir);
  if (!state || !(await readHealth(state))) {
    await unlink(resolveGameSessionBrokerStatePath(projectDir)).catch(
      () => undefined,
    );
    return { stopped: false, running: false, projectDir };
  }
  return requestGameSessionBroker({
    state,
    request: { operation: "shutdown" },
  });
};

export const openSession = async ({
  dir,
  ...input
}: {
  dir?: string;
  gameId?: string;
  mode?: "standalone-dev" | "arcade-dev" | "arcade-test";
  secure?: boolean;
  roomId?: string;
  controllerJoinUrl?: string;
  timeoutMs?: number;
}): Promise<unknown> =>
  request({ dir, operation: { operation: "open", input } });

export const readSession = async ({
  dir,
  gameSessionId,
  requestSync = true,
  timeoutMs,
}: {
  dir?: string;
  gameSessionId: string;
  requestSync?: boolean;
  timeoutMs?: number;
}): Promise<unknown> =>
  request({
    dir,
    operation: {
      operation: "read",
      input: { gameSessionId, requestSync, timeoutMs },
    },
  });

export const sendSessionInput = async ({
  dir,
  gameSessionId,
  input,
}: {
  dir?: string;
  gameSessionId: string;
  input: Record<string, unknown>;
}): Promise<unknown> =>
  request({
    dir,
    operation: { operation: "input", input: { gameSessionId, input } },
  });

export const invokeSessionAction = async ({
  dir,
  gameSessionId,
  actionId,
  payload,
  timeoutMs,
}: {
  dir?: string;
  gameSessionId: string;
  actionId: string;
  payload?: unknown;
  timeoutMs?: number;
}): Promise<unknown> =>
  request({
    dir,
    operation: {
      operation: "invoke",
      input: { gameSessionId, actionId, payload, timeoutMs },
    },
  });

export const captureSessionVisuals = async ({
  dir,
  gameSessionId,
  timeoutMs,
}: {
  dir?: string;
  gameSessionId: string;
  timeoutMs?: number;
}): Promise<unknown> =>
  request({
    dir,
    operation: {
      operation: "capture",
      input: { gameSessionId, timeoutMs },
    },
  });

export const closeSession = async ({
  dir,
  gameSessionId,
}: {
  dir?: string;
  gameSessionId: string;
}): Promise<unknown> =>
  request({
    dir,
    operation: { operation: "close", input: { gameSessionId } },
  });
