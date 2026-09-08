import {
  AIRJAM_DEV_LOG_EVENTS,
  type ServerErrorPayload,
} from "@air-jam/sdk/protocol";
import type { RuntimeUsagePublisher } from "../analytics/runtime-usage.js";
import type { ServerLogger } from "../logging/logger.js";
import type { ServerOperationalEventPublisher } from "../operations/operational-event-publisher.js";
import {
  createRateLimitGuard,
  createScopedRateLimitGuard,
  resolveSocketIdentifier,
  type ProxyHeaderTrustMode,
} from "../policies/rate-limit-policy.js";
import { createSocketAuthorization } from "../policies/socket-authorization.js";
import type { HostBootstrapAuthService } from "../services/auth-service.js";
import type { RateLimitService } from "../services/rate-limit-service.js";
import type { RealtimeAdmissionService } from "../services/realtime-admission-service.js";
import type { RoomManager } from "../services/room-manager.js";
import { registerControllerHandlers } from "./handlers/register-controller-handlers.js";
import { registerDisconnectHandler } from "./handlers/register-disconnect-handler.js";
import { registerHostLifecycleHandlers } from "./handlers/register-host-lifecycle-handlers.js";
import { registerRealtimeHandlers } from "./handlers/register-realtime-handlers.js";
import type { SocketHandlerContext } from "./socket-handler-context.js";
import type { AirJamIoServer, AirJamSocket } from "./socket-types.js";

export interface RegisterSocketHandlersOptions {
  io: AirJamIoServer;
  socket: AirJamSocket;
  logger: ServerLogger;
  roomManager: RoomManager;
  realtimeAdmissionService: RealtimeAdmissionService;
  rateLimitService: RateLimitService;
  authService: HostBootstrapAuthService;
  runtimeUsagePublisher: RuntimeUsagePublisher;
  operationalEventPublisher: ServerOperationalEventPublisher;
  rateLimitWindowMs: number;
  hostRegistrationRateLimitMax: number;
  controllerJoinRateLimitMax: number;
  staticAppRateLimitMax: number;
  runtimeErrorReportRateLimitMax: number;
  proxyHeaderTrustMode: ProxyHeaderTrustMode;
  maintenanceMode: boolean;
}

export const registerSocketHandlers = ({
  io,
  socket,
  logger,
  roomManager,
  realtimeAdmissionService,
  rateLimitService,
  authService,
  runtimeUsagePublisher,
  operationalEventPublisher,
  rateLimitWindowMs,
  hostRegistrationRateLimitMax,
  controllerJoinRateLimitMax,
  staticAppRateLimitMax,
  runtimeErrorReportRateLimitMax,
  proxyHeaderTrustMode,
  maintenanceMode,
}: RegisterSocketHandlersOptions): void => {
  const {
    isHostAuthorizedForRoom,
    isControllerAuthorizedForRoom,
    hasControllerPrivilegeForRoom,
  } = createSocketAuthorization(socket.id, roomManager);

  const socketIdentifier = resolveSocketIdentifier(
    socket.handshake.headers["x-forwarded-for"],
    socket.handshake.address,
    socket.id,
    proxyHeaderTrustMode,
  );
  const isRateLimited = createRateLimitGuard(
    rateLimitService,
    socketIdentifier,
    rateLimitWindowMs,
  );
  const isScopedRateLimited = createScopedRateLimitGuard(
    rateLimitService,
    rateLimitWindowMs,
  );
  const socketLogger = logger.child({
    scope: "socket",
    socketId: socket.id,
    socketIdentifier,
    origin:
      typeof socket.handshake.headers.origin === "string"
        ? socket.handshake.headers.origin
        : undefined,
  });

  const emitError = (socketId: string, payload: ServerErrorPayload): void => {
    io.to(socketId).emit("server:error", payload);
  };

  const context: SocketHandlerContext = {
    io,
    socket,
    logger: socketLogger,
    roomManager,
    realtimeAdmissionService,
    authService,
    runtimeUsagePublisher,
    operationalEventPublisher,
    hostRegistrationRateLimitMax,
    controllerJoinRateLimitMax,
    staticAppRateLimitMax,
    runtimeErrorReportRateLimitMax,
    emitError,
    isRateLimited,
    isScopedRateLimited,
    maintenanceMode,
    isHostAuthorizedForRoom,
    isControllerAuthorizedForRoom,
    hasControllerPrivilegeForRoom,
  };

  socketLogger.debug(
    { event: AIRJAM_DEV_LOG_EVENTS.socket.connected },
    "Socket connected",
  );

  registerHostLifecycleHandlers(context);
  registerControllerHandlers(context);
  registerRealtimeHandlers(context);
  registerDisconnectHandler(context);
};
