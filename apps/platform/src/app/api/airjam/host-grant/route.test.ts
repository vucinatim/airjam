import {
  AIR_JAM_LAUNCH_SESSION_COOKIE_NAME,
  createAirJamLaunchSession,
} from "@/lib/airjam-launch-session";
import { verifyHostGrant } from "@air-jam/sdk/protocol";
import { PgDialect } from "drizzle-orm/pg-core";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const databaseMocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { from, limit, select, where };
});

vi.mock("@/db", () => ({
  db: { select: databaseMocks.select },
}));

const ORIGINAL_ENV = { ...process.env };

const resetEnv = (): void => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
};

beforeEach(() => {
  databaseMocks.select.mockClear();
  databaseMocks.from.mockClear();
  databaseMocks.where.mockClear();
  databaseMocks.limit.mockReset().mockResolvedValue([]);

  process.env.NODE_ENV = "production";
  process.env.NEXT_PUBLIC_AIR_JAM_PUBLIC_HOST = "https://airjam.io";
  process.env.AIR_JAM_SYSTEM_APP_ID = "aj_app_system_test";
  process.env.AIR_JAM_HOST_GRANT_SECRET = "host-grant-test-secret";
});

afterEach(resetEnv);

const createLaunchSessionCookie = async (now?: number): Promise<string> => {
  const launchSession = await createAirJamLaunchSession({
    secret: process.env.AIR_JAM_HOST_GRANT_SECRET!,
    ...(now === undefined ? {} : { now }),
    createId: () => "11111111-1111-4111-8111-111111111111",
  });
  return `${AIR_JAM_LAUNCH_SESSION_COOKIE_NAME}=${launchSession.token}`;
};

describe("platform host-grant trust boundary", () => {
  it("issues a v3 single-use system grant bound to the anonymous abuse session", async () => {
    databaseMocks.limit.mockResolvedValue([
      { gameId: "game-system", creatorId: "creator-system" },
    ]);
    const response = await POST(
      new NextRequest("https://airjam.io/api/airjam/host-grant", {
        method: "POST",
        headers: {
          origin: "https://airjam.io",
          cookie: await createLaunchSessionCookie(),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { hostGrant: string };
    const verified = await verifyHostGrant({
      secret: process.env.AIR_JAM_HOST_GRANT_SECRET!,
      token: body.hostGrant,
    });
    expect(verified.ok).toBe(true);
    expect(verified.claims).toMatchObject({
      typ: "airjam.host_grant.v3",
      aud: "airjam:realtime",
      appId: "aj_app_system_test",
      gameId: "game-system",
      creatorId: "creator-system",
      sessionKind: "system",
      intent: "system_register",
      abuseSessionId: "11111111-1111-4111-8111-111111111111",
      origins: ["https://airjam.io"],
    });
    expect(verified.claims?.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(verified.claims!.exp - verified.claims!.iat).toBe(60);
  });

  it.each([
    ["missing", undefined],
    ["cross-origin", "https://attacker.example"],
  ])(
    "rejects a %s Origin before reading app identity",
    async (_label, origin) => {
      const response = await POST(
        new NextRequest("https://airjam.io/api/airjam/host-grant", {
          method: "POST",
          headers: {
            ...(origin ? { origin } : {}),
            cookie: await createLaunchSessionCookie(),
          },
        }),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Origin not allowed",
      });
      expect(databaseMocks.select).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", undefined],
    ["forged", `${AIR_JAM_LAUNCH_SESSION_COOKIE_NAME}=forged.capability`],
  ])(
    "rejects a %s launch-session cookie before reading app identity",
    async (_label, cookie) => {
      const response = await POST(
        new NextRequest("https://airjam.io/api/airjam/host-grant", {
          method: "POST",
          headers: {
            origin: "https://airjam.io",
            ...(cookie ? { cookie } : {}),
          },
        }),
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "Valid Arcade launch session required",
      });
      expect(databaseMocks.select).not.toHaveBeenCalled();
    },
  );

  it("rejects an expired launch session without minting a grant", async () => {
    const expiredCookie = await createLaunchSessionCookie(1_700_000_000);
    const response = await POST(
      new NextRequest("https://airjam.io/api/airjam/host-grant", {
        method: "POST",
        headers: {
          origin: "https://airjam.io",
          cookie: expiredCookie,
        },
      }),
    );

    expect(response.status).toBe(401);
    expect(databaseMocks.select).not.toHaveBeenCalled();
  });

  it("requires an active app credential and issues no grant when none exists", async () => {
    const response = await POST(
      new NextRequest("https://airjam.io/api/airjam/host-grant", {
        method: "POST",
        headers: {
          origin: "https://airjam.io",
          cookie: await createLaunchSessionCookie(),
        },
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Platform Arcade App ID is not registered",
    });
    expect(databaseMocks.limit).toHaveBeenCalledWith(1);

    const condition = databaseMocks.where.mock.calls[0]?.[0];
    expect(condition).toBeDefined();
    const query = new PgDialect().sqlToQuery(condition);
    expect(query.sql).toBe(
      '("app_ids"."key" = $1 and "app_ids"."is_active" = $2)',
    );
    expect(query.params).toEqual(["aj_app_system_test", true]);
  });
});
