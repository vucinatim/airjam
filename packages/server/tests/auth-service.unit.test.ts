import { AIRJAM_DEV_LOG_EVENTS, createHostGrant } from "@air-jam/sdk/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerLogger } from "../src/logging/logger";
import { AuthService } from "../src/services/auth-service";

const ORIGINAL_ENV = { ...process.env };

const resetEnv = (): void => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }

  Object.assign(process.env, ORIGINAL_ENV);
};

afterEach(() => {
  resetEnv();
});

const createMockLogger = (): Pick<ServerLogger, "info" | "warn" | "error"> => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe("AuthService", () => {
  it("emits canonical startup events for disabled auth mode", () => {
    process.env.AIR_JAM_AUTH_MODE = "disabled";

    const logger = createMockLogger();
    new AuthService({ logger: logger as unknown as ServerLogger });

    expect(logger.info).toHaveBeenCalledWith(
      { event: AIRJAM_DEV_LOG_EVENTS.auth.modeDisabled },
      "Authentication disabled (set AIR_JAM_AUTH_MODE=required to enforce app identity checks)",
    );
  });

  it("emits a canonical startup warning when required auth has no backend", () => {
    process.env.AIR_JAM_AUTH_MODE = "required";
    delete process.env.AIR_JAM_MASTER_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.AIR_JAM_HOST_GRANT_SECRET;

    const logger = createMockLogger();
    new AuthService({ logger: logger as unknown as ServerLogger });

    expect(logger.warn).toHaveBeenCalledWith(
      { event: AIRJAM_DEV_LOG_EVENTS.auth.backendMissing },
      "Authentication required, but no auth backend is configured (set DATABASE_URL)",
    );
  });

  it("accepts missing app ID when AIR_JAM_AUTH_MODE=disabled", async () => {
    process.env.AIR_JAM_AUTH_MODE = "disabled";
    delete process.env.AIR_JAM_MASTER_KEY;

    const authService = new AuthService();
    const result = await authService.verifyAppId();

    expect(result).toEqual({ isVerified: true });
  });

  it("rejects missing app ID when AIR_JAM_AUTH_MODE=required", async () => {
    process.env.AIR_JAM_AUTH_MODE = "required";
    delete process.env.AIR_JAM_MASTER_KEY;

    const authService = new AuthService();
    const result = await authService.verifyAppId();

    expect(result.isVerified).toBe(false);
    expect(result.error).toBe("Unauthorized: Invalid or Missing App ID");
  });

  it("accepts the master key only as an explicit local-development backend", async () => {
    const authService = new AuthService({
      env: {
        authMode: "required",
        masterKey: "master-key",
        nodeEnv: "development",
        operationalEnvironment: "development",
      },
    });
    const result = await authService.verifyAppId("master-key");

    expect(result).toEqual({ isVerified: true });
  });

  it.each(["production", "preview"] as const)(
    "rejects the legacy master key in hosted %s required-auth mode",
    async (operationalEnvironment) => {
      const authService = new AuthService({
        env: {
          authMode: "required",
          masterKey: "master-key",
          nodeEnv: "production",
          operationalEnvironment,
        },
      });

      await expect(authService.verifyAppId("master-key")).resolves.toEqual({
        isVerified: false,
        error: "Unauthorized: Invalid or Missing App ID",
      });
      expect(authService.getStartupConfigurationError()).toBe(
        "AIR_JAM_AUTH_MODE=required requires an auth backend. Configure DATABASE_URL for app ID bootstrap and signed host grants.",
      );
    },
  );

  it("does not let an operational test label enable a master key in a production process", async () => {
    const authService = new AuthService({
      env: {
        authMode: "required",
        masterKey: "master-key",
        nodeEnv: "production",
        operationalEnvironment: "test",
      },
    });

    await expect(authService.verifyAppId("master-key")).resolves.toEqual({
      isVerified: false,
      error: "Unauthorized: Invalid or Missing App ID",
    });
  });

  it("defaults to disabled auth in development even when DATABASE_URL is set", async () => {
    delete process.env.AIR_JAM_AUTH_MODE;
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgres://example";

    const authService = new AuthService();
    const result = await authService.verifyAppId();

    expect(result).toEqual({ isVerified: true });
  });

  it("does not treat a remote DATABASE_URL as an active backend in development unless explicitly enabled", () => {
    process.env.AIR_JAM_AUTH_MODE = "required";
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL =
      "postgresql://user:pass@db.example.com:5432/airjam";
    delete process.env.AIR_JAM_MASTER_KEY;
    delete process.env.AIR_JAM_HOST_GRANT_SECRET;
    delete process.env.AIR_JAM_ALLOW_REMOTE_DATABASE;

    const authService = new AuthService();

    expect(authService.getStartupConfigurationError()).toBe(
      "AIR_JAM_AUTH_MODE=required requires an auth backend. Configure DATABASE_URL for app ID bootstrap and signed host grants.",
    );
  });

  it("defaults to required auth in production when mode is not set", async () => {
    delete process.env.AIR_JAM_AUTH_MODE;
    process.env.NODE_ENV = "production";
    delete process.env.AIR_JAM_MASTER_KEY;
    delete process.env.DATABASE_URL;

    const authService = new AuthService();
    const result = await authService.verifyAppId();

    expect(result.isVerified).toBe(false);
    expect(result.error).toBe("Unauthorized: Invalid or Missing App ID");
  });

  it("reports a clear startup configuration error when required auth has no backend", () => {
    process.env.AIR_JAM_AUTH_MODE = "required";
    delete process.env.AIR_JAM_MASTER_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.AIR_JAM_HOST_GRANT_SECRET;

    const authService = new AuthService();

    expect(authService.getStartupConfigurationError()).toBe(
      "AIR_JAM_AUTH_MODE=required requires an auth backend. Configure DATABASE_URL for app ID bootstrap and signed host grants.",
    );
  });

  it("rejects signed host grants without PostgreSQL consumption authority", async () => {
    process.env.AIR_JAM_AUTH_MODE = "required";
    process.env.AIR_JAM_HOST_GRANT_SECRET = "secret_123";

    const authService = new AuthService();
    const now = Math.floor(Date.now() / 1000);
    const hostGrant = await createHostGrant({
      secret: "secret_123",
      claims: {
        jti: crypto.randomUUID(),
        aud: "airjam:realtime",
        appId: "aj_app_demo",
        gameId: "game_demo",
        creatorId: "creator_demo",
        iat: now,
        exp: now + 60,
        scopes: ["host:bootstrap"],
        origins: ["https://example.com"],
        sessionKind: "system",
        intent: "system_register",
        abuseSessionId: crypto.randomUUID(),
      },
    });

    const result = await authService.verifyHostBootstrap({
      hostGrant,
      origin: "https://example.com",
    });

    expect(result).toEqual({
      isVerified: false,
      error: "Unauthorized: Host grant consumption is unavailable",
    });
    expect(authService.getStartupConfigurationError()).toBe(
      "Signed host grants require PostgreSQL consumption authority.",
    );
  });

  it("rejects an expired signed host grant", async () => {
    process.env.AIR_JAM_AUTH_MODE = "required";
    process.env.AIR_JAM_HOST_GRANT_SECRET = "secret_123";

    const authService = new AuthService();
    const now = Math.floor(Date.now() / 1000);
    const hostGrant = await createHostGrant({
      secret: "secret_123",
      claims: {
        jti: crypto.randomUUID(),
        aud: "airjam:realtime",
        appId: "aj_app_demo",
        gameId: "game_demo",
        creatorId: "creator_demo",
        iat: now - 65,
        exp: now - 5,
        scopes: ["host:bootstrap"],
        origins: ["https://example.com"],
        sessionKind: "system",
        intent: "system_register",
        abuseSessionId: crypto.randomUUID(),
      },
    });

    const result = await authService.verifyHostBootstrap({
      hostGrant,
      origin: "https://example.com",
    });

    expect(result.isVerified).toBe(false);
    expect(result.error).toBe("Host grant expired");
  });

  it("rejects a signed host grant when the request origin is not allowed", async () => {
    process.env.AIR_JAM_AUTH_MODE = "required";
    process.env.AIR_JAM_HOST_GRANT_SECRET = "secret_123";

    const authService = new AuthService();
    const now = Math.floor(Date.now() / 1000);
    const hostGrant = await createHostGrant({
      secret: "secret_123",
      claims: {
        jti: crypto.randomUUID(),
        aud: "airjam:realtime",
        appId: "aj_app_demo",
        gameId: "game_demo",
        creatorId: "creator_demo",
        iat: now,
        exp: now + 60,
        scopes: ["host:bootstrap"],
        origins: ["https://allowed.example"],
        sessionKind: "system",
        intent: "system_register",
        abuseSessionId: crypto.randomUUID(),
      },
    });

    const result = await authService.verifyHostBootstrap({
      hostGrant,
      origin: "https://blocked.example",
    });

    expect(result.isVerified).toBe(false);
    expect(result.error).toBe("Unauthorized: Origin not allowed by Host Grant");
  });
});
