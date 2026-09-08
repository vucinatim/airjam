import { REALTIME_ADMISSION_POLICY } from "@air-jam/database-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AirJamServerRuntime } from "../src/index";
import type { ServerLogger } from "../src/logging/logger";
import { installServerProcessSignalHandlers } from "../src/process-lifecycle";
import type { RealtimeAdmissionTerminalFailure } from "../src/services/realtime-admission-service";

describe("server process lifecycle", () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("turns terminal authority loss into one bounded drain and shutdown", async () => {
    let terminalFailureListener:
      | ((failure: RealtimeAdmissionTerminalFailure) => void)
      | null = null;
    const unsubscribe = vi.fn();
    const drain = vi.fn(async () => ({
      completed: false,
      remainingRooms: 2,
      waitedMs: REALTIME_ADMISSION_POLICY.shutdownDrainTimeoutMs,
    }));
    const stop = vi.fn(async () => undefined);
    const runtime = {
      drain,
      stop,
      onTerminalFailure: (
        listener: (failure: RealtimeAdmissionTerminalFailure) => void,
      ) => {
        terminalFailureListener = listener;
        return unsubscribe;
      },
    } as unknown as AirJamServerRuntime;
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    } as unknown as ServerLogger;
    const removeHandlers = installServerProcessSignalHandlers({
      runtime,
      logger,
    });
    const failure = {
      code: "instance_lease_lost",
      message: "instance lease expired",
    } as const;

    terminalFailureListener!(failure);
    terminalFailureListener!(failure);

    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(process.exitCode).toBe(1);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        failureMessage: failure.message,
        completed: false,
        remainingRooms: 2,
      }),
      "Realtime server drain reached its bounded timeout",
    );

    removeHandlers();
  });
});
