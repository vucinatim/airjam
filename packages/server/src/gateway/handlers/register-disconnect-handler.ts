import { AIRJAM_DEV_LOG_EVENTS } from "@air-jam/sdk/protocol";
import { createRoomRuntimeUsageEvent } from "../../analytics/runtime-usage.js";
import {
  beginRoomClosing,
  emitControllerLeftNotice,
  getChildHostDisconnectTeardownMs,
  getControllerResumeLeaseMsForSource,
  transitionToSystemFocus,
} from "../../domain/room-session-domain.js";
import type { SocketHandlerContext } from "../socket-handler-context.js";

export const registerDisconnectHandler = (
  context: SocketHandlerContext,
): void => {
  const {
    io,
    socket,
    roomManager,
    runtimeUsagePublisher,
    realtimeAdmissionService,
  } = context;
  const logger = context.logger.child({ component: "disconnect" });

  const getDisconnectLogger = (bindings: Record<string, unknown> = {}) => {
    const mergedBindings = {
      ...(socket.data.hostAuthority?.traceId
        ? { traceId: socket.data.hostAuthority.traceId }
        : {}),
      ...(socket.data.controllerAuthority
        ? {
            roomId: socket.data.controllerAuthority.roomId,
            controllerId: socket.data.controllerAuthority.controllerId,
          }
        : {}),
      ...bindings,
    };

    return Object.keys(mergedBindings).length > 0
      ? logger.child(mergedBindings)
      : logger;
  };

  socket.on("disconnect", (reason) => {
    logger.debug(
      {
        event: AIRJAM_DEV_LOG_EVENTS.socket.disconnected,
        reason,
        traceId: socket.data.hostAuthority?.traceId,
        roomId: socket.data.controllerAuthority?.roomId,
        controllerId: socket.data.controllerAuthority?.controllerId,
      },
      "Socket disconnected",
    );
    const roomId = roomManager.getRoomByHostId(socket.id);
    if (roomId) {
      const session = roomManager.getRoom(roomId);
      if (!session) {
        roomManager.deleteHost(socket.id);
        return;
      }

      if (socket.id === session.childHostSocketId) {
        if (session.pendingChildTeardownTimer) {
          clearTimeout(session.pendingChildTeardownTimer);
        }
        getDisconnectLogger({ roomId }).info(
          {
            event: AIRJAM_DEV_LOG_EVENTS.childHost.disconnectPendingSystemFocus,
            reason,
            teardownMs: getChildHostDisconnectTeardownMs(),
          },
          "Child host disconnected; scheduled system focus restore",
        );
        session.childHostSocketId = undefined;
        session.pendingChildTeardownTimer = setTimeout(() => {
          session.pendingChildTeardownTimer = undefined;
          const current = roomManager.getRoom(roomId);
          if (!current) {
            return;
          }
          const childAlive =
            current.childHostSocketId &&
            io.sockets.sockets.get(current.childHostSocketId)?.connected;
          if (childAlive) {
            return;
          }
          const previousGameId = current.activeGameId;
          beginRoomClosing(current);
          transitionToSystemFocus(io, current, {
            resyncPlayersToMaster: true,
          });
          runtimeUsagePublisher.publish(
            createRoomRuntimeUsageEvent(current, {
              kind: "game_returned_to_system",
              gameId: previousGameId,
              payload: {
                reason: "child_host_disconnect_timeout",
              },
            }),
          );
          getDisconnectLogger({ roomId }).info(
            {
              event:
                AIRJAM_DEV_LOG_EVENTS.childHost.disconnectSystemFocusRestored,
              reason,
            },
            "Child host teardown restored system focus",
          );
        }, getChildHostDisconnectTeardownMs());
        roomManager.deleteHost(socket.id);
        return;
      } else if (socket.id === session.masterHostSocketId) {
        if (session.pendingRoomCloseTimer) {
          clearTimeout(session.pendingRoomCloseTimer);
        }
        getDisconnectLogger({ roomId }).info(
          {
            event: AIRJAM_DEV_LOG_EVENTS.host.disconnectPendingRoomClose,
            reason,
            teardownMs: 3000,
          },
          "Master host disconnected; scheduled room close",
        );
        session.pendingRoomCloseTimer = setTimeout(() => {
          session.pendingRoomCloseTimer = undefined;
          const currentSession = roomManager.getRoom(roomId);
          if (
            currentSession &&
            currentSession.masterHostSocketId === socket.id
          ) {
            runtimeUsagePublisher.publish(
              createRoomRuntimeUsageEvent(currentSession, {
                kind: "room_closed",
                payload: {
                  reason: "host_disconnected",
                },
              }),
            );
            getDisconnectLogger({ roomId }).info(
              {
                event: AIRJAM_DEV_LOG_EVENTS.host.disconnectRoomClosed,
                reason,
              },
              "Room closed after master host disconnect",
            );
            roomManager.removeRoom(roomId, io, "Host disconnected");
            void realtimeAdmissionService.releaseRoom(
              currentSession.admissionLease,
            );
          }
        }, 3000);
      }

      roomManager.deleteHost(socket.id);
      return;
    }

    const controller = roomManager.getControllerInfo(socket.id);
    if (!controller) {
      return;
    }

    const session = roomManager.getRoom(controller.roomId);
    if (session) {
      const controllerSession = session.controllers.get(
        controller.controllerId,
      );
      const resumeLeaseMs = getControllerResumeLeaseMsForSource(
        controllerSession?.source ?? "phone",
      );
      const resumeLeaseExpiresAt =
        resumeLeaseMs > 0 ? Date.now() + resumeLeaseMs : null;

      if (controllerSession) {
        if (controllerSession.pendingDisconnectTimer) {
          clearTimeout(controllerSession.pendingDisconnectTimer);
        }
        controllerSession.connected = false;
        controllerSession.socketId = undefined;
        controllerSession.resumeLeaseExpiresAt = resumeLeaseExpiresAt;
        if (resumeLeaseMs > 0 && resumeLeaseExpiresAt !== null) {
          controllerSession.pendingDisconnectTimer = setTimeout(() => {
            const currentSession = roomManager.getRoom(controller.roomId);
            const currentController = currentSession?.controllers.get(
              controller.controllerId,
            );
            if (
              !currentSession ||
              !currentController ||
              currentController.connected ||
              currentController.resumeLeaseExpiresAt !== resumeLeaseExpiresAt
            ) {
              return;
            }
            currentController.pendingDisconnectTimer = undefined;
            currentController.retiredAt = Date.now();
            currentSession.controllers.delete(controller.controllerId);
            void realtimeAdmissionService.releaseController(
              currentController.admissionLease,
            );
            emitControllerLeftNotice(
              io,
              currentSession,
              controller.controllerId,
            );
            runtimeUsagePublisher.publish(
              createRoomRuntimeUsageEvent(currentSession, {
                kind: "controller_left",
                payload: {
                  controllerId: controller.controllerId,
                  reason: "resume_lease_expired",
                },
              }),
            );
            getDisconnectLogger({
              roomId: controller.roomId,
              controllerId: controller.controllerId,
            }).info(
              {
                event: AIRJAM_DEV_LOG_EVENTS.controller.disconnectLeaseExpired,
                reason,
                resumeLeaseMs,
                source: currentController.source,
              },
              "Controller resume lease expired and was removed from room",
            );
          }, resumeLeaseMs);
        } else {
          controllerSession.retiredAt = Date.now();
          session.controllers.delete(controller.controllerId);
          void realtimeAdmissionService.releaseController(
            controllerSession.admissionLease,
          );
          emitControllerLeftNotice(io, session, controller.controllerId);
          runtimeUsagePublisher.publish(
            createRoomRuntimeUsageEvent(session, {
              kind: "controller_left",
              payload: {
                controllerId: controller.controllerId,
                reason: "no_resume_lease",
              },
            }),
          );
          getDisconnectLogger({
            roomId: controller.roomId,
            controllerId: controller.controllerId,
          }).info(
            {
              event: AIRJAM_DEV_LOG_EVENTS.controller.disconnectApplied,
              reason,
              resumeLeaseMs,
              source: controllerSession.source,
            },
            "Controller disconnected and was removed immediately",
          );
        }
      }

      if (resumeLeaseMs > 0) {
        if (controllerSession && resumeLeaseExpiresAt !== null) {
          void realtimeAdmissionService.markControllerDisconnected(
            controllerSession.admissionLease,
            resumeLeaseMs,
          );
        }
        runtimeUsagePublisher.publish(
          createRoomRuntimeUsageEvent(session, {
            kind: "controller_disconnected",
            payload: {
              controllerId: controller.controllerId,
              reason,
              resumable: true,
              resumeLeaseMs,
            },
          }),
        );
        getDisconnectLogger({
          roomId: controller.roomId,
          controllerId: controller.controllerId,
        }).info(
          {
            event: AIRJAM_DEV_LOG_EVENTS.controller.disconnectPendingResume,
            reason,
            resumeLeaseMs,
            source: controllerSession?.source ?? "phone",
          },
          "Controller disconnected and entered resume lease window",
        );
      }
    }
    roomManager.deleteController(socket.id);
    delete socket.data.controllerAuthority;
  });
};
