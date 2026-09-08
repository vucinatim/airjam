import {
  normalizeUnknownOperationalFailure,
  resolveDeploymentEnvironment,
  type DeploymentEnvironment,
} from "@air-jam/operations-contract";
import {
  AIRJAM_DEV_LOG_EVENTS,
  verifyHostGrant,
  type HostGrantClaims,
} from "@air-jam/sdk/protocol";
import { and, eq, sql } from "drizzle-orm";
import {
  appIds,
  realtimeHostGrantConsumptions,
  type ServerDatabase,
} from "../db.js";
import { resolveServerRuntimeDatabaseUrl } from "../env/database-url-policy.js";
import { isLocalMasterKeyAllowed } from "../env/server-env.js";
import { createServerLogger, type ServerLogger } from "../logging/logger.js";
import {
  publishServerOperationalFailureSafely,
  type ServerOperationalEventPublisher,
} from "../operations/operational-event-publisher.js";

type AuthMode = "disabled" | "required";

/**
 * App identity verification result
 */
export interface VerificationResult {
  isVerified: boolean;
  error?: string;
  gameId?: string;
  creatorId?: string;
}

export interface VerifyAppIdContext {
  origin?: string;
}

export interface VerifyHostBootstrapInput {
  appId?: string;
  hostGrant?: string;
  origin?: string;
  hostSessionKind?: "game" | "system";
}

export interface HostBootstrapVerificationResult extends VerificationResult {
  appId?: string;
  verifiedVia?: "appId" | "hostGrant";
  verifiedOrigin?: string;
  grantClaims?: HostGrantClaims;
}

export interface HostBootstrapAuthService {
  verifyHostBootstrap: (
    input: VerifyHostBootstrapInput,
  ) => Promise<HostBootstrapVerificationResult>;
  getStartupConfigurationError?: () => string | null;
}

export interface AuthServiceEnvironment {
  authMode?: AuthMode;
  masterKey?: string;
  hostGrantSecret?: string;
  databaseUrl?: string;
  nodeEnv?: string;
  operationalEnvironment?: DeploymentEnvironment;
}

export interface AuthServiceOptions {
  logger?: ServerLogger;
  env?: AuthServiceEnvironment;
  db?: ServerDatabase | null;
  operationalEventPublisher?: ServerOperationalEventPublisher;
}

