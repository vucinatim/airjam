import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { z } from "zod";
import { z as zod } from "zod";
import { useStore } from "zustand";
import { useAirJamContext } from "../../context/air-jam-context";
import {
  useAssertSessionScope,
  useClaimSessionRuntimeOwner,
} from "../../context/session-scope";
import { updateDevBrowserLogContext } from "../../dev/browser-log-sink";
import { emitAirJamDiagnostic } from "../../diagnostics";
import type {
  ControllerInputEvent,
  ControllerJoinedNotice,
  ControllerPresenceNotice,
  ControllerPrivilegedCapability,
  ControllerStateMessage,
  ControllerStatePayload,
  HapticSignalPayload,
  HostBootstrapAck,
  HostBootstrapPayload,
  HostRegistrationAck,
  PlayerProfile,
  RoomCode,
  RuntimeState,
  SignalPayload,
  SignalType,
  ToastSignalPayload,
} from "../../protocol";
import {
  AIRJAM_DEV_LOG_EVENTS,
  controllerStateSchema,
  ErrorCode,
  hostBootstrapSchema,
  hostCreateRoomSchema,
  hostReconnectSchema,
  hostRemoveControllerSchema,
  hostResetRoomSchema,
  roomCodeSchema,
} from "../../protocol";
import type { PlayerUpdatedNotice } from "../../protocol/notices";
import {
  resolveAdmissionRetry,
  type AdmissionRetryDecision,
} from "../../runtime/admission-retry";
import { emitAirJamDevRuntimeEvent } from "../../runtime/dev-runtime-events";
import { readEmbeddedHostChildSession } from "../../runtime/embedded-runtime-adapters";
import { getHostRealtimeClient } from "../../runtime/host-realtime-client";
import type { AirJamRealtimeClient } from "../../runtime/realtime-client";
import { detectRunMode } from "../../utils/mode";
import { urlBuilder } from "../../utils/url-builder";
import type {
  AirJamHostApi,
  AirJamHostOptions,
  AirJamHostRuntimeControls,
  JoinUrlStatus,
} from "../use-air-jam-host";

const HOST_BOOTSTRAP_TIMEOUT_MESSAGE =
  "Host bootstrap timed out. The deployed Air Jam server may be out of sync with this client.";
const HOST_ROOM_SESSION_STORAGE_KEY = "airjam_room_id";
const HOST_RESUME_CAPABILITY_SESSION_STORAGE_KEY =
  "airjam_host_resume_capability";
const HOST_RESET_CANCELLED_MESSAGE =
  "Host room reset was cancelled because the host session changed.";

interface PendingHostResetOperation {
  roomId: RoomCode;
  retryTimeout: ReturnType<typeof setTimeout> | null;
  resolve: (ack: HostRegistrationAck) => void;
}

const clearPersistedHostSession = (): void => {
  if (typeof window === "undefined") {
    return;
  }

  sessionStorage.removeItem(HOST_ROOM_SESSION_STORAGE_KEY);
  sessionStorage.removeItem(HOST_RESUME_CAPABILITY_SESSION_STORAGE_KEY);
};

const persistHostSession = (ack: HostRegistrationAck): void => {
  if (typeof window === "undefined") {
    return;
  }

  if (!ack.roomId || !ack.hostResumeCapability) {
    clearPersistedHostSession();
    return;
  }

  sessionStorage.setItem(HOST_ROOM_SESSION_STORAGE_KEY, ack.roomId);
  sessionStorage.setItem(
    HOST_RESUME_CAPABILITY_SESSION_STORAGE_KEY,
    ack.hostResumeCapability.token,
  );
};

