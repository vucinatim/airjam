import {
  AIR_JAM_LAUNCH_SESSION_COOKIE_NAME,
  AIR_JAM_LAUNCH_SESSION_TTL_SECONDS,
  createAirJamLaunchSession,
  verifyAirJamLaunchSession,
} from "@/lib/airjam-launch-session";
import { createLoginHref } from "@/lib/auth-redirect";
import { resolvePlatformDeploymentConfig } from "@/lib/platform-deployment-config";
import { isPlatformLivenessPath } from "@/lib/platform-service-contract";
import type { ProductTelemetryAgentResource } from "@/lib/product-telemetry-contract";
import {
  assessHostedReleaseOrigin,
  readConfiguredHostedReleaseRequestHost,
} from "@/lib/releases/hosted-release-origin";
import { normalizePlatformRequestHost } from "@/lib/request-host-policy";
import { recordAgentResourceRequestBestEffort } from "@/server/product-telemetry/agent-resource";
import {
  type NextFetchEvent,
  type NextRequest,
  NextResponse,
} from "next/server";

const AGENT_RESOURCE_BY_PATHNAME = {
  "/llms.txt": "llms_txt",
  "/docs-manifest": "docs_manifest",
  "/docs-search-index": "docs_search_index",
  "/ai-pack/manifest.json": "ai_pack_manifest",
} as const satisfies Record<string, ProductTelemetryAgentResource>;

const isHostedReleasePath = (pathname: string): boolean =>
  pathname === "/releases" || pathname.startsWith("/releases/");

export type HostedReleaseRequestDisposition =
  | { kind: "platform" }
  | { kind: "serve_release" }
  | { kind: "block_release_origin" }
  | { kind: "block_unknown_host" }
  | { kind: "release_unavailable"; reason: string }
  | { kind: "redirect_release"; destination: string };

export const resolveHostedReleaseRequestDisposition = (
  requestUrl: string | URL,
  requestHost: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): HostedReleaseRequestDisposition => {
  const url = new URL(requestUrl);
  const assessment = assessHostedReleaseOrigin(env);
  const deployment = resolvePlatformDeploymentConfig(env);
  const incomingHost = normalizePlatformRequestHost(requestHost);
  const configuredReleaseRequestHost =
    readConfiguredHostedReleaseRequestHost(env);
  const isConfiguredReleaseOriginHost =
    configuredReleaseRequestHost !== null &&
    incomingHost === configuredReleaseRequestHost;
  const isReleaseOriginHost =
    assessment.status === "ready" && isConfiguredReleaseOriginHost;
  if (isPlatformLivenessPath(url.pathname) && !isConfiguredReleaseOriginHost) {
    return { kind: "platform" };
  }
  const isReleasePath = isHostedReleasePath(url.pathname);
  const isPlatformHost =
    incomingHost !== null &&
    deployment.platformRequestHosts.includes(incomingHost);
  const isLocalDevelopment =
    env.NODE_ENV !== "production" && !env.RAILWAY_ENVIRONMENT_NAME;

  if (assessment.status !== "ready") {
    if (!isPlatformHost && !isLocalDevelopment) {
      return { kind: "block_unknown_host" };
    }
    return isReleasePath
      ? {
          kind: "release_unavailable",
          reason: assessment.reason,
        }
      : { kind: "platform" };
  }

  if (isReleaseOriginHost) {
    return isReleasePath
      ? { kind: "serve_release" }
      : { kind: "block_release_origin" };
  }

  if (!isPlatformHost) {
    return { kind: "block_unknown_host" };
  }

  if (isReleasePath) {
    return {
      kind: "redirect_release",
      destination: new URL(
        `${url.pathname}${url.search}`,
        assessment.publicOrigin,
      ).toString(),
    };
  }

  return { kind: "platform" };
};

export const resolveAgentResource = (
  pathname: string,
): ProductTelemetryAgentResource | null =>
  AGENT_RESOURCE_BY_PATHNAME[
    pathname as keyof typeof AGENT_RESOURCE_BY_PATHNAME
  ] ?? null;

export const isTopLevelArcadeNavigation = (request: NextRequest): boolean =>
  request.method === "GET" &&
  (request.nextUrl.pathname === "/arcade" ||
    request.nextUrl.pathname.startsWith("/arcade/")) &&
  request.headers.get("sec-fetch-mode") === "navigate" &&
  request.headers.get("sec-fetch-dest") === "document" &&
  request.headers.get("accept")?.includes("text/html") === true;

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  const releaseDisposition = resolveHostedReleaseRequestDisposition(
    request.url,
    request.headers.get("host"),
  );
  if (
    releaseDisposition.kind === "block_release_origin" ||
    releaseDisposition.kind === "block_unknown_host"
  ) {
    return new NextResponse("Not found", {
      status: 404,
      headers: {
        "cache-control": "no-store",
        "x-airjam-content-class": "untrusted-release",
      },
    });
  }
  if (releaseDisposition.kind === "release_unavailable") {
    return new NextResponse("Hosted release delivery is unavailable", {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "x-airjam-release-status": "unavailable",
      },
    });
  }
  if (releaseDisposition.kind === "redirect_release") {
    const response = NextResponse.redirect(releaseDisposition.destination, 307);
    response.headers.set("cache-control", "no-store");
    return response;
  }
  if (releaseDisposition.kind === "serve_release") {
    const response = NextResponse.next();
    response.headers.set("x-airjam-content-class", "untrusted-release");
    return response;
  }

  const resource = resolveAgentResource(request.nextUrl.pathname);

  if (resource) {
    event.waitUntil(
      recordAgentResourceRequestBestEffort({ resource, request }),
    );
  }

  if (request.nextUrl.pathname.startsWith("/dashboard")) {
    const sessionCookie = request.cookies.get("better-auth.session_token");
    const secureSessionCookie = request.cookies.get(
      "__Secure-better-auth.session_token",
    );

    if (!sessionCookie && !secureSessionCookie) {
      const nextPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
      return NextResponse.redirect(
        new URL(createLoginHref(nextPath), request.url),
      );
    }
  }

  const response = NextResponse.next();
  if (!isTopLevelArcadeNavigation(request)) {
    return response;
  }

  const secret = process.env.AIR_JAM_HOST_GRANT_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV !== "production") {
      return response;
    }
    return new NextResponse("Arcade launch session is unavailable", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }

  try {
    const existingToken = request.cookies.get(
      AIR_JAM_LAUNCH_SESSION_COOKIE_NAME,
    )?.value;
    if (existingToken) {
      const existingSession = await verifyAirJamLaunchSession({
        secret,
        token: existingToken,
      });
      if (existingSession.ok) {
        return response;
      }
    }

    const launchSession = await createAirJamLaunchSession({ secret });
    response.cookies.set({
      name: AIR_JAM_LAUNCH_SESSION_COOKIE_NAME,
      value: launchSession.token,
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: AIR_JAM_LAUNCH_SESSION_TTL_SECONDS,
    });
    return response;
  } catch {
    return new NextResponse("Arcade launch session is unavailable", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}

export const config = {
  matcher: ["/:path*"],
};
