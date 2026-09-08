// @vitest-environment jsdom

import {
  resolveRuntimeTopology,
  runtimeTopologyToQueryParams,
} from "@air-jam/sdk/runtime-topology";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onAirJamDiagnostic } from "../src/diagnostics";
import { useAirJamController } from "../src/hooks/use-air-jam-controller";
import { useAirJamHost } from "../src/hooks/use-air-jam-host";
import { resolveAirJamConfig } from "../src/runtime/air-jam-config";
import { resetControllerRealtimeClientForTests } from "../src/runtime/controller-realtime-client";
import {
  AIRJAM_DEV_RUNTIME_EVENT,
  type AirJamDevRuntimeEventDetail,
} from "../src/runtime/dev-runtime-events";
import { resetHostRealtimeClientForTests } from "../src/runtime/host-realtime-client";
import {
  AirJamControllerRuntime,
  AirJamHostRuntime,
} from "../src/runtime/session-runtimes";
import { createAirJamStore } from "../src/state/connection-store";

interface MockSocket {
  connected: boolean;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

const mocked = vi.hoisted(() => ({
  createMockSocket: () => {
    type Listener = (...args: unknown[]) => void;
    const listeners = new Map<string, Set<Listener>>();

    const socket = {
      connected: true,
      on: vi.fn((event: string, handler: Listener) => {
        const current = listeners.get(event) ?? new Set<Listener>();
        current.add(handler);
        listeners.set(event, current);
        return socket;
      }),
      off: vi.fn((event: string, handler: Listener) => {
        const current = listeners.get(event);
        if (!current) {
          return socket;
        }
        current.delete(handler);
        if (current.size === 0) {
          listeners.delete(event);
        }
        return socket;
      }),
      emit: vi.fn(),
      connect: vi.fn(() => socket),
      disconnect: vi.fn(() => {
        socket.connected = false;
        return socket;
      }),
    };

    return socket;
  },
  store: null as ReturnType<typeof createAirJamStore> | null,
  controllerSocket: null as unknown as MockSocket,
  hostSocket: null as unknown as MockSocket,
  useAirJamContext: vi.fn(),
  useAssertSessionScope: vi.fn(),
  useClaimSessionRuntimeOwner: vi.fn(),
}));

vi.mock("../src/context/air-jam-context", async () => {
  const actual = await vi.importActual<
    typeof import("../src/context/air-jam-context")
  >("../src/context/air-jam-context");

  return {
    ...actual,
    useAirJamContext: mocked.useAirJamContext,
  };
});

vi.mock("../src/context/session-scope", async () => {
  const actual = await vi.importActual<
    typeof import("../src/context/session-scope")
  >("../src/context/session-scope");

  return {
    ...actual,
    useAssertSessionScope: mocked.useAssertSessionScope,
    useClaimSessionRuntimeOwner: mocked.useClaimSessionRuntimeOwner,
  };
});

const PROVIDER_CONFIG = {
  topology: resolveRuntimeTopology({
    runtimeMode: "self-hosted-production",
    surfaceRole: "host",
    appOrigin: "http://localhost:3000",
    backendOrigin: "http://localhost:3001",
    publicHost: "http://localhost:3000",
  }),
  appId: "test_app_id",
};
const TEST_CONFIG = resolveAirJamConfig({
  topology: PROVIDER_CONFIG.topology,
  resolveEnv: false,
});
const TEST_HOST_RESUME_CAPABILITY = { token: "host-resume-token" };

const persistTestHostSession = (roomId = "ROOM1"): void => {
  sessionStorage.setItem("airjam_room_id", roomId);
  sessionStorage.setItem(
    "airjam_host_resume_capability",
    TEST_HOST_RESUME_CAPABILITY.token,
  );
};

const withArcadeRuntimeTopology = (
  path: string,
  surfaceRole: "host" | "controller",
): string => {
  const url = new URL(path, window.location.origin);
  const topology = resolveRuntimeTopology({
    runtimeMode: "arcade-live",
    surfaceRole,
    appOrigin: window.location.origin,
    backendOrigin: window.location.origin,
    socketOrigin: window.location.origin,
    publicHost: "https://platform.example",
    assetBasePath: "/",
    secureTransport: false,
    embedded: true,
    embedParentOrigin: "https://platform.example",
    proxyStrategy: "none",
  });
  for (const [key, value] of Object.entries(
    runtimeTopologyToQueryParams(topology),
  )) {
    url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}`;
};

const createHostWrapper =
  () =>
  ({ children }: { children: ReactNode }) =>
    React.createElement(AirJamHostRuntime, {
      ...PROVIDER_CONFIG,
      children,
    });

const createControllerWrapper =
  (
    options: {
      roomId?: string;
      controllerId?: string;
      nickname?: string;
      avatarId?: string;
    } = {},
  ) =>
  ({ children }: { children: ReactNode }) =>
    React.createElement(AirJamControllerRuntime, {
      ...PROVIDER_CONFIG,
      ...options,
      children,
    });

describe("session reconnect behavior", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    sessionStorage.clear();
    mocked.store = createAirJamStore();
    mocked.controllerSocket = mocked.createMockSocket();
    mocked.hostSocket = mocked.createMockSocket();
    vi.stubGlobal("fetch", vi.fn());

    mocked.useAirJamContext.mockReturnValue({
      config: {
        ...TEST_CONFIG,
        appId: undefined,
      },
      store: mocked.store,
      getSocket: (role: "host" | "controller") =>
        role === "controller" ? mocked.controllerSocket : mocked.hostSocket,
      disconnectSocket: vi.fn(),
      inputManager: null,
    });
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
    mocked.store = null;
    resetControllerRealtimeClientForTests();
    resetHostRealtimeClientForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("recovers controller status when the cached socket is already connected", async () => {
    const { result } = renderHook(() => useAirJamController(), {
      wrapper: createControllerWrapper({
        roomId: "ROOM1",
        controllerId: "ctrl_1",
      }),
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected");
    });

    expect(mocked.controllerSocket.connect).not.toHaveBeenCalled();
    expect(mocked.controllerSocket.emit).toHaveBeenCalledWith(
      "controller:join",
      expect.objectContaining({
        roomId: "ROOM1",
        controllerId: "ctrl_1",
        nickname: undefined,
      }),
      expect.any(Function),
    );
  });

  it("retries a controller admission denial after the server retry-after delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let joinAttempts = 0;
    mocked.controllerSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event !== "controller:join") {
          return;
        }
        joinAttempts += 1;
        callback?.(
          joinAttempts === 1
            ? {
                ok: false,
                code: "SERVICE_UNAVAILABLE",
                message: "Admission authority is busy",
                retryAfterSeconds: 1,
              }
            : { ok: true, controllerId: "ctrl_retry_1" },
        );
      },
    );

    const { result } = renderHook(() => useAirJamController(), {
      wrapper: createControllerWrapper({
        roomId: "ROOM1",
        controllerId: "ctrl_retry_1",
      }),
    });

    expect(joinAttempts).toBe(1);
    expect(result.current.connectionStatus).toBe("connecting");
    expect(result.current.lastError).toBe("Admission authority is busy");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(joinAttempts).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(joinAttempts).toBe(2);
    expect(result.current.connectionStatus).toBe("connected");
    expect(result.current.lastError).toBeUndefined();
  });

  it("cancels a pending controller admission retry on unmount", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let joinAttempts = 0;
    mocked.controllerSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "controller:join") {
          joinAttempts += 1;
          callback?.({
            ok: false,
            code: "SERVICE_UNAVAILABLE",
            message: "Admission authority is busy",
            retryAfterSeconds: 1,
          });
        }
      },
    );

    const { unmount } = renderHook(() => useAirJamController(), {
      wrapper: createControllerWrapper({ roomId: "ROOM1" }),
    });
    expect(joinAttempts).toBe(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(joinAttempts).toBe(1);
  });

  it("keeps controller runtime state unchanged on disconnect", async () => {
    const { result } = renderHook(() => useAirJamController(), {
      wrapper: createControllerWrapper({
        roomId: "ROOM1",
        controllerId: "ctrl_1",
      }),
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected");
    });

    const stateHandler = mocked.controllerSocket.on.mock.calls.find(
      ([event]) => event === "server:state",
    )?.[1] as
      | ((payload: {
          roomId: string;
          state: { runtimeState?: "paused" | "playing" };
        }) => void)
      | undefined;
    expect(stateHandler).toBeDefined();

    act(() => {
      stateHandler?.({
        roomId: "ROOM1",
        state: { runtimeState: "playing" },
      });
    });
    expect(result.current.runtimeState).toBe("playing");

    const disconnectHandler = mocked.controllerSocket.on.mock.calls.find(
      ([event]) => event === "disconnect",
    )?.[1] as ((reason?: string) => void) | undefined;
    expect(disconnectHandler).toBeDefined();

    act(() => {
      disconnectHandler?.("transport close");
    });

    expect(result.current.connectionStatus).toBe("disconnected");
    expect(result.current.runtimeState).toBe("playing");
  });

  it("hydrates controller players from the welcome roster", async () => {
    const { result } = renderHook(() => useAirJamController(), {
      wrapper: createControllerWrapper({
        roomId: "ROOM1",
        controllerId: "ctrl_1",
      }),
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected");
    });

    const welcomeHandler = mocked.controllerSocket.on.mock.calls.find(
      ([event]) => event === "server:welcome",
    )?.[1] as
      | ((payload: {
          controllerId: string;
          roomId: string;
          player?: { id: string; label: string };
          players?: Array<{ id: string; label: string }>;
        }) => void)
      | undefined;
    expect(welcomeHandler).toBeDefined();

    act(() => {
      welcomeHandler?.({
        controllerId: "ctrl_1",
        roomId: "ROOM1",
        player: { id: "ctrl_1", label: "Alpha" },
        players: [
          { id: "ctrl_1", label: "Alpha" },
          { id: "ctrl_2", label: "Beta" },
        ],
      });
    });

    expect(result.current.players).toEqual([
      { id: "ctrl_1", label: "Alpha" },
      { id: "ctrl_2", label: "Beta" },
    ]);
  });

  it("applies controller roster join and leave notices after welcome", async () => {
    const { result } = renderHook(() => useAirJamController(), {
      wrapper: createControllerWrapper({
        roomId: "ROOM1",
        controllerId: "ctrl_1",
      }),
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected");
    });

    const joinedHandler = mocked.controllerSocket.on.mock.calls.find(
      ([event]) => event === "server:controllerJoined",
    )?.[1] as
      | ((payload: {
          controllerId: string;
          player?: { id: string; label: string };
        }) => void)
      | undefined;
    const leftHandler = mocked.controllerSocket.on.mock.calls.find(
      ([event]) => event === "server:controllerLeft",
    )?.[1] as ((payload: { controllerId: string }) => void) | undefined;
    expect(joinedHandler).toBeDefined();
    expect(leftHandler).toBeDefined();

    act(() => {
      joinedHandler?.({
        controllerId: "ctrl_2",
        player: { id: "ctrl_2", label: "Beta" },
      });
    });

    expect(result.current.players).toContainEqual({
      id: "ctrl_2",
      label: "Beta",
    });

    act(() => {
      leftHandler?.({
        controllerId: "ctrl_2",
      });
    });

    expect(result.current.players).not.toContainEqual({
      id: "ctrl_2",
      label: "Beta",
    });
  });

  it("retries host room admission and persists the resulting resume capability", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    sessionStorage.clear();
    let createAttempts = 0;
    mocked.hostSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({ ok: true });
          return;
        }
        if (event === "host:createRoom") {
          createAttempts += 1;
          callback?.(
            createAttempts === 1
              ? {
                  ok: false,
                  code: "SERVICE_UNAVAILABLE",
                  message: "Room admission is busy",
                  retryAfterSeconds: 1,
                }
              : {
                  ok: true,
                  roomId: "ROOM1",
                  hostResumeCapability: TEST_HOST_RESUME_CAPABILITY,
                },
          );
        }
      },
    );

    const { result } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(createAttempts).toBe(1);
    expect(result.current.connectionStatus).toBe("connecting");
    expect(result.current.lastError).toBe("Room admission is busy");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(createAttempts).toBe(2);
    expect(result.current.connectionStatus).toBe("connected");
    expect(result.current.lastError).toBeUndefined();
    expect(sessionStorage.getItem("airjam_room_id")).toBe("ROOM1");
    expect(sessionStorage.getItem("airjam_host_resume_capability")).toBe(
      TEST_HOST_RESUME_CAPABILITY.token,
    );
  });

  it("cancels a pending host admission retry on unmount", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    sessionStorage.clear();
    let createAttempts = 0;
    mocked.hostSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({ ok: true });
          return;
        }
        if (event === "host:createRoom") {
          createAttempts += 1;
          callback?.({
            ok: false,
            code: "SERVICE_UNAVAILABLE",
            message: "Room admission is busy",
            retryAfterSeconds: 1,
          });
        }
      },
    );

    const { unmount } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(createAttempts).toBe(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(createAttempts).toBe(1);
  });

  it("retries a reset admission denial and preserves structured attempt events", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let resetAttempts = 0;
    const runtimeEvents: AirJamDevRuntimeEventDetail[] = [];
    const runtimeEventHandler = (event: Event) => {
      runtimeEvents.push(
        (event as CustomEvent<AirJamDevRuntimeEventDetail>).detail,
      );
    };
    window.addEventListener(AIRJAM_DEV_RUNTIME_EVENT, runtimeEventHandler);
    mocked.hostSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({ ok: true });
          return;
        }
        if (event === "host:createRoom") {
          callback?.({
            ok: true,
            roomId: "ROOM1",
            hostResumeCapability: TEST_HOST_RESUME_CAPABILITY,
          });
          return;
        }
        if (event === "host:resetRoom") {
          resetAttempts += 1;
          callback?.(
            resetAttempts === 1
              ? {
                  ok: false,
                  code: "SERVICE_UNAVAILABLE",
                  message: "Reset admission is busy",
                  retryAfterSeconds: 1,
                }
              : {
                  ok: true,
                  roomId: "ROOM2",
                  hostResumeCapability: { token: "reset-resume-token" },
                },
          );
        }
      },
    );

    const { result, unmount } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });
    await act(async () => {
      await Promise.resolve();
    });

    const resetPromise = result.current.resetRoom();
    await act(async () => {
      await Promise.resolve();
    });
    expect(resetAttempts).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(resetAttempts).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    await expect(resetPromise).resolves.toMatchObject({
      ok: true,
      roomId: "ROOM2",
    });
    expect(resetAttempts).toBe(2);
    expect(result.current.roomId).toBe("ROOM2");
    expect(sessionStorage.getItem("airjam_host_resume_capability")).toBe(
      "reset-resume-token",
    );
    expect(
      runtimeEvents
        .filter(({ event }) => event === "runtime.host.reset_room.requested")
        .map(({ data }) => data),
    ).toEqual([
      { admissionAttempt: 1 },
      {
        admissionAttempt: 2,
        retryReasonCode: "SERVICE_UNAVAILABLE",
        retryAfterSeconds: 1,
      },
    ]);

    unmount();
    window.removeEventListener(AIRJAM_DEV_RUNTIME_EVENT, runtimeEventHandler);
  });

  it("does not retry reset denials outside the admission retry contract", async () => {
    vi.useFakeTimers();
    let resetAttempts = 0;
    mocked.hostSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({ ok: true });
          return;
        }
        if (event === "host:createRoom") {
          callback?.({
            ok: true,
            roomId: "ROOM1",
            hostResumeCapability: TEST_HOST_RESUME_CAPABILITY,
          });
          return;
        }
        if (event === "host:resetRoom") {
          resetAttempts += 1;
          callback?.({
            ok: false,
            code: "ROOM_FULL",
            message: "Reset denied",
            retryAfterSeconds: 1,
          });
        }
      },
    );

    const { result } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });
    await act(async () => {
      await Promise.resolve();
    });

    await expect(result.current.resetRoom()).resolves.toMatchObject({
      ok: false,
      code: "ROOM_FULL",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(resetAttempts).toBe(1);
  });

  it("cancels a pending reset admission retry on unmount", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let resetAttempts = 0;
    mocked.hostSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({ ok: true });
          return;
        }
        if (event === "host:createRoom") {
          callback?.({
            ok: true,
            roomId: "ROOM1",
            hostResumeCapability: TEST_HOST_RESUME_CAPABILITY,
          });
          return;
        }
        if (event === "host:resetRoom") {
          resetAttempts += 1;
          callback?.({
            ok: false,
            code: "SERVICE_UNAVAILABLE",
            message: "Reset admission is busy",
            retryAfterSeconds: 1,
          });
        }
      },
    );

    const { result, unmount } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });
    await act(async () => {
      await Promise.resolve();
    });

    const resetPromise = result.current.resetRoom();
    await act(async () => {
      await Promise.resolve();
    });
    expect(resetAttempts).toBe(1);

    unmount();
    await expect(resetPromise).resolves.toMatchObject({
      ok: false,
      code: "CONNECTION_FAILED",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(resetAttempts).toBe(1);
  });

  it("cancels a pending reset admission retry when the room session changes", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let resetAttempts = 0;
    mocked.hostSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({ ok: true });
          return;
        }
        if (event === "host:createRoom") {
          callback?.({
            ok: true,
            roomId: "ROOM1",
            hostResumeCapability: TEST_HOST_RESUME_CAPABILITY,
          });
          return;
        }
        if (event === "host:resetRoom") {
          resetAttempts += 1;
          callback?.({
            ok: false,
            code: "SERVICE_UNAVAILABLE",
            message: "Reset admission is busy",
            retryAfterSeconds: 1,
          });
        }
      },
    );

    const { result } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });
    await act(async () => {
      await Promise.resolve();
    });

    const resetPromise = result.current.resetRoom();
    await act(async () => {
      await Promise.resolve();
    });
    expect(resetAttempts).toBe(1);

    let cancelledAck: Awaited<typeof resetPromise> | undefined;
    await act(async () => {
      mocked.store?.getState().setRoomId("ROOM2");
      cancelledAck = await resetPromise;
    });
    expect(cancelledAck).toMatchObject({
      ok: false,
      code: "CONNECTION_FAILED",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(resetAttempts).toBe(1);
  });

  it("recovers host status when the cached socket is already connected", async () => {
    mocked.store?.getState().setRoomId("ROOM1");
    mocked.store?.getState().setRegisteredRoomId("ROOM1");
    persistTestHostSession();
    mocked.hostSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({ ok: true });
        }
        if (event === "host:reconnect") {
          callback?.({
            ok: true,
            roomId: "ROOM1",
            hostResumeCapability: TEST_HOST_RESUME_CAPABILITY,
          });
        }
      },
    );

    const { result } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected");
    });

    expect(mocked.hostSocket.connect).not.toHaveBeenCalled();
    expect(mocked.hostSocket.emit).toHaveBeenCalledWith(
      "host:bootstrap",
      { appId: undefined, hostSessionKind: "game" },
      expect.any(Function),
    );
    expect(mocked.hostSocket.emit).toHaveBeenCalledWith(
      "host:reconnect",
      {
        roomId: "ROOM1",
        resumeCapabilityToken: TEST_HOST_RESUME_CAPABILITY.token,
      },
      expect.any(Function),
    );
  });

  it("retains the arcade checkpoint even when reconnecting without an active game", async () => {
    mocked.store?.getState().setRoomId("ROOM1");
    mocked.store?.getState().setRegisteredRoomId("ROOM1");
    persistTestHostSession();
    mocked.hostSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({ ok: true });
        }
        if (event === "host:reconnect") {
          callback?.({
            ok: true,
            roomId: "ROOM1",
            arcadeSurfaceCheckpoint: { epoch: 9, revision: 12 },
          });
        }
      },
    );

    renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });

    await waitFor(() => {
      expect(mocked.store?.getState().hostArcadeRestore).toEqual({
        phase: "pending_restore",
        session: null,
        surfaceCheckpoint: { epoch: 9, revision: 12 },
      });
    });
  });

  it("hydrates existing players from the host reconnect ack", async () => {
    mocked.store?.getState().setRoomId("ROOM1");
    mocked.store?.getState().setRegisteredRoomId("ROOM1");
    persistTestHostSession();
    mocked.hostSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({ ok: true });
        }
        if (event === "host:reconnect") {
          callback?.({
            ok: true,
            roomId: "ROOM1",
            players: [
              {
                id: "ctrl_existing_1",
                label: "Existing Player",
                avatarId: "avatar-1",
              },
            ],
          });
        }
      },
    );

    const { result } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected");
    });

    expect(result.current.players).toEqual([
      {
        id: "ctrl_existing_1",
        label: "Existing Player",
        avatarId: "avatar-1",
      },
    ]);
  });

  it("blocks direct host state emits when the active room is no longer authoritative", async () => {
    mocked.store?.getState().setRoomId("ROOM1");
    mocked.store?.getState().setRegisteredRoomId("ROOM1");
    persistTestHostSession();
    mocked.hostSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({ ok: true });
        }
        if (event === "host:reconnect") {
          callback?.({ ok: true, roomId: "ROOM1" });
        }
      },
    );

    const { result } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected");
    });

    expect(
      result.current.sendState({
        runtimeState: "playing",
      }),
    ).toBe(true);
    expect(mocked.hostSocket.emit).toHaveBeenCalledWith("host:state", {
      roomId: "ROOM1",
      state: {
        runtimeState: "playing",
      },
    });

    act(() => {
      mocked.store?.getState().setRegisteredRoomId(null);
    });

    expect(
      result.current.sendState({
        runtimeState: "paused",
      }),
    ).toBe(false);
    expect(
      mocked.hostSocket.emit.mock.calls.filter(
        ([event]) => event === "host:state",
      ),
    ).toHaveLength(1);
  });

  it("fetches a signed host grant before bootstrap when a grant endpoint is configured", async () => {
    mocked.store?.getState().setRoomId("ROOM1");
    mocked.store?.getState().setRegisteredRoomId("ROOM1");
    persistTestHostSession();
    mocked.useAirJamContext.mockReturnValue({
      config: {
        ...TEST_CONFIG,
        appId: "aj_app_demo",
        hostGrantEndpoint: "/api/airjam/host-grant",
      },
      store: mocked.store,
      getSocket: (role: "host" | "controller") =>
        role === "controller" ? mocked.controllerSocket : mocked.hostSocket,
      disconnectSocket: vi.fn(),
      inputManager: null,
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ hostGrant: "signed_host_grant" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    mocked.hostSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({ ok: true });
        }
        if (event === "host:reconnect") {
          callback?.({ ok: true, roomId: "ROOM1" });
        }
      },
    );

    const { result } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected");
    });

    expect(fetch).toHaveBeenCalledWith("/api/airjam/host-grant", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ appId: "aj_app_demo" }),
    });
    expect(mocked.hostSocket.emit).toHaveBeenCalledWith(
      "host:bootstrap",
      { hostGrant: "signed_host_grant", hostSessionKind: "game" },
      expect.any(Function),
    );
  });

  it("emits a diagnostic when host bootstrap is rejected", async () => {
    const diagnostics: string[] = [];
    const unsubscribe = onAirJamDiagnostic((diagnostic) => {
      diagnostics.push(diagnostic.code);
    });

    mocked.hostSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({
            ok: false,
            code: "INVALID_APP_ID",
            message: "Unauthorized: Invalid or Missing App ID",
          });
        }
      },
    );

    const { result } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("disconnected");
    });

    expect(result.current.lastError).toBe(
      "Unauthorized: Invalid or Missing App ID",
    );
    expect(diagnostics).toContain("AJ_HOST_BOOTSTRAP_FAILED");
    unsubscribe();
  });

  it("surfaces a compatibility error when host bootstrap never acknowledges", async () => {
    vi.useFakeTimers();
    const diagnostics: string[] = [];
    const unsubscribe = onAirJamDiagnostic((diagnostic) => {
      diagnostics.push(diagnostic.code);
    });

    mocked.hostSocket.emit.mockImplementation((event: string) => {
      if (event === "host:bootstrap") {
        return;
      }
    });

    const { result } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });

    expect(result.current.connectionStatus).toBe("disconnected");
    expect(result.current.lastError).toBe(
      "Host bootstrap timed out. The deployed Air Jam server may be out of sync with this client.",
    );
    expect(diagnostics).toContain("AJ_HOST_BOOTSTRAP_FAILED");
    unsubscribe();
  });

  it("does not re-bootstrap on the same socket after createRoom updates room state", async () => {
    sessionStorage.clear();

    mocked.hostSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({ ok: true });
          return;
        }
        if (event === "host:createRoom") {
          callback?.({
            ok: true,
            roomId: "ROOM1",
            hostResumeCapability: TEST_HOST_RESUME_CAPABILITY,
          });
        }
      },
    );

    const { result } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected");
      expect(result.current.roomId).toBe("ROOM1");
    });

    await waitFor(() => {
      expect(
        mocked.hostSocket.emit.mock.calls.filter(
          ([event]) => event === "host:bootstrap",
        ),
      ).toHaveLength(1);
    });

    expect(
      mocked.hostSocket.emit.mock.calls.filter(
        ([event]) => event === "host:createRoom",
      ),
    ).toHaveLength(1);
    expect(
      mocked.hostSocket.emit.mock.calls.filter(
        ([event]) => event === "host:reconnect",
      ),
    ).toHaveLength(0);
  });

  it("discards legacy room-only storage instead of attempting an unowned reconnect", async () => {
    sessionStorage.clear();
    sessionStorage.setItem("airjam_room_id", "ROOM1");
    mocked.hostSocket.emit.mockImplementation(
      (event: string, _payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({ ok: true });
          return;
        }
        if (event === "host:createRoom") {
          callback?.({
            ok: true,
            roomId: "ROOM2",
            hostResumeCapability: TEST_HOST_RESUME_CAPABILITY,
          });
        }
      },
    );

    const { result } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });

    await waitFor(() => {
      expect(result.current.roomId).toBe("ROOM2");
      expect(result.current.connectionStatus).toBe("connected");
    });
    expect(
      mocked.hostSocket.emit.mock.calls.filter(
        ([event]) => event === "host:reconnect",
      ),
    ).toHaveLength(0);
    expect(sessionStorage.getItem("airjam_room_id")).toBe("ROOM2");
    expect(sessionStorage.getItem("airjam_host_resume_capability")).toBe(
      TEST_HOST_RESUME_CAPABILITY.token,
    );
  });

  it("clears room authority before reconnect fallback creates a replacement room", async () => {
    mocked.store?.getState().setRoomId("ROOM1");
    mocked.store?.getState().setRegisteredRoomId("ROOM1");
    persistTestHostSession();

    mocked.hostSocket.emit.mockImplementation(
      (event: string, payload: unknown, callback?: (ack: unknown) => void) => {
        if (event === "host:bootstrap") {
          callback?.({ ok: true });
          return;
        }
        if (event === "host:reconnect") {
          callback?.({
            ok: false,
            code: "ROOM_NOT_FOUND",
            message: "Room missing",
          });
          return;
        }
        if (event === "host:createRoom") {
          expect(mocked.store?.getState().registeredRoomId).toBeNull();
          expect(payload).toMatchObject({
            maxPlayers: 8,
          });
          callback?.({
            ok: true,
            roomId: "ROOM2",
            hostResumeCapability: { token: "replacement-resume-token" },
          });
        }
      },
    );

    const { result } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected");
      expect(result.current.roomId).toBe("ROOM2");
    });

    expect(mocked.store?.getState().registeredRoomId).toBe("ROOM2");
    expect(sessionStorage.getItem("airjam_room_id")).toBe("ROOM2");
    expect(sessionStorage.getItem("airjam_host_resume_capability")).toBe(
      "replacement-resume-token",
    );
  });

  it("prefers the injected arcade join url in child-host mode", async () => {
    window.history.replaceState(
      {},
      "",
      withArcadeRuntimeTopology(
        "/game?aj_room=ROOM1&aj_cap=join_123&aj_cap_exp=1700000000000&aj_join_url=https%3A%2F%2Fplatform.example%2Fcontroller%3Froom%3DROOM1&aj_arcade_epoch=2&aj_arcade_kind=game&aj_arcade_game_id=pong",
        "host",
      ),
    );

    const { result, unmount } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });

    await waitFor(() => {
      expect(result.current.joinUrl).toBe(
        "https://platform.example/controller?room=ROOM1",
      );
    });

    unmount();
  });

  it("uses the embedded host bridge without opening a direct host socket", async () => {
    window.history.replaceState(
      {},
      "",
      withArcadeRuntimeTopology(
        "/game?aj_room=ROOM1&aj_cap=join_123&aj_cap_exp=1700000000000&aj_join_url=https%3A%2F%2Fplatform.example%2Fcontroller%3Froom%3DROOM1&aj_arcade_epoch=2&aj_arcade_kind=game&aj_arcade_game_id=pong",
        "host",
      ),
    );
    const postMessageSpy = vi.spyOn(window.parent, "postMessage");

    const { result, unmount } = renderHook(() => useAirJamHost(), {
      wrapper: createHostWrapper(),
    });
    const requestCall = postMessageSpy.mock.calls[0] as unknown[] | undefined;
    const bridgePort = (requestCall?.[2] as MessagePort[] | undefined)?.[0];
    expect(bridgePort).toBeDefined();

    act(() => {
      bridgePort!.postMessage({
        type: "AIRJAM_HOST_BRIDGE_ATTACH",
        payload: {
          handshake: {
            protocolVersion: "2",
            sdkVersion: "1.0.0",
            runtimeKind: "arcade-host-runtime",
            capabilityFlags: {
              hostBridge: true,
            },
          },
          snapshot: {
            roomId: "ROOM1",
            capabilityToken: "join_123",
            connected: true,
            players: [],
            arcadeSurface: { epoch: 2, kind: "game", gameId: "pong" },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected");
    });

    expect(mocked.hostSocket.connect).not.toHaveBeenCalled();
    expect(mocked.hostSocket.emit).not.toHaveBeenCalledWith(
      "host:joinAsChild",
      expect.anything(),
      expect.any(Function),
    );

    unmount();
  });

  it("uses the embedded controller bridge without opening a direct controller socket", async () => {
    window.history.replaceState(
      {},
      "",
      withArcadeRuntimeTopology(
        "/controller?aj_room=ROOM1&aj_controller_id=ctrl_1&aj_arcade_epoch=2&aj_arcade_kind=game&aj_arcade_game_id=pong&aj_player_label=Captain&aj_player_avatar=aj-3",
        "controller",
      ),
    );
    const postMessageSpy = vi.spyOn(window.parent, "postMessage");

    const { result, unmount } = renderHook(() => useAirJamController(), {
      wrapper: createControllerWrapper(),
    });
    const requestCall = postMessageSpy.mock.calls[0] as unknown[] | undefined;
    const bridgePort = (requestCall?.[2] as MessagePort[] | undefined)?.[0];
    expect(bridgePort).toBeDefined();

    act(() => {
      bridgePort!.postMessage({
        type: "AIRJAM_CONTROLLER_BRIDGE_ATTACH",
        payload: {
          handshake: {
            protocolVersion: "2",
            sdkVersion: "1.0.0",
            runtimeKind: "arcade-controller-runtime",
            capabilityFlags: {
              controllerBridge: true,
            },
          },
          snapshot: {
            roomId: "ROOM1",
            controllerId: "ctrl_1",
            connected: true,
            arcadeSurface: { epoch: 2, kind: "game", gameId: "pong" },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected");
    });
    expect(result.current.selfPlayer).toMatchObject({
      id: "ctrl_1",
      label: "Captain",
      avatarId: "aj-3",
    });

    expect(mocked.controllerSocket.connect).not.toHaveBeenCalled();
    expect(mocked.controllerSocket.emit).not.toHaveBeenCalledWith(
      "controller:join",
      expect.anything(),
      expect.any(Function),
    );

    unmount();
  });
});