export const useHostRuntimeApi = <TSchema extends z.ZodSchema = z.ZodSchema>(
  options: AirJamHostOptions,
  hookName: string,
): AirJamHostRuntimeControls<TSchema> => {
  useAssertSessionScope("host", hookName);
  useClaimSessionRuntimeOwner("host-runtime", hookName);

  const { config, store, getSocket, disconnectSocket, inputManager } =
    useAirJamContext();

  const embeddedHost = useMemo(() => readEmbeddedHostChildSession(), []);

  const shouldConnect = true;
  const storeRoomId = useStore(store, (s) => s.roomId);

  const parsedRoomId = useMemo<RoomCode | null>(() => {
    if (embeddedHost) {
      return embeddedHost.roomId;
    }

    if (storeRoomId) {
      return roomCodeSchema.parse(storeRoomId.toUpperCase());
    }

    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const paramRoom = params.get("room");
      if (paramRoom) {
        const result = roomCodeSchema.safeParse(paramRoom.toUpperCase());
        if (result.success) return result.data;
      }
    }

    if (options.roomId) {
      return roomCodeSchema.parse(options.roomId.toUpperCase());
    }

    return null;
  }, [options.roomId, storeRoomId, embeddedHost]);

  const [controllerCapability, setControllerCapability] =
    useState<ControllerPrivilegedCapability | null>(null);

  const joinUrlBuildKey = useMemo(
    () =>
      parsedRoomId
        ? `${parsedRoomId}\0${config.topology.publicHost}\0${controllerCapability?.token ?? ""}`
        : null,
    [config.topology.publicHost, controllerCapability?.token, parsedRoomId],
  );
  const [computedJoinUrl, setComputedJoinUrl] = useState<{
    key: string | null;
    url: string;
    error: boolean;
  }>({
    key: null,
    url: "",
    error: false,
  });

  const onPlayerJoinRef = useRef(options.onPlayerJoin);
  const onPlayerLeaveRef = useRef(options.onPlayerLeave);
  const parsedRoomIdRef = useRef<RoomCode | null>(parsedRoomId);

  useEffect(() => {
    onPlayerJoinRef.current = options.onPlayerJoin;
    onPlayerLeaveRef.current = options.onPlayerLeave;
  }, [options.onPlayerJoin, options.onPlayerLeave]);

  useEffect(() => {
    parsedRoomIdRef.current = parsedRoomId;
  }, [parsedRoomId]);

  const socket = useMemo<AirJamRealtimeClient | null>(
    () =>
      shouldConnect ? getHostRealtimeClient((role) => getSocket(role)) : null,
    [shouldConnect, getSocket],
  );
  const setRegisteredRoomId = useStore(store, (s) => s.setRegisteredRoomId);
  const pendingHostResetRef = useRef<PendingHostResetOperation | null>(null);
  const cancelPendingHostReset = useCallback((): void => {
    const pendingReset = pendingHostResetRef.current;
    if (!pendingReset) {
      return;
    }

    pendingHostResetRef.current = null;
    if (pendingReset.retryTimeout) {
      clearTimeout(pendingReset.retryTimeout);
    }
    pendingReset.resolve({
      ok: false,
      code: ErrorCode.CONNECTION_FAILED,
      message: HOST_RESET_CANCELLED_MESSAGE,
    });
  }, []);

  useEffect(
    () => () => {
      cancelPendingHostReset();
    },
    [cancelPendingHostReset, parsedRoomId, socket],
  );

  const hydrateHostRoster = useCallback(
    (players?: PlayerProfile[], controllers?: ControllerPresenceNotice[]) => {
      const latestState = store.getState();
      latestState.resetPlayers();
      players?.forEach((player) => {
        latestState.upsertPlayer(player);
      });
      latestState.resetControllerSessions();
      controllers?.forEach((controller) => {
        latestState.upsertControllerSession(controller);
      });
    },
    [store],
  );
  const canEmitAuthoritativeHostState = useCallback(
    (roomId: RoomCode | null): roomId is RoomCode => {
      if (!socket || !socket.connected || !roomId) {
        return false;
      }

      const latestState = store.getState();
      return (
        latestState.registeredRoomId === roomId &&
        latestState.hostArcadeRestore.phase === "idle"
      );
    },
    [socket, store],
  );

  const emitHostRuntimeEvent = useCallback(
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
        role: "host",
        roomId,
        data,
      });
    },
    [],
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
      emitHostRuntimeEvent({
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
    [emitHostRuntimeEvent],
  );

  const sendState = useCallback(
    (state: ControllerStatePayload): boolean => {
      const activeSocket = socket;
      const activeRoomId = parsedRoomIdRef.current;
      if (!activeSocket || !canEmitAuthoritativeHostState(activeRoomId)) {
        return false;
      }
      const payload = controllerStateSchema.safeParse({
        roomId: activeRoomId,
        state,
      });
      if (!payload.success) {
        return false;
      }
      activeSocket.emit("host:state", payload.data);
      return true;
    },
    [canEmitAuthoritativeHostState, socket],
  );

  const setRuntimeState = useCallback(
    (runtimeState: RuntimeState): void => {
      const activeRoomId = parsedRoomIdRef.current;
      if (store.getState().runtimeState === runtimeState) {
        return;
      }
      if (!canEmitAuthoritativeHostState(activeRoomId)) {
        return;
      }
      sendState({ runtimeState });
    },
    [canEmitAuthoritativeHostState, sendState, store],
  );

  const pauseRuntime = useCallback((): void => {
    setRuntimeState("paused");
  }, [setRuntimeState]);

  const resumeRuntime = useCallback((): void => {
    setRuntimeState("playing");
  }, [setRuntimeState]);

  const sendSignal = useCallback(
    (
      type: SignalType,
      payload: HapticSignalPayload | ToastSignalPayload,
      targetId?: string,
    ): void => {
      if (!socket || !socket.connected) {
        return;
      }
      const signal: SignalPayload = {
        targetId,
        type,
        payload,
      } as SignalPayload;
      socket.emit("host:signal", signal);
    },
    [socket],
  ) as AirJamHostApi["sendSignal"];

  const reconnect = useCallback(() => {
    socket?.disconnect();
    if (!embeddedHost) {
      disconnectSocket("host");
    }
    if (socket) {
      socket.connect();
    }
  }, [socket, embeddedHost, disconnectSocket]);

  const removeController = useCallback(
    async (controllerId: string) => {
      const activeRoomId = parsedRoomIdRef.current;
      if (!socket || !activeRoomId) {
        return {
          ok: false,
          message: "Host is not connected to a room.",
        };
      }

      const payload = hostRemoveControllerSchema.parse({
        roomId: activeRoomId,
        controllerId,
      });

      return socket.emitWithAck<{
        ok: boolean;
        message?: string;
        code?: string;
      }>("host:removeController", payload);
    },
    [socket],
  );

  const resetRoom = useCallback((): Promise<HostRegistrationAck> => {
    const activeRoomId = parsedRoomIdRef.current;
    if (!socket || !socket.connected || !activeRoomId) {
      return Promise.resolve({
        ok: false,
        message: "Host is not connected to a room.",
      });
    }

    const payload = hostResetRoomSchema.parse({
      roomId: activeRoomId,
    });

    cancelPendingHostReset();

    return new Promise<HostRegistrationAck>((resolve, reject) => {
      const operation: PendingHostResetOperation = {
        roomId: activeRoomId,
        retryTimeout: null,
        resolve,
      };
      pendingHostResetRef.current = operation;

      const isCurrentOperation = (): boolean =>
        pendingHostResetRef.current === operation &&
        parsedRoomIdRef.current === operation.roomId &&
        socket.connected;

      const finish = (ack: HostRegistrationAck): void => {
        if (pendingHostResetRef.current !== operation) {
          return;
        }
        pendingHostResetRef.current = null;
        if (operation.retryTimeout) {
          clearTimeout(operation.retryTimeout);
          operation.retryTimeout = null;
        }
        resolve(ack);
      };

      const attemptReset = (
        completedRetries = 0,
        retry?: AdmissionRetryDecision,
      ): void => {
        if (!isCurrentOperation()) {
          cancelPendingHostReset();
          return;
        }

        emitHostRuntimeEvent({
          event: AIRJAM_DEV_LOG_EVENTS.runtime.hostResetRoomRequested,
          message:
            completedRetries === 0
              ? "Host requested local room reset"
              : "Host retried local room reset after admission denial",
          roomId: activeRoomId,
          data: {
            admissionAttempt: completedRetries + 1,
            ...(retry
              ? {
                  retryReasonCode: retry.code,
                  retryAfterSeconds: retry.retryAfterSeconds,
                }
              : {}),
          },
        });

        void socket
          .emitWithAck<HostRegistrationAck>("host:resetRoom", payload)
          .then(
            (ack) => {
              if (!isCurrentOperation()) {
                cancelPendingHostReset();
                return;
              }

              if (!ack.ok) {
                const retryDecision = resolveAdmissionRetry(
                  ack,
                  completedRetries,
                );
                if (retryDecision) {
                  operation.retryTimeout = setTimeout(() => {
                    operation.retryTimeout = null;
                    attemptReset(completedRetries + 1, retryDecision);
                  }, retryDecision.delayMs);
                  return;
                }

                finish(ack);
                return;
              }

              if (!ack.roomId) {
                finish(ack);
                return;
              }

              const latestState = store.getState();
              latestState.setStatus("connected");
              latestState.setRoomId(ack.roomId);
              latestState.setError(undefined);
              latestState.clearHostArcadeRestore();
              latestState.resetRuntimeState();
              hydrateHostRoster(ack.players, ack.controllers);
              setRegisteredRoomId(ack.roomId);
              setControllerCapability(ack.controllerCapability ?? null);
              persistHostSession(ack);
              finish(ack);
            },
            (error: unknown) => {
              if (pendingHostResetRef.current !== operation) {
                return;
              }
              pendingHostResetRef.current = null;
              reject(error);
            },
          );
      };

      attemptReset();
    });
  }, [
    cancelPendingHostReset,
    emitHostRuntimeEvent,
    hydrateHostRoster,
    setRegisteredRoomId,
    socket,
    store,
  ]);

  useEffect(() => {
    if (embeddedHost?.joinUrl) {
      return;
    }
    if (!parsedRoomId || !joinUrlBuildKey) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const url = await urlBuilder.buildControllerUrl(parsedRoomId, {
          host: config.topology.publicHost,
          capabilityToken: controllerCapability?.token,
        });
        if (!cancelled) {
          setComputedJoinUrl({
            key: joinUrlBuildKey,
            url,
            error: false,
          });
        }
      } catch {
        if (!cancelled) {
          setComputedJoinUrl({
            key: joinUrlBuildKey,
            url: "",
            error: true,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    parsedRoomId,
    embeddedHost?.joinUrl,
    config.topology.publicHost,
    controllerCapability?.token,
    joinUrlBuildKey,
  ]);

  const joinUrl = embeddedHost?.joinUrl
    ? embeddedHost.joinUrl
    : computedJoinUrl.key === joinUrlBuildKey
      ? computedJoinUrl.url
      : "";

  const joinUrlStatus: JoinUrlStatus = embeddedHost?.joinUrl
    ? "ready"
    : !joinUrlBuildKey
      ? "loading"
      : computedJoinUrl.key !== joinUrlBuildKey
        ? "loading"
        : computedJoinUrl.error
          ? "unavailable"
          : computedJoinUrl.url
            ? "ready"
            : "loading";

  const reconnectRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const setDevHostTraceId = useCallback((traceId?: string) => {
    updateDevBrowserLogContext({ traceId });
  }, []);

  useEffect(() => {
    updateDevBrowserLogContext({
      role: "host",
      roomId: parsedRoomId ?? undefined,
    });
  }, [parsedRoomId]);

  useEffect(() => {
    return () => {
      updateDevBrowserLogContext({
        role: undefined,
        roomId: undefined,
        traceId: undefined,
      });
    };
  }, []);

  const hostGrantResponseSchema = useMemo(
    () =>
      zod.object({
        hostGrant: zod.string().min(1),
      }),
    [],
  );

  useEffect(() => {
    let disposed = false;
    let hostAdmissionEpoch = 0;
    let admissionRetryTimeout: ReturnType<typeof setTimeout> | null = null;
    const clearAdmissionRetryTimeout = (): void => {
      if (!admissionRetryTimeout) {
        return;
      }
      clearTimeout(admissionRetryTimeout);
      admissionRetryTimeout = null;
    };

    const storeState = store.getState();
    const initialRoomId = parsedRoomIdRef.current;
    storeState.setMode(detectRunMode());
    storeState.setRole("host");
    if (initialRoomId) {
      storeState.setRoomId(initialRoomId);
    }
    storeState.setStatus("connecting");
    storeState.setError(undefined);
    lastObservedStateVersionRef.current = null;
    emittedInvariantKeysRef.current.clear();

    if (!shouldConnect || !socket) {
      storeState.setStatus("idle");
      return;
    }

    const registerHost = async (operationEpoch: number) => {
      if (embeddedHost) {
        const childRoomId = embeddedHost.roomId;
        const latestState = store.getState();
        latestState.setStatus("connected");
        latestState.setRoomId(childRoomId);
        hydrateHostRoster();
        setRegisteredRoomId(childRoomId);
        setControllerCapability(null);
        return;
      }

      const resolveBootstrapPayload =
        async (): Promise<HostBootstrapPayload> => {
          if (!config.hostGrantEndpoint) {
            return hostBootstrapSchema.parse({
              appId: config.appId,
              hostSessionKind: config.hostSessionKind,
            });
          }

          const response = await fetch(config.hostGrantEndpoint, {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(config.appId ? { appId: config.appId } : {}),
          });

          if (!response.ok) {
            throw new Error(`Failed to fetch host grant (${response.status})`);
          }

          const parsed = hostGrantResponseSchema.safeParse(
            await response.json(),
          );
          if (!parsed.success) {
            throw new Error("Invalid host grant response");
          }

          return hostBootstrapSchema.parse({
            hostGrant: parsed.data.hostGrant,
            hostSessionKind: config.hostSessionKind,
          });
        };

      let bootstrapPayload: HostBootstrapPayload;
      try {
        bootstrapPayload = await resolveBootstrapPayload();
      } catch (error) {
        if (disposed || operationEpoch !== hostAdmissionEpoch) {
          return;
        }
        const latestState = store.getState();
        const message =
          error instanceof Error
            ? error.message
            : "Failed to resolve host bootstrap grant";
        emitAirJamDiagnostic({
          code: "AJ_HOST_BOOTSTRAP_FAILED",
          severity: "error",
          message,
          details: {
            stage: "resolve_bootstrap_payload",
            hasAppId: Boolean(config.appId),
            hasHostGrantEndpoint: Boolean(config.hostGrantEndpoint),
          },
        });
        latestState.setError(message);
        latestState.setStatus("disconnected");
        latestState.clearHostArcadeRestore();
        setRegisteredRoomId(null);
        setDevHostTraceId(undefined);
        setControllerCapability(null);
        return;
      }

      if (
        disposed ||
        operationEpoch !== hostAdmissionEpoch ||
        !socket.connected
      ) {
        return;
      }

      let bootstrapAck: HostBootstrapAck;
      try {
        bootstrapAck = await socket.emitWithAck<HostBootstrapAck>(
          "host:bootstrap",
          bootstrapPayload,
        );
      } catch (error) {
        if (disposed || operationEpoch !== hostAdmissionEpoch) {
          return;
        }
        const latestState = store.getState();
        const message =
          error instanceof Error &&
          error.message.includes(
            'Timed out waiting for acknowledgement for realtime event "host:bootstrap".',
          )
            ? HOST_BOOTSTRAP_TIMEOUT_MESSAGE
            : error instanceof Error
              ? error.message
              : "Failed to authorize host";
        emitAirJamDiagnostic({
          code: "AJ_HOST_BOOTSTRAP_FAILED",
          severity: "error",
          message,
          details: {
            stage: "bootstrap_ack_timeout",
            hasAppId: Boolean(config.appId),
            hasHostGrantEndpoint: Boolean(config.hostGrantEndpoint),
          },
        });
        latestState.setError(message);
        latestState.setStatus("disconnected");
        latestState.clearHostArcadeRestore();
        setRegisteredRoomId(null);
        setDevHostTraceId(undefined);
        setControllerCapability(null);
        return;
      }

      if (
        disposed ||
        operationEpoch !== hostAdmissionEpoch ||
        !socket.connected
      ) {
        return;
      }

      if (!bootstrapAck.ok) {
        const latestState = store.getState();
        const message = bootstrapAck.message ?? "Failed to authorize host";
        emitAirJamDiagnostic({
          code: "AJ_HOST_BOOTSTRAP_FAILED",
          severity: "error",
          message,
          details: {
            stage: "bootstrap_ack",
            ackCode: bootstrapAck.code,
            hasAppId: Boolean(config.appId),
            hasHostGrantEndpoint: Boolean(config.hostGrantEndpoint),
          },
        });
        latestState.setError(message);
        latestState.setStatus("disconnected");
        latestState.clearHostArcadeRestore();
        setRegisteredRoomId(null);
        setDevHostTraceId(undefined);
        setControllerCapability(null);
        return;
      }

      setDevHostTraceId(bootstrapAck.traceId);

      const createNewRoom = (
        reason: "bootstrap" | "reconnect_fallback" = "bootstrap",
        details?: Record<string, unknown>,
        completedRetries = 0,
        retry?: AdmissionRetryDecision,
      ): void => {
        if (
          disposed ||
          operationEpoch !== hostAdmissionEpoch ||
          !socket.connected
        ) {
          return;
        }

        const latestState = store.getState();
        latestState.clearHostArcadeRestore();
        latestState.resetPlayers();
        setRegisteredRoomId(null);
        setControllerCapability(null);
        const payload = hostCreateRoomSchema.parse({
          maxPlayers: config.maxPlayers,
        });
        emitHostRuntimeEvent({
          event: AIRJAM_DEV_LOG_EVENTS.runtime.hostCreateRoomRequested,
          message:
            completedRetries === 0
              ? "Host requested room creation"
              : "Host retried room creation after admission denial",
          data: {
            reason,
            maxPlayers: payload.maxPlayers,
            admissionAttempt: completedRetries + 1,
            ...(retry
              ? {
                  retryReasonCode: retry.code,
                  retryAfterSeconds: retry.retryAfterSeconds,
                }
              : {}),
            ...details,
          },
        });

        socket.emit("host:createRoom", payload, (ack: HostRegistrationAck) => {
          if (disposed || operationEpoch !== hostAdmissionEpoch) {
            return;
          }

          const latestState = store.getState();
          if (!ack.ok) {
            latestState.setError(ack.message ?? "Failed to create room");
            setRegisteredRoomId(null);
            setControllerCapability(null);

            const retryDecision = resolveAdmissionRetry(ack, completedRetries);
            if (retryDecision) {
              latestState.setStatus("connecting");
              clearAdmissionRetryTimeout();
              admissionRetryTimeout = setTimeout(() => {
                admissionRetryTimeout = null;
                createNewRoom(
                  reason,
                  details,
                  completedRetries + 1,
                  retryDecision,
                );
              }, retryDecision.delayMs);
              return;
            }

            latestState.setStatus("disconnected");
            setDevHostTraceId(undefined);
            return;
          }

          if (ack.roomId) {
            latestState.setStatus("connected");
            latestState.setRoomId(ack.roomId);
            latestState.setError(undefined);
            latestState.clearHostArcadeRestore();
            hydrateHostRoster(ack.players, ack.controllers);
            setRegisteredRoomId(ack.roomId);
            setControllerCapability(ack.controllerCapability ?? null);

            persistHostSession(ack);
            return;
          }

          latestState.setError("Server did not return room ID");
          latestState.setStatus("disconnected");
          setDevHostTraceId(undefined);
          setControllerCapability(null);
        });
      };

      if (typeof window !== "undefined") {
        const savedRoomId = sessionStorage.getItem(
          HOST_ROOM_SESSION_STORAGE_KEY,
        );
        const savedResumeCapabilityToken = sessionStorage.getItem(
          HOST_RESUME_CAPABILITY_SESSION_STORAGE_KEY,
        );
        if (savedRoomId && savedResumeCapabilityToken) {
          const reconnectPayload = hostReconnectSchema.parse({
            roomId: savedRoomId,
            resumeCapabilityToken: savedResumeCapabilityToken,
          });

          const maxReconnectAttempts = 12;
          const reconnectRetryDelayMs = 250;

          const attemptReconnect = (attempt: number) => {
            if (
              disposed ||
              operationEpoch !== hostAdmissionEpoch ||
              !socket.connected
            ) {
              return;
            }
            store.getState().setHostArcadeRestore({
              phase: "awaiting_ack",
              session: null,
              surfaceCheckpoint: null,
            });
            emitHostRuntimeEvent({
              event: AIRJAM_DEV_LOG_EVENTS.runtime.hostReconnectRequested,
              message: "Host requested room reconnect",
              roomId: reconnectPayload.roomId,
              data: {
                attempt,
                source: "session_storage_restore",
              },
            });
            socket.emit(
              "host:reconnect",
              reconnectPayload,
              (ack: HostRegistrationAck) => {
                if (disposed || operationEpoch !== hostAdmissionEpoch) {
                  return;
                }
                const latestState = store.getState();
                if (ack.ok && ack.roomId) {
                  latestState.setStatus("connected");
                  latestState.setRoomId(ack.roomId);
                  hydrateHostRoster(ack.players, ack.controllers);
                  setControllerCapability(ack.controllerCapability ?? null);
                  const surfaceCheckpoint =
                    ack.arcadeSurfaceCheckpoint ??
                    (ack.arcadeSession ? { epoch: 1, revision: 0 } : null);
                  latestState.setHostArcadeRestore(
                    surfaceCheckpoint
                      ? {
                          phase: "pending_restore",
                          session: ack.arcadeSession ?? null,
                          surfaceCheckpoint,
                        }
                      : {
                          phase: "idle",
                          session: null,
                          surfaceCheckpoint: null,
                        },
                  );
                  setRegisteredRoomId(ack.roomId);
                  persistHostSession(ack);
                  return;
                }

                if (
                  ack.code === ErrorCode.ALREADY_CONNECTED &&
                  attempt < maxReconnectAttempts
                ) {
                  emitHostRuntimeEvent({
                    event:
                      AIRJAM_DEV_LOG_EVENTS.runtime.hostReconnectRetryScheduled,
                    message: "Host reconnect retry scheduled",
                    roomId: reconnectPayload.roomId,
                    data: {
                      attempt,
                      nextAttempt: attempt + 1,
                      retryDelayMs: reconnectRetryDelayMs,
                      ackCode: ack.code,
                    },
                  });
                  reconnectRetryTimeoutRef.current = setTimeout(() => {
                    reconnectRetryTimeoutRef.current = null;
                    attemptReconnect(attempt + 1);
                  }, reconnectRetryDelayMs);
                  return;
                }

                latestState.clearHostArcadeRestore();
                clearPersistedHostSession();
                setControllerCapability(null);
                createNewRoom("reconnect_fallback", {
                  attempt,
                  ackCode: ack.code,
                  ackMessage: ack.message,
                });
              },
            );
          };

          attemptReconnect(0);
          return;
        }

        if (savedRoomId || savedResumeCapabilityToken) {
          clearPersistedHostSession();
        }
      }

      createNewRoom();
    };

    const handleConnect = (): void => {
      clearAdmissionRetryTimeout();
      hostAdmissionEpoch += 1;
      const operationEpoch = hostAdmissionEpoch;
      emitHostRuntimeEvent({
        event: AIRJAM_DEV_LOG_EVENTS.runtime.socketConnected,
        message: "Host socket connected",
        roomId: parsedRoomIdRef.current ?? undefined,
        data: {
          socketId: socket.id,
          connected: socket.connected,
        },
      });
      store.getState().setStatus("connecting");
      void registerHost(operationEpoch);
    };

    const handleDisconnect = (reason: string): void => {
      hostAdmissionEpoch += 1;
      clearAdmissionRetryTimeout();
      emitHostRuntimeEvent({
        event: AIRJAM_DEV_LOG_EVENTS.runtime.socketDisconnected,
        message: "Host socket disconnected",
        roomId: parsedRoomIdRef.current ?? undefined,
        data: {
          socketId: socket.id,
          reason,
        },
      });
      store.getState().setStatus("disconnected");
      store.getState().resetPlayers();
      store.getState().resetRuntimeState();
      lastObservedStateVersionRef.current = null;
      setRegisteredRoomId(null);
      setDevHostTraceId(undefined);
    };

    const handleConnectError = (error: Error): void => {
      emitAirJamDevRuntimeEvent({
        event: AIRJAM_DEV_LOG_EVENTS.runtime.socketConnectError,
        level: "warn",
        message: "Host socket connect error",
        role: "host",
        roomId: parsedRoomIdRef.current ?? undefined,
        data: {
          message: error.message,
          name: error.name,
        },
      });
    };

    const handleJoin = (payload: ControllerJoinedNotice): void => {
      store.getState().upsertControllerSession(payload);
      if (!payload.player) {
        return;
      }
      store.getState().upsertPlayer(payload.player);
      setTimeout(() => {
        onPlayerJoinRef.current?.(payload.player!);
      }, 0);
    };

    const handleLeave = (payload: { controllerId: string }): void => {
      const latestState = store.getState();
      latestState.removePlayer(payload.controllerId);
      latestState.removeControllerSession(payload.controllerId);
      onPlayerLeaveRef.current?.(payload.controllerId);
    };

    const handlePlayerUpdated = (payload: PlayerUpdatedNotice): void => {
      const latestState = store.getState();
      latestState.upsertPlayer(payload.player);
      const existingSession = latestState.controllerSessions.find(
        (controller) => controller.controllerId === payload.player.id,
      );
      if (existingSession) {
        latestState.upsertControllerSession({
          ...existingSession,
          player: payload.player,
        });
      }
    };

    const handleInput = (payload: ControllerInputEvent): void => {
      if (inputManager) {
        inputManager.handleInput(payload);
      }
    };

    const handleState = (payload: ControllerStateMessage): void => {
      const activeRoomId = parsedRoomIdRef.current;
      if (!activeRoomId || payload.roomId !== activeRoomId) return;

      emitHostRuntimeEvent({
        event: AIRJAM_DEV_LOG_EVENTS.runtime.hostStateReceived,
        message: "Host received state update",
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
          emitHostRuntimeEvent({
            event: AIRJAM_DEV_LOG_EVENTS.runtime.stateVersionReceived,
            message: "Host received initial room state version",
            roomId: payload.roomId,
            data: {
              stateVersion: incomingVersion,
              relation: "initial",
            },
          });
        } else if (incomingVersion <= previousVersion) {
          emitHostRuntimeEvent({
            event: AIRJAM_DEV_LOG_EVENTS.runtime.stateVersionReceived,
            level: "warn",
            message: "Host received non-monotonic room state version",
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
              "Received non-monotonic room state version in host runtime",
            data: {
              stateVersion: incomingVersion,
              previousStateVersion: previousVersion,
            },
          });
        } else if (incomingVersion !== previousVersion + 1) {
          emitHostRuntimeEvent({
            event: AIRJAM_DEV_LOG_EVENTS.runtime.stateVersionReceived,
            message: "Host detected room state version gap",
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
        emitHostRuntimeEvent({
          event: AIRJAM_DEV_LOG_EVENTS.runtime.phaseTransition,
          message: "Host runtime phase transition",
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
    };

    const handleError = (payload: { message: string }): void => {
      store.getState().setError(payload.message);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("server:controllerJoined", handleJoin);
    socket.on("server:controllerLeft", handleLeave);
    socket.on("server:playerUpdated", handlePlayerUpdated);
    socket.on("server:input", handleInput);
    socket.on("server:error", handleError);
    socket.on("server:state", handleState);

    if (socket.connected) {
      handleConnect();
    } else {
      socket.connect();
    }

    return () => {
      disposed = true;
      hostAdmissionEpoch += 1;
      clearAdmissionRetryTimeout();
      if (reconnectRetryTimeoutRef.current) {
        clearTimeout(reconnectRetryTimeoutRef.current);
        reconnectRetryTimeoutRef.current = null;
      }
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("server:controllerJoined", handleJoin);
      socket.off("server:controllerLeft", handleLeave);
      socket.off("server:playerUpdated", handlePlayerUpdated);
      socket.off("server:input", handleInput);
      socket.off("server:error", handleError);
      socket.off("server:state", handleState);
      setDevHostTraceId(undefined);
    };
  }, [
    config.maxPlayers,
    config.appId,
    config.hostGrantEndpoint,
    config.hostSessionKind,
    embeddedHost,
    shouldConnect,
    socket,
    store,
    inputManager,
    setRegisteredRoomId,
    setDevHostTraceId,
    hostGrantResponseSchema,
    emitHostRuntimeEvent,
    emitInvariantOnce,
    hydrateHostRoster,
  ]);

  const getInput = useCallback(
    (controllerId: string): z.infer<TSchema> | undefined => {
      if (!inputManager) {
        return undefined;
      }
      return inputManager.getInput(controllerId) as
        | z.infer<TSchema>
        | undefined;
    },
    [inputManager],
  );

  return useMemo(
    () => ({
      roomId: parsedRoomId ?? ("" as RoomCode),
      joinUrl,
      joinUrlStatus,
      pauseRuntime,
      resumeRuntime,
      setRuntimeState,
      sendState,
      sendSignal,
      reconnect,
      removeController,
      resetRoom,
      socket: socket ?? getHostRealtimeClient((role) => getSocket(role)),
      getInput,
    }),
    [
      getInput,
      getSocket,
      joinUrl,
      joinUrlStatus,
      parsedRoomId,
      pauseRuntime,
      reconnect,
      removeController,
      resetRoom,
      resumeRuntime,
      sendSignal,
      sendState,
      setRuntimeState,
      socket,
    ],
  );
};
