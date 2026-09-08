import { REALTIME_ADMISSION_POLICY } from "@air-jam/database-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RealtimeAdmissionDecision,
  RealtimeAdmissionService,
  RealtimeControllerLease,
} from "../src/services/realtime-admission-service";
import { setupServerTestHarness } from "./helpers/server-test-harness";

describe("realtime admission socket boundary", () => {
  let mode: "allow" | "deny-room" | "deny-controller" = "allow";
  type ControllerAdmissionInput = Parameters<
    RealtimeAdmissionService["admitController"]
  >[0];
  type ControllerAdmissionDecision =
    RealtimeAdmissionDecision<RealtimeControllerLease>;
  type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
  };
  const createDeferred = <T>(): Deferred<T> => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
      resolve = nextResolve;
    });
    return { promise, resolve };
  };
  let deferredControllerAdmission: {
    called: Deferred<ControllerAdmissionInput>;
    decision: Deferred<ControllerAdmissionDecision>;
  } | null = null;
  let deferredControllerRelease: {
    called: Deferred<RealtimeControllerLease>;
    completed: Deferred<void>;
  } | null = null;
  const releaseController = vi.fn(async (lease: RealtimeControllerLease) => {
    const pending = deferredControllerRelease;
    if (!pending) {
      return;
    }
    deferredControllerRelease = null;
    pending.called.resolve(lease);
    await pending.completed.promise;
  });
  const releaseRoom = vi.fn(async () => undefined);
  const markControllerDisconnected = vi.fn(async () => undefined);
  const deferNextControllerAdmission = () => {
    const deferred = {
      called: createDeferred<ControllerAdmissionInput>(),
      decision: createDeferred<ControllerAdmissionDecision>(),
    };
    deferredControllerAdmission = deferred;
    return deferred;
  };
  const deferNextControllerRelease = () => {
    const deferred = {
      called: createDeferred<RealtimeControllerLease>(),
      completed: createDeferred<void>(),
    };
    deferredControllerRelease = deferred;
    return deferred;
  };

  beforeEach(() => {
    mode = "allow";
    deferredControllerAdmission = null;
    deferredControllerRelease = null;
    releaseController.mockClear();
    releaseRoom.mockClear();
    markControllerDisconnected.mockClear();
  });

  const service: RealtimeAdmissionService = {
    start: async () => undefined,
    beginDrain: async () => undefined,
    stop: async () => undefined,
    admitRoom: async ({ roomId }) =>
      mode === "deny-room"
        ? {
            ok: false,
            reason: "global_capacity_exceeded",
            message: "Air Jam is at room capacity. Please try again shortly.",
            retryAfterSeconds: 15,
          }
        : {
            ok: true,
            lease: { roomId, leaseToken: `room-lease-${roomId}` },
          },
    releaseRoom,
    admitController: async (input) => {
      const pending = deferredControllerAdmission;
      if (pending) {
        deferredControllerAdmission = null;
        pending.called.resolve(input);
        return pending.decision.promise;
      }
      const { roomLease, controllerId, existingLease } = input;
      return mode === "deny-controller"
        ? {
            ok: false,
            reason: "room_full",
            message: "Room full",
            retryAfterSeconds: null,
          }
        : {
            ok: true,
            lease:
              existingLease ??
              ({
                roomId: roomLease.roomId,
                controllerId,
                leaseToken: `controller-lease-${controllerId}`,
              } satisfies RealtimeControllerLease),
          };
    },
    markControllerDisconnected,
    releaseController,
    getStatus: () => ({
      contractVersion: 1,
      authority: "database",
      budgetRequirement: "required",
      instanceId: "test-admission",
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
  const harness = setupServerTestHarness({
    server: { realtimeAdmissionService: service },
  });

  it("rejects only the new room while leaving the healthy interaction model unchanged", async () => {
    mode = "deny-room";
    const host = await harness.connectSocket();
    expect(await harness.bootstrapHost(host, "app-test", "game")).toMatchObject(
      {
        ok: true,
      },
    );

    const ack = await harness.emitWithAck<{
      ok: boolean;
      code?: string;
      message?: string;
    }>(host, "host:createRoom", { maxPlayers: 8 });

    expect(ack).toMatchObject({
      ok: false,
      code: "SERVICE_UNAVAILABLE",
      message: "Air Jam is at room capacity. Please try again shortly.",
    });
    expect(harness.getRoomManager().getAllRooms().size).toBe(0);
  });

  it("maps authoritative room capacity to the existing controller UX", async () => {
    mode = "allow";
    const host = await harness.connectSocket();
    await harness.bootstrapHost(host, "app-test", "game");
    const room = await harness.emitWithAck<{
      ok: boolean;
      roomId: string;
    }>(host, "host:createRoom", { maxPlayers: 8 });
    expect(room.ok).toBe(true);

    mode = "deny-controller";
    const controller = await harness.connectSocket();
    const ack = await harness.emitWithAck<{
      ok: boolean;
      code?: string;
      message?: string;
    }>(controller, "controller:join", {
      roomId: room.roomId,
      controllerId: "controller-capacity-test",
      deviceId: "device-capacity-test",
    });

    expect(ack).toEqual({
      ok: false,
      code: "ROOM_FULL",
      message: "Room full",
    });
    expect(
      harness.getRoomManager().getRoom(room.roomId)?.controllers.size,
    ).toBe(0);
  });

  it("releases a controller admitted after its room was torn down", async () => {
    const host = await harness.connectSocket();
    await harness.bootstrapHost(host, "app-race-room", "game");
    const room = await harness.emitWithAck<{
      ok: boolean;
      roomId: string;
    }>(host, "host:createRoom", { maxPlayers: 8 });
    expect(room.ok).toBe(true);

    const deferred = deferNextControllerAdmission();
    const controller = await harness.connectSocket();
    const joinAck = new Promise<{
      ok: boolean;
      code?: string;
      message?: string;
    }>((resolve) => {
      controller.emit(
        "controller:join",
        {
          roomId: room.roomId,
          controllerId: "controller-room-teardown-race",
          deviceId: "device-room-teardown-race",
        },
        resolve,
      );
    });
    await deferred.called.promise;

    host.disconnect();
    await vi.waitFor(
      () =>
        expect(harness.getRoomManager().getRoom(room.roomId)).toBeUndefined(),
      { timeout: 3_500 },
    );
    const admittedLease = {
      roomId: room.roomId,
      controllerId: "controller-room-teardown-race",
      leaseToken: "lease-room-teardown-race",
    };
    deferred.decision.resolve({ ok: true, lease: admittedLease });

    await expect(joinAck).resolves.toMatchObject({
      ok: false,
      code: "SERVICE_UNAVAILABLE",
    });
    expect(releaseRoom).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: room.roomId }),
    );
    expect(releaseController).toHaveBeenCalledWith(admittedLease);
    expect(harness.getRoomManager().getControllerInfo(controller.id!)).toBe(
      undefined,
    );
  });

  it("does not resurrect a replacement controller when leave wins deferred admission", async () => {
    const host = await harness.connectSocket();
    await harness.bootstrapHost(host, "app-race-leave", "game");
    const room = await harness.emitWithAck<{
      ok: boolean;
      roomId: string;
    }>(host, "host:createRoom", { maxPlayers: 8 });
    const controller = await harness.connectSocket();
    const identity = {
      roomId: room.roomId,
      controllerId: "controller-leave-race",
      deviceId: "device-leave-race",
    };
    expect(
      await harness.emitWithAck<{ ok: boolean }>(
        controller,
        "controller:join",
        identity,
      ),
    ).toMatchObject({ ok: true });
    const existingLease = harness
      .getRoomManager()
      .getRoom(room.roomId)!
      .controllers.get(identity.controllerId)!.admissionLease;

    const replacementIdentity = {
      roomId: room.roomId,
      controllerId: "controller-after-leave-race",
      deviceId: "device-after-leave-race",
    };
    const deferred = deferNextControllerAdmission();
    const replacementAck = new Promise<{ ok: boolean; code?: string }>(
      (resolve) => {
        controller.emit("controller:join", replacementIdentity, resolve);
      },
    );
    const admissionInput = await deferred.called.promise;
    expect(admissionInput.existingLease).toBeUndefined();
    expect(admissionInput.replacingLease).toEqual(existingLease);

    await expect(
      harness.emitWithAck<{ ok: boolean }>(
        controller,
        "controller:leave",
        identity,
      ),
    ).resolves.toEqual({ ok: true });
    const replacementLease = {
      roomId: room.roomId,
      controllerId: replacementIdentity.controllerId,
      leaseToken: "lease-after-leave-race",
    };
    deferred.decision.resolve({ ok: true, lease: replacementLease });

    await expect(replacementAck).resolves.toMatchObject({
      ok: false,
      code: "SERVICE_UNAVAILABLE",
    });
    expect(
      harness
        .getRoomManager()
        .getRoom(room.roomId)
        ?.controllers.has(identity.controllerId),
    ).toBe(false);
    expect(
      harness
        .getRoomManager()
        .getRoom(room.roomId)
        ?.controllers.has(replacementIdentity.controllerId),
    ).toBe(false);
    expect(harness.getRoomManager().getControllerInfo(controller.id!)).toBe(
      undefined,
    );
    expect(releaseController).toHaveBeenCalledTimes(2);
    expect(releaseController).toHaveBeenNthCalledWith(1, existingLease);
    expect(releaseController).toHaveBeenNthCalledWith(2, replacementLease);
  });

  it("revokes local controller authority before its database release completes", async () => {
    const host = await harness.connectSocket();
    await harness.bootstrapHost(host, "app-race-release", "game");
    const room = await harness.emitWithAck<{
      ok: boolean;
      roomId: string;
    }>(host, "host:createRoom", { maxPlayers: 8 });
    const controller = await harness.connectSocket();
    const identity = {
      roomId: room.roomId,
      controllerId: "controller-release-race",
      deviceId: "device-release-race",
    };
    expect(
      await harness.emitWithAck<{ ok: boolean }>(
        controller,
        "controller:join",
        identity,
      ),
    ).toEqual(expect.objectContaining({ ok: true }));

    const deferred = deferNextControllerRelease();
    const leaveAck = new Promise<{ ok: boolean }>((resolve) => {
      controller.emit("controller:leave", identity, resolve);
    });
    await deferred.called.promise;

    expect(
      harness
        .getRoomManager()
        .getRoom(room.roomId)
        ?.controllers.has(identity.controllerId),
    ).toBe(false);
    expect(harness.getRoomManager().getControllerInfo(controller.id!)).toBe(
      undefined,
    );
    controller.emit("controller:input", {
      roomId: room.roomId,
      controllerId: identity.controllerId,
      input: { action: true },
    });
    await harness.expectNoEvent(host, "server:input", 100);

    deferred.completed.resolve(undefined);
    await expect(leaveAck).resolves.toEqual({ ok: true });
  });

  it("disconnects a host-removed controller before its database release completes", async () => {
    const host = await harness.connectSocket();
    await harness.bootstrapHost(host, "app-race-host-remove", "game");
    const room = await harness.emitWithAck<{
      ok: boolean;
      roomId: string;
    }>(host, "host:createRoom", { maxPlayers: 8 });
    const controller = await harness.connectSocket();
    const identity = {
      roomId: room.roomId,
      controllerId: "controller-host-remove-race",
      deviceId: "device-host-remove-race",
    };
    expect(
      await harness.emitWithAck<{ ok: boolean }>(
        controller,
        "controller:join",
        identity,
      ),
    ).toEqual(expect.objectContaining({ ok: true }));

    const deferred = deferNextControllerRelease();
    const removeAck = new Promise<{ ok: boolean }>((resolve) => {
      host.emit("host:removeController", identity, resolve);
    });
    await deferred.called.promise;

    expect(
      harness
        .getRoomManager()
        .getRoom(room.roomId)
        ?.controllers.has(identity.controllerId),
    ).toBe(false);
    expect(harness.getRoomManager().getControllerInfo(controller.id!)).toBe(
      undefined,
    );
    await vi.waitFor(() => expect(controller.connected).toBe(false));

    deferred.completed.resolve(undefined);
    await expect(removeAck).resolves.toEqual({ ok: true });
  });

  it("does not resurrect a stale controller when resume expiry wins deferred admission", async () => {
    const host = await harness.connectSocket();
    await harness.bootstrapHost(host, "app-race-expiry", "game");
    const room = await harness.emitWithAck<{
      ok: boolean;
      roomId: string;
    }>(host, "host:createRoom", { maxPlayers: 8 });
    const originalController = await harness.connectSocket();
    const identity = {
      roomId: room.roomId,
      controllerId: "controller-expiry-race",
      deviceId: "device-expiry-race",
    };
    expect(
      await harness.emitWithAck<{ ok: boolean }>(
        originalController,
        "controller:join",
        identity,
      ),
    ).toMatchObject({ ok: true });
    const existingLease = harness
      .getRoomManager()
      .getRoom(room.roomId)!
      .controllers.get(identity.controllerId)!.admissionLease;

    originalController.disconnect();
    await vi.waitFor(() =>
      expect(markControllerDisconnected).toHaveBeenCalledWith(
        existingLease,
        100,
      ),
    );
    const deferred = deferNextControllerAdmission();
    const resumedController = await harness.connectSocket();
    const resumeAck = new Promise<{ ok: boolean; code?: string }>((resolve) => {
      resumedController.emit("controller:join", identity, resolve);
    });
    const admissionInput = await deferred.called.promise;
    expect(admissionInput.existingLease).toEqual(existingLease);

    await vi.waitFor(
      () =>
        expect(
          harness
            .getRoomManager()
            .getRoom(room.roomId)
            ?.controllers.has(identity.controllerId),
        ).toBe(false),
      { timeout: 500 },
    );
    deferred.decision.resolve({ ok: true, lease: existingLease });

    await expect(resumeAck).resolves.toMatchObject({
      ok: false,
      code: "SERVICE_UNAVAILABLE",
    });
    expect(
      harness.getRoomManager().getControllerInfo(resumedController.id!),
    ).toBeUndefined();
    expect(releaseController).toHaveBeenCalledTimes(2);
    expect(releaseController).toHaveBeenNthCalledWith(1, existingLease);
    expect(releaseController).toHaveBeenNthCalledWith(2, existingLease);
  });

  it("releases a deferred admission completed after its socket disconnects", async () => {
    const host = await harness.connectSocket();
    await harness.bootstrapHost(host, "app-race-disconnect", "game");
    const room = await harness.emitWithAck<{
      ok: boolean;
      roomId: string;
    }>(host, "host:createRoom", { maxPlayers: 8 });
    const deferred = deferNextControllerAdmission();
    const controller = await harness.connectSocket();
    const acknowledgement = vi.fn();
    controller.emit(
      "controller:join",
      {
        roomId: room.roomId,
        controllerId: "controller-disconnect-race",
        deviceId: "device-disconnect-race",
      },
      acknowledgement,
    );
    await deferred.called.promise;

    controller.disconnect();
    await harness.delay(25);
    const admittedLease = {
      roomId: room.roomId,
      controllerId: "controller-disconnect-race",
      leaseToken: "lease-disconnect-race",
    };
    deferred.decision.resolve({ ok: true, lease: admittedLease });

    await vi.waitFor(() =>
      expect(releaseController).toHaveBeenCalledWith(admittedLease),
    );
    expect(acknowledgement).not.toHaveBeenCalled();
    expect(
      harness
        .getRoomManager()
        .getRoom(room.roomId)
        ?.controllers.has(admittedLease.controllerId),
    ).toBe(false);
  });
});
