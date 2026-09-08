import { validateEnv } from "@air-jam/env";
import {
  deploymentEnvironments,
  resolveDeploymentEnvironment,
} from "@air-jam/operations-contract";
import { z } from "zod";
import {
  REMOTE_DATABASE_BLOCKED_MESSAGE,
  resolveServerRuntimeDatabaseUrl,
} from "./database-url-policy.js";

export type AuthMode = "disabled" | "required";
export type ProxyHeaderTrustMode = "auto" | "enabled" | "disabled";

export interface ServerEnvConfig {
  nodeEnv: string;
  operationalEnvironment: "production" | "preview" | "development" | "test";
  port: number;
  rateLimitWindowMs: number;
  hostRegistrationRateLimitMax: number;
  controllerJoinRateLimitMax: number;
  staticAppRateLimitMax: number;
  runtimeErrorReportRateLimitMax: number;
  allowedOrigins: string[] | "*";
  devLogCollectorEnabled: boolean;
  devLogDir?: string;
  authMode: AuthMode;
  proxyHeaderTrustMode: ProxyHeaderTrustMode;
  remoteDatabaseBlocked: boolean;
  maintenanceMode: boolean;
  masterKey?: string;
  hostGrantSecret?: string;
  databaseUrl?: string;
  logLevel?: string;
}

const trimToUndefined = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const optionalEnvString = z
  .string()
  .optional()
  .transform((value) => trimToUndefined(value));

const createOptionalEnumSchema = <
  TValues extends readonly [string, ...string[]],
>(
  envKey: string,
  values: TValues,
) =>
  optionalEnvString.transform((value, context) => {
    if (!value) {
      return undefined;
    }

    if (!values.includes(value)) {
      context.addIssue({
        code: "custom",
        message: `${envKey} must be one of: ${values.join(", ")}.`,
      });
      return z.NEVER;
    }

    return value as TValues[number];
  });

const createPositiveIntegerSchema = (envKey: string, fallback: number) =>
  optionalEnvString.transform((value, context) => {
    if (!value) {
      return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      context.addIssue({
        code: "custom",
        message: `${envKey} must be a positive integer.`,
      });
      return z.NEVER;
    }

    return parsed;
  });

const normalizeAllowedOrigins = (
  rawAllowedOrigins: string | undefined,
): string[] | "*" => {
  if (!rawAllowedOrigins) {
    return "*";
  }

  const parsed = rawAllowedOrigins
    .split(",")
    .map((origin) => origin.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);

  if (parsed.length === 0 || parsed.includes("*")) {
    return "*";
  }

  return parsed;
};

const resolveAuthMode = ({
  configuredAuthMode,
  nodeEnv,
}: {
  configuredAuthMode?: AuthMode;
  nodeEnv: string;
}): AuthMode => {
  if (configuredAuthMode) {
    return configuredAuthMode;
  }

  return nodeEnv === "production" ? "required" : "disabled";
};

export const isLocalMasterKeyAllowed = ({
  nodeEnv,
  operationalEnvironment,
}: {
  nodeEnv: string;
  operationalEnvironment: ServerEnvConfig["operationalEnvironment"];
}): boolean =>
  nodeEnv !== "production" &&
  (operationalEnvironment === "development" ||
    operationalEnvironment === "test");

