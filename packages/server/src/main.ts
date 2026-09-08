import { formatEnvValidationError, isEnvValidationError } from "@air-jam/env";
import { loadWorkspaceEnv } from "./env/load-workspace-env.js";
import type { AirJamServerRuntime } from "./index.js";
import { createServerLogger } from "./logging/logger.js";

const main = async (): Promise<void> => {
  let runtime: AirJamServerRuntime | null = null;
  try {
    loadWorkspaceEnv();
    const { createAirJamServer } = await import("./index.js");
    const { installServerProcessSignalHandlers } =
      await import("./process-lifecycle.js");
    runtime = createAirJamServer();
    await runtime.start();
    installServerProcessSignalHandlers({ runtime });
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
      process.exitCode = 1;
      return;
    }

    const logger = createServerLogger({ service: "air-jam-server" });
    logger.error({ err: error }, "Failed to start server");
    process.exitCode = 1;
  }
};

void main();
