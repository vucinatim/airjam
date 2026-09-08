import * as schema from "@/db/schema";
import type {
  OperationalEventEnvelopeV1,
  OperationalSyntheticRunV1,
} from "@air-jam/operations-contract";
import { createStructuredOperationalFailure } from "@air-jam/operations-contract";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Socket } from "socket.io-client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimOperationalEventDelivery,
  completeOperationalEventDelivery,
  enqueueOperationalEvent,
  failOperationalEventDelivery,
  OperationalEventConflictError,
  previewOperationalEventDeadLetterRequeue,
  repairExpiredOperationalEventDeliveries,
  requeueOperationalEventDeadLetter,
} from "./operational-event-delivery-service";
import { OPERATIONAL_SYNTHETIC_CHECKS } from "./operational-reliability-policy";
import {
  executeOperationalSyntheticCheck,
  listOperationalAlerts,
  persistOperationalSyntheticRun,
  runOperationalSynthetic,
  type OperationalSyntheticRuntimeConfig,
} from "./operational-synthetic-service";

const databaseUrl = process.env.AIR_JAM_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("operational reliability PostgreSQL invariants", () => {
  const client = postgres(databaseUrl!, { max: 8 });
  const database = drizzle(client, { schema });
  const suffix = crypto.randomUUID();
  const baseTime = new Date("2020-01-01T00:00:00.000Z");
  const at = (offsetMilliseconds: number) =>
    new Date(baseTime.getTime() + offsetMilliseconds);

  const resetReliabilityTables = async () => {
    await database.delete(schema.operationalAlerts);
    await database.delete(schema.operationalSloEvaluations);
    await database.delete(schema.operationalSyntheticRuns);
    await database.delete(schema.operationalEventDeliveryCommands);
    await database.delete(schema.operationalEvents);
    await database.delete(schema.operationalEventOutbox);
  };

  beforeEach(resetReliabilityTables);
  afterAll(async () => {
    await resetReliabilityTables();
    await client.end();
  });

  const event = (label: string): OperationalEventEnvelopeV1 => ({
    contractVersion: 1,
    plane: "lifecycle_runtime",
    eventId: `reliability-test:${suffix}:${label}`,
    kind: "test.operational_event",
    severity: "error",
    outcome: "failed",
    authority: "airjam_authoritative",
    source: {
      service: "operational_worker",
      component: "reliability-postgres-test",
      environment: "test",
    },
    subject: { type: "service", id: "operational_worker" },
    actor: { type: "agent", id: "agent:reliability-test" },
    correlation: {
      contractVersion: 1,
      correlationId: `reliability-test:${suffix}:${label}`,
    },
    occurredAt: baseTime.toISOString(),
    observedAt: baseTime.toISOString(),
    payload: { label },
    evidence: [],
  });

  it("fences concurrent delivery, retries, repairs, dead letters, and audited requeue", async () => {
    const original = event("durable-delivery");
    const first = await enqueueOperationalEvent({
      database,
      event: original,
      maxAttempts: 3,
      now: baseTime,
    });
    const replay = await enqueueOperationalEvent({
      database,
      event: original,
      maxAttempts: 3,
      now: baseTime,
    });
    expect(replay).toEqual(first);
    await expect(
      enqueueOperationalEvent({
        database,
        event: { ...original, kind: "test.changed_event" },
        maxAttempts: 3,
        now: baseTime,
      }),
    ).rejects.toBeInstanceOf(OperationalEventConflictError);

    const concurrentClaims = await Promise.all([
      claimOperationalEventDelivery({
        database,
        workerId: "worker:one",
        now: baseTime,
      }),
      claimOperationalEventDelivery({
        database,
        workerId: "worker:two",
        now: baseTime,
      }),
    ]);
    const claimed = concurrentClaims.find((candidate) => candidate !== null)!;
    expect(concurrentClaims.filter(Boolean)).toHaveLength(1);

    const retryableFailure = createStructuredOperationalFailure({
      code: "delivery.dependency_unavailable",
      failureClass: "dependency",
      summary: "The event-store dependency was unavailable.",
      retryable: true,
    });
    const retried = await failOperationalEventDelivery({
      database,
      eventId: claimed.id,
      leaseToken: claimed.leaseToken!,
      workerId: claimed.leaseOwner!,
      failure: retryableFailure,
      now: at(1_000),
    });
    expect(retried).toMatchObject({ status: "pending", attemptCount: 1 });

    const retryClaim = await claimOperationalEventDelivery({
      database,
      workerId: "worker:retry",
      now: at(2_000),
    });
    expect(retryClaim?.id).toBe(original.eventId);
    const terminalFailure = createStructuredOperationalFailure({
      code: "delivery.invalid_envelope",
      failureClass: "invalid_input",
      summary: "The target rejected the event envelope.",
      retryable: false,
    });
    const deadLetter = await failOperationalEventDelivery({
      database,
      eventId: retryClaim!.id,
      leaseToken: retryClaim!.leaseToken!,
      workerId: retryClaim!.leaseOwner!,
      failure: terminalFailure,
      now: at(3_000),
    });
    expect(deadLetter).toMatchObject({
      status: "dead_letter",
      lastErrorCode: "delivery.invalid_envelope",
    });

    await expect(
      previewOperationalEventDeadLetterRequeue({
        database,
        eventId: original.eventId,
        maxAttempts: 4,
      }),
    ).resolves.toMatchObject({ applied: false, eligible: true });
    const commandInput = {
      database,
      eventId: original.eventId,
      actor: "agent:reliability-test",
      reason: "Retry after the dependency contract was repaired.",
      idempotencyKey: `requeue:${suffix}`,
      maxAttempts: 4,
      now: at(4_000),
    };
    const requeued = await requeueOperationalEventDeadLetter(commandInput);
    const commandReplay = await requeueOperationalEventDeadLetter({
      ...commandInput,
      now: at(5_000),
    });
    expect(requeued).toMatchObject({
      replayed: false,
      event: { status: "pending", attemptCount: 0, maxAttempts: 4 },
    });
    expect(commandReplay).toMatchObject({
      replayed: true,
      commandId: requeued.commandId,
      auditEventId: requeued.auditEventId,
    });
    await expect(
      requeueOperationalEventDeadLetter({
        ...commandInput,
        maxAttempts: 5,
      }),
    ).rejects.toBeInstanceOf(OperationalEventConflictError);

    const delivery = await claimOperationalEventDelivery({
      database,
      workerId: "worker:after-requeue",
      now: at(5_000),
    });
    expect(delivery?.id).toBe(original.eventId);
    await completeOperationalEventDelivery({
      database,
      eventId: delivery!.id,
      leaseToken: delivery!.leaseToken!,
      workerId: delivery!.leaseOwner!,
      now: at(6_000),
    });
    const auditDelivery = await claimOperationalEventDelivery({
      database,
      workerId: "worker:audit",
      now: at(6_000),
    });
    expect(auditDelivery?.id).toBe(requeued.auditEventId);
    await completeOperationalEventDelivery({
      database,
      eventId: auditDelivery!.id,
      leaseToken: auditDelivery!.leaseToken!,
      workerId: auditDelivery!.leaseOwner!,
      now: at(7_000),
    });

    const leasedEvent = event("expired-lease");
    await enqueueOperationalEvent({
      database,
      event: leasedEvent,
      maxAttempts: 2,
      now: at(10_000),
    });
    await claimOperationalEventDelivery({
      database,
      workerId: "worker:expired",
      now: at(10_000),
    });
    const repaired = await repairExpiredOperationalEventDeliveries({
      database,
      now: at(41_000),
    });
    expect(repaired).toEqual([
      expect.objectContaining({
        id: leasedEvent.eventId,
        status: "pending",
        lastErrorCode: "delivery.lease_expired",
      }),
    ]);

    const [commands, storedEvents] = await Promise.all([
      database.select().from(schema.operationalEventDeliveryCommands),
      database
        .select()
        .from(schema.operationalEvents)
        .orderBy(asc(schema.operationalEvents.storedAt)),
    ]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      eventId: original.eventId,
      action: "requeue_dead_letter",
      result: expect.objectContaining({ auditEventId: requeued.auditEventId }),
    });
    expect(storedEvents.map((stored) => stored.id)).toEqual([
      original.eventId,
      requeued.auditEventId,
    ]);
    expect(storedEvents[0]!.envelope).toEqual(original);
  });

  const syntheticRun = ({
    label,
    status,
    completedAt,
  }: {
    label: string;
    status: "passed" | "failed";
    completedAt: Date;
  }): OperationalSyntheticRunV1 => {
    const startedAt = new Date(completedAt.getTime() - 1_000);
    const failure = createStructuredOperationalFailure({
      code: "synthetic.health_unavailable",
      failureClass: "unavailable",
      summary: "The declared health boundary was unavailable.",
      retryable: true,
    });
    return {
      contractVersion: 1,
      runId: `synthetic-run:${suffix}:${label}`,
      checkId: "platform-realtime-health",
      environment: "test",
      status,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMilliseconds: 1_000,
      eventId: `synthetic-event:${suffix}:${label}`,
      observations: ["platform", "realtime"].map((stepId) => ({
        stepId,
        status,
        latencyMilliseconds: 10,
        ...(status === "failed" ? { failure } : {}),
      })),
      evidence: [
        {
          kind: "snapshot",
          reference: `synthetic-proof:${suffix}:${label}`,
          collectedAt: completedAt.toISOString(),
        },
      ],
    };
  };

  it("opens and recovers a durable SLO alert from retained synthetic evidence", async () => {
    const persist = (run: OperationalSyntheticRunV1) =>
      persistOperationalSyntheticRun({
        database,
        run,
        actor: "agent:reliability-test",
        reason: "Prove the retained synthetic-to-alert lifecycle.",
        idempotencyKey: `persist:${run.runId}`,
        now: new Date(run.completedAt),
      });

    for (const [index, minutes] of [0, 1, 2].entries()) {
      await persist(
        syntheticRun({
          label: `failure-${index + 1}`,
          status: "failed",
          completedAt: at(minutes * 60_000),
        }),
      );
    }
    const [openAlert] = await listOperationalAlerts({
      database,
      environment: "test",
    });
    expect(openAlert).toMatchObject({
      alertKey: "slo:control-plane-availability:test",
      status: "open",
      occurrenceCount: 1,
      revision: 1,
    });

    for (const [index, minutes] of [33, 34, 35].entries()) {
      const run = syntheticRun({
        label: `recovery-${index + 1}`,
        status: "passed",
        completedAt: at(minutes * 60_000),
      });
      const stored = await persist(run);
      if (index === 0) {
        const replay = await persist(run);
        expect(replay.transition).toBe("replayed");
      }
      expect(stored.run.runId).toBe(run.runId);
    }
    const [recoveredAlert] = await listOperationalAlerts({
      database,
      environment: "test",
    });
    expect(recoveredAlert).toMatchObject({
      alertKey: "slo:control-plane-availability:test",
      status: "recovered",
      occurrenceCount: 2,
      revision: 2,
      recoveredAt: at(35 * 60_000).toISOString(),
    });

    const [runs, evaluations, alertEvents] = await Promise.all([
      database.select().from(schema.operationalSyntheticRuns),
      database.select().from(schema.operationalSloEvaluations),
      database
        .select()
        .from(schema.operationalEventOutbox)
        .where(eq(schema.operationalEventOutbox.status, "pending")),
    ]);
    expect(runs).toHaveLength(6);
    expect(evaluations).toHaveLength(6);
    expect(alertEvents).toHaveLength(8);
    expect(
      alertEvents.filter((row) => row.envelope.kind.startsWith("alert.slo.")),
    ).toHaveLength(2);
  });

  it("retains late evidence without allowing an older SLO evaluation to regress alert state", async () => {
    const persist = (run: OperationalSyntheticRunV1) =>
      persistOperationalSyntheticRun({
        database,
        run,
        actor: "agent:reliability-fence-test",
        reason: "Prove stale SLO evaluations are fenced.",
        idempotencyKey: `fence:${run.runId}`,
        now: new Date(run.completedAt),
      });

    for (const [index, minutes] of [0, 1, 2].entries()) {
      await persist(
        syntheticRun({
          label: `fence-failure-${index + 1}`,
          status: "failed",
          completedAt: at(minutes * 60_000),
        }),
      );
    }
    for (const [index, minutes] of [33, 34, 35].entries()) {
      await persist(
        syntheticRun({
          label: `fence-recovery-${index + 1}`,
          status: "passed",
          completedAt: at(minutes * 60_000),
        }),
      );
    }

    const late = await persist(
      syntheticRun({
        label: "late-failure",
        status: "failed",
        completedAt: at(3 * 60_000),
      }),
    );
    expect(late).toMatchObject({
      evaluation: null,
      evaluationDisposition: "stale_ignored",
      transition: null,
      alert: { status: "recovered", revision: 2 },
    });

    const [runs, evaluations, alerts] = await Promise.all([
      database.select().from(schema.operationalSyntheticRuns),
      database.select().from(schema.operationalSloEvaluations),
      database.select().from(schema.operationalAlerts),
    ]);
    expect(runs).toHaveLength(7);
    expect(evaluations).toHaveLength(6);
    expect(alerts[0]?.document).toMatchObject({
      status: "recovered",
      revision: 2,
      recoveredAt: at(35 * 60_000).toISOString(),
    });
  });

  it("fences duplicate execution before external synthetic side effects", async () => {
    let fetchCount = 0;
    const config: OperationalSyntheticRuntimeConfig = {
      environment: "test",
      targets: {
        "platform.home": "https://platform.example.test/",
        "platform.docs": "https://platform.example.test/docs",
      },
      realtimeOrigin: "https://realtime.example.test",
      requestOrigin: "https://platform.example.test",
      appId: "app:synthetic-execution-fence-test",
    };
    const fetchImpl = (async () => {
      fetchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const command = {
      database,
      checkId: "landing-docs",
      actor: "agent:synthetic-execution-fence-test",
      reason: "Prove duplicate side effects are fenced before execution.",
      idempotencyKey: `execution-fence:${suffix}`,
      config,
      fetchImpl,
    };

    const results = await Promise.all([
      runOperationalSynthetic(command),
      runOperationalSynthetic(command),
    ]);

    expect(fetchCount).toBe(2);
    expect(
      results.map((result) => result.evaluationDisposition).sort(),
    ).toEqual(["evaluated", "replayed"]);
    expect(
      await database.select().from(schema.operationalSyntheticRuns),
    ).toHaveLength(1);
  });

  it("executes and retains every launch-critical synthetic story through one durable pipeline", async () => {
    const runtimeConfig: OperationalSyntheticRuntimeConfig = {
      environment: "test",
      targets: {
        "platform.home": "https://platform.example.test/",
        "platform.docs": "https://platform.example.test/docs",
        "platform.arcade": "https://platform.example.test/arcade",
        "platform.health": "https://platform.example.test/api/health",
        "platform.readiness": "https://platform.example.test/api/readiness",
        "realtime.health": "https://realtime.example.test/health",
        "hosted.release": "https://release.example.test/",
        "worker.ready": "https://worker.example.test/ready",
        "browser_worker.health": "https://browser-worker.example.test/health",
        "realtime.room_controller": "https://realtime.example.test/",
        "realtime.semantic_action": "https://realtime.example.test/",
      },
      realtimeOrigin: "https://realtime.example.test",
      requestOrigin: "https://platform.example.test",
      appId: "app:synthetic-postgres-proof",
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("/api/readiness")) {
        return Response.json({
          ok: true,
          boundaries: {
            hostedReleaseOrigin: { required: true, status: "ready" },
            releaseStorage: { required: true, status: "ready" },
            releaseModeration: { required: true, status: "ready" },
          },
        });
      }
      if (url.includes("/api/health")) {
        return Response.json({ ok: true });
      }
      if (url.includes("/health") || url.includes("/ready")) {
        return Response.json({ ok: true });
      }
      if (url.includes("release.example.test")) {
        return new Response("<!doctype html><html><body>ready</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    type Handler = (...args: unknown[]) => void;
    class SyntheticSocket {
      handlers = new Map<string, Handler[]>();
      peer: SyntheticSocket | null = null;

      constructor() {
        queueMicrotask(() => this.trigger("connect"));
      }

      once(event: string, handler: Handler) {
        this.handlers.set(event, [handler]);
        return this;
      }

      emit(event: string, payload: Record<string, unknown>, ack?: Handler) {
        if (event === "host:bootstrap") ack?.({ ok: true });
        if (event === "host:createRoom") {
          ack?.({
            ok: true,
            roomId: "ROOM01",
            controllerCapability: { token: "opaque-proof-capability" },
          });
        }
        if (event === "controller:join") ack?.({ ok: true });
        if (event === "host:state_sync") {
          this.peer?.trigger("airjam:state_sync", {
            data: payload.data,
            revision: payload.revision,
          });
        }
        if (event === "controller:action_rpc") {
          this.peer?.trigger(
            "airjam:action_rpc",
            payload,
            (result: Record<string, unknown>) => ack?.(result),
          );
        }
        return this;
      }

      disconnect() {
        return this;
      }

      trigger(event: string, ...args: unknown[]) {
        const handlers = this.handlers.get(event) ?? [];
        this.handlers.delete(event);
        for (const handler of handlers) handler(...args);
      }
    }

    const sockets: SyntheticSocket[] = [];
    const socketFactory = (() => {
      const socket = new SyntheticSocket();
      sockets.push(socket);
      if (sockets.length % 2 === 0) {
        sockets.at(-2)!.peer = socket;
        socket.peer = sockets.at(-2)!;
      }
      return socket as unknown as Socket;
    }) as typeof import("socket.io-client").io;

    for (const check of OPERATIONAL_SYNTHETIC_CHECKS) {
      const run = await executeOperationalSyntheticCheck({
        check,
        config: runtimeConfig,
        fetchImpl,
        socketFactory,
        startedAt: new Date(Date.now() - 100),
        runId: `pipeline-proof:${suffix}:${check.checkId}`,
      });
      expect(run.status).toBe("passed");
      await persistOperationalSyntheticRun({
        database,
        run,
        actor: "agent:reliability-pipeline-proof",
        reason: "Prove every source-owned launch-critical synthetic story.",
        idempotencyKey: `pipeline-proof:${run.runId}`,
      });
    }

    const [runs, evaluations, outbox] = await Promise.all([
      database.select().from(schema.operationalSyntheticRuns),
      database.select().from(schema.operationalSloEvaluations),
      database.select().from(schema.operationalEventOutbox),
    ]);
    expect(runs).toHaveLength(6);
    expect(evaluations).toHaveLength(6);
    expect(outbox).toHaveLength(6);
    expect(runs.map((run) => run.checkId).sort()).toEqual(
      OPERATIONAL_SYNTHETIC_CHECKS.map((check) => check.checkId).sort(),
    );
    expect(
      outbox.every((row) => row.envelope.authority === "synthetic_observation"),
    ).toBe(true);
  });
});
