import { db } from "@/db";
import { appIds } from "@/db/schema";
import {
  AIR_JAM_LAUNCH_SESSION_COOKIE_NAME,
  verifyAirJamLaunchSession,
} from "@/lib/airjam-launch-session";
import { resolvePlatformDeploymentConfig } from "@/lib/platform-deployment-config";
import { createHostGrant } from "@air-jam/sdk/protocol";
import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

const HOST_GRANT_TTL_SECONDS = 60;

const jsonError = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status });

export async function POST(request: NextRequest) {
  const deploymentConfig = resolvePlatformDeploymentConfig(process.env);
  const appId =
    process.env.AIR_JAM_SYSTEM_APP_ID?.trim() || deploymentConfig.appId;
  const secret = process.env.AIR_JAM_HOST_GRANT_SECRET?.trim();
  const requestOrigin = request.headers.get("origin");

  if (!secret) {
    return jsonError("Host grant signing is not configured", 503);
  }

  if (!appId) {
    return jsonError("Platform Arcade App ID is not configured", 503);
  }

  if (requestOrigin !== deploymentConfig.platformPublicOrigin) {
    return jsonError("Origin not allowed", 403);
  }

  const launchSessionToken = request.cookies.get(
    AIR_JAM_LAUNCH_SESSION_COOKIE_NAME,
  )?.value;
  if (!launchSessionToken) {
    return jsonError("Valid Arcade launch session required", 401);
  }

  const launchSession = await verifyAirJamLaunchSession({
    secret,
    token: launchSessionToken,
  });
  if (!launchSession.ok || !launchSession.claims) {
    return jsonError("Valid Arcade launch session required", 401);
  }

  const [appIdentity] = await db
    .select({ gameId: appIds.gameId, creatorId: appIds.creatorId })
    .from(appIds)
    .where(and(eq(appIds.key, appId), eq(appIds.isActive, true)))
    .limit(1);
  if (!appIdentity) {
    return jsonError("Platform Arcade App ID is not registered", 503);
  }

  const now = Math.floor(Date.now() / 1000);
  const hostGrant = await createHostGrant({
    secret,
    claims: {
      jti: globalThis.crypto.randomUUID(),
      aud: "airjam:realtime",
      appId,
      gameId: appIdentity.gameId,
      creatorId: appIdentity.creatorId,
      iat: now,
      exp: now + HOST_GRANT_TTL_SECONDS,
      scopes: ["host:bootstrap"],
      origins: [deploymentConfig.platformPublicOrigin],
      sessionKind: "system",
      intent: "system_register",
      abuseSessionId: launchSession.claims.abuseSessionId,
    },
  });

  return NextResponse.json(
    { hostGrant },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
