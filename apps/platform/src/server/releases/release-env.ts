import { validateEnv } from "@air-jam/env";
import { z } from "zod";

const DEFAULT_UPLOAD_URL_TTL_SECONDS = 15 * 60;

const trimToUndefined = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const optionalEnvValue = z.preprocess(trimToUndefined, z.string().optional());

const requiredEnvValue = (envKey: string) =>
  z.preprocess(trimToUndefined, z.string().min(1, `${envKey} is required.`));

const positiveIntegerFromEnv = (envKey: string, fallback: number) =>
  optionalEnvValue.transform((value, context) => {
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

const releaseImageModerationModeFromEnv = optionalEnvValue.transform(
  (value, context) => {
    if (!value) {
      return "openai" as const;
    }

    if (value === "openai" || value === "disabled") {
      return value;
    }

    context.addIssue({
      code: "custom",
      message:
        "AIRJAM_RELEASES_IMAGE_MODERATION_MODE must be either 'openai' or 'disabled'.",
    });
    return z.NEVER;
  },
);

const releaseStorageEnvSchema = z
  .object({
    AIRJAM_RELEASES_R2_BUCKET: requiredEnvValue("AIRJAM_RELEASES_R2_BUCKET"),
    AIRJAM_RELEASES_R2_ENDPOINT: optionalEnvValue,
    AIRJAM_RELEASES_R2_ACCOUNT_ID: optionalEnvValue,
    AIRJAM_RELEASES_R2_ACCESS_KEY_ID: requiredEnvValue(
      "AIRJAM_RELEASES_R2_ACCESS_KEY_ID",
    ),
    AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY: requiredEnvValue(
      "AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY",
    ),
    AIRJAM_RELEASES_R2_SESSION_TOKEN: optionalEnvValue,
    AIRJAM_RELEASES_UPLOAD_URL_TTL_SECONDS: positiveIntegerFromEnv(
      "AIRJAM_RELEASES_UPLOAD_URL_TTL_SECONDS",
      DEFAULT_UPLOAD_URL_TTL_SECONDS,
    ),
  })
  .superRefine((value, context) => {
    if (
      !value.AIRJAM_RELEASES_R2_ENDPOINT &&
      !value.AIRJAM_RELEASES_R2_ACCOUNT_ID
    ) {
      context.addIssue({
        code: "custom",
        path: ["AIRJAM_RELEASES_R2_ENDPOINT"],
        message:
          "Configure AIRJAM_RELEASES_R2_ENDPOINT, or configure AIRJAM_RELEASES_R2_ACCOUNT_ID to build the endpoint automatically.",
      });
    }
  })
  .transform((value) => ({
    bucket: value.AIRJAM_RELEASES_R2_BUCKET,
    endpoint:
      value.AIRJAM_RELEASES_R2_ENDPOINT ??
      `https://${value.AIRJAM_RELEASES_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: value.AIRJAM_RELEASES_R2_ACCESS_KEY_ID,
    secretAccessKey: value.AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY,
    sessionToken: value.AIRJAM_RELEASES_R2_SESSION_TOKEN,
    uploadUrlTtlSeconds: value.AIRJAM_RELEASES_UPLOAD_URL_TTL_SECONDS,
  }));

const releaseModerationEnvSchema = z
  .object({
    AIRJAM_RELEASES_BROWSER_WS_ENDPOINT: optionalEnvValue,
    AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN: optionalEnvValue,
    AIRJAM_RELEASES_BROWSER_EXECUTABLE_PATH: optionalEnvValue,
    AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN: requiredEnvValue(
      "AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN",
    ),
    OPENAI_API_KEY: optionalEnvValue,
    AIRJAM_RELEASES_IMAGE_MODERATION_MODE: releaseImageModerationModeFromEnv,
    AIRJAM_RELEASES_BROWSER_NAVIGATION_TIMEOUT_MS: positiveIntegerFromEnv(
      "AIRJAM_RELEASES_BROWSER_NAVIGATION_TIMEOUT_MS",
      20_000,
    ),
    AIRJAM_RELEASES_BROWSER_WAIT_AFTER_LOAD_MS: positiveIntegerFromEnv(
      "AIRJAM_RELEASES_BROWSER_WAIT_AFTER_LOAD_MS",
      1_000,
    ),
    AIRJAM_RELEASES_BROWSER_VIEWPORT_WIDTH: positiveIntegerFromEnv(
      "AIRJAM_RELEASES_BROWSER_VIEWPORT_WIDTH",
      1440,
    ),
    AIRJAM_RELEASES_BROWSER_VIEWPORT_HEIGHT: positiveIntegerFromEnv(
      "AIRJAM_RELEASES_BROWSER_VIEWPORT_HEIGHT",
      900,
    ),
    AIRJAM_RELEASES_OPENAI_MODERATION_MODEL: optionalEnvValue,
    AIRJAM_RELEASES_OPENAI_BASE_URL: optionalEnvValue,
    AIRJAM_RELEASES_OPENAI_TIMEOUT_MS: positiveIntegerFromEnv(
      "AIRJAM_RELEASES_OPENAI_TIMEOUT_MS",
      20_000,
    ),
  })
  .superRefine((value, context) => {
    if (
      !value.AIRJAM_RELEASES_BROWSER_WS_ENDPOINT &&
      !value.AIRJAM_RELEASES_BROWSER_EXECUTABLE_PATH
    ) {
      context.addIssue({
        code: "custom",
        path: ["AIRJAM_RELEASES_BROWSER_WS_ENDPOINT"],
        message:
          "Configure AIRJAM_RELEASES_BROWSER_WS_ENDPOINT or AIRJAM_RELEASES_BROWSER_EXECUTABLE_PATH to enable screenshot moderation.",
      });
    }

    if (
      value.AIRJAM_RELEASES_BROWSER_WS_ENDPOINT &&
      !value.AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN
    ) {
      context.addIssue({
        code: "custom",
        path: ["AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN"],
        message:
          "AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN is required when AIRJAM_RELEASES_BROWSER_WS_ENDPOINT is configured.",
      });
    }

    if (
      value.AIRJAM_RELEASES_IMAGE_MODERATION_MODE === "openai" &&
      !value.OPENAI_API_KEY
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message:
          "OPENAI_API_KEY is required when AIRJAM_RELEASES_IMAGE_MODERATION_MODE=openai.",
      });
    }
  })
  .transform((value) => ({
    internalAccessSecret: value.AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN,
    browserLaunch: {
      wsEndpoint: value.AIRJAM_RELEASES_BROWSER_WS_ENDPOINT ?? null,
      accessToken: value.AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN ?? null,
      executablePath: value.AIRJAM_RELEASES_BROWSER_EXECUTABLE_PATH ?? null,
      navigationTimeoutMs: value.AIRJAM_RELEASES_BROWSER_NAVIGATION_TIMEOUT_MS,
      waitAfterLoadMs: value.AIRJAM_RELEASES_BROWSER_WAIT_AFTER_LOAD_MS,
      viewportWidth: value.AIRJAM_RELEASES_BROWSER_VIEWPORT_WIDTH,
      viewportHeight: value.AIRJAM_RELEASES_BROWSER_VIEWPORT_HEIGHT,
    },
    imageModeration:
      value.AIRJAM_RELEASES_IMAGE_MODERATION_MODE === "disabled"
        ? {
            mode: "disabled" as const,
            openAi: null,
          }
        : {
            mode: "openai" as const,
            openAi: {
              apiKey: value.OPENAI_API_KEY ?? "",
              model:
                value.AIRJAM_RELEASES_OPENAI_MODERATION_MODEL ||
                "omni-moderation-latest",
              baseUrl:
                value.AIRJAM_RELEASES_OPENAI_BASE_URL ||
                "https://api.openai.com/v1",
              timeoutMs: value.AIRJAM_RELEASES_OPENAI_TIMEOUT_MS,
            },
          },
  }));

const releaseModerationAvailabilityProbeSchema = z.object({
  AIRJAM_RELEASES_BROWSER_WS_ENDPOINT: optionalEnvValue,
  AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN: optionalEnvValue,
  AIRJAM_RELEASES_BROWSER_EXECUTABLE_PATH: optionalEnvValue,
  AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN: optionalEnvValue,
  AIRJAM_RELEASES_IMAGE_MODERATION_MODE: releaseImageModerationModeFromEnv,
  OPENAI_API_KEY: optionalEnvValue,
});

export type ReleaseStorageEnvConfig = z.output<typeof releaseStorageEnvSchema>;
export type ReleaseModerationEnvConfig = z.output<
  typeof releaseModerationEnvSchema
>;

export const loadReleaseStorageEnv = (
  env: Record<string, string | undefined> = process.env,
): ReleaseStorageEnvConfig =>
  validateEnv({
    boundary: "platform.release-storage",
    schema: releaseStorageEnvSchema,
    env,
    docsHint:
      "Set AIRJAM_RELEASES_R2_* variables in apps/platform/.env.local (or deployment env) and retry.",
    keyHints: {
      AIRJAM_RELEASES_R2_ENDPOINT:
        "Set AIRJAM_RELEASES_R2_ENDPOINT directly, or AIRJAM_RELEASES_R2_ACCOUNT_ID for automatic endpoint resolution.",
      AIRJAM_RELEASES_UPLOAD_URL_TTL_SECONDS:
        "Set a positive integer in seconds (for example: 900).",
    },
  });

export const loadReleaseModerationEnv = (
  env: Record<string, string | undefined> = process.env,
): ReleaseModerationEnvConfig =>
  validateEnv({
    boundary: "platform.release-moderation",
    schema: releaseModerationEnvSchema,
    env,
    docsHint:
      "Set AIRJAM_RELEASES_* moderation variables in apps/platform/.env.local (or deployment env), and add OPENAI_API_KEY when AIRJAM_RELEASES_IMAGE_MODERATION_MODE=openai.",
  });

export const loadReleaseModerationAvailabilityProbeEnv = (
  env: Record<string, string | undefined> = process.env,
) =>
  validateEnv({
    boundary: "platform.release-moderation",
    schema: releaseModerationAvailabilityProbeSchema,
    env,
  });
