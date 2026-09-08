import { REALTIME_ADMISSION_POLICY } from "@air-jam/database-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerDatabase } from "../src/db";
import { loadServerEnv } from "../src/env/server-env";
import { createAirJamServer, type AirJamServerRuntime } from "../src/index";
import { createServerLogger } from "../src/logging/logger";
import type { ServerOperationalEventPublisher } from "../src/operations/operational-event-publisher";
import type {
  RealtimeAdmissionService,
  RealtimeAdmissionStatus,
  RealtimeAdmissionTerminalFailure,
} from "../src/services/realtime-admission-service";
import { getHttpServerLoopbackUrl } from "./helpers/http-server-test-url";

const healthyStatus = (): RealtimeAdmissionStatus => ({
  contractVersion: REALTIME_ADMISSION_POLICY.contractVersion,
  authority: "database",
  instanceId: "readiness-test",
  acceptingNewWork: true,
  draining: false,
  terminalAuthorityLost: false,
  pendingReconciliations: 0,
  lastHeartbeatAt: new Date().toISOString(),
  lastError: null,
  policy: REALTIME_ADMISSION_POLICY,
});

const createAdmissionService = () => {
  let status = healthyStatus();
  const listeners = new Set<
    (failure: RealtimeAdmissionTerminalFailure) => void
  >();
  const service: RealtimeAdmissionService = {
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
    getStatus: () => status,
    onTerminalAuthorityLoss: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    service,
    setStatus: (next: RealtimeAdmissionStatus) => {
      status = next;
    },
    failTerminally: (failure: RealtimeAdmissionTerminalFailure) => {
      status = {
        ...status,
        authority: "unavailable",
        acceptingNewWork: false,
        draining: true,
        terminalAuthorityLost: true,
        lastError: failure.message,
      };
      for (const listener of listeners) listener(failure);
    },
  };
};

const testEnv = loadServerEnv({
  NODE_ENV: "test",
  AIRJAM_OPERATIONAL_ENVIRONMENT: "test",
  AIR_JAM_AUTH_MODE: "disabled",
  AIR_JAM_DEV_LOG_COLLECTOR: "disabled",
});
const logger = createServerLogger(undefined, undefined, null, {
  level: "silent",
});

describe("server health, readiness, and terminal authority lifecycle", () => {
  let runtime: AirJamServerRuntime | null = null;

  afterEach(async () => {
    await runtime?.stop();
    runtime = null;
  });

  it("keeps health as liveness while readiness rejects unavailable and draining admission", async () => {
    const admission = createAdmissionService();
    admission.setStatus({
      ...healthyStatus(),
      authority: "unavailable",
      acceptingNewWork: false,
      lastError: "database unavailable",
    });
    runtime = createAirJamServer({
      db: null,
      realtimeAdmissionService: admission.service,
      devLogCollector: false,
      envConfig: testEnv,
      logger,
    });
    await runtime.start(0);
    const baseUrl = getHttpServerLoopbackUrl(runtime.httpServer);

    const unavailableHealth = await fetch(`${baseUrl}/health`);
    const unavailableReady = await fetch(`${baseUrl}/ready`);
    expect(unavailableHealth.status).toBe(200);
    await expect(unavailableHealth.json()).resolves.toMatchObject({
      ok: true,
      realtimeAdmission: {
        authority: "unavailable",
        acceptingNewWork: false,
      },
    });
    expect(unavailableReady.status).toBe(503);
    await expect(unavailableReady.json()).resolves.toMatchObject({ ok: false });

    admission.setStatus({
      ...healthyStatus(),
      acceptingNewWork: false,
      draining: true,
    });
    const drainingHealth = await fetch(`${baseUrl}/health`);
    const drainingReady = await fetch(`${baseUrl}/ready`);
    expect(drainingHealth.status).toBe(200);
    await expect(drainingHealth.json()).resolves.toMatchObject({ ok: true });
    expect(drainingReady.status).toBe(503);
    await expect(drainingReady.json()).resolves.toMatchObject({
      ok: false,
      realtimeAdmission: { draining: true, acceptingNewWork: false },
    });
  });

  it("retains a terminal authority loss for a listener registered afterward", async () => {
    const admission = createAdmissionService();
    const publishFailure = vi.fn(async () => undefined);
    const operationalEventPublisher = {
      publishFailure,
      publishRuntimeErrorReport: vi.fn(async () => undefined),
    } satisfies ServerOperationalEventPublisher;
    runtime = createAirJamServer({
      db: null,
      realtimeAdmissionService: admission.service,
      operationalEventPublisher,
      devLogCollector: false,
      envConfig: testEnv,
      logger,
    });
    const failure = {
      code: "instance_lease_lost",
      message: "instance lease was replaced",
    } as const;

    admission.failTerminally(failure);
    admission.failTerminally(failure);
    const delivered = new Promise<RealtimeAdmissionTerminalFailure>(
      (resolve) => {
        runtime!.onTerminalFailure(resolve);
      },
    );

    await expect(delivered).resolves.toEqual(failure);
    await vi.waitFor(() => expect(publishFailure).toHaveBeenCalledTimes(1));
    expect(publishFailure).toHaveBeenCalledWith({
      code: "realtime_admission.instance_lease_lost",
      failureClass: "dependency",
      summary:
        "The realtime server lost its database-backed admission authority.",
      retryable: false,
      component: "realtime-admission",
      subject: { type: "service", id: "realtime_server" },
      correlation: {
        contractVersion: 1,
        correlationId: expect.stringMatching(/^realtime-admission:/),
      },
      details: {
        authorityFailureCode: failure.code,
        action: "drain_and_stop_instance",
      },
    });
  });

  it("does not close an externally injected database", async () => {
    const end = vi.fn(async () => undefined);
    const injectedDatabase = {
      $client: { end },
    } as unknown as ServerDatabase;
    const admission = createAdmissionService();
    runtime = createAirJamServer({
      db: injectedDatabase,
      realtimeAdmissionService: admission.service,
      devLogCollector: false,
      envConfig: testEnv,
      logger,
    });

    await runtime.stop();
    await runtime.stop();
    runtime = null;

    expect(end).not.toHaveBeenCalled();
  });
});
