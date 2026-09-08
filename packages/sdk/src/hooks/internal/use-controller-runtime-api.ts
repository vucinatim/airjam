import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useAirJamContext } from "../../context/air-jam-context";
import {
  useAssertSessionScope,
  useClaimSessionRuntimeOwner,
} from "../../context/session-scope";
import { updateDevBrowserLogContext } from "../../dev/browser-log-sink";
import { readPreviewControllerDeviceIdFromLocation } from "../../preview/identity";
import {
  AIR_JAM_PREVIEW_CLOSE_RESULT,
  isPreviewCloseRequestMessage,
} from "../../preview/messages";
import type {
  ControllerJoinAck,
  ControllerLeaveAck,
  ControllerStateMessage,
  ControllerUpdatePlayerProfileAck,
  PlayerProfile,
  PlayerProfilePatch,
  RoomCode,
  SignalPayload,
} from "../../protocol";
import {
  AIRJAM_DEV_LOG_EVENTS,
  controllerJoinSchema,
  controllerLeaveSchema,
  controllerSystemSchema,
  ErrorCode,
  playerProfilePatchSchema,
  roomCodeSchema,
} from "../../protocol";
import type {
  ControllerJoinedNotice,
  ControllerLeftNotice,
  ControllerWelcomePayload,
  PlayerUpdatedNotice,
} from "../../protocol/notices";
import {
  resolveAdmissionRetry,
  type AdmissionRetryDecision,
} from "../../runtime/admission-retry";
import {
  clearControllerRoomBinding,
  getOrCreateControllerDeviceId,
  readControllerRoomBinding,
  writeControllerRoomBinding,
} from "../../runtime/controller-identity";
import { getControllerRealtimeClient } from "../../runtime/controller-realtime-client";
import { emitAirJamDevRuntimeEvent } from "../../runtime/dev-runtime-events";
import { readEmbeddedControllerChildSession } from "../../runtime/embedded-runtime-adapters";
import type { AirJamRealtimeClient } from "../../runtime/realtime-client";
import { generateControllerId } from "../../utils/ids";
import { detectRunMode } from "../../utils/mode";
import type {
  AirJamControllerOptions,
  AirJamControllerRuntimeControls,
} from "../use-air-jam-controller";

const getRoomFromLocation = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  const code = params.get("room");
  return code ? code.toUpperCase() : null;
};

const getControllerCapabilityTokenFromLocation = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  return params.get("aj_controller_cap");
};

export const resolveControllerJoinSource = ({
  embeddedRoomId,
  optionRoomId,
  urlRoomId,
}: {
  embeddedRoomId?: string | null;
  optionRoomId?: string | null;
  urlRoomId?: string | null;
}): "embedded" | "options" | "url" | "unknown" => {
  if (embeddedRoomId) {
    return "embedded";
  }
  if (optionRoomId) {
    return "options";
  }
  if (urlRoomId) {
    return "url";
  }
  return "unknown";
};

