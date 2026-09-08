import { REALTIME_ADMISSION_POLICY } from "@air-jam/database-contract";
import {
  AIRJAM_DEV_LOG_EVENTS,
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
  type SocketData,
} from "@air-jam/sdk/protocol";
import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { createDatabaseRuntimeUsageLedgerPublisher } from "./analytics/runtime-usage-ledger.js";
import { type RuntimeUsagePublisher } from "./analytics/runtime-usage.js";
import { createOwnedServerDatabase, type ServerDatabase } from "./db.js";
import { REMOTE_DATABASE_BLOCKED_MESSAGE } from "./env/database-url-policy.js";
import { loadServerEnv, type ServerEnvConfig } from "./env/server-env.js";
import { registerSocketHandlers } from "./gateway/register-socket-handlers.js";
import {
  DevLogCollector,
  type BrowserLogBatchPayload,
  type BrowserLogUnloadPayload,
} from "./logging/dev-log-collector.js";
import { resolveDefaultDevLogDir } from "./logging/log-paths.js";
import { createServerLogger, type ServerLogger } from "./logging/logger.js";
import {
  createDatabaseServerOperationalEventPublisher,
  publishServerOperationalFailureSafely,
  type ServerOperationalEventPublisher,
} from "./operations/operational-event-publisher.js";
import { resolveCorsOrigin, type AllowedOrigins } from "./origin-policy.js";
import {
  AuthService,
  type HostBootstrapAuthService,
} from "./services/auth-service.js";
import { RateLimitService } from "./services/rate-limit-service.js";
import {
  createLocalRealtimeAdmissionService,
  createUnavailableRealtimeAdmissionService,
  DatabaseRealtimeAdmissionService,
  type RealtimeAdmissionService,
  type RealtimeAdmissionTerminalFailure,
} from "./services/realtime-admission-service.js";
import { RoomManager } from "./services/room-manager.js";

export type AirJamIoServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export interface CreateAirJamServerOptions {
  port?: number;
  rateLimitWindowMs?: number;
  hostRegistrationRateLimitMax?: number;
  controllerJoinRateLimitMax?: number;
  staticAppRateLimitMax?: number;
  runtimeErrorReportRateLimitMax?: number;
  allowedOrigins?: AllowedOrigins;
  logger?: ServerLogger;
  authService?: HostBootstrapAuthService;
  runtimeUsagePublisher?: RuntimeUsagePublisher;
  operationalEventPublisher?: ServerOperationalEventPublisher;
  rateLimitService?: RateLimitService;
  roomManager?: RoomManager;
  db?: ServerDatabase | null;
  realtimeAdmissionService?: RealtimeAdmissionService;
  proxyHeaderTrustMode?: ServerEnvConfig["proxyHeaderTrustMode"];
  devLogCollector?: DevLogCollector | false;
  devLogDir?: string;
  envConfig?: ServerEnvConfig;
}

export interface AirJamServerRuntime {
  app: express.Express;
  httpServer: ReturnType<typeof createServer>;
  io: AirJamIoServer;
  start: (portOverride?: number) => Promise<number>;
  drain: (timeoutMs?: number) => Promise<{
    completed: boolean;
    remainingRooms: number;
    waitedMs: number;
  }>;
  stop: () => Promise<void>;
  flushDevLogs: () => Promise<void>;
  getPort: () => number | null;
  onTerminalFailure: (
    listener: (failure: RealtimeAdmissionTerminalFailure) => void,
  ) => () => void;
}

let hasWarnedAboutBlockedRemoteDatabase = false;

