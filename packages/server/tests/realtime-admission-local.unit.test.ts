import { describe, expect, it } from "vitest";
import { createLocalRealtimeAdmissionService } from "../src/services/realtime-admission-service";

describe("local realtime admission authority", () => {
  it("enforces room capacity while preserving resume and exact release semantics", async () => {
    const service = createLocalRealtimeAdmissionService({
      instanceId: "local-capacity-test",
    });
    const room = await service.admitRoom({
      roomId: "ROOM-A",
      maxControllers: 2,
    });
    expect(room.ok).toBe(true);
    if (!room.ok) throw new Error(room.message);

    const first = await service.admitController({
      roomLease: room.lease,
      controllerId: "controller-1",
    });
    const second = await service.admitController({
      roomLease: room.lease,
      controllerId: "controller-2",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("controllers not admitted");

    await expect(
      service.admitController({
        roomLease: room.lease,
        controllerId: "controller-3",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "room_full" });

    const resumed = await service.admitController({
      roomLease: room.lease,
      controllerId: first.lease.controllerId,
      existingLease: first.lease,
    });
    expect(resumed).toMatchObject({
      ok: true,
      lease: { roomId: "ROOM-A", controllerId: "controller-1" },
    });
    if (!resumed.ok) throw new Error(resumed.message);
    expect(resumed.lease.leaseToken).not.toBe(first.lease.leaseToken);

    await service.releaseController(first.lease);
    await expect(
      service.admitController({
        roomLease: room.lease,
        controllerId: "controller-3",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "room_full" });

    await service.releaseController(resumed.lease);
    await expect(
      service.admitController({
        roomLease: room.lease,
        controllerId: "controller-3",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("validates leases and performs controller replacement atomically", async () => {
    const service = createLocalRealtimeAdmissionService();
    const room = await service.admitRoom({
      roomId: "ROOM-B",
      maxControllers: 1,
    });
    expect(room.ok).toBe(true);
    if (!room.ok) throw new Error(room.message);

    await expect(
      service.admitController({
        roomLease: { ...room.lease, leaseToken: "wrong-room-lease" },
        controllerId: "controller-wrong-room",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "authority_unavailable",
    });

    const first = await service.admitController({
      roomLease: room.lease,
      controllerId: "controller-before-replacement",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);

    const replacement = await service.admitController({
      roomLease: room.lease,
      controllerId: "controller-after-replacement",
      replacingLease: first.lease,
    });
    expect(replacement).toMatchObject({ ok: true });
    if (!replacement.ok) throw new Error(replacement.message);

    await expect(
      service.admitController({
        roomLease: room.lease,
        controllerId: "controller-conflict",
        replacingLease: first.lease,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "authority_unavailable",
    });
  });

  it("rejects new work while draining but permits an existing controller resume", async () => {
    const service = createLocalRealtimeAdmissionService();
    const room = await service.admitRoom({
      roomId: "ROOM-C",
      maxControllers: 2,
    });
    expect(room.ok).toBe(true);
    if (!room.ok) throw new Error(room.message);
    const controller = await service.admitController({
      roomLease: room.lease,
      controllerId: "controller-resume",
    });
    expect(controller.ok).toBe(true);
    if (!controller.ok) throw new Error(controller.message);

    await service.beginDrain();
    await expect(
      service.admitRoom({ roomId: "ROOM-D", maxControllers: 1 }),
    ).resolves.toMatchObject({ ok: false, reason: "instance_draining" });
    await expect(
      service.admitController({
        roomLease: room.lease,
        controllerId: "controller-new",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "instance_draining" });
    await expect(
      service.admitController({
        roomLease: room.lease,
        controllerId: controller.lease.controllerId,
        existingLease: controller.lease,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("replaces and releases rooms only with exact authority", async () => {
    const service = createLocalRealtimeAdmissionService();
    const first = await service.admitRoom({
      roomId: "ROOM-E",
      maxControllers: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);

    await service.releaseRoom({ ...first.lease, leaseToken: "wrong-lease" });
    await expect(
      service.admitRoom({ roomId: "ROOM-E", maxControllers: 1 }),
    ).resolves.toMatchObject({ ok: false, reason: "room_conflict" });

    const second = await service.admitRoom({
      roomId: "ROOM-F",
      maxControllers: 1,
      replacingLease: first.lease,
    });
    expect(second).toMatchObject({ ok: true });
    await expect(
      service.admitController({
        roomLease: first.lease,
        controllerId: "controller-old-room",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "authority_unavailable",
    });
  });
});
