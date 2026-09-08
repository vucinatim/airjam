import { describe, expect, it } from "vitest";
import {
  AIR_JAM_LAUNCH_SESSION_TTL_SECONDS,
  createAirJamLaunchSession,
  verifyAirJamLaunchSession,
} from "./airjam-launch-session";

describe("Air Jam anonymous launch-session capability", () => {
  it("issues a 24-hour signed capability with a non-forgeable abuse identity", async () => {
    const issued = await createAirJamLaunchSession({
      secret: "test-host-grant-secret",
      now: 1_800_000_000,
      createId: () => "11111111-1111-4111-8111-111111111111",
    });

    expect(issued.claims).toEqual({
      typ: "airjam.launch_session.v1",
      abuseSessionId: "11111111-1111-4111-8111-111111111111",
      iat: 1_800_000_000,
      exp: 1_800_000_000 + AIR_JAM_LAUNCH_SESSION_TTL_SECONDS,
    });
    await expect(
      verifyAirJamLaunchSession({
        secret: "test-host-grant-secret",
        token: issued.token,
        now: 1_800_000_001,
      }),
    ).resolves.toEqual({ ok: true, claims: issued.claims });
  });

  it("fails closed for tampered, wrongly signed, and expired capabilities", async () => {
    const issued = await createAirJamLaunchSession({
      secret: "test-host-grant-secret",
      now: 1_800_000_000,
      createId: () => "11111111-1111-4111-8111-111111111111",
    });
    const [payload, signature] = issued.token.split(".");
    const tamperedToken = `${payload}x.${signature}`;

    await expect(
      verifyAirJamLaunchSession({
        secret: "test-host-grant-secret",
        token: tamperedToken,
        now: 1_800_000_001,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      verifyAirJamLaunchSession({
        secret: "different-secret",
        token: issued.token,
        now: 1_800_000_001,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      verifyAirJamLaunchSession({
        secret: "test-host-grant-secret",
        token: issued.token,
        now: issued.claims.exp,
      }),
    ).resolves.toEqual({ ok: false, error: "Launch session expired" });
  });
});