const rawServerEnvSchema = z
  .object({
    NODE_ENV: optionalEnvString,
    AIRJAM_OPERATIONAL_ENVIRONMENT: createOptionalEnumSchema(
      "AIRJAM_OPERATIONAL_ENVIRONMENT",
      deploymentEnvironments,
    ),
    PORT: createPositiveIntegerSchema("PORT", 4000),
    AIR_JAM_RATE_LIMIT_WINDOW_MS: createPositiveIntegerSchema(
      "AIR_JAM_RATE_LIMIT_WINDOW_MS",
      60_000,
    ),
    AIR_JAM_HOST_REGISTRATION_RATE_LIMIT_MAX: createPositiveIntegerSchema(
      "AIR_JAM_HOST_REGISTRATION_RATE_LIMIT_MAX",
      30,
    ),
    AIR_JAM_CONTROLLER_JOIN_RATE_LIMIT_MAX: createPositiveIntegerSchema(
      "AIR_JAM_CONTROLLER_JOIN_RATE_LIMIT_MAX",
      120,
    ),
    AIR_JAM_STATIC_APP_RATE_LIMIT_MAX: createPositiveIntegerSchema(
      "AIR_JAM_STATIC_APP_RATE_LIMIT_MAX",
      120,
    ),
    AIR_JAM_RUNTIME_ERROR_REPORT_RATE_LIMIT_MAX: createPositiveIntegerSchema(
      "AIR_JAM_RUNTIME_ERROR_REPORT_RATE_LIMIT_MAX",
      30,
    ),
    AIR_JAM_ALLOWED_ORIGINS: optionalEnvString,
    AIR_JAM_DEV_LOG_COLLECTOR: createOptionalEnumSchema(
      "AIR_JAM_DEV_LOG_COLLECTOR",
      ["enabled", "disabled"],
    ),
    AIR_JAM_DEV_LOG_DIR: optionalEnvString,
    AIR_JAM_AUTH_MODE: createOptionalEnumSchema("AIR_JAM_AUTH_MODE", [
      "disabled",
      "required",
    ]),
    AIR_JAM_TRUST_PROXY_HEADERS: createOptionalEnumSchema(
      "AIR_JAM_TRUST_PROXY_HEADERS",
      ["auto", "enabled", "disabled"],
    ),
    AIR_JAM_ALLOW_REMOTE_DATABASE: createOptionalEnumSchema(
      "AIR_JAM_ALLOW_REMOTE_DATABASE",
      ["enabled", "disabled"],
    ),
    AIR_JAM_MASTER_KEY: optionalEnvString,
    AIR_JAM_HOST_GRANT_SECRET: optionalEnvString,
    DATABASE_URL: optionalEnvString,
    AIR_JAM_LOG_LEVEL: optionalEnvString,
    AIR_JAM_MAINTENANCE_MODE: createOptionalEnumSchema(
      "AIR_JAM_MAINTENANCE_MODE",
      ["enabled", "disabled"],
    ),
  })
  .superRefine((value, context) => {
    const nodeEnv = value.NODE_ENV ?? "development";
    const authMode = resolveAuthMode({
      configuredAuthMode: value.AIR_JAM_AUTH_MODE as AuthMode | undefined,
      nodeEnv,
    });
    const operationalEnvironment = resolveDeploymentEnvironment({
      NODE_ENV: value.NODE_ENV,
      AIRJAM_OPERATIONAL_ENVIRONMENT: value.AIRJAM_OPERATIONAL_ENVIRONMENT,
    });
    const localMasterKeyEnabled = isLocalMasterKeyAllowed({
      nodeEnv,
      operationalEnvironment,
    });
    const databasePolicy = resolveServerRuntimeDatabaseUrl({
      NODE_ENV: nodeEnv,
      DATABASE_URL: value.DATABASE_URL,
      AIR_JAM_ALLOW_REMOTE_DATABASE: value.AIR_JAM_ALLOW_REMOTE_DATABASE,
    });

    if (
      authMode === "required" &&
      !(localMasterKeyEnabled && value.AIR_JAM_MASTER_KEY) &&
      !databasePolicy.databaseUrl &&
      !value.AIR_JAM_HOST_GRANT_SECRET
    ) {
      context.addIssue({
        code: "custom",
        path: databasePolicy.remoteDatabaseBlocked
          ? ["DATABASE_URL"]
          : ["AIR_JAM_AUTH_MODE"],
        message: databasePolicy.remoteDatabaseBlocked
          ? [
              REMOTE_DATABASE_BLOCKED_MESSAGE,
              "Required auth cannot rely on that blocked database URL without AIR_JAM_ALLOW_REMOTE_DATABASE=enabled.",
            ].join(" ")
          : "AIR_JAM_AUTH_MODE=required requires DATABASE_URL or AIR_JAM_HOST_GRANT_SECRET. AIR_JAM_MASTER_KEY is local-development only.",
      });
    }
  });

