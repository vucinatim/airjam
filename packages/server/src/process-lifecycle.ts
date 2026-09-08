import type { AirJamServerRuntime } from "./index.js";
import { createServerLogger, type ServerLogger } from "./logging/logger.js";

type ShutdownSignal = "SIGINT" | "SIGTERM";

export const installServerProcessSignalHandlers = ({
  runtime,
  logger = createServerLogger({
    service: "air-jam-server",
    component: "process-lifecycle",
  }),
}: {
  runtime: AirJamServerRuntime;
  logger?: ServerLogger;
}): (() => void) => {
  let shutdownPromise: Promise<void> | null = null;
  let unsubscribeTerminalFailure: (() => void) | null = null;

  const removeHandlers = (): void => {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    unsubscribeTerminalFailure?.();
    unsubscribeTerminalFailure = null;
  };

  const shutdown = ({
    signal,
    failureMessage,
  }: {
    signal?: ShutdownSignal;
    failureMessage?: string;
  }): void => {
    if (shutdownPromise) return;
    if (failureMessage) process.exitCode = 1;
    removeHandlers();
    shutdownPromise = (async () => {
      logger.info(
        { signal, failureMessage },
        failureMessage
          ? "Realtime authority failed; server started bounded drain"
          : "Realtime server started graceful drain",
      );
      const result = await runtime.drain();
      logger.info(
        { signal, failureMessage, ...result },
        result.completed
          ? "Realtime server drain completed"
          : "Realtime server drain reached its bounded timeout",
      );
      await runtime.stop();
    })().catch(async (error) => {
      process.exitCode = 1;
      logger.error(
        { err: error, signal, failureMessage },
        "Realtime server shutdown failed",
      );
      try {
        await runtime.stop();
      } catch (stopError) {
        logger.error(
          { err: stopError, signal },
          "Realtime server forced cleanup failed",
        );
      }
    });
  };

  const handleSignal = (signal: ShutdownSignal): void => shutdown({ signal });

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  unsubscribeTerminalFailure = runtime.onTerminalFailure((failure) => {
    shutdown({ failureMessage: failure.message });
  });
  return removeHandlers;
};
