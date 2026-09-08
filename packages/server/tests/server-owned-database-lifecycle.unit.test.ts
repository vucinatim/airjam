import { REALTIME_ADMISSION_POLICY } from "@air-jam/database-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  createOwned: vi.fn(),
}));

vi.mock("../src/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db")>();
  return {
    ...actual,
    createOwnedServerDatabase: databaseMocks.createOwned,
  };
});

import { loadServerEnv } from "../src/env/server-env";
import { createAirJamServer } from "../src/index";
import { createServerLogger } from "../src/logging/logger";
import type { RealtimeAdmissionService } from "../src/services/realtime-admission-service";

const realtimeAdmissionService: RealtimeAdmissionService = {
  start: async () => undefined,
  beginDrain: async () => undefined,
  stop: async () => undefined,
  admitRoom: async ({ roomId }) => ({
    ok: true,
    lease: { roomId, leaseToken: `room-lease-${roomId}` },
  }),
  releaseRoom: async () => undefined,
  admitController: async ({ roomLease, controllerId, existingLease }) => ({
    ok: true,
    lease: existingLease ?? {
      roomId: roomLease.roomId,
      controllerId,
      leaseToken: `controller-lease-${controllerId}`,
    },
  }),
  markControllerDisconnected: async () => undefined,
  releaseController: async () => undefined,
  getStatus: () => ({
    contractVersion: REALTIME_ADMISSION_POLICY.contractVersion,
    authority: "database",
    budgetRequirement: "required",
    instanceId: "owned-database-test",
    acceptingNewWork: true,
    draining: false,
    terminalAuthorityLost: false,
    pendingReconciliations: 0,
    lastHeartbeatAt: new Date().toISOString(),
    lastError: null,
    policy: REALTIME_ADMISSION_POLICY,
  }),
  onTerminalAuthorityLoss: () => () => undefined,
};

describe("server-owned database lifecycle", () => {
  beforeEach(() => {
    databaseMocks.close.mockClear();
    databaseMocks.createOwned.mockReset();
    databaseMocks.createOwned.mockReturnValue({
      database: {},
      close: databaseMocks.close,
    });
  });

  it("closes its internally created database exactly once across repeated stops", async () => {
    const runtime = createAirJamServer({
      realtimeAdmissionService,
      devLogCollector: false,
      logger: createServerLogger(undefined, undefined, null, {
        level: "silent",
      }),
      envConfig: loadServerEnv({
        NODE_ENV: "test",
        AIRJAM_OPERATIONAL_ENVIRONMENT: "test",
        AIR_JAM_AUTH_MODE: "disabled",
        AIR_JAM_DEV_LOG_COLLECTOR: "disabled",
        DATABASE_URL: "postgresql://127.0.0.1:5432/unused",
      }),
    });

    await runtime.stop();
    await runtime.stop();

    expect(databaseMocks.createOwned).toHaveBeenCalledTimes(1);
    expect(databaseMocks.close).toHaveBeenCalledTimes(1);
  });
});