export const loadServerEnv = (
  env: Record<string, string | undefined> = process.env,
): ServerEnvConfig => {
  const parsed = validateEnv({
    boundary: "air-jam-server",
    schema: rawServerEnvSchema,
    env,
    docsHint:
      "Set AIR_JAM_* values in .env.local (repo root) or packages/server/.env and retry.",
    keyHints: {
      AIR_JAM_AUTH_MODE:
        "Choose disabled/required. Hosted required auth needs DATABASE_URL or AIR_JAM_HOST_GRANT_SECRET; AIR_JAM_MASTER_KEY is local-development only.",
      AIR_JAM_ALLOW_REMOTE_DATABASE:
        "Choose enabled only when local or test server workflows intentionally need a non-local DATABASE_URL.",
      AIR_JAM_TRUST_PROXY_HEADERS:
        "Choose auto/enabled/disabled. Use auto to trust proxy headers only when the socket peer looks like a local/private proxy hop.",
      AIR_JAM_ALLOWED_ORIGINS:
        "Use comma-separated exact origins, a leading subdomain wildcard such as 'https://*.vercel.app', or '*' to allow all origins.",
      PORT: "Set a positive integer port (for example: PORT=4000).",
    },
  });

  const nodeEnv = parsed.NODE_ENV ?? "development";

  // Railway PR previews clone every service (including this server)
  // from production, which means production's AIR_JAM_ALLOWED_ORIGINS
  // (e.g. https://airjam.io) gets inherited and silently blocks the
  // sibling preview platform's origin. Mirror the platform's preview
  // detection convention in resolvePlatformDeploymentConfig and open
  // CORS to "*" on previews so socket.io can connect. Production stays
  // strict.
  const railwayEnvironmentName = env.RAILWAY_ENVIRONMENT_NAME?.trim();
  const isRailwayPreviewEnvironment =
    Boolean(railwayEnvironmentName) && railwayEnvironmentName !== "production";
  const operationalEnvironment = resolveDeploymentEnvironment(env);
  const localMasterKeyAllowed = isLocalMasterKeyAllowed({
    nodeEnv,
    operationalEnvironment,
  });

  const authMode = resolveAuthMode({
    configuredAuthMode: parsed.AIR_JAM_AUTH_MODE as AuthMode | undefined,
    nodeEnv,
  });
  const databasePolicy = resolveServerRuntimeDatabaseUrl({
    NODE_ENV: nodeEnv,
    DATABASE_URL: parsed.DATABASE_URL,
    AIR_JAM_ALLOW_REMOTE_DATABASE: parsed.AIR_JAM_ALLOW_REMOTE_DATABASE,
  });

  return {
    nodeEnv,
    operationalEnvironment,
    port: parsed.PORT,
    rateLimitWindowMs: parsed.AIR_JAM_RATE_LIMIT_WINDOW_MS,
    hostRegistrationRateLimitMax:
      parsed.AIR_JAM_HOST_REGISTRATION_RATE_LIMIT_MAX,
    controllerJoinRateLimitMax: parsed.AIR_JAM_CONTROLLER_JOIN_RATE_LIMIT_MAX,
    staticAppRateLimitMax: parsed.AIR_JAM_STATIC_APP_RATE_LIMIT_MAX,
    runtimeErrorReportRateLimitMax:
      parsed.AIR_JAM_RUNTIME_ERROR_REPORT_RATE_LIMIT_MAX,
    allowedOrigins: isRailwayPreviewEnvironment
      ? "*"
      : normalizeAllowedOrigins(parsed.AIR_JAM_ALLOWED_ORIGINS),
    devLogCollectorEnabled: parsed.AIR_JAM_DEV_LOG_COLLECTOR
      ? parsed.AIR_JAM_DEV_LOG_COLLECTOR === "enabled"
      : nodeEnv !== "production",
    devLogDir: parsed.AIR_JAM_DEV_LOG_DIR,
    authMode,
    proxyHeaderTrustMode:
      (parsed.AIR_JAM_TRUST_PROXY_HEADERS as
        | ProxyHeaderTrustMode
        | undefined) ?? "auto",
    remoteDatabaseBlocked: databasePolicy.remoteDatabaseBlocked,
    masterKey: localMasterKeyAllowed ? parsed.AIR_JAM_MASTER_KEY : undefined,
    hostGrantSecret: parsed.AIR_JAM_HOST_GRANT_SECRET,
    databaseUrl: databasePolicy.databaseUrl,
    logLevel: parsed.AIR_JAM_LOG_LEVEL,
    maintenanceMode: parsed.AIR_JAM_MAINTENANCE_MODE === "enabled",
  };
};
