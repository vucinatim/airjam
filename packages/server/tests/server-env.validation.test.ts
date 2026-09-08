import { EnvValidationError } from "@air-jam/env";
import { describe, expect, it } from "vitest";
import { loadServerEnv } from "../src/env/server-env";

describe("loadServerEnv", () => {
  it("fails with an env validation error when required auth mode has no backend", () => {
    expect(() =>
      loadServerEnv({
        AIR_JAM_AUTH_MODE: "required",
        NODE_ENV: "production",
      }),
    ).toThrow(EnvValidationError);
  });

  it.each(["production", "preview"] as const)(
    "does not accept AIR_JAM_MASTER_KEY as a hosted %s auth backend",
    (operationalEnvironment) => {
      expect(() =>
        loadServerEnv({
          AIR_JAM_AUTH_MODE: "required",
          AIR_JAM_MASTER_KEY: "legacy-shared-key",
          AIRJAM_OPERATIONAL_ENVIRONMENT: operationalEnvironment,
          NODE_ENV: "production",
        }),
      ).toThrow(EnvValidationError);
    },
  );

  it("preserves explicit local-development master-key auth", () => {
    const config = loadServerEnv({
      AIR_JAM_AUTH_MODE: "required",
      AIR_JAM_MASTER_KEY: "local-development-key",
      AIRJAM_OPERATIONAL_ENVIRONMENT: "development",
      NODE_ENV: "development",
    });

    expect(config.masterKey).toBe("local-development-key");
  });

  it("does not let an operational test label enable a master key in a production process", () => {
    expect(() =>
      loadServerEnv({
        AIR_JAM_AUTH_MODE: "required",
        AIR_JAM_MASTER_KEY: "legacy-shared-key",
        AIRJAM_OPERATIONAL_ENVIRONMENT: "test",
        NODE_ENV: "production",
      }),
    ).toThrow(EnvValidationError);
  });

  it("fails when rate limit env expects a positive integer", () => {
    expect(() =>
      loadServerEnv({
        AIR_JAM_RATE_LIMIT_WINDOW_MS: "abc",
      }),
    ).toThrow(EnvValidationError);
  });

  it("returns parsed defaults when optional values are omitted", () => {
    const config = loadServerEnv({
      AIR_JAM_AUTH_MODE: "disabled",
    });

    expect(config.port).toBe(4000);
    expect(config.allowedOrigins).toBe("*");
    expect(config.rateLimitWindowMs).toBe(60_000);
    expect(config.runtimeErrorReportRateLimitMax).toBe(30);
    expect(config.authMode).toBe("disabled");
    expect(config.proxyHeaderTrustMode).toBe("auto");
    expect(config.remoteDatabaseBlocked).toBe(false);
  });

  it("validates the hosted-runtime report rate limit", () => {
    expect(() =>
      loadServerEnv({
        AIR_JAM_AUTH_MODE: "disabled",
        AIR_JAM_RUNTIME_ERROR_REPORT_RATE_LIMIT_MAX: "0",
      }),
    ).toThrow(EnvValidationError);

    expect(
      loadServerEnv({
        AIR_JAM_AUTH_MODE: "disabled",
        AIR_JAM_RUNTIME_ERROR_REPORT_RATE_LIMIT_MAX: "12",
      }).runtimeErrorReportRateLimitMax,
    ).toBe(12);
  });

  it("accepts a partial app-local env file shape", () => {
    const config = loadServerEnv({
      AIR_JAM_AUTH_MODE: "disabled",
      DATABASE_URL: "",
    });

    expect(config.authMode).toBe("disabled");
    expect(config.databaseUrl).toBeUndefined();
  });

  it("blocks a non-local database url by default outside production", () => {
    const config = loadServerEnv({
      AIR_JAM_AUTH_MODE: "disabled",
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@db.example.com:5432/airjam",
    });

    expect(config.databaseUrl).toBeUndefined();
    expect(config.remoteDatabaseBlocked).toBe(true);
  });

  it("allows a non-local database url when explicitly enabled", () => {
    const config = loadServerEnv({
      AIR_JAM_AUTH_MODE: "disabled",
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://user:pass@db.example.com:5432/airjam",
      AIR_JAM_ALLOW_REMOTE_DATABASE: "enabled",
    });

    expect(config.databaseUrl).toBe(
      "postgresql://user:pass@db.example.com:5432/airjam",
    );
    expect(config.remoteDatabaseBlocked).toBe(false);
  });

  it("fails when required auth depends on a blocked non-local database url", () => {
    expect(() =>
      loadServerEnv({
        AIR_JAM_AUTH_MODE: "required",
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://user:pass@db.example.com:5432/airjam",
      }),
    ).toThrow(EnvValidationError);
  });

  it("forces allowedOrigins='*' on Railway PR preview environments", () => {
    // Production AIR_JAM_ALLOWED_ORIGINS gets cloned into PR envs by
    // Railway; the server must ignore the inherited prod value so
    // socket.io from the sibling preview platform isn't blocked.
    const config = loadServerEnv({
      AIR_JAM_AUTH_MODE: "disabled",
      AIR_JAM_ALLOWED_ORIGINS: "https://airjam.io",
      RAILWAY_ENVIRONMENT_NAME: "air-jam-pr-42",
    });

    expect(config.allowedOrigins).toBe("*");
  });

  it("respects AIR_JAM_ALLOWED_ORIGINS on Railway production", () => {
    const config = loadServerEnv({
      AIR_JAM_AUTH_MODE: "disabled",
      AIR_JAM_ALLOWED_ORIGINS: "https://airjam.io",
      RAILWAY_ENVIRONMENT_NAME: "production",
    });

    expect(config.allowedOrigins).toEqual(["https://airjam.io"]);
  });

  it("preserves leading-subdomain origin patterns in production", () => {
    const config = loadServerEnv({
      AIR_JAM_AUTH_MODE: "disabled",
      AIR_JAM_ALLOWED_ORIGINS: "https://airjam.io,https://*.vercel.app",
      RAILWAY_ENVIRONMENT_NAME: "production",
    });

    expect(config.allowedOrigins).toEqual([
      "https://airjam.io",
      "https://*.vercel.app",
    ]);
  });
});