export const useControllerRuntimeApi = (
  options: AirJamControllerOptions,
  hookName: string,
): AirJamControllerRuntimeControls => {
  useAssertSessionScope("controller", hookName);
  useClaimSessionRuntimeOwner("controller-runtime", hookName);

  const { store, getSocket, disconnectSocket } = useAirJamContext();
  const nicknameRef = useRef(options.nickname ?? "");
  const avatarIdRef = useRef(options.avatarId ?? "");

  useEffect(() => {
    nicknameRef.current = options.nickname ?? "";
  }, [options.nickname]);

  useEffect(() => {
    avatarIdRef.current = options.avatarId ?? "";
  }, [options.avatarId]);

  const embeddedController = useMemo(
    () => readEmbeddedControllerChildSession(),
    [],
  );
  const urlRoomId = useMemo(() => getRoomFromLocation(), []);
  const locationCapabilityToken = useMemo(
    () => getControllerCapabilityTokenFromLocation(),
    [],
  );
  const capabilityToken =
    options.capabilityToken === undefined
      ? locationCapabilityToken
      : options.capabilityToken;
  const previewDeviceId = useMemo(
    () => readPreviewControllerDeviceIdFromLocation(),
    [],
  );
  const joinSource = useMemo(
    () =>
      resolveControllerJoinSource({
        embeddedRoomId: embeddedController?.roomId,
        optionRoomId: options.roomId ?? null,
        urlRoomId,
      }),
    [embeddedController?.roomId, options.roomId, urlRoomId],
  );

  const parsedRoomId = useMemo<RoomCode | null>(() => {
    const code = embeddedController?.roomId ?? options.roomId ?? urlRoomId;
    if (!code) return null;
    try {
      return roomCodeSchema.parse(code.toUpperCase());
    } catch {
      return null;
    }
  }, [options.roomId, embeddedController, urlRoomId]);

  const deviceId = useMemo<string | null>(() => {
    if (embeddedController) {
      return null;
    }
    if (previewDeviceId) {
      return previewDeviceId;
    }
    return getOrCreateControllerDeviceId();
  }, [embeddedController, previewDeviceId]);

  const controllerId = useMemo<string>(() => {
    if (embeddedController?.controllerId) {
      return embeddedController.controllerId;
    }
    if (options.controllerId) {
      return options.controllerId;
    }
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const urlControllerId = params.get("controllerId");
      if (urlControllerId) return urlControllerId;
    }
    if (parsedRoomId) {
      const persistedControllerId = readControllerRoomBinding(parsedRoomId);
      if (persistedControllerId) {
        return persistedControllerId;
      }
    }
    return generateControllerId();
  }, [options.controllerId, embeddedController, parsedRoomId]);

  const onStateRef = useRef<AirJamControllerOptions["onState"]>(
    options.onState,
  );
  useEffect(() => {
    onStateRef.current = options.onState;
  }, [options.onState]);

  const activeControllerId = useStore(store, (state) => state.controllerId);

  useEffect(() => {
    updateDevBrowserLogContext({
      role: "controller",
      traceId: undefined,
      roomId: parsedRoomId ?? undefined,
      controllerId: activeControllerId ?? controllerId ?? undefined,
    });
  }, [activeControllerId, controllerId, parsedRoomId]);

  useEffect(() => {
    return () => {
      updateDevBrowserLogContext({
        role: undefined,
        roomId: undefined,
        controllerId: undefined,
      });
    };
  }, []);

  const [reconnectKey, setReconnectKey] = useState(0);
  const leaveIssuedRef = useRef(false);
  const emitControllerRuntimeEvent = useCallback(
    ({
      event,
      level = "info",
      message,
      roomId,
      data,
    }: {
      event: (typeof AIRJAM_DEV_LOG_EVENTS.runtime)[keyof typeof AIRJAM_DEV_LOG_EVENTS.runtime];
      level?: "info" | "warn" | "error";
      message: string;
      roomId?: string;
      data?: Record<string, unknown>;
    }) => {
      emitAirJamDevRuntimeEvent({
        event,
        level,
        message,
        role: "controller",
        roomId,
        controllerId,
        data,
      });
    },
    [controllerId],
  );
  const lastObservedStateVersionRef = useRef<number | null>(null);
  const emittedInvariantKeysRef = useRef<Set<string>>(new Set());
  const emitInvariantOnce = useCallback(
    ({
      code,
      roomId,
      data,
      message,
    }: {
      code: string;
      roomId?: string;
      data?: Record<string, unknown>;
      message: string;
    }) => {
      const key = `${roomId ?? "unknown"}:${code}`;
      if (emittedInvariantKeysRef.current.has(key)) {
        return;
      }
      emittedInvariantKeysRef.current.add(key);
      emitControllerRuntimeEvent({
        event: AIRJAM_DEV_LOG_EVENTS.runtime.invariantViolation,
        level: "warn",
        message,
        roomId,
        data: {
          code,
          ...data,
        },
      });
    },
    [emitControllerRuntimeEvent],
  );

  const socket = useMemo<AirJamRealtimeClient | null>(
    () =>
      parsedRoomId
        ? getControllerRealtimeClient((role) => getSocket(role))
        : null,
    [parsedRoomId, getSocket],
  );

  const reconnect = useCallback(() => {
    if (!parsedRoomId) return;
    socket?.disconnect();
    if (!embeddedController) {
      disconnectSocket("controller");
    }
    setReconnectKey((prev) => prev + 1);
  }, [parsedRoomId, disconnectSocket, socket, embeddedController]);

  const leave = useCallback(async (): Promise<ControllerLeaveAck> => {
    const storeState = store.getState();
    const activeControllerId = storeState.controllerId;

    if (!socket || !parsedRoomId || !activeControllerId) {
      return { ok: false, message: "Not connected" };
    }

    if (!socket.connected) {
      return { ok: true };
    }

    const payload = controllerLeaveSchema.safeParse({
      roomId: parsedRoomId,
      controllerId: activeControllerId,
    });

    if (!payload.success) {
      return {
        ok: false,
        message: payload.error.message,
      };
    }

    const applyLocalLeaveState = () => {
      if (parsedRoomId) {
        clearControllerRoomBinding(parsedRoomId);
      }
      const latestState = store.getState();
      latestState.removePlayer(activeControllerId);
      latestState.setControllerId(null);
      latestState.setStatus("disconnected");
      latestState.resetRuntimeState();
    };

    leaveIssuedRef.current = true;

    if (embeddedController) {
      socket.emit("controller:leave", payload.data);
      applyLocalLeaveState();
      return { ok: true };
    }

    return await new Promise<ControllerLeaveAck>((resolve) => {
      socket.emit(
        "controller:leave",
        payload.data,
        (ack: ControllerLeaveAck) => {
          if (ack.ok) {
            applyLocalLeaveState();
          }
          resolve(ack);
        },
      );
    });
  }, [embeddedController, parsedRoomId, socket, store]);

  useEffect(() => {
    if (!socket) return;

    const handleSignal = (signal: SignalPayload) => {
      if (signal.type !== "HAPTIC") return;
      if (typeof navigator === "undefined" || !navigator.vibrate) return;

      const payload = signal.payload;

      switch (payload.pattern) {
        case "light":
          navigator.vibrate(10);
          break;
        case "medium":
          navigator.vibrate(30);
          break;
        case "heavy":
          navigator.vibrate([50, 20, 50]);
          break;
        case "success":
          navigator.vibrate([10, 30, 10]);
          break;
        case "failure":
          navigator.vibrate([50, 50, 50, 50]);
          break;
        case "custom":
          if (Array.isArray(payload.sequence)) {
            navigator.vibrate(payload.sequence);
          } else if (typeof payload.sequence === "number") {
            navigator.vibrate(payload.sequence);
          }
          break;
      }
    };

    socket.on("server:signal", handleSignal);
    return () => {
      socket.off("server:signal", handleSignal);
    };
  }, [socket]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !previewDeviceId ||
      embeddedController ||
      !socket
    ) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) {
        return;
      }

      if (!isPreviewCloseRequestMessage(event.data)) {
        return;
      }

      void leave()
        .catch(() => ({ ok: false }) satisfies ControllerLeaveAck)
        .then((ack) => {
          window.parent.postMessage(
            {
              type: AIR_JAM_PREVIEW_CLOSE_RESULT,
              ok: ack.ok,
            },
            "*",
          );
          socket.disconnect();
          disconnectSocket("controller");
        });
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [disconnectSocket, embeddedController, leave, previewDeviceId, socket]);

  useEffect(() => {
    if (!previewDeviceId || !parsedRoomId || embeddedController || !socket) {
      return;
    }

    return () => {
      const controllerIdForLeave = store.getState().controllerId;
      if (
        leaveIssuedRef.current ||
        !controllerIdForLeave ||
        !socket.connected
      ) {
        return;
      }

      leaveIssuedRef.current = true;
      socket.emit(
        "controller:leave",
        {
          roomId: parsedRoomId,
          controllerId: controllerIdForLeave,
        },
        () => {},
      );
    };
  }, [embeddedController, parsedRoomId, previewDeviceId, socket, store]);

  useEffect(() => {
    const storeState = store.getState();
    storeState.setMode(detectRunMode());
    storeState.setRole("controller");
    storeState.setRoomId(parsedRoomId);
    storeState.setStatus(parsedRoomId ? "connecting" : "idle");
    storeState.setError(undefined);
    lastObservedStateVersionRef.current = null;
    emittedInvariantKeysRef.current.clear();

    if (!parsedRoomId || !socket || !controllerId) {
      storeState.setStatus("idle");
      return;
    }

    let disposed = false;
    let joinEpoch = 0;
    let joinRetryTimeout: ReturnType<typeof setTimeout> | null = null;
    const clearJoinRetryTimeout = (): void => {
      if (!joinRetryTimeout) {
        return;
      }
      clearTimeout(joinRetryTimeout);
      joinRetryTimeout = null;
    };

    storeState.setControllerId(controllerId);
    if (
      embeddedController?.playerProfile?.label ||
      embeddedController?.playerProfile?.avatarId
    ) {
      const fallbackPlayer: PlayerProfile = {
        id: controllerId,
        label:
          embeddedController.playerProfile?.label ||
          nicknameRef.current ||
          "Player",
        ...(embeddedController.playerProfile?.avatarId
          ? { avatarId: embeddedController.playerProfile.avatarId }
          : avatarIdRef.current
            ? { avatarId: avatarIdRef.current }
            : {}),
      };
      storeState.upsertPlayer(fallbackPlayer);
    }

    const attemptJoin = (
      completedRetries: number,
      operationEpoch: number,
      retry?: AdmissionRetryDecision,
    ): void => {
      if (
        disposed ||
        operationEpoch !== joinEpoch ||
        !socket.connected ||
        embeddedController
      ) {
        return;
      }

      const payload = controllerJoinSchema.parse({
        roomId: parsedRoomId,
        controllerId,
        deviceId: deviceId ?? undefined,
        nickname: nicknameRef.current || undefined,
        avatarId: avatarIdRef.current || undefined,
        capabilityToken: capabilityToken ?? undefined,
      });
      emitControllerRuntimeEvent({
        event: AIRJAM_DEV_LOG_EVENTS.runtime.controllerJoinRequested,
        message:
          completedRetries === 0
            ? "Controller requested room join"
            : "Controller retried room join after admission denial",
        roomId: payload.roomId,
        data: {
          joinSource,
          controllerId: payload.controllerId,
          hasNickname: Boolean(payload.nickname),
          hasAvatarId: Boolean(payload.avatarId),
          hasCapabilityToken: Boolean(payload.capabilityToken),
          admissionAttempt: completedRetries + 1,
          ...(retry
            ? {
                retryReasonCode: retry.code,
                retryAfterSeconds: retry.retryAfterSeconds,
              }
            : {}),
        },
      });
      socket.emit("controller:join", payload, (ack: ControllerJoinAck) => {
        if (disposed || operationEpoch !== joinEpoch) {
          return;
        }

        const latestState = store.getState();
        if (!ack.ok) {
          if (ack.code === ErrorCode.ROOM_NOT_FOUND) {
            clearControllerRoomBinding(parsedRoomId);
          }
          latestState.setError(ack.message ?? "Unable to join room");
          latestState.resetRuntimeState();

          const retryDecision = resolveAdmissionRetry(ack, completedRetries);
          if (retryDecision) {
            latestState.setStatus("connecting");
            clearJoinRetryTimeout();
            joinRetryTimeout = setTimeout(() => {
              joinRetryTimeout = null;
              attemptJoin(completedRetries + 1, operationEpoch, retryDecision);
            }, retryDecision.delayMs);
            return;
          }

          latestState.setStatus("disconnected");
          return;
        }
        if (ack.controllerId) {
          latestState.setControllerId(ack.controllerId);
          writeControllerRoomBinding(parsedRoomId, ack.controllerId);
        }
        latestState.setError(undefined);
        latestState.setStatus("connected");
      });
    };

    const handleConnect = (): void => {
      clearJoinRetryTimeout();
      joinEpoch += 1;
      const operationEpoch = joinEpoch;
      emitControllerRuntimeEvent({
        event: AIRJAM_DEV_LOG_EVENTS.runtime.socketConnected,
        message: "Controller socket connected",
        roomId: parsedRoomId ?? undefined,
        data: {
          socketId: socket.id,
          connected: socket.connected,
        },
      });
      store.getState().setStatus("connected");

      if (embeddedController) {
        return;
      }
      attemptJoin(0, operationEpoch);
    };

    const handleDisconnect = (reason?: string): void => {
      joinEpoch += 1;
      clearJoinRetryTimeout();
      emitControllerRuntimeEvent({
        event: AIRJAM_DEV_LOG_EVENTS.runtime.socketDisconnected,
        message: "Controller socket disconnected",
        roomId: parsedRoomId ?? undefined,
        data: {
          socketId: socket.id,
          reason,
        },
      });
      const latestState = store.getState();
      if (reason) {
        latestState.setError(reason);
      }
      latestState.setStatus("disconnected");
      latestState.resetRuntimeState();
      lastObservedStateVersionRef.current = null;
    };

    const handleConnectError = (error: Error): void => {
      emitControllerRuntimeEvent({
        event: AIRJAM_DEV_LOG_EVENTS.runtime.socketConnectError,
        level: "warn",
        message: "Controller socket connect error",
        roomId: parsedRoomId ?? undefined,
        data: {
          message: error.message,
          name: error.name,
        },
      });
    };

    const handleWelcome = (payload: ControllerWelcomePayload): void => {
      const latestState = store.getState();
      const storeRoomId = latestState.roomId;
      if (
        storeRoomId &&
        payload.roomId.toUpperCase() !== storeRoomId.toUpperCase()
      ) {
        return;
      }
      if (!storeRoomId && payload.roomId) {
        latestState.setRoomId(payload.roomId);
      }
      writeControllerRoomBinding(payload.roomId, payload.controllerId);
      if (Array.isArray(payload.players)) {
        latestState.resetPlayers();
        payload.players.forEach((player) => {
          latestState.upsertPlayer(player);
        });
      }
      if (!payload.player) {
        latestState.setError(
          "Welcome message received but no player profile included.",
        );
        return;
      }
      latestState.upsertPlayer(payload.player);
    };

    const handleControllerJoined = (payload: ControllerJoinedNotice): void => {
      if (!payload.player) {
        return;
      }
      store.getState().upsertPlayer(payload.player);
    };

    const handleControllerLeft = (payload: ControllerLeftNotice): void => {
      store.getState().removePlayer(payload.controllerId);
    };

    const handleState = (payload: ControllerStateMessage): void => {
      if (payload.roomId !== parsedRoomId) return;

      emitControllerRuntimeEvent({
        event: AIRJAM_DEV_LOG_EVENTS.runtime.controllerStateReceived,
        message: "Controller received state update",
        roomId: payload.roomId,
        data: {
          runtimeState: payload.state.runtimeState,
          orientation: payload.state.orientation,
          stateVersion: payload.state.stateVersion,
          hasMessage: payload.state.message !== undefined,
        },
      });

      const latestState = store.getState();
      const previousRuntimeState = latestState.runtimeState;
      const nextRuntimeState =
        payload.state.runtimeState ?? previousRuntimeState;
      const incomingVersion = payload.state.stateVersion;
      const previousVersion = lastObservedStateVersionRef.current;
      if (typeof incomingVersion === "number") {
        if (previousVersion === null) {
          emitControllerRuntimeEvent({
            event: AIRJAM_DEV_LOG_EVENTS.runtime.stateVersionReceived,
            message: "Controller received initial room state version",
            roomId: payload.roomId,
            data: {
              stateVersion: incomingVersion,
              relation: "initial",
            },
          });
        } else if (incomingVersion <= previousVersion) {
          emitControllerRuntimeEvent({
            event: AIRJAM_DEV_LOG_EVENTS.runtime.stateVersionReceived,
            level: "warn",
            message: "Controller received non-monotonic room state version",
            roomId: payload.roomId,
            data: {
              stateVersion: incomingVersion,
              previousStateVersion: previousVersion,
              relation: "non_monotonic",
            },
          });
          emitInvariantOnce({
            code: "state_version_non_monotonic",
            roomId: payload.roomId,
            message:
              "Received non-monotonic room state version in controller runtime",
            data: {
              stateVersion: incomingVersion,
              previousStateVersion: previousVersion,
            },
          });
        } else if (incomingVersion !== previousVersion + 1) {
          emitControllerRuntimeEvent({
            event: AIRJAM_DEV_LOG_EVENTS.runtime.stateVersionReceived,
            message: "Controller detected room state version gap",
            roomId: payload.roomId,
            data: {
              stateVersion: incomingVersion,
              previousStateVersion: previousVersion,
              relation: "gap",
            },
          });
        }
        lastObservedStateVersionRef.current =
          previousVersion === null
            ? incomingVersion
            : Math.max(previousVersion, incomingVersion);
      }
      if (
        typeof incomingVersion === "number" &&
        nextRuntimeState !== previousRuntimeState
      ) {
        emitControllerRuntimeEvent({
          event: AIRJAM_DEV_LOG_EVENTS.runtime.phaseTransition,
          message: "Controller runtime phase transition",
          roomId: payload.roomId,
          data: {
            from: previousRuntimeState,
            to: nextRuntimeState,
            source: "server_state",
            stateVersion: incomingVersion,
          },
        });
      }
      if (payload.state.runtimeState) {
        latestState.setRuntimeState(payload.state.runtimeState);
      }
      if (payload.state.orientation) {
        latestState.setControllerOrientation(payload.state.orientation);
      }
      if (payload.state.message !== undefined) {
        latestState.setStateMessage(payload.state.message);
      }
      if (payload.state.roomSettings) {
        latestState.setRoomSettings(payload.state.roomSettings);
      }
      onStateRef.current?.(payload.state);
    };

    const handleHostLeft = (payload: { reason: string }): void => {
      const latestState = store.getState();
      if (parsedRoomId) {
        clearControllerRoomBinding(parsedRoomId);
      }
      latestState.setError(payload.reason);
      latestState.setStatus("disconnected");
      latestState.resetRuntimeState();
      lastObservedStateVersionRef.current = null;

      setTimeout(() => {
        socket.disconnect();
        if (!embeddedController) {
          disconnectSocket("controller");
        }
        setReconnectKey((prev) => prev + 1);
      }, 1000);
    };

    const handleError = (payload: { message: string }): void => {
      store.getState().setError(payload.message);
    };

    const handlePlayerUpdated = (payload: PlayerUpdatedNotice): void => {
      store.getState().upsertPlayer(payload.player);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("server:welcome", handleWelcome);
    socket.on("server:controllerJoined", handleControllerJoined);
    socket.on("server:controllerLeft", handleControllerLeft);
    socket.on("server:state", handleState);
    socket.on("server:hostLeft", handleHostLeft);
    socket.on("server:error", handleError);
    socket.on("server:playerUpdated", handlePlayerUpdated);

    if (socket.connected) {
      handleConnect();
    } else {
      socket.connect();
    }

    return () => {
      disposed = true;
      joinEpoch += 1;
      clearJoinRetryTimeout();
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("server:welcome", handleWelcome);
      socket.off("server:controllerJoined", handleControllerJoined);
      socket.off("server:controllerLeft", handleControllerLeft);
      socket.off("server:state", handleState);
      socket.off("server:hostLeft", handleHostLeft);
      socket.off("server:error", handleError);
      socket.off("server:playerUpdated", handlePlayerUpdated);
    };
  }, [
    parsedRoomId,
    reconnectKey,
    socket,
    controllerId,
    embeddedController,
    store,
    disconnectSocket,
    emitControllerRuntimeEvent,
    deviceId,
    joinSource,
    capabilityToken,
    emitInvariantOnce,
  ]);

  const setNickname = useCallback((value: string) => {
    nicknameRef.current = value;
  }, []);

  const setAvatarId = useCallback((value: string) => {
    avatarIdRef.current = value;
  }, []);

  const updatePlayerProfile = useCallback(
    (patch: PlayerProfilePatch): Promise<ControllerUpdatePlayerProfileAck> => {
      const parsedPatch = playerProfilePatchSchema.safeParse(patch);
      if (!parsedPatch.success) {
        return Promise.resolve({
          ok: false,
          message: parsedPatch.error.message,
        });
      }

      if (!socket || !parsedRoomId) {
        return Promise.resolve({ ok: false, message: "Not connected" });
      }

      const controllerIdForPatch = store.getState().controllerId;
      if (!controllerIdForPatch) {
        return Promise.resolve({ ok: false, message: "No controller id" });
      }

      const payload = {
        roomId: parsedRoomId,
        controllerId: controllerIdForPatch,
        patch: parsedPatch.data,
      };

      if (embeddedController) {
        socket.emit("controller:updatePlayerProfile", payload);
        return Promise.resolve({ ok: true });
      }

      return new Promise((resolve) => {
        socket.emit(
          "controller:updatePlayerProfile",
          payload,
          (ack: ControllerUpdatePlayerProfileAck) => {
            resolve(ack);
          },
        );
      });
    },
    [parsedRoomId, socket, store, embeddedController],
  );

  const sendSystemCommand = useCallback(
    (command: "exit" | "pause" | "resume") => {
      const storeState = store.getState();

      if (!parsedRoomId || !storeState.controllerId || !socket) return;
      if (!socket.connected) return;

      const payload = controllerSystemSchema.safeParse({
        roomId: parsedRoomId,
        command,
      });

      if (payload.success) {
        socket.emit("controller:system", payload.data);
      }
    },
    [parsedRoomId, socket, store],
  );

  return useMemo(
    () => ({
      sendSystemCommand,
      setNickname,
      setAvatarId,
      updatePlayerProfile,
      leave,
      reconnect,
      socket,
    }),
    [
      leave,
      reconnect,
      sendSystemCommand,
      setAvatarId,
      setNickname,
      socket,
      updatePlayerProfile,
    ],
  );
};
