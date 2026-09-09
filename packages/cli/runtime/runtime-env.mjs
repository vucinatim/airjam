import { validateEnv } from "@air-jam/env";
import { z } from "zod";
import { DEFAULT_AIR_JAM_SERVER_PORT } from "./local-network.mjs";

const trimToUndefined = (value) => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const optionalEnvValue = z
  .string()
  .optional()
  .transform((value) => trimToUndefined(value));

const optionalEnumFromEnv = (envKey, values) =>
  optionalEnvValue.transform((value, context) => {
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

    return value;
  });

const positiveIntegerFromEnv = (envKey, fallback) =>
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

const createAirJamRuntimeEnvSchema = z.object({
  VITE_PORT: positiveIntegerFromEnv("VITE_PORT", 5173),
  AIR_JAM_SERVER_PORT: positiveIntegerFromEnv(
    "AIR_JAM_SERVER_PORT",
    DEFAULT_AIR_JAM_SERVER_PORT,
  ),
  AIR_JAM_SECURE_MODE: optionalEnumFromEnv("AIR_JAM_SECURE_MODE", [
    "local",
    "tunnel",
  ]),
  AIR_JAM_MKCERT_TRUST_STORES: optionalEnvValue,
  AIR_JAM_SECURE_PUBLIC_HOST: optionalEnvValue,
  CLOUDFLARE_TUNNEL_NAME: optionalEnvValue,
  AIR_JAM_SECURE_ROOT: optionalEnvValue,
  VITE_AIR_JAM_SERVER_URL: optionalEnvValue,
  VITE_AIR_JAM_PUBLIC_HOST: optionalEnvValue,
  NEXT_PUBLIC_APP_URL: optionalEnvValue,
  HOME: optionalEnvValue,
});

export const loadCreateAirJamRuntimeEnv = ({
  env = process.env,
  boundary = "create-airjam.runtime",
} = {}) =>
  validateEnv({
    boundary,
    schema: createAirJamRuntimeEnvSchema,
    env,
    docsHint:
      "Fix runtime env values in .env / .env.local before running create-airjam runtime commands.",
    keyHints: {
      VITE_PORT:
        "Set a positive integer Vite port (for example: VITE_PORT=5173).",
      AIR_JAM_SERVER_PORT:
        "Set a positive integer local server port (for example: AIR_JAM_SERVER_PORT=4000).",
      AIR_JAM_SECURE_MODE:
        "Use AIR_JAM_SECURE_MODE=local or AIR_JAM_SECURE_MODE=tunnel.",
    },
  });
