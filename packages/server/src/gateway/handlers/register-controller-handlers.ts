import {
  AIRJAM_DEV_LOG_EVENTS,
  controllerInputSchema,
  controllerJoinSchema,
  controllerLeaveSchema,
  controllerSystemSchema,
  controllerUpdatePlayerProfileSchema,
  ErrorCode,
  inferControllerSourceFromDeviceId,
  type AirJamDevLogEventName,
  type ControllerInputEvent,
  type ControllerJoinPayload,
  type ControllerLeavePayload,
  type ControllerUpdatePlayerProfileAck,
  type PlayerProfile,
} from "@air-jam/sdk/protocol";
import Color from "color";
import { createRoomRuntimeUsageEvent } from "../../analytics/runtime-usage.js";
import {
  beginRoomClosing,
  buildRoomStateMessage,
  disconnectChildHostIfPresent,
  emitControllerJoinedNotice,
  emitControllerLeftNotice,
  emitRoomState,
  getDefaultControllerPrivilegedGrants,
  isControllerPrivilegedCapabilityExpired,
  listRoomPlayers,
  transitionToSystemFocus,
} from "../../domain/room-session-domain.js";
import { createWindowedEventSummary } from "../../logging/create-windowed-event-summary.js";
import type {
  RealtimeAdmissionDecision,
  RealtimeControllerLease,
} from "../../services/realtime-admission-service.js";
import type { SocketHandlerContext } from "../socket-handler-context.js";

const PLAYER_COLORS = [
  "#38bdf8",
  "#a78bfa",
  "#f472b6",
  "#34d399",
  "#fbbf24",
  "#60a5fa",
  "#c084fc",
  "#fb7185",
  "#4ade80",
  "#f87171",
  "#22d3ee",
  "#a855f7",
  "#ec4899",
  "#10b981",
  "#f59e0b",
  "#3b82f6",
  "#8b5cf6",
  "#ef4444",
  "#14b8a6",
  "#f97316",
] as const;

