#!/usr/bin/env node

/**
 * CLI entry point for @air-jam/server
 * Handles environment variable loading and starts the server
 */

import { formatEnvValidationError, isEnvValidationError } from "@air-jam/env";
import { AIRJAM_DEV_LOG_EVENTS } from "@air-jam/sdk/protocol";
import { Command } from "commander";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadWorkspaceEnv } from "./env/load-workspace-env.js";
import type { AirJamServerRuntime } from "./index.js";
import {
  coerceDevLogsCliOptions,
  configureDevLogsCommand,
  executeDevLogsCliOptions,
} from "./logging/dev-logs-cli.js";
import { createServerLogger } from "./logging/logger.js";
import { AIR_JAM_SERVER_VERSION } from "./version.js";

const runServer = async (): Promise<number> => {
  let runtime: AirJamServerRuntime | null = null;
  try {
    loadWorkspaceEnv();
    const { createAirJamServer } = await import("./index.js");
    const { installServerProcessSignalHandlers } = await import(
      "./process-lifecycle.js"
    );
    runtime = createAirJamServer();
    await runtime.start();
    installServerProcessSignalHandlers({ runtime });
    return 0;
  } catch (error) {
    try {
      await runtime?.stop();
    } catch {
      // The original startup failure remains the actionable error.
    }
    if (isEnvValidationError(error)) {
      console.error(
        formatEnvValidationError(error, {
          docsHint:
            "Fix the listed AIR_JAM_* variables and retry. For local dev, check .env.local or packages/server/.env.",
        }),
      );
      return 1;
    }

    const logger = createServerLogger({ service: "air-jam-server" });
    logger.error(
      { event: AIRJAM_DEV_LOG_EVENTS.server.startupFailed, err: error },
      "Failed to start server",
    );
    return 1;
  }
};

export const normalizeCliArgv = (argv: string[]): string[] => {
  if (argv.length >= 4 && argv[2] === "logs" && argv[3] === "--") {
    return [argv[0], argv[1], argv[2], ...argv.slice(4)];
  }

  return argv;
};

export const createServerCli = (): Command => {
  const program = new Command();
  program
    .name("air-jam-server")
    .description("Air Jam development and production server")
    .version(AIR_JAM_SERVER_VERSION)
    .action(async () => {
      process.exitCode = await runServer();
    });

  program
    .command("start")
    .description("Start the Air Jam server")
    .action(async () => {
      process.exitCode = await runServer();
    });

  configureDevLogsCommand(program.command("logs")).action(async (options) => {
    loadWorkspaceEnv();
    process.exitCode = await executeDevLogsCliOptions(
      coerceDevLogsCliOptions(options as Record<string, unknown>),
    );
  });

  return program;
};

export const formatCliHelp = (): string => createServerCli().helpInformation();

export const runServerCli = async (): Promise<number> => {
  await createServerCli().parseAsync(normalizeCliArgv(process.argv));
  const exitCode = process.exitCode;
  if (typeof exitCode === "number") {
    return exitCode;
  }
  return exitCode ? Number(exitCode) : 0;
};

const resolveIsDirectRun = (): boolean => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  if (pathToFileURL(entry).href === import.meta.url) {
    return true;
  }

  const entryBaseName = path.basename(entry);
  return entryBaseName === "air-jam-server" || entryBaseName === "cli.js";
};

const isDirectRun = resolveIsDirectRun();

if (isDirectRun) {
  void runServerCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
