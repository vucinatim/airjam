import { REALTIME_ADMISSION_POLICY } from "@air-jam/database-contract";
import type { OperationalBudgetRequirement } from "@air-jam/operations-contract";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runtimeDatabaseSchema, type ServerDatabase } from "../src/db";
import type { ServerLogger } from "../src/logging/logger";
import { DatabaseRealtimeAdmissionService } from "../src/services/realtime-admission-service";

const databaseUrl = process.env.AIR_JAM_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("realtime admission PostgreSQL authority", () => {
  const client = postgres(databaseUrl!, { max: 8 });
  const database = drizzle(client, {
    schema: runtimeDatabaseSchema,
  }) as ServerDatabase;
  const suffix = crypto.randomUUID();
  const instancePrefix = `admission-test-${suffix}`;
  const controlActor = `admission-test-${suffix}`;
  const budgetCycleId = `admission-budget-${suffix}`;
  const logger = {
    error: vi.fn(),
  } as unknown as ServerLogger;

  const createService = (
    name: string,
    budgetRequirement: OperationalBudgetRequirement = "required",
  ) =>
    new DatabaseRealtimeAdmissionService({
      database,
      logger,
      instanceId: `${instancePrefix}-${name}`,
      budgetRequirement,
    });

  beforeEach(async () => {
    await client`
      insert into operational_budget_cycles (
        id, period_start, period_end, profile,
        normal_target_microusd, warning_microusd,
        protection_microusd, near_ceiling_microusd,
        ceiling_microusd
      ) values (
        ${budgetCycleId}, now() - interval '1 hour', now() + interval '1 hour',
        'ordinary', 25000000, 50000000, 75000000, 90000000, 100000000
      )
    `;
    await client`
      insert into operational_budget_evidence (
        id, idempotency_key, cycle_id, contract_version,
        provider, scope_kind, scope_id, scope_name, scope_metadata,
        currency, observed_at, actual_amount_microusd,
        projected_amount_microusd, measurements, cost_breakdown_microusd,
        rate_card, source_version, collected_by, reason
      ) values (
        ${`admission-evidence-${crypto.randomUUID()}`},
        ${`admission-evidence-command-${crypto.randomUUID()}`},
        ${budgetCycleId}, 1, 'test', 'project', ${suffix}, 'Air Jam test', '{}',
        'USD', now(), 1, 1, '{}', '{}', '{}', 'test@1',
        ${controlActor}, 'Realtime admission test authority'
      )
    `;
  });

  afterEach(async () => {
    await client`
      delete from operational_lane_controls
      where updated_by = ${controlActor}
    `;
    await client`
      delete from realtime_admission_instances
      where instance_id like ${`${instancePrefix}%`}
         or instance_id like ${`seed-${suffix}%`}
    `;
    await client`
      delete from operational_budget_evidence
      where cycle_id = ${budgetCycleId}
    `;
    await client`
      delete from operational_budget_cycles
      where id = ${budgetCycleId}
    `;
  });

  afterAll(async () => {
    await client.end();
  });

  it("owns room, controller, disconnect, drain, and release lifecycle", async () => {
    const service = createService("lifecycle");
    await service.start();

    const room = await service.admitRoom({
      roomId: `ROOM-${suffix}`,
      appId: `app-${suffix}`,
      gameId: `game-${suffix}`,
      creatorId: `creator-${suffix}`,
      maxControllers: 1,
    });
    expect(room.ok).toBe(true);
    if (!room.ok) throw new Error(room.message);

    const controller = await service.admitController({
      roomLease: room.lease,
      controllerId: `controller-${suffix}`,
    });
    expect(controller.ok).toBe(true);
    if (!controller.ok) throw new Error(controller.message);

    const full = await service.admitController({
      roomLease: room.lease,
      controllerId: `controller-extra-${suffix}`,
    });
    expect(full).toMatchObject({ ok: false, reason: "room_full" });

    await service.markControllerDisconnected(controller.lease, 30_000);
    const rows = await client`
      select disconnected_at, resume_expires_at
      from realtime_controller_admission_leases
      where lease_token = ${controller.lease.leaseToken}
    `;
    expect(rows).toHaveLength(1);
    expect(
      new Date(rows[0]!.resume_expires_at).getTime() -
        new Date(rows[0]!.disconnected_at).getTime(),
    ).toBe(30_000);

    const resumed = await service.admitController({
      roomLease: room.lease,
      controllerId: controller.lease.controllerId,
      existingLease: controller.lease,
    });
    expect(resumed).toMatchObject({
      ok: true,
      lease: {
        roomId: controller.lease.roomId,
        controllerId: controller.lease.controllerId,
      },
    });
    expect(resumed.ok && resumed.lease.leaseToken).not.toBe(
      controller.lease.leaseToken,
    );

    await service.beginDrain();
    expect(service.getStatus()).toMatchObject({
      authority: "database",
      acceptingNewWork: false,
      draining: true,
    });
    await expect(
      service.admitRoom({
        roomId: `DRAIN-${suffix}`,
        maxControllers: 8,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "instance_draining" });

    await service.stop();
    const remaining = await client`
      select count(*)::int as count
      from realtime_room_admission_leases
      where room_id = ${room.lease.roomId}
    `;
    expect(remaining[0]!.count).toBe(0);
  });

  it("uses preview database authority without claiming production budget evidence", async () => {
    await client`
      delete from operational_budget_evidence
      where cycle_id = ${budgetCycleId}
    `;
    const service = createService("preview-budget", "not_applicable");
    await service.start();
    expect(service.getStatus()).toMatchObject({
      authority: "database",
      budgetRequirement: "not_applicable",
      acceptingNewWork: true,
    });

    await expect(
      service.admitRoom({
        roomId: `PREVIEW-BUDGET-${suffix}`,
        maxControllers: 8,
      }),
    ).resolves.toMatchObject({ ok: true });
    await service.stop();
  });

  it("admits atomically at the global burst boundary", async () => {
    const seedInstance = `seed-${suffix}-capacity`;
    await client`
      insert into realtime_admission_instances (
        instance_id, lease_token, started_at, heartbeat_at, expires_at
      ) values (
        ${seedInstance}, ${crypto.randomUUID()}, now(), now(), now() + interval '5 minutes'
      )
    `;
    await client`
      insert into realtime_room_admission_leases (
        room_id, lease_token, instance_id, max_controllers, admitted_at
      )
      select
        ${`seed-room-${suffix}-`} || value::text,
        ${`seed-lease-${suffix}-`} || value::text,
        ${seedInstance},
        16,
        now()
      from generate_series(1, 299) as value
    `;

    const service = createService("capacity");
    await service.start();
    const decisions = await Promise.all([
      service.admitRoom({
        roomId: `BOUNDARY-A-${suffix}`,
        maxControllers: 16,
      }),
      service.admitRoom({
        roomId: `BOUNDARY-B-${suffix}`,
        maxControllers: 16,
      }),
    ]);

    expect(decisions.filter((decision) => decision.ok)).toHaveLength(1);
    expect(decisions.filter((decision) => !decision.ok)).toEqual([
      expect.objectContaining({ reason: "global_capacity_exceeded" }),
    ]);
    await service.stop();
  });

  it("admits controllers atomically at the global burst boundary", async () => {
    const service = createService("controller-capacity");
    await service.start();
    const room = await service.admitRoom({
      roomId: `CONTROLLER-BOUNDARY-${suffix}`,
      maxControllers: REALTIME_ADMISSION_POLICY.burstControllers + 1,
    });
    expect(room.ok).toBe(true);
    if (!room.ok) throw new Error(room.message);

    await client`
      insert into realtime_controller_admission_leases (
        room_id, controller_id, lease_token, instance_id, admitted_at
      )
      select
        ${room.lease.roomId},
        ${`seed-controller-${suffix}-`} || value::text,
        ${`seed-controller-lease-${suffix}-`} || value::text,
        ${`${instancePrefix}-controller-capacity`},
        now()
      from generate_series(
        1,
        ${REALTIME_ADMISSION_POLICY.burstControllers - 1}
      ) as value
    `;

    const decisions = await Promise.all([
      service.admitController({
        roomLease: room.lease,
        controllerId: `BOUNDARY-CONTROLLER-A-${suffix}`,
      }),
      service.admitController({
        roomLease: room.lease,
        controllerId: `BOUNDARY-CONTROLLER-B-${suffix}`,
      }),
    ]);

    expect(decisions.filter((decision) => decision.ok)).toHaveLength(1);
    expect(decisions.filter((decision) => !decision.ok)).toEqual([
      expect.objectContaining({ reason: "global_capacity_exceeded" }),
    ]);
    await service.stop();
  });

  it("enforces the exact restricted global room boundary", async () => {
    const service = createService("restricted-room-capacity");
    await service.start();
    await client`
      insert into operational_lane_controls (
        lane, mode, reason, retry_after_seconds, revision, updated_by
      ) values (
        'realtime_room_admission', 'restricted',
        'restricted room boundary test', 11, 1, ${controlActor}
      )
    `;
    await client`
      insert into realtime_room_admission_leases (
        room_id, lease_token, instance_id, max_controllers, admitted_at
      )
      select
        ${`restricted-room-${suffix}-`} || value::text,
        ${`restricted-room-lease-${suffix}-`} || value::text,
        ${`${instancePrefix}-restricted-room-capacity`},
        16,
        now()
      from generate_series(
        1,
        ${REALTIME_ADMISSION_POLICY.sustainedRooms - 1}
      ) as value
    `;

    const boundaryRoom = await service.admitRoom({
      roomId: `RESTRICTED-ROOM-BOUNDARY-${suffix}`,
      maxControllers: 16,
    });
    expect(boundaryRoom.ok).toBe(true);

    await expect(
      service.admitRoom({
        roomId: `RESTRICTED-ROOM-OVERFLOW-${suffix}`,
        maxControllers: 16,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "global_capacity_exceeded",
    });
    const [roomCount] = await client`
      select count(*)::int as count
      from realtime_room_admission_leases
      where instance_id = ${`${instancePrefix}-restricted-room-capacity`}
    `;
    expect(roomCount).toMatchObject({
      count: REALTIME_ADMISSION_POLICY.sustainedRooms,
    });
    await service.stop();
  });

  it("enforces the exact restricted global controller boundary", async () => {
    const service = createService("restricted-controller-capacity");
    await service.start();
    const room = await service.admitRoom({
      roomId: `RESTRICTED-CONTROLLER-ROOM-${suffix}`,
      maxControllers: REALTIME_ADMISSION_POLICY.sustainedControllers + 1,
    });
    expect(room.ok).toBe(true);
    if (!room.ok) throw new Error(room.message);
    await client`
      insert into operational_lane_controls (
        lane, mode, reason, retry_after_seconds, revision, updated_by
      ) values (
        'realtime_controller_admission', 'restricted',
        'restricted controller boundary test', 11, 1, ${controlActor}
      )
    `;
    await client`
      insert into realtime_controller_admission_leases (
        room_id, controller_id, lease_token, instance_id, admitted_at
      )
      select
        ${room.lease.roomId},
        ${`restricted-controller-${suffix}-`} || value::text,
        ${`restricted-controller-lease-${suffix}-`} || value::text,
        ${`${instancePrefix}-restricted-controller-capacity`},
        now()
      from generate_series(
        1,
        ${REALTIME_ADMISSION_POLICY.sustainedControllers - 1}
      ) as value
    `;

    const boundaryController = await service.admitController({
      roomLease: room.lease,
      controllerId: `RESTRICTED-CONTROLLER-BOUNDARY-${suffix}`,
    });
    expect(boundaryController.ok).toBe(true);

    await expect(
      service.admitController({
        roomLease: room.lease,
        controllerId: `RESTRICTED-CONTROLLER-OVERFLOW-${suffix}`,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "global_capacity_exceeded",
    });
    const [controllerCount] = await client`
      select count(*)::int as count
      from realtime_controller_admission_leases
      where instance_id = ${`${instancePrefix}-restricted-controller-capacity`}
    `;
    expect(controllerCount).toMatchObject({
      count: REALTIME_ADMISSION_POLICY.sustainedControllers,
    });
    await service.stop();
  });

  it("keeps creator and game room limits observational in normal mode and enforces them in restricted mode", async () => {
    const service = createService("scoped-policy");
    await service.start();
    const creatorId = `creator-policy-${suffix}`;
    const gameId = `game-policy-${suffix}`;
    await client`
      insert into realtime_room_admission_leases (
        room_id, lease_token, instance_id, game_id, creator_id,
        max_controllers, admitted_at
      )
      select
        ${`seed-policy-room-${suffix}-`} || value::text,
        ${`seed-policy-lease-${suffix}-`} || value::text,
        ${`${instancePrefix}-scoped-policy`},
        ${gameId},
        ${creatorId},
        16,
        now()
      from generate_series(1, ${REALTIME_ADMISSION_POLICY.creatorRooms}) as value
    `;

    const normalCreator = await service.admitRoom({
      roomId: `NORMAL-CREATOR-${suffix}`,
      creatorId,
      maxControllers: 16,
    });
    expect(normalCreator.ok).toBe(true);
    if (!normalCreator.ok) throw new Error(normalCreator.message);
    await service.releaseRoom(normalCreator.lease);

    const normalGame = await service.admitRoom({
      roomId: `NORMAL-GAME-${suffix}`,
      gameId,
      maxControllers: 16,
    });
    expect(normalGame.ok).toBe(true);
    if (!normalGame.ok) throw new Error(normalGame.message);
    await service.releaseRoom(normalGame.lease);

    await client`
      insert into operational_lane_controls (
        lane, mode, reason, retry_after_seconds, revision, updated_by
      ) values (
        'realtime_room_admission', 'restricted',
        'capacity test', 11, 1, ${controlActor}
      )
    `;

    await expect(
      service.admitRoom({
        roomId: `RESTRICTED-CREATOR-${suffix}`,
        creatorId,
        maxControllers: 16,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "creator_quota_exceeded",
      retryAfterSeconds: REALTIME_ADMISSION_POLICY.defaultRetryAfterSeconds,
    });
    await expect(
      service.admitRoom({
        roomId: `RESTRICTED-GAME-${suffix}`,
        gameId,
        maxControllers: 16,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "game_quota_exceeded",
      retryAfterSeconds: REALTIME_ADMISSION_POLICY.defaultRetryAfterSeconds,
    });
    await service.stop();
  });

  it("uses the shared budget ladder for room quotas and new-work pauses", async () => {
    const service = createService("budget-policy");
    await service.start();
    const creatorId = `creator-budget-${suffix}`;
    await client`
      insert into realtime_room_admission_leases (
        room_id, lease_token, instance_id, creator_id,
        max_controllers, admitted_at
      )
      select
        ${`seed-budget-room-${suffix}-`} || value::text,
        ${`seed-budget-lease-${suffix}-`} || value::text,
        ${`${instancePrefix}-budget-policy`},
        ${creatorId}, 16, now()
      from generate_series(1, ${REALTIME_ADMISSION_POLICY.creatorRooms}) as value
    `;

    await client`
      update operational_budget_evidence
      set actual_amount_microusd = 75000000,
          projected_amount_microusd = 75000000
      where cycle_id = ${budgetCycleId}
    `;
    await expect(
      service.admitRoom({
        roomId: `PROTECTED-CREATOR-${suffix}`,
        creatorId,
        maxControllers: 16,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "creator_quota_exceeded",
    });

    const existingRoom = await service.admitRoom({
      roomId: `ROOM-BEFORE-CEILING-${suffix}`,
      maxControllers: 16,
    });
    expect(existingRoom.ok).toBe(true);
    if (!existingRoom.ok) throw new Error(existingRoom.message);

    await client`
      update operational_budget_evidence
      set actual_amount_microusd = 100000000,
          projected_amount_microusd = 100000000
      where cycle_id = ${budgetCycleId}
    `;
    await expect(
      service.admitRoom({
        roomId: `CEILING-ROOM-${suffix}`,
        maxControllers: 16,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "budget_protection",
    });
    await expect(
      service.admitController({
        roomLease: existingRoom.lease,
        controllerId: `ceiling-controller-${suffix}`,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "budget_protection",
    });
    await service.stop();
  });

  it("recovers missing and stale budget authority without losing an existing room", async () => {
    const service = createService("budget-authority");
    await service.start();
    const existingRoom = await service.admitRoom({
      roomId: `BUDGET-AUTHORITY-EXISTING-${suffix}`,
      maxControllers: 1,
    });
    expect(existingRoom.ok).toBe(true);
    if (!existingRoom.ok) throw new Error(existingRoom.message);

    await client`
      delete from operational_budget_evidence
      where cycle_id = ${budgetCycleId}
    `;
    await expect(
      service.admitRoom({
        roomId: `MISSING-BUDGET-${suffix}`,
        maxControllers: 16,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "authority_unavailable",
      retryAfterSeconds: 30,
    });

    await client`
      insert into operational_budget_evidence (
        id, idempotency_key, cycle_id, contract_version,
        provider, scope_kind, scope_id, scope_name, scope_metadata,
        currency, observed_at, actual_amount_microusd,
        projected_amount_microusd, measurements, cost_breakdown_microusd,
        rate_card, source_version, collected_by, reason
      ) values (
        ${`stale-admission-evidence-${crypto.randomUUID()}`},
        ${`stale-admission-command-${crypto.randomUUID()}`},
        ${budgetCycleId}, 1, 'test', 'project', ${suffix}, 'Air Jam test', '{}',
        'USD', now() - interval '7 hours', 1, 1, '{}', '{}', '{}', 'test@1',
        ${controlActor}, 'Stale realtime admission test authority'
      )
    `;
    await expect(
      service.admitRoom({
        roomId: `STALE-BUDGET-${suffix}`,
        maxControllers: 16,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "authority_unavailable",
      retryAfterSeconds: 30,
    });

    const [preservedRoom] = await client`
      select count(*)::int as count
      from realtime_room_admission_leases
      where room_id = ${existingRoom.lease.roomId}
        and lease_token = ${existingRoom.lease.leaseToken}
    `;
    expect(preservedRoom).toMatchObject({ count: 1 });

    await client`
      update operational_budget_evidence
      set observed_at = now()
      where cycle_id = ${budgetCycleId}
    `;
    const recoveredRoom = await service.admitRoom({
      roomId: `RECOVERED-BUDGET-${suffix}`,
      maxControllers: 1,
    });
    expect(recoveredRoom.ok).toBe(true);
    const existingRoomController = await service.admitController({
      roomLease: existingRoom.lease,
      controllerId: `recovered-existing-room-controller-${suffix}`,
    });
    expect(existingRoomController.ok).toBe(true);
    await service.stop();
  });

  it("lets an existing controller resume while its lane is paused and its instance drains", async () => {
    const service = createService("resume-controls");
    await service.start();
    const room = await service.admitRoom({
      roomId: `RESUME-CONTROLS-${suffix}`,
      maxControllers: 2,
    });
    expect(room.ok).toBe(true);
    if (!room.ok) throw new Error(room.message);
    const controller = await service.admitController({
      roomLease: room.lease,
      controllerId: `resume-controller-${suffix}`,
    });
    expect(controller.ok).toBe(true);
    if (!controller.ok) throw new Error(controller.message);
    await service.markControllerDisconnected(controller.lease, 30_000);

    await client`
      insert into operational_lane_controls (
        lane, mode, reason, retry_after_seconds, revision, updated_by
      ) values (
        'realtime_controller_admission', 'paused',
        'controller pause test', 9, 1, ${controlActor}
      )
    `;
    await expect(
      service.admitController({
        roomLease: room.lease,
        controllerId: `new-controller-${suffix}`,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "lane_paused",
      retryAfterSeconds: 9,
    });
    const pausedResume = await service.admitController({
      roomLease: room.lease,
      controllerId: controller.lease.controllerId,
      existingLease: controller.lease,
    });
    expect(pausedResume).toMatchObject({ ok: true });
    if (!pausedResume.ok) throw new Error("Expected paused controller resume");

    await service.markControllerDisconnected(pausedResume.lease, 30_000);
    await service.beginDrain();
    const drainingResume = await service.admitController({
      roomLease: room.lease,
      controllerId: pausedResume.lease.controllerId,
      existingLease: pausedResume.lease,
    });
    expect(drainingResume).toMatchObject({ ok: true });
    if (!drainingResume.ok) {
      throw new Error("Expected draining controller resume");
    }
    expect(drainingResume.lease.leaseToken).not.toBe(
      pausedResume.lease.leaseToken,
    );
    await service.stop();
  });

  it("fails an existing controller resume closed when PostgreSQL becomes unavailable", async () => {
    const isolatedClient = postgres(databaseUrl!, { max: 1 });
    const isolatedDatabase = drizzle(isolatedClient, {
      schema: runtimeDatabaseSchema,
    }) as ServerDatabase;
    const service = new DatabaseRealtimeAdmissionService({
      database: isolatedDatabase,
      logger,
      instanceId: `${instancePrefix}-unavailable-resume`,
      budgetRequirement: "required",
    });
    await service.start();
    const room = await service.admitRoom({
      roomId: `UNAVAILABLE-RESUME-${suffix}`,
      maxControllers: 1,
    });
    expect(room.ok).toBe(true);
    if (!room.ok) throw new Error(room.message);
    const controller = await service.admitController({
      roomLease: room.lease,
      controllerId: `unavailable-resume-controller-${suffix}`,
    });
    expect(controller.ok).toBe(true);
    if (!controller.ok) throw new Error(controller.message);
    await service.markControllerDisconnected(controller.lease, 30_000);

    await isolatedClient.end();
    await expect(
      service.admitController({
        roomLease: room.lease,
        controllerId: controller.lease.controllerId,
        existingLease: controller.lease,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "authority_unavailable",
    });
    expect(service.getStatus()).toMatchObject({
      authority: "unavailable",
      acceptingNewWork: false,
    });
    await service.stop();
  });

  it("ignores dead instances and reclaims a stale room-code reservation", async () => {
    const staleInstance = `seed-${suffix}-stale`;
    const roomId = `STALE-${suffix}`;
    await client`
      insert into realtime_admission_instances (
        instance_id, lease_token, started_at, heartbeat_at, expires_at
      ) values (
        ${staleInstance}, ${crypto.randomUUID()}, now() - interval '2 minutes',
        now() - interval '1 minute', now() - interval '30 seconds'
      )
    `;
    await client`
      insert into realtime_room_admission_leases (
        room_id, lease_token, instance_id, max_controllers, admitted_at
      ) values (${roomId}, ${crypto.randomUUID()}, ${staleInstance}, 8, now() - interval '1 minute')
    `;

    const service = createService("stale");
    await service.start();
    const decision = await service.admitRoom({ roomId, maxControllers: 8 });

    expect(decision.ok).toBe(true);
    const owners = await client`
      select instance_id
      from realtime_room_admission_leases
      where room_id = ${roomId}
    `;
    expect(owners).toEqual([
      expect.objectContaining({
        instance_id: `${instancePrefix}-stale`,
      }),
    ]);
    const [expiredInstance] = await client`
      select count(*)::int as count
      from realtime_admission_instances
      where instance_id = ${staleInstance}
    `;
    expect(expiredInstance).toMatchObject({ count: 0 });
    await service.stop();
  });

  it("does not drain a healthy incumbent before the candidate has fresh authority", async () => {
    const incumbent = createService("incumbent-preflight");
    const candidate = createService("candidate-preflight");
    await incumbent.start();
    await client`
      delete from operational_budget_evidence
      where cycle_id = ${budgetCycleId}
    `;

    await candidate.start();

    expect(candidate.getStatus()).toMatchObject({
      authority: "unavailable",
      acceptingNewWork: false,
    });
    const [incumbentRow] = await client`
      select draining_at
      from realtime_admission_instances
      where instance_id = ${`${instancePrefix}-incumbent-preflight`}
    `;
    expect(incumbentRow).toMatchObject({ draining_at: null });

    await candidate.stop();
    await incumbent.stop();
  });

  it("recovers incumbent admission after an activated candidate disappears", async () => {
    const incumbent = createService("incumbent-recovery");
    const candidate = createService("candidate-recovery");
    await incumbent.start();
    await candidate.start();

    const [drainingIncumbent] = await client`
      select draining_at
      from realtime_admission_instances
      where instance_id = ${`${instancePrefix}-incumbent-recovery`}
    `;
    expect(drainingIncumbent?.draining_at).not.toBeNull();

    await candidate.stop();
    await (
      incumbent as unknown as { heartbeat: () => Promise<void> }
    ).heartbeat();

    expect(incumbent.getStatus()).toMatchObject({
      authority: "database",
      acceptingNewWork: true,
      draining: false,
    });
    const [recoveredIncumbent] = await client`
      select draining_at
      from realtime_admission_instances
      where instance_id = ${`${instancePrefix}-incumbent-recovery`}
    `;
    expect(recoveredIncumbent).toMatchObject({ draining_at: null });

    await incumbent.stop();
  });
});