const normalizeOrigin = (value?: string): string | null => {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const resolveActiveAppIdRecord = async ({
  appId,
  db,
}: {
  appId?: string;
  db: ServerDatabase | null;
}) => {
  if (!appId || !db) {
    return null;
  }

  const [keyRecord] = await db
    .select({
      id: appIds.id,
      gameId: appIds.gameId,
      creatorId: appIds.creatorId,
      key: appIds.key,
      allowedOrigins: appIds.allowedOrigins,
      isActive: appIds.isActive,
      createdAt: appIds.createdAt,
      lastUsedAt: appIds.lastUsedAt,
    })
    .from(appIds)
    .where(and(eq(appIds.key, appId), eq(appIds.isActive, true)))
    .limit(1);

  return keyRecord ?? null;
};

/**
 * Authentication service
 * Handles app identity verification.
 * In local/dev mode, allows all connections by default.
 * In production, defaults to required auth (fail-closed).
 */
export class AuthService {
  private logger: ServerLogger;
  private masterKey: string | undefined;
  private hostGrantSecret: string | undefined;
  private databaseUrl: string | undefined;
  private authMode: AuthMode;
  private nodeEnv: string;
  private operationalEnvironment: DeploymentEnvironment;
  private db: ServerDatabase | null;
  private operationalEventPublisher: ServerOperationalEventPublisher | null;

  constructor(options: AuthServiceOptions = {}) {
    this.logger = options.logger ?? createServerLogger({ component: "auth" });
    this.masterKey = options.env?.masterKey ?? process.env.AIR_JAM_MASTER_KEY;
    this.hostGrantSecret =
      options.env?.hostGrantSecret ?? process.env.AIR_JAM_HOST_GRANT_SECRET;
    this.databaseUrl =
      options.env?.databaseUrl ??
      resolveServerRuntimeDatabaseUrl(process.env).databaseUrl;
    this.authMode = this.resolveAuthMode(options.env);
    this.nodeEnv =
      options.env?.nodeEnv ?? process.env.NODE_ENV ?? "development";
    this.operationalEnvironment =
      options.env?.operationalEnvironment ??
      resolveDeploymentEnvironment({
        ...process.env,
        ...(options.env?.nodeEnv ? { NODE_ENV: options.env.nodeEnv } : {}),
      });
    this.db = options.db ?? null;
    this.operationalEventPublisher = options.operationalEventPublisher ?? null;

    if (this.authMode === "disabled") {
      this.logger.info(
        { event: AIRJAM_DEV_LOG_EVENTS.auth.modeDisabled },
        "Authentication disabled (set AIR_JAM_AUTH_MODE=required to enforce app identity checks)",
      );
    } else if (
      this.canUseLocalMasterKey() &&
      !this.databaseUrl &&
      !this.hostGrantSecret
    ) {
      this.logger.info(
        { event: AIRJAM_DEV_LOG_EVENTS.auth.modeMasterKey },
        "Running with local-development master key authentication",
      );
    } else if (this.databaseUrl && this.hostGrantSecret) {
      this.logger.info(
        { event: AIRJAM_DEV_LOG_EVENTS.auth.modeDatabaseAndHostGrant },
        "Running with database authentication and signed host-grant verification",
      );
    } else if (this.databaseUrl) {
      this.logger.info(
        { event: AIRJAM_DEV_LOG_EVENTS.auth.modeDatabase },
        "Running with database authentication",
      );
    } else if (this.hostGrantSecret) {
      this.logger.warn(
        { event: AIRJAM_DEV_LOG_EVENTS.auth.backendMissing },
        "Signed host grants are configured without PostgreSQL consumption authority",
      );
    } else {
      this.logger.warn(
        { event: AIRJAM_DEV_LOG_EVENTS.auth.backendMissing },
        "Authentication required, but no auth backend is configured (set DATABASE_URL)",
      );
    }
  }

  getStartupConfigurationError(): string | null {
    if (this.authMode !== "required") {
      return null;
    }

    if (this.hostGrantSecret && !this.db && !this.canUseLocalMasterKey()) {
      return "Signed host grants require PostgreSQL consumption authority.";
    }

    if (this.db || this.canUseLocalMasterKey()) {
      return null;
    }

    return [
      "AIR_JAM_AUTH_MODE=required requires an auth backend.",
      "Configure DATABASE_URL for app ID bootstrap and signed host grants.",
    ].join(" ");
  }

  async verifyHostBootstrap({
    appId,
    hostGrant,
    origin,
    hostSessionKind,
  }: VerifyHostBootstrapInput): Promise<HostBootstrapVerificationResult> {
    const normalizedOrigin = normalizeOrigin(origin) ?? undefined;

    if (hostGrant) {
      if (!this.hostGrantSecret) {
        return {
          isVerified: false,
          error:
            "Unauthorized: Host grant verification is not configured on the server",
        };
      }

      const grantResult = await verifyHostGrant({
        secret: this.hostGrantSecret,
        token: hostGrant,
      });
      if (!grantResult.ok || !grantResult.claims) {
        return {
          isVerified: false,
          error: grantResult.error ?? "Unauthorized: Invalid Host Grant",
        };
      }
      const grantClaims = grantResult.claims;

      const requestedHostSessionKind = hostSessionKind ?? "system";
      const expectedIntent =
        requestedHostSessionKind === "system"
          ? "system_register"
          : "create_room";
      if (
        grantClaims.sessionKind !== requestedHostSessionKind ||
        grantClaims.intent !== expectedIntent
      ) {
        return {
          isVerified: false,
          error: "Unauthorized: Host grant session intent mismatch",
        };
      }

      const grantOrigins = grantClaims.origins
        .map((value) => normalizeOrigin(value))
        .filter((value): value is string => value !== null);

      if (grantOrigins.length > 0) {
        if (!normalizedOrigin) {
          return {
            isVerified: false,
            error: "Unauthorized: Missing or Invalid Origin",
          };
        }

        if (!grantOrigins.includes(normalizedOrigin)) {
          return {
            isVerified: false,
            error: "Unauthorized: Origin not allowed by Host Grant",
          };
        }
      }

      if (!this.db) {
        return {
          isVerified: false,
          error: "Unauthorized: Host grant consumption is unavailable",
        };
      }

      try {
        const consumption = await this.db.transaction(async (transaction) => {
          const [activeIdentity] = await transaction
            .select({
              gameId: appIds.gameId,
              creatorId: appIds.creatorId,
            })
            .from(appIds)
            .where(
              and(eq(appIds.key, grantClaims.appId), eq(appIds.isActive, true)),
            )
            .limit(1);
          if (
            !activeIdentity ||
            activeIdentity.gameId !== grantClaims.gameId ||
            activeIdentity.creatorId !== grantClaims.creatorId
          ) {
            return { status: "invalid_identity" as const };
          }

          await transaction.execute(sql`
            delete from ${realtimeHostGrantConsumptions}
            where ${realtimeHostGrantConsumptions.jti} in (
              select ${realtimeHostGrantConsumptions.jti}
              from ${realtimeHostGrantConsumptions}
              where ${realtimeHostGrantConsumptions.expiresAt} <= clock_timestamp()
              order by ${realtimeHostGrantConsumptions.expiresAt} asc
              limit 256
              for update skip locked
            )
          `);
          const inserted = await transaction
            .insert(realtimeHostGrantConsumptions)
            .values({
              jti: grantClaims.jti,
              appId: grantClaims.appId,
              abuseSessionId: grantClaims.abuseSessionId,
              sessionKind: grantClaims.sessionKind,
              intent: grantClaims.intent,
              expiresAt: new Date(grantClaims.exp * 1_000),
            })
            .onConflictDoNothing()
            .returning({ jti: realtimeHostGrantConsumptions.jti });
          return {
            status:
              inserted.length === 1
                ? ("consumed" as const)
                : ("already_consumed" as const),
          };
        });
        if (consumption.status === "invalid_identity") {
          return {
            isVerified: false,
            error: "Unauthorized: Host grant identity is not active",
          };
        }
        if (consumption.status === "already_consumed") {
          return {
            isVerified: false,
            error: "Unauthorized: Host grant was already consumed",
          };
        }
      } catch (error) {
        this.logger.error({ err: error }, "Host grant consumption failed");
        return {
          isVerified: false,
          error: "Unauthorized: Host grant consumption is unavailable",
        };
      }

      return {
        isVerified: true,
        appId: grantClaims.appId,
        gameId: grantClaims.gameId,
        creatorId: grantClaims.creatorId,
        verifiedVia: "hostGrant",
        verifiedOrigin: normalizedOrigin,
        grantClaims,
      };
    }

    const appIdResult = await this.verifyAppId(appId, { origin });
    return {
      ...appIdResult,
      appId: appIdResult.isVerified ? appId : undefined,
      gameId: appIdResult.gameId,
      creatorId: appIdResult.creatorId,
      verifiedVia: appIdResult.isVerified ? "appId" : undefined,
      verifiedOrigin: appIdResult.isVerified ? normalizedOrigin : undefined,
    };
  }

  /**
   * Verify a browser-supplied app ID.
   * Returns verification result with optional error message
   * In local/dev mode, always returns success
   */
  async verifyAppId(
    appId?: string,
    context?: VerifyAppIdContext,
  ): Promise<VerificationResult> {
    // Local/dev mode: no auth required
    if (this.authMode === "disabled") {
      return { isVerified: true };
    }

    if (!appId) {
      return {
        isVerified: false,
        error: "Unauthorized: Invalid or Missing App ID",
      };
    }

    // The shared key is an explicitly local-only development convenience. It
    // is never a hosted identity because it carries no game or creator scope.
    if (this.canUseLocalMasterKey() && appId === this.masterKey) {
      return { isVerified: true };
    }

    // Check database (only if database URL is configured)
    if (!this.databaseUrl || !this.db) {
      return {
        isVerified: false,
        error: "Unauthorized: Invalid or Missing App ID",
      };
    }

    try {
      const keyRecord = await resolveActiveAppIdRecord({
        appId,
        db: this.db,
      });

      if (keyRecord) {
        const allowedOrigins = keyRecord.allowedOrigins ?? [];
        if (allowedOrigins.length > 0) {
          const requestOrigin = normalizeOrigin(context?.origin);
          if (!requestOrigin) {
            return {
              isVerified: false,
              error: "Unauthorized: Missing or Invalid Origin",
            };
          }

          const normalizedAllowedOrigins = allowedOrigins
            .map((value) => normalizeOrigin(value))
            .filter((value): value is string => value !== null);

          if (!normalizedAllowedOrigins.includes(requestOrigin)) {
            return {
              isVerified: false,
              error: "Unauthorized: Origin not allowed for this App ID",
            };
          }
        }

        // Update last used timestamp (fire and forget)
        this.db
          .update(appIds)
          .set({ lastUsedAt: new Date() })
          .where(eq(appIds.id, keyRecord.id))
          .catch((err: unknown) => {
            this.logger.warn(
              {
                event: AIRJAM_DEV_LOG_EVENTS.auth.appIdLastUsedAtUpdateFailed,
                err,
              },
              "Failed to update app ID lastUsedAt",
            );
          });

        return {
          isVerified: true,
          gameId: keyRecord.gameId,
          creatorId: keyRecord.creatorId ?? undefined,
        };
      }

      return {
        isVerified: false,
        error: "Unauthorized: Invalid or Missing App ID",
      };
    } catch (error) {
      const failure = normalizeUnknownOperationalFailure({
        error,
        code: "auth.app_id_verification_failed",
        summary:
          "Realtime app identity verification could not query its authority.",
        retryable: true,
        details: { operation: "verify_app_id" },
      });
      this.logger.error(
        {
          event: AIRJAM_DEV_LOG_EVENTS.auth.appIdVerificationDatabaseError,
          failure,
        },
        "Database error during app ID verification",
      );
      if (this.operationalEventPublisher) {
        publishServerOperationalFailureSafely({
          publisher: this.operationalEventPublisher,
          logger: this.logger,
          input: {
            code: "auth.app_id_verification_failed",
            failureClass: "dependency",
            summary:
              "Realtime app identity verification could not query its authority.",
            retryable: true,
            component: "auth-service",
            subject: { type: "service", id: "realtime_server" },
            correlation: {
              contractVersion: 1,
              correlationId: `auth-verification:${crypto.randomUUID()}`,
            },
            details: { operation: "verify_app_id" },
          },
        });
      }
      return {
        isVerified: false,
        error: "Internal Server Error",
      };
    }
  }

  private resolveAuthMode(env?: AuthServiceEnvironment): AuthMode {
    const configuredMode =
      env?.authMode ?? process.env.AIR_JAM_AUTH_MODE?.toLowerCase();

    if (configuredMode === "disabled") {
      return "disabled";
    }

    if (configuredMode === "required") {
      return "required";
    }

    // Auto mode (default):
    // - Production defaults to required.
    // - Development defaults to disabled for friction-free local iteration.
    // - Use AIR_JAM_AUTH_MODE=required to enforce auth in development.
    if ((env?.nodeEnv ?? process.env.NODE_ENV) === "production") {
      return "required";
    }

    return "disabled";
  }

  private canUseLocalMasterKey(): boolean {
    return (
      Boolean(this.masterKey) &&
      isLocalMasterKeyAllowed({
        nodeEnv: this.nodeEnv,
        operationalEnvironment: this.operationalEnvironment,
      })
    );
  }
}