export const registerControllerHandlers = (
  context: SocketHandlerContext,
): void => {
  const {
    io,
    socket,
    roomManager,
    realtimeAdmissionService,
    runtimeUsagePublisher,
    isControllerAuthorizedForRoom,
    hasControllerPrivilegeForRoom,
    emitError,
  } = context;
  const logger = context.logger.child({ component: "controller" });
  let lastServerInputFailLogTime = 0;
  let controllerAdmissionPending = false;
  let controllerLifecycleEpoch = 0;
  let lastAcceptedLeave: Pick<
    ControllerLeavePayload,
    "roomId" | "controllerId"
  > | null = null;
  const controllerInputSummary = createWindowedEventSummary({
    logger,
    event: AIRJAM_DEV_LOG_EVENTS.controller.inputSummary,
    msg: "Controller input activity summary",
    shouldEmit: (next, previous) => {
      const nextInputCount =
        typeof next.data.inputCount === "number" ? next.data.inputCount : 0;
      const nextActiveInputCount =
        typeof next.data.activeInputCount === "number"
          ? next.data.activeInputCount
          : 0;
      if (nextActiveInputCount > 0 || !previous) {
        return true;
      }

      const previousInputCount =
        typeof previous.data.inputCount === "number"
          ? previous.data.inputCount
          : 0;
      const previousActiveInputCount =
        typeof previous.data.activeInputCount === "number"
          ? previous.data.activeInputCount
          : 0;

      if (previousActiveInputCount > 0) {
        return true;
      }

      return Math.abs(nextInputCount - previousInputCount) > 2;
    },
  });
  const controllerInputDroppedSummary = createWindowedEventSummary({
    logger,
    event: AIRJAM_DEV_LOG_EVENTS.controller.inputDroppedSummary,
    msg: "Controller input drops summary",
  });

  const getControllerLogger = (bindings: Record<string, unknown> = {}) => {
    const authority = socket.data.controllerAuthority;
    const mergedBindings = {
      ...(authority
        ? {
            roomId: authority.roomId,
            controllerId: authority.controllerId,
          }
        : {}),
      ...bindings,
    };

    return Object.keys(mergedBindings).length > 0
      ? logger.child(mergedBindings)
      : logger;
  };

  const logControllerEvent = (
    level: "debug" | "info" | "warn",
    event: AirJamDevLogEventName,
    msg: string,
    bindings: Record<string, unknown> = {},
  ): void => {
    const target = getControllerLogger(bindings);
    if (level === "debug") {
      target.debug({ event }, msg);
      return;
    }
    if (level === "warn") {
      target.warn({ event }, msg);
      return;
    }
    target.info({ event }, msg);
  };

  socket.on("disconnect", () => {
    controllerLifecycleEpoch += 1;
    controllerInputSummary.flushAll();
    controllerInputDroppedSummary.flushAll();
  });

  const recordInputDrop = ({
    roomId,
    controllerId,
    reason,
    hasActiveInput,
  }: {
    roomId?: string;
    controllerId?: string;
    reason: string;
    hasActiveInput: boolean;
  }): void => {
    const roomKey = roomId ?? "unknown_room";
    const controllerKey = controllerId ?? "unknown_controller";
    controllerInputDroppedSummary.record({
      key: `${roomKey}:${controllerKey}:${reason}`,
      bindings: {
        ...(roomId ? { roomId } : {}),
        ...(controllerId ? { controllerId } : {}),
      },
      data: {
        reason,
      },
      metrics: {
        droppedCount: 1,
        droppedActiveCount: hasActiveInput ? 1 : 0,
      },
    });
  };

  socket.on(
    "controller:join",
    async (payload: ControllerJoinPayload, callback) => {
      if (
        context.isRateLimited(
          "controller-join",
          context.controllerJoinRateLimitMax,
        )
      ) {
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.joinRejected,
          "Rejected controller join due to socket rate limit",
          { reason: "rate_limited" },
        );
        callback({
          ok: false,
          message: "Too many join attempts. Please try again.",
          code: ErrorCode.SERVICE_UNAVAILABLE,
        });
        return;
      }

      const parsed = controllerJoinSchema.safeParse(payload);
      if (!parsed.success) {
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.joinRejected,
          "Rejected controller join with invalid payload",
          {
            reason: "invalid_payload",
            issues: parsed.error.issues,
          },
        );
        callback({
          ok: false,
          message: parsed.error.message,
          code: ErrorCode.INVALID_PAYLOAD,
        });
        return;
      }

      const {
        roomId,
        controllerId,
        deviceId: rawDeviceId,
        nickname,
        avatarId,
        capabilityToken,
      } = parsed.data;
      const deviceId = rawDeviceId ?? controllerId;
      const session = roomManager.getRoom(roomId);
      if (!session) {
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.joinRejected,
          "Rejected controller join because room was not found",
          {
            roomId,
            controllerId,
            reason: "room_not_found",
          },
        );
        callback({
          ok: false,
          message: "Room not found",
          code: ErrorCode.ROOM_NOT_FOUND,
        });
        emitError(socket.id, {
          code: ErrorCode.ROOM_NOT_FOUND,
          message: "Room not found",
        });
        return;
      }

      const existing = session.controllers.get(controllerId);
      const isResumedJoin = Boolean(existing);
      const isResumeCandidate =
        Boolean(existing) && existing?.deviceId === deviceId;
      const roomCapability = session.controllerCapability;
      const hasProvidedCapability = typeof capabilityToken === "string";
      const capabilityExpired = roomCapability
        ? isControllerPrivilegedCapabilityExpired(roomCapability)
        : false;
      const hasValidCapability =
        Boolean(roomCapability) &&
        !capabilityExpired &&
        roomCapability?.token === capabilityToken;

      if (hasProvidedCapability && !hasValidCapability && !isResumeCandidate) {
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.joinRejected,
          "Rejected controller join because privileged capability was invalid",
          {
            roomId,
            controllerId,
            reason: capabilityExpired
              ? "capability_expired"
              : "invalid_capability",
          },
        );
        callback({
          ok: false,
          message: capabilityExpired
            ? "Controller link expired. Please re-open it from the host."
            : "Invalid controller link",
          code: ErrorCode.UNAUTHORIZED,
        });
        return;
      }

      if (existing && existing.deviceId !== deviceId) {
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.joinRejected,
          "Rejected controller join because resume binding belongs to another device",
          {
            roomId,
            controllerId,
            reason: "resume_device_mismatch",
          },
        );
        callback({
          ok: false,
          message: "Controller slot is unavailable",
          code: ErrorCode.INVALID_PAYLOAD,
        });
        return;
      }

      const previousController = roomManager.getControllerInfo(socket.id);
      const switchesController =
        previousController &&
        (previousController.roomId !== roomId ||
          previousController.controllerId !== controllerId);
      const previousSession = switchesController
        ? roomManager.getRoom(previousController.roomId)
        : undefined;
      const previousEntry = switchesController
        ? previousSession?.controllers.get(previousController.controllerId)
        : undefined;
      const replacingLease =
        previousEntry?.socketId === socket.id
          ? previousEntry.admissionLease
          : undefined;

      if (controllerAdmissionPending) {
        callback({
          ok: false,
          message: "A controller join is already in progress. Please retry.",
          code: ErrorCode.SERVICE_UNAVAILABLE,
          retryAfterSeconds: 1,
        });
        return;
      }

      controllerAdmissionPending = true;
      const operationEpoch = controllerLifecycleEpoch;
      const roomLeaseToken = session.admissionLease.leaseToken;
      let admission: RealtimeAdmissionDecision<RealtimeControllerLease>;
      try {
        admission = await realtimeAdmissionService.admitController({
          roomLease: session.admissionLease,
          controllerId,
          existingLease: existing?.admissionLease,
          replacingLease,
        });
        if (
          admission.ok &&
          (!socket.connected ||
            controllerLifecycleEpoch !== operationEpoch ||
            roomManager.getRoom(roomId) !== session ||
            session.admissionLease.leaseToken !== roomLeaseToken ||
            (existing !== undefined &&
              (existing.retiredAt !== undefined ||
                session.controllers.get(controllerId) !== existing)) ||
            (previousEntry !== undefined &&
              previousEntry.socketId === socket.id &&
              previousEntry.retiredAt !== undefined))
        ) {
          await realtimeAdmissionService.releaseController(admission.lease);
          admission = {
            ok: false,
            reason: "operation_cancelled",
            message: "The controller state changed before joining completed.",
            retryAfterSeconds: null,
          };
        }
      } finally {
        controllerAdmissionPending = false;
      }
      if (!admission.ok) {
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.joinRejected,
          "Rejected controller join by realtime admission authority",
          { roomId, controllerId, reason: admission.reason },
        );
        callback({
          ok: false,
          message: admission.message,
          code:
            admission.reason === "room_full"
              ? ErrorCode.ROOM_FULL
              : ErrorCode.SERVICE_UNAVAILABLE,
          ...(admission.retryAfterSeconds
            ? { retryAfterSeconds: admission.retryAfterSeconds }
            : {}),
        });
        return;
      }

      if (
        previousController &&
        (previousController.roomId !== roomId ||
          previousController.controllerId !== controllerId)
      ) {
        if (previousSession && previousEntry?.socketId === socket.id) {
          previousEntry.retiredAt = Date.now();
          previousSession.controllers.delete(previousController.controllerId);
          emitControllerLeftNotice(
            io,
            previousSession,
            previousController.controllerId,
          );
        }
        roomManager.deleteController(socket.id);
      }

      const grantedPrivileges = hasValidCapability
        ? [...roomCapability!.grants]
        : existing?.privilegedGrants.length
          ? [...existing.privilegedGrants]
          : getDefaultControllerPrivilegedGrants();
      const resumed = isResumedJoin;
      if (existing) {
        if (existing.pendingDisconnectTimer) {
          clearTimeout(existing.pendingDisconnectTimer);
          existing.pendingDisconnectTimer = undefined;
        }
        if (existing.socketId && existing.socketId !== socket.id) {
          roomManager.deleteController(existing.socketId);
        }
      }

      const colorHex =
        PLAYER_COLORS[session.controllers.size % PLAYER_COLORS.length];
      let color: string;
      try {
        color = Color(colorHex).hex();
      } catch {
        color = Color("#38bdf8").hex();
      }

      let controllerSession = session.controllers.get(controllerId) ?? existing;
      if (controllerSession) {
        controllerSession.retiredAt = undefined;
        controllerSession.nickname = nickname ?? controllerSession.nickname;
        controllerSession.connected = true;
        controllerSession.resumeLeaseExpiresAt = null;
        controllerSession.socketId = socket.id;
        controllerSession.privilegedGrants = grantedPrivileges;
        controllerSession.admissionLease = admission.lease;
        controllerSession.playerProfile = {
          ...controllerSession.playerProfile,
          label:
            nickname ??
            controllerSession.nickname ??
            controllerSession.playerProfile.label,
          ...(avatarId !== undefined
            ? { avatarId }
            : controllerSession.playerProfile.avatarId
              ? { avatarId: controllerSession.playerProfile.avatarId }
              : {}),
        };
        session.controllers.set(controllerId, controllerSession);
      } else {
        const playerProfile: PlayerProfile = {
          id: controllerId,
          label: nickname ?? `Player ${session.controllers.size}`,
          color,
          ...(avatarId ? { avatarId } : {}),
        };

        controllerSession = {
          controllerId,
          deviceId,
          nickname,
          socketId: socket.id,
          connected: true,
          resumeLeaseExpiresAt: null,
          playerProfile,
          privilegedGrants: grantedPrivileges,
          source: inferControllerSourceFromDeviceId(deviceId),
          admissionLease: admission.lease,
        };
        session.controllers.set(controllerId, controllerSession);
      }

      roomManager.setController(socket.id, { roomId, controllerId });
      socket.data.controllerAuthority = {
        roomId,
        controllerId,
        deviceId,
        joinedAt: Date.now(),
        privilegedGrants: grantedPrivileges,
      };
      lastAcceptedLeave = null;
      socket.join(roomId);

      emitControllerJoinedNotice(io, session, controllerSession, { resumed });

      if (resumed) {
        logControllerEvent(
          "info",
          AIRJAM_DEV_LOG_EVENTS.controller.resumeAccepted,
          "Controller resumed existing room binding",
          {
            roomId,
            controllerId,
            nickname: nickname ?? undefined,
            privilegedGrantCount: grantedPrivileges.length,
          },
        );
      }

      logControllerEvent(
        "info",
        AIRJAM_DEV_LOG_EVENTS.controller.joinAccepted,
        "Controller joined room",
        {
          roomId,
          controllerId,
          nickname: nickname ?? undefined,
          resumed,
          privilegedGrantCount: grantedPrivileges.length,
          hasCapability: hasValidCapability,
        },
      );
      runtimeUsagePublisher.publish(
        createRoomRuntimeUsageEvent(session, {
          kind: "controller_joined",
          payload: {
            controllerId,
            rejoined: resumed,
            resumed,
          },
        }),
      );

      callback({ ok: true, controllerId, roomId, resumed });
      socket.emit("server:welcome", {
        controllerId,
        roomId,
        resumed,
        player: controllerSession.playerProfile,
        players: listRoomPlayers(session),
      });
      socket.emit("server:state", buildRoomStateMessage(roomId, session));
    },
  );

  socket.on(
    "controller:updatePlayerProfile",
    (
      payload: unknown,
      callback: (ack: ControllerUpdatePlayerProfileAck) => void,
    ) => {
      const respond = (ack: ControllerUpdatePlayerProfileAck): void => {
        callback?.(ack);
      };

      const parsed = controllerUpdatePlayerProfileSchema.safeParse(payload);
      if (!parsed.success) {
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.profileUpdateRejected,
          "Rejected controller profile update with invalid payload",
          {
            reason: "invalid_payload",
            issues: parsed.error.issues,
          },
        );
        respond({
          ok: false,
          message: parsed.error.message,
        });
        return;
      }

      const { roomId, controllerId, patch } = parsed.data;
      if (!isControllerAuthorizedForRoom(roomId, controllerId)) {
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.profileUpdateRejected,
          "Rejected controller profile update because socket is unauthorized",
          {
            roomId,
            controllerId,
            reason: "unauthorized",
          },
        );
        respond({
          ok: false,
          message: "Not authorized",
          code: ErrorCode.INVALID_PAYLOAD,
        });
        return;
      }

      const session = roomManager.getRoom(roomId);
      if (!session) {
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.profileUpdateRejected,
          "Rejected controller profile update because room was not found",
          {
            roomId,
            controllerId,
            reason: "room_not_found",
          },
        );
        respond({
          ok: false,
          message: "Room not found",
          code: ErrorCode.ROOM_NOT_FOUND,
        });
        return;
      }

      const controllerSession = session.controllers.get(controllerId);
      if (!controllerSession) {
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.profileUpdateRejected,
          "Rejected controller profile update because controller is not in room",
          {
            roomId,
            controllerId,
            reason: "controller_not_in_room",
          },
        );
        respond({
          ok: false,
          message: "Controller not in room",
        });
        return;
      }
      const nextProfile: PlayerProfile = {
        ...controllerSession.playerProfile,
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.avatarId !== undefined ? { avatarId: patch.avatarId } : {}),
      };

      controllerSession.playerProfile = nextProfile;
      if (patch.label !== undefined) {
        controllerSession.nickname = patch.label;
      }

      const notice = { player: nextProfile };

      io.to(roomManager.getActiveHostId(session)).emit(
        "server:playerUpdated",
        notice,
      );
      socket.emit("server:playerUpdated", notice);

      logControllerEvent(
        "info",
        AIRJAM_DEV_LOG_EVENTS.controller.profileUpdateAccepted,
        "Controller profile updated",
        {
          roomId,
          controllerId,
          patch: parsed.data.patch,
        },
      );

      respond({ ok: true, player: nextProfile });
    },
  );

  socket.on(
    "controller:leave",
    async (
      payload: ControllerLeavePayload,
      callback: (ack: { ok: boolean; message?: string; code?: string }) => void,
    ) => {
      const parsed = controllerLeaveSchema.safeParse(payload);
      if (!parsed.success) {
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.leaveRejected,
          "Rejected controller leave with invalid payload",
          {
            reason: "invalid_payload",
            issues: parsed.error.issues,
          },
        );
        callback({
          ok: false,
          message: parsed.error.message,
          code: ErrorCode.INVALID_PAYLOAD,
        });
        return;
      }

      const { roomId, controllerId } = parsed.data;
      const repeatsAcceptedLeave =
        !socket.data.controllerAuthority &&
        lastAcceptedLeave?.roomId === roomId &&
        lastAcceptedLeave.controllerId === controllerId;
      if (
        !repeatsAcceptedLeave &&
        !isControllerAuthorizedForRoom(roomId, controllerId)
      ) {
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.leaveRejected,
          "Rejected controller leave because socket is unauthorized",
          {
            roomId,
            controllerId,
            reason: "unauthorized",
          },
        );
        callback({
          ok: false,
          message: "Unauthorized controller leave request",
          code: ErrorCode.INVALID_PAYLOAD,
        });
        return;
      }

      const session = roomManager.getRoom(roomId);
      if (!session) {
        roomManager.deleteController(socket.id);
        delete socket.data.controllerAuthority;
        lastAcceptedLeave = { roomId, controllerId };
        socket.leave(roomId);
        logControllerEvent(
          "info",
          AIRJAM_DEV_LOG_EVENTS.controller.leaveAccepted,
          "Controller leave was already complete",
          {
            roomId,
            controllerId,
            alreadyAbsent: true,
          },
        );
        callback({ ok: true });
        return;
      }

      const controllerSession = session.controllers.get(controllerId);
      if (controllerSession?.pendingDisconnectTimer) {
        clearTimeout(controllerSession.pendingDisconnectTimer);
        controllerSession.pendingDisconnectTimer = undefined;
      }
      if (controllerSession) {
        controllerLifecycleEpoch += 1;
        controllerSession.retiredAt = Date.now();
        session.controllers.delete(controllerId);
      }
      roomManager.deleteController(socket.id);
      delete socket.data.controllerAuthority;
      lastAcceptedLeave = { roomId, controllerId };
      socket.leave(roomId);
      logControllerEvent(
        "info",
        AIRJAM_DEV_LOG_EVENTS.controller.leaveAccepted,
        controllerSession
          ? "Controller left room"
          : "Controller leave was already complete",
        {
          roomId,
          controllerId,
          alreadyAbsent: !controllerSession,
        },
      );
      if (controllerSession) {
        emitControllerLeftNotice(io, session, controllerId);
        runtimeUsagePublisher.publish(
          createRoomRuntimeUsageEvent(session, {
            kind: "controller_left",
            payload: {
              controllerId,
            },
          }),
        );
        await realtimeAdmissionService.releaseController(
          controllerSession.admissionLease,
        );
      }
      callback({ ok: true });
    },
  );

  socket.on("controller:input", (payload: ControllerInputEvent) => {
    const now = Date.now();
    const input = payload?.input;
    const hasActiveInput =
      input &&
      (input.action === true ||
        (typeof input.vector === "object" &&
          input.vector !== null &&
          (Math.abs((input.vector as { x?: number; y?: number }).x ?? 0) >
            0.01 ||
            Math.abs((input.vector as { x?: number; y?: number }).y ?? 0) >
              0.01)));

    const result = controllerInputSchema.safeParse(payload);
    if (!result.success) {
      const rawRoomId =
        typeof payload?.roomId === "string" ? payload.roomId : undefined;
      const rawControllerId =
        typeof payload?.controllerId === "string"
          ? payload.controllerId
          : undefined;
      recordInputDrop({
        roomId: rawRoomId,
        controllerId: rawControllerId,
        reason: "invalid_payload",
        hasActiveInput: Boolean(hasActiveInput),
      });
      if (
        !lastServerInputFailLogTime ||
        now - lastServerInputFailLogTime > 1000
      ) {
        lastServerInputFailLogTime = now;
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.inputRejected,
          "Rejected controller input with invalid payload",
          {
            reason: "invalid_payload",
            issues: result.error.issues,
          },
        );
      }
      return;
    }

    const { roomId, controllerId } = result.data;
    if (!isControllerAuthorizedForRoom(roomId, controllerId)) {
      recordInputDrop({
        roomId,
        controllerId,
        reason: "unauthorized",
        hasActiveInput: Boolean(hasActiveInput),
      });
      if (
        !lastServerInputFailLogTime ||
        now - lastServerInputFailLogTime > 1000
      ) {
        lastServerInputFailLogTime = now;
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.inputRejected,
          "Rejected controller input because socket is unauthorized",
          {
            roomId,
            controllerId,
            reason: "unauthorized",
          },
        );
      }
      return;
    }

    const session = roomManager.getRoom(roomId);
    if (!session) {
      recordInputDrop({
        roomId,
        controllerId,
        reason: "room_not_found",
        hasActiveInput: Boolean(hasActiveInput),
      });
      if (
        !lastServerInputFailLogTime ||
        now - lastServerInputFailLogTime > 1000
      ) {
        lastServerInputFailLogTime = now;
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.inputRejected,
          "Rejected controller input because room was not found",
          {
            roomId,
            controllerId,
            reason: "room_not_found",
          },
        );
      }
      return;
    }

    const targetHostId = roomManager.getActiveHostId(session);
    if (targetHostId) {
      io.to(targetHostId).emit("server:input", result.data);
      controllerInputSummary.record({
        key: `${roomId}:${controllerId}`,
        bindings: {
          roomId,
          controllerId,
        },
        metrics: {
          inputCount: 1,
          activeInputCount: hasActiveInput ? 1 : 0,
        },
      });
    } else {
      recordInputDrop({
        roomId,
        controllerId,
        reason: "active_host_missing",
        hasActiveInput: Boolean(hasActiveInput),
      });
      if (
        !lastServerInputFailLogTime ||
        now - lastServerInputFailLogTime > 1000
      ) {
        lastServerInputFailLogTime = now;
        logControllerEvent(
          "warn",
          AIRJAM_DEV_LOG_EVENTS.controller.inputRejected,
          "Rejected controller input because no active host was available",
          {
            roomId,
            controllerId,
            reason: "active_host_missing",
          },
        );
      }
    }
  });

  socket.on("controller:system", (payload) => {
    const parsed = controllerSystemSchema.safeParse(payload);
    if (!parsed.success) {
      logControllerEvent(
        "warn",
        AIRJAM_DEV_LOG_EVENTS.controller.systemRejected,
        "Rejected controller system command with invalid payload",
        {
          reason: "invalid_payload",
          issues: parsed.error.issues,
        },
      );
      return;
    }

    const { roomId, command } = parsed.data;
    if (!isControllerAuthorizedForRoom(roomId)) {
      logControllerEvent(
        "warn",
        AIRJAM_DEV_LOG_EVENTS.controller.systemRejected,
        "Rejected controller system command because socket is unauthorized",
        {
          roomId,
          reason: "unauthorized",
          command,
        },
      );
      return;
    }

    if (!hasControllerPrivilegeForRoom(roomId, "system")) {
      logControllerEvent(
        "warn",
        AIRJAM_DEV_LOG_EVENTS.controller.systemRejected,
        "Rejected controller system command because privileged capability is missing",
        {
          roomId,
          reason: "missing_capability",
          command,
        },
      );
      return;
    }

    const session = roomManager.getRoom(roomId);
    if (!session) {
      logControllerEvent(
        "warn",
        AIRJAM_DEV_LOG_EVENTS.controller.systemRejected,
        "Rejected controller system command because room was not found",
        {
          roomId,
          reason: "room_not_found",
          command,
        },
      );
      return;
    }

    const previousGameId = session.activeGameId;
    if (command === "exit") {
      logControllerEvent(
        "info",
        AIRJAM_DEV_LOG_EVENTS.controller.systemAccepted,
        "Controller requested room exit",
        {
          roomId,
          command,
        },
      );
      beginRoomClosing(session);
      disconnectChildHostIfPresent(io, session);
      transitionToSystemFocus(io, session, {
        resetGameState: true,
        notifyMasterCloseChild: true,
      });
      runtimeUsagePublisher.publish(
        createRoomRuntimeUsageEvent(session, {
          kind: "game_returned_to_system",
          gameId: previousGameId,
          payload: {
            reason: "controller_exit",
          },
        }),
      );
      return;
    }

    if (command === "pause" || command === "resume") {
      const previousRuntimeState = session.runtimeState;
      const nextRuntimeState = command === "pause" ? "paused" : "playing";
      session.runtimeState = nextRuntimeState;
      const broadcastPayload = emitRoomState(io, roomId, session);
      logControllerEvent(
        "info",
        AIRJAM_DEV_LOG_EVENTS.controller.systemAccepted,
        "Controller updated runtime state",
        {
          roomId,
          command,
          previousRuntimeState,
          nextRuntimeState,
          stateVersion: broadcastPayload.state.stateVersion,
        },
      );
      return;
    }

    logControllerEvent(
      "warn",
      AIRJAM_DEV_LOG_EVENTS.controller.systemRejected,
      "Rejected controller system command because command is unsupported",
      {
        roomId,
        command,
        reason: "unsupported_command",
      },
    );
  });
};
