import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import {
  captureGameSessionVisuals,
  closeGameSession,
  invokeGameSessionAction,
  openGameSession,
  readGameSession,
  sendGameSessionInput,
} from "./game-session.js";
import type {
  CaptureGameSessionVisualsOptions,
  CloseGameSessionOptions,
  InvokeGameSessionActionOptions,
  OpenGameSessionOptions,
  ReadGameSessionOptions,
  SendGameSessionInputOptions,
} from "./types.js";

export type AirJamGameSessionBrokerState = {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  projectDir: string;
  origin: string;
  secret: string;
  startedAt: string;
};

export type AirJamGameSessionBrokerOperation =
  | { operation: "health"; input?: undefined }
  | { operation: "open"; input: OpenGameSessionOptions }
  | { operation: "read"; input: ReadGameSessionOptions }
  | { operation: "input"; input: SendGameSessionInputOptions }
  | { operation: "invoke"; input: InvokeGameSessionActionOptions }
  | { operation: "capture"; input: CaptureGameSessionVisualsOptions }
  | { operation: "close"; input: CloseGameSessionOptions }
  | { operation: "shutdown"; input?: undefined };

export type AirJamGameSessionBrokerHealth = {
  ok: true;
  instanceId: string;
  pid: number;
  projectDir: string;
  activeSessionCount: number;
  startedAt: string;
};

const BROKER_STATE_RELATIVE_PATH = path.join(
  ".airjam",
  "devtools",
  "game-session-broker.json",
);
const REQUEST_BODY_LIMIT_BYTES = 1_048_576;

export const resolveGameSessionBrokerStatePath = (projectDir: string): string =>
  path.join(projectDir, BROKER_STATE_RELATIVE_PATH);

export const readGameSessionBrokerState = async (
  projectDir: string,
): Promise<AirJamGameSessionBrokerState | null> => {
  try {
    const value = JSON.parse(
      await readFile(resolveGameSessionBrokerStatePath(projectDir), "utf8"),
    ) as Partial<AirJamGameSessionBrokerState>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.instanceId !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.projectDir !== "string" ||
      typeof value.origin !== "string" ||
      typeof value.secret !== "string" ||
      typeof value.startedAt !== "string"
    ) {
      return null;
    }
    return value as AirJamGameSessionBrokerState;
  } catch {
    return null;
  }
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > REQUEST_BODY_LIMIT_BYTES) {
      throw new Error("Game session broker request exceeds 1 MiB.");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void => {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(value)}\n`);
};

export const requestGameSessionBroker = async <TResult>({
  state,
  request,
}: {
  state: AirJamGameSessionBrokerState;
  request: AirJamGameSessionBrokerOperation;
}): Promise<TResult> => {
  const timeoutMs =
    request.operation === "open"
      ? Math.max(120_000, (request.input.timeoutMs ?? 0) + 60_000)
      : request.operation === "read" ||
          request.operation === "invoke" ||
          request.operation === "capture"
        ? Math.max(30_000, (request.input.timeoutMs ?? 0) + 10_000)
        : 30_000;
  const response = await fetch(`${state.origin}/v1/game-session`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${state.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = (await response.json()) as {
    ok?: boolean;
    result?: TResult;
    error?: { message?: string };
  };
  if (!response.ok || result.ok !== true) {
    throw new Error(
      result.error?.message ??
        `Game session broker request failed with HTTP ${response.status}.`,
    );
  }
  return result.result as TResult;
};

export const runGameSessionBroker = async ({
  projectDir,
}: {
  projectDir: string;
}): Promise<void> => {
  const resolvedProjectDir = path.resolve(projectDir);
  const statePath = resolveGameSessionBrokerStatePath(resolvedProjectDir);
  const instanceId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const startedAt = new Date().toISOString();
  const activeSessionIds = new Set<string>();
  let shuttingDown = false;
  let shutdownCleanup: Promise<void> = Promise.resolve();

  const closeActiveSessions = async (): Promise<void> => {
    await Promise.all(
      [...activeSessionIds].map((gameSessionId) =>
        closeGameSession({ gameSessionId }).catch(() => undefined),
      ),
    );
    activeSessionIds.clear();
  };

  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/game-session") {
      writeJson(response, 404, { ok: false, error: { message: "Not found." } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${secret}`) {
      writeJson(response, 401, {
        ok: false,
        error: { message: "Invalid game session broker credentials." },
      });
      return;
    }

    try {
      const operation = (await readJsonBody(
        request,
      )) as AirJamGameSessionBrokerOperation;
      let result: unknown;
      switch (operation.operation) {
        case "health":
          result = {
            ok: true,
            instanceId,
            pid: process.pid,
            projectDir: resolvedProjectDir,
            activeSessionCount: activeSessionIds.size,
            startedAt,
          } satisfies AirJamGameSessionBrokerHealth;
          break;
        case "open": {
          const opened = await openGameSession({
            ...operation.input,
            cwd: resolvedProjectDir,
          });
          activeSessionIds.add(opened.gameSessionId);
          result = opened;
          break;
        }
        case "read":
          result = await readGameSession(operation.input);
          break;
        case "input":
          result = await sendGameSessionInput(operation.input);
          break;
        case "invoke":
          result = await invokeGameSessionAction(operation.input);
          break;
        case "capture":
          result = await captureGameSessionVisuals(operation.input);
          break;
        case "close":
          result = await closeGameSession(operation.input);
          activeSessionIds.delete(operation.input.gameSessionId);
          break;
        case "shutdown":
          await closeActiveSessions();
          result = { stopped: true, instanceId };
          shuttingDown = true;
          break;
        default:
          throw new Error("Unknown game session broker operation.");
      }
      writeJson(response, 200, { ok: true, result });
      if (shuttingDown) {
        server.close();
      }
    } catch (error) {
      writeJson(response, 400, {
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  const cleanupState = async (): Promise<void> => {
    const current = await readGameSessionBrokerState(resolvedProjectDir);
    if (current?.instanceId === instanceId) {
      await unlink(statePath).catch(() => undefined);
    }
  };
  const stop = (): void => {
    if (!shuttingDown) {
      shuttingDown = true;
      server.close();
      shutdownCleanup = closeActiveSessions();
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", async () => {
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Game session broker did not bind a TCP port.");
        }
        const state: AirJamGameSessionBrokerState = {
          schemaVersion: 1,
          instanceId,
          pid: process.pid,
          projectDir: resolvedProjectDir,
          origin: `http://127.0.0.1:${address.port}`,
          secret,
          startedAt,
        };
        await mkdir(path.dirname(statePath), { recursive: true });
        await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await chmod(statePath, 0o600);
      } catch (error) {
        server.close();
        reject(error);
      }
    });
    server.once("close", resolve);
  });

  await shutdownCleanup;
  await cleanupState();
};