export const createAirJamServer = (
  options: CreateAirJamServerOptions = {},
): AirJamServerRuntime => {
  const envConfig = options.envConfig ?? loadServerEnv();
  let activePort: number | null = null;
  let admissionStarted = false;
  let stopPromise: Promise<void> | null = null;
  let terminalFailure: RealtimeAdmissionTerminalFailure | null = null;
  const terminalFailureListeners = new Set<
    (failure: RealtimeAdmissionTerminalFailure) => void
  >();

  const devLogCollector =
    options.devLogCollector === false
      ? null
      : (options.devLogCollector ??
        new DevLogCollector({
          enabled: envConfig.devLogCollectorEnabled,
          logDir:
            options.devLogDir ??
            envConfig.devLogDir ??
            resolveDefaultDevLogDir(),
        }));
  const logger =
    options.logger ??
    createServerLogger(
      { service: "air-jam-server" },
      undefined,
      devLogCollector,
      { level: envConfig.logLevel },
    );
  if (envConfig.remoteDatabaseBlocked && !hasWarnedAboutBlockedRemoteDatabase) {
    hasWarnedAboutBlockedRemoteDatabase = true;
    logger.warn(
      { component: "env", nodeEnv: envConfig.nodeEnv },
      REMOTE_DATABASE_BLOCKED_MESSAGE,
    );
  }
  const roomManagerInstance = options.roomManager ?? new RoomManager();
  const rateLimitServiceInstance =
    options.rateLimitService ?? new RateLimitService();
  const ownedDatabase =
    options.db === undefined
      ? createOwnedServerDatabase(envConfig.databaseUrl)
      : null;
  const db =
    options.db === undefined ? (ownedDatabase?.database ?? null) : options.db;
  const realtimeAdmissionService =
    options.realtimeAdmissionService ??
    (db
      ? new DatabaseRealtimeAdmissionService({
          database: db,
          logger: logger.child({ component: "realtime-admission" }),
          instanceId: [
            process.env.RAILWAY_REPLICA_ID?.trim() || "realtime",
            crypto.randomUUID(),
          ].join(":"),
        })
      : envConfig.operationalEnvironment === "production" ||
          envConfig.operationalEnvironment === "preview"
        ? createUnavailableRealtimeAdmissionService({
            reason:
              "DATABASE_URL is required for hosted realtime admission authority.",
          })
        : createLocalRealtimeAdmissionService());
  const operationalEventPublisher =
    options.operationalEventPublisher ??
    createDatabaseServerOperationalEventPublisher({
      database: db,
      environment: envConfig.operationalEnvironment,
      instanceId: process.env.RAILWAY_REPLICA_ID?.trim() || undefined,
    });
  const authServiceInstance =
    options.authService ??
    new AuthService({
      logger: logger.child({ component: "auth" }),
      env: {
        authMode: envConfig.authMode,
        masterKey: envConfig.masterKey,
        hostGrantSecret: envConfig.hostGrantSecret,
        databaseUrl: envConfig.databaseUrl,
        nodeEnv: envConfig.nodeEnv,
      },
      db,
      operationalEventPublisher,
    });
  const runtimeUsagePublisher =
    options.runtimeUsagePublisher ??
    createDatabaseRuntimeUsageLedgerPublisher(
      logger.child({ component: "analytics" }),
      db,
      operationalEventPublisher,
    );
  const startupConfigurationError =
    typeof authServiceInstance.getStartupConfigurationError === "function"
      ? authServiceInstance.getStartupConfigurationError()
      : null;
  if (startupConfigurationError) {
    void ownedDatabase?.close().catch((error) => {
      logger.error(
        { err: error },
        "Could not close PostgreSQL after startup validation failed",
      );
    });
    throw new Error(startupConfigurationError);
  }

  const defaultPort = envConfig.port;
  const rateLimitWindowMs =
    options.rateLimitWindowMs ?? envConfig.rateLimitWindowMs;
  const hostRegistrationRateLimitMax =
    options.hostRegistrationRateLimitMax ??
    envConfig.hostRegistrationRateLimitMax;
  const controllerJoinRateLimitMax =
    options.controllerJoinRateLimitMax ?? envConfig.controllerJoinRateLimitMax;
  const staticAppRateLimitMax =
    options.staticAppRateLimitMax ?? envConfig.staticAppRateLimitMax;
  const runtimeErrorReportRateLimitMax =
    options.runtimeErrorReportRateLimitMax ??
    envConfig.runtimeErrorReportRateLimitMax;
  const corsOrigin = resolveCorsOrigin(
    options.allowedOrigins,
    envConfig.allowedOrigins,
  );

  const app = express();
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: "512kb" }));

  app.get("/health", (_, res) => {
    const rooms = roomManagerInstance.getAllRooms();
    let controllerCount = 0;
    for (const session of rooms.values()) {
      controllerCount += session.controllers.size;
    }
    const realtimeAdmission = realtimeAdmissionService.getStatus();
    res.json({
      ok: true,
      uptime: Math.floor(process.uptime()),
      rooms: rooms.size,
      controllers: controllerCount,
      maintenance: envConfig.maintenanceMode,
      realtimeAdmission,
    });
  });

  app.get("/ready", (_, res) => {
    const realtimeAdmission = realtimeAdmissionService.getStatus();
    const ok = !envConfig.maintenanceMode && realtimeAdmission.acceptingNewWork;
    res.status(ok ? 200 : 503).json({
      ok,
      maintenance: envConfig.maintenanceMode,
      realtimeAdmission,
    });
  });

  app.post("/__airjam/dev/browser-logs", async (req, res) => {
    if (!devLogCollector?.enabled) {
      res.status(404).json({ ok: false });
      return;
    }

    const payload = req.body as BrowserLogBatchPayload | undefined;
    if (
      !payload ||
      (payload.mode !== "reset" && payload.mode !== "append") ||
      typeof payload.sessionId !== "string" ||
      !payload.sessionId ||
      !Array.isArray(payload.entries) ||
      payload.entries.length === 0 ||
      typeof payload.metadata !== "object" ||
      payload.metadata === null
    ) {
      res
        .status(400)
        .json({ ok: false, message: "Invalid browser log payload" });
      return;
    }

    devLogCollector.enqueueBrowserBatch(payload);
    res.json({ ok: true });
  });

  app.post(
    "/__airjam/dev/browser-unload",
    express.text({ type: "*/*" }),
    async (req, res) => {
      if (!devLogCollector?.enabled) {
        res.status(404).json({ ok: false });
        return;
      }

      if (typeof req.body !== "string" || req.body.trim().length === 0) {
        res
          .status(400)
          .json({ ok: false, message: "Invalid browser unload payload" });
        return;
      }

      let payload: BrowserLogUnloadPayload | null = null;
      try {
        payload = JSON.parse(req.body) as BrowserLogUnloadPayload;
      } catch {
        res
          .status(400)
          .json({ ok: false, message: "Invalid browser unload payload" });
        return;
      }

      if (
        !payload ||
        typeof payload.sessionId !== "string" ||
        !payload.sessionId ||
        typeof payload.metadata !== "object" ||
        payload.metadata === null ||
        typeof payload.entry !== "object" ||
        payload.entry === null
      ) {
        res
          .status(400)
          .json({ ok: false, message: "Invalid browser unload payload" });
        return;
      }

      devLogCollector.enqueueBrowserUnload(payload);
      res.status(204).end();
    },
  );

  const httpServer = createServer(app);

  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    cors: { origin: corsOrigin },
    // Arcade tab: system host + game iframe share one event loop. Heavy WebGL /
    // match start can stall the JS thread for several seconds; the default
    // ~5s ping window drops the master host and tears down the room.
    pingInterval: 10_000,
    pingTimeout: 45_000,
  });

  io.on("connection", (socket) => {
    registerSocketHandlers({
      io,
      socket,
      logger,
      roomManager: roomManagerInstance,
      realtimeAdmissionService,
      rateLimitService: rateLimitServiceInstance,
      authService: authServiceInstance,
      runtimeUsagePublisher,
      operationalEventPublisher,
      rateLimitWindowMs,
      hostRegistrationRateLimitMax,
      controllerJoinRateLimitMax,
      staticAppRateLimitMax,
      runtimeErrorReportRateLimitMax,
      proxyHeaderTrustMode:
        options.proxyHeaderTrustMode ?? envConfig.proxyHeaderTrustMode,
      maintenanceMode: envConfig.maintenanceMode,
    });
  });

  const start = async (portOverride?: number): Promise<number> => {
    if (httpServer.listening) {
      return activePort ?? defaultPort;
    }

    const resolvedPort = portOverride ?? options.port ?? defaultPort;
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(resolvedPort, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });

    await realtimeAdmissionService.start();
    admissionStarted = true;

    const address = httpServer.address();
    activePort =
      typeof address === "object" && address?.port
        ? address.port
        : resolvedPort;

    logger.info(
      {
        event: AIRJAM_DEV_LOG_EVENTS.server.started,
        port: activePort,
        corsOrigin,
      },
      `Server listening on http://localhost:${activePort}`,
    );
    return activePort;
  };

  const drain = async (
    timeoutMs: number = REALTIME_ADMISSION_POLICY.shutdownDrainTimeoutMs,
  ): Promise<{
    completed: boolean;
    remainingRooms: number;
    waitedMs: number;
  }> => {
    const startedAt = Date.now();
    await realtimeAdmissionService.beginDrain();

    while (roomManagerInstance.getAllRooms().size > 0) {
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(100, remainingMs));
        timer.unref?.();
      });
    }

    const remainingRooms = roomManagerInstance.getAllRooms().size;
    return {
      completed: remainingRooms === 0,
      remainingRooms,
      waitedMs: Date.now() - startedAt,
    };
  };

  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      const cleanupErrors: unknown[] = [];
      const attempt = async (cleanup: () => void | Promise<void>) => {
        try {
          await cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };

      if (admissionStarted) {
        await attempt(() => realtimeAdmissionService.beginDrain());
      }
      await attempt(() =>
        roomManagerInstance.clearAllRooms(io, "Server shutting down"),
      );

      if (httpServer.listening) {
        await attempt(
          () =>
            new Promise<void>((resolve) => {
              io.close(() => resolve());
            }),
        );
      }

      activePort = null;
      if (admissionStarted) {
        await attempt(() => realtimeAdmissionService.stop());
        admissionStarted = false;
      }
      await attempt(async () => devLogCollector?.flush());
      unsubscribeAdmissionFailure();
      await attempt(async () => ownedDatabase?.close());

      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "Realtime server cleanup failed",
        );
      }
    })();
    return stopPromise;
  };

  const flushDevLogs = async (): Promise<void> => {
    await devLogCollector?.flush();
  };

  const getPort = (): number | null => activePort;

  const onTerminalFailure = (
    listener: (failure: RealtimeAdmissionTerminalFailure) => void,
  ): (() => void) => {
    terminalFailureListeners.add(listener);
    if (terminalFailure) {
      queueMicrotask(() => {
        if (terminalFailure && terminalFailureListeners.has(listener)) {
          listener(terminalFailure);
        }
      });
    }
    return () => terminalFailureListeners.delete(listener);
  };

  const unsubscribeAdmissionFailure =
    realtimeAdmissionService.onTerminalAuthorityLoss((failure) => {
      if (terminalFailure) return;
      terminalFailure = failure;
      publishServerOperationalFailureSafely({
        publisher: operationalEventPublisher,
        logger,
        input: {
          code: "realtime_admission.instance_lease_lost",
          failureClass: "dependency",
          summary:
            "The realtime server lost its database-backed admission authority.",
          retryable: false,
          component: "realtime-admission",
          subject: { type: "service", id: "realtime_server" },
          correlation: {
            contractVersion: 1,
            correlationId: `realtime-admission:${crypto.randomUUID()}`,
          },
          details: {
            authorityFailureCode: failure.code,
            action: "drain_and_stop_instance",
          },
        },
      });
      for (const listener of terminalFailureListeners) listener(failure);
    });

  return {
    app,
    httpServer,
    io,
    start,
    drain,
    stop,
    flushDevLogs,
    getPort,
    onTerminalFailure,
  };
};
