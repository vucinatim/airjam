import { describe, expect, it } from "vitest";
import {
  createHostGrant,
  verifyHostGrant,
  type HostGrantClaims,
} from "../src/protocol/host-grant";

const secret = "host-grant-unit-test-secret";

const createClaims = (
  overrides: Partial<HostGrantClaims> = {},
): Omit<HostGrantClaims, "typ"> => {
  const now = 2_000_000_000;
  return {
    jti: crypto.randomUUID(),
    aud: "airjam:realtime",
    appId: "aj_app_test",
    gameId: "game-test",
    creatorId: "creator-test",
    iat: now,
    exp: now + 60,
    scopes: ["host:bootstrap"],
    origins: ["https://airjam.io"],
    sessionKind: "system",
    intent: "system_register",
    abuseSessionId: crypto.randomUUID(),
    ...overrides,
  };
};

describe("signed host-grant protocol", () => {
  it("round-trips the complete v3 authority claims", async () => {
    const claims = createClaims();
    const token = await createHostGrant({ secret, claims });

    await expect(
      verifyHostGrant({ secret, token, now: claims.iat }),
    ).resolves.toEqual({
      ok: true,
      claims: {
        typ: "airjam.host_grant.v3",
        ...claims,
      },
    });
  });

  it("rejects a modified signed token", async () => {
    const claims = createClaims();
    const token = await createHostGrant({ secret, claims });
    const [header, payload, signature] = token.split(".");
    const modifiedPayload = `${payload!.slice(0, -1)}${payload!.endsWith("a") ? "b" : "a"}`;

    await expect(
      verifyHostGrant({
        secret,
        token: `${header}.${modifiedPayload}.${signature}`,
        now: claims.iat,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Invalid host grant signature",
    });
  });

  it("rejects an expired grant", async () => {
    const claims = createClaims();
    const token = await createHostGrant({ secret, claims });

    await expect(
      verifyHostGrant({ secret, token, now: claims.exp }),
    ).resolves.toEqual({ ok: false, error: "Host grant expired" });
  });

  it("rejects grants with excessive lifetime", async () => {
    const claims = createClaims({ exp: 2_000_000_121 });
    const token = await createHostGrant({ secret, claims });

    await expect(
      verifyHostGrant({ secret, token, now: claims.iat }),
    ).resolves.toEqual({ ok: false, error: "Invalid host grant lifetime" });
  });

  it("rejects grants issued too far in the future", async () => {
    const claims = createClaims({
      iat: 2_000_000_031,
      exp: 2_000_000_091,
    });
    const token = await createHostGrant({ secret, claims });

    await expect(
      verifyHostGrant({ secret, token, now: 2_000_000_000 }),
    ).resolves.toEqual({ ok: false, error: "Invalid host grant lifetime" });
  });
});
