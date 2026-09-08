import { DEFAULT_ROOM_PLATFORM_SETTINGS } from "@air-jam/sdk";
import type { Server } from "socket.io";
import { describe, expect, it, vi } from "vitest";
import {
  beginChildHostActivation,
  beginGameLaunch,
  beginRoomClosing,
  buildRoomStateMessage,
  canActivateChildHost,
  canBeginGameLaunch,
  canTransitionRoomLifecycle,
  emitRoomState,
  getRoomLifecyclePhase,
  issueChildHostCapability,
  markRoomTeardown,
  resetRoomToSystemState,
} from "../src/domain/room-session-domain";
import type { RoomSession } from "../src/types";

const createSession = (): RoomSession => ({
  roomId: "ABCD",
  masterHostSocketId: "host-master",
  hostResumeCapability: { token: "host-resume-token" },
  analytics: {
    runtimeSessionId: "runtime-session-1",
    startedAt: Date.now(),
    hostSessionKind: "system",
  },
  focus: "SYSTEM",
  controllers: new Map(),
  replicatedStoreSnapshots: new Map(),
  maxPlayers: 8,
  runtimeState: "paused",
  stateVersion: 0,
  controllerOrientation: "portrait",
  roomSettings: DEFAULT_ROOM_PLATFORM_SETTINGS,
  lifecycleState: "SYSTEM_IDLE",
  admissionLease: {
    roomId: "ABCD",
    leaseToken: "test-room-lease",
  },
});

describe("room session domain lifecycle", () => {
  it("computes lifecycle phase from room state", () => {
    const session = createSession();
    expect(getRoomLifecyclePhase(session)).toBe("SYSTEM_IDLE");

    beginGameLaunch(session, issueChildHostCapability("token-1"), "g1");
    expect(getRoomLifecyclePhase(session)).toBe("GAME_LAUNCH_PENDING");

    beginChildHostActivation(session, "host-child");
    expect(getRoomLifecyclePhase(session)).toBe("GAME_ACTIVE");
  });

  it("allows launch only from idle system state", () => {
    const idleSession = createSession();
    expect(canBeginGameLaunch(idleSession)).toEqual({ ok: true });

    const pendingSession = createSession();
    pendingSession.lifecycleState = "GAME_LAUNCH_PENDING";
    expect(canBeginGameLaunch(pendingSession)).toEqual({
      ok: false,
      reason: "LAUNCH_PENDING",
    });

    const activeSession = createSession();
    activeSession.lifecycleState = "GAME_ACTIVE";
    expect(canBeginGameLaunch(activeSession)).toEqual({
      ok: false,
      reason: "GAME_ACTIVE",
    });
  });

  it("resets stale runtime state and starts a new launch in playing state", () => {
    const session = createSession();
    session.runtimeState = "playing";
    session.controllerOrientation = "landscape";

    const launchAttempt = beginGameLaunch(
      session,
      issueChildHostCapability("token-1"),
      "g1",
    );

    expect(launchAttempt).toEqual({ ok: true });
    expect(session.lifecycleState).toBe("GAME_LAUNCH_PENDING");
    expect(session.runtimeState).toBe("playing");
    expect(session.controllerOrientation).toBe("portrait");
  });

  it("resets game and routing fields when returning to system state", () => {
    const session = createSession();
    beginGameLaunch(session, issueChildHostCapability("token-1"), "g1");
    beginChildHostActivation(session, "host-child");
    session.runtimeState = "playing";

    resetRoomToSystemState(session, false);
    expect(session.focus).toBe("SYSTEM");
    expect(session.childHostSocketId).toBeUndefined();
    expect(session.launchCapability).toBeUndefined();
    expect(session.activeGameId).toBeUndefined();
    expect(session.lifecycleState).toBe("SYSTEM_IDLE");
    expect(session.runtimeState).toBe("playing");
    expect(session.controllerOrientation).toBe("portrait");

    session.runtimeState = "playing";
    session.controllerOrientation = "landscape";
    resetRoomToSystemState(session, true);
    expect(session.runtimeState).toBe("paused");
    expect(session.controllerOrientation).toBe("portrait");
  });

  it("blocks child-host activation unless launch is pending", () => {
    const idleSession = createSession();
    expect(canActivateChildHost(idleSession)).toEqual({
      ok: false,
      reason: "NO_LAUNCH_PENDING",
    });

    const pendingSession = createSession();
    beginGameLaunch(pendingSession, issueChildHostCapability("token-1"), "g1");
    expect(canActivateChildHost(pendingSession)).toEqual({ ok: true });

    const activeSession = createSession();
    activeSession.lifecycleState = "GAME_ACTIVE";
    expect(canActivateChildHost(activeSession)).toEqual({
      ok: false,
      reason: "GAME_ACTIVE",
    });
  });

  it("prevents invalid launch and activation transitions", () => {
    const activeSession = createSession();
    activeSession.lifecycleState = "GAME_ACTIVE";

    const launchAttempt = beginGameLaunch(
      activeSession,
      issueChildHostCapability("token-1"),
      "g1",
    );
    expect(launchAttempt).toEqual({ ok: false, reason: "GAME_ACTIVE" });
    expect(activeSession.launchCapability).toBeUndefined();

    const idleSession = createSession();
    const activationAttempt = beginChildHostActivation(
      idleSession,
      "host-child",
    );
    expect(activationAttempt).toEqual({
      ok: false,
      reason: "NO_LAUNCH_PENDING",
    });
    expect(idleSession.childHostSocketId).toBeUndefined();
  });

  it("enforces explicit closing and teardown transitions", () => {
    const session = createSession();
    expect(beginRoomClosing(session)).toEqual({ ok: true });
    expect(session.lifecycleState).toBe("CLOSING");

    expect(canBeginGameLaunch(session)).toEqual({
      ok: false,
      reason: "ROOM_CLOSING",
    });

    expect(markRoomTeardown(session)).toEqual({ ok: true });
    expect(session.lifecycleState).toBe("TEARDOWN");
    expect(canActivateChildHost(session)).toEqual({
      ok: false,
      reason: "ROOM_TORN_DOWN",
    });
  });

  it("rejects invalid lifecycle transitions", () => {
    const session = createSession();
    markRoomTeardown(session);

    const invalid = canTransitionRoomLifecycle(session, "SYSTEM_IDLE");
    expect(invalid).toEqual({ ok: false, reason: "INVALID_TRANSITION" });
  });

  it("increments state version when broadcasting room state", () => {
    const session = createSession();
    const emit = vi.fn();
    const io = {
      to: vi.fn(() => ({ emit })),
    } as unknown as Server;

    const first = emitRoomState(io, session.roomId, session);
    expect(first.state.stateVersion).toBe(1);
    expect(first.state.roomSettings).toEqual(DEFAULT_ROOM_PLATFORM_SETTINGS);
    expect(session.stateVersion).toBe(1);
    expect(emit).toHaveBeenCalledWith("server:state", first);

    const snapshot = buildRoomStateMessage(session.roomId, session);
    expect(snapshot.state.stateVersion).toBe(1);
    expect(snapshot.state.roomSettings).toEqual(DEFAULT_ROOM_PLATFORM_SETTINGS);
  });
});
