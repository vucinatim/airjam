import { NextRequest, type NextFetchEvent } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  AIR_JAM_LAUNCH_SESSION_COOKIE_NAME,
  createAirJamLaunchSession,
} from "./lib/airjam-launch-session";

const recordAgentResourceRequestBestEffort = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

vi.mock("@/server/product-telemetry/agent-resource", () => ({
  recordAgentResourceRequestBestEffort,
}));

import {
  config,
  isTopLevelArcadeNavigation,
  proxy,
  resolveAgentResource,
  resolveHostedReleaseRequestDisposition,
} from "./proxy";

const makeEvent = () => ({ waitUntil: vi.fn() }) as unknown as NextFetchEvent;

describe("agent-resource proxy", () => {
  it.each([
    ["/llms.txt", "llms_txt"],
    ["/docs-manifest", "docs_manifest"],
    ["/docs-search-index", "docs_search_index"],
    ["/ai-pack/manifest.json", "ai_pack_manifest"],
  ] as const)("maps %s to %s", (pathname, resource) => {
    expect(resolveAgentResource(pathname)).toBe(resource);
  });

  it("does not classify arbitrary public routes", () => {
    expect(resolveAgentResource("/docs")).toBeNull();
    expect(resolveAgentResource("/ai-pack/stable/manifest.json")).toBeNull();
  });

  it("records a classified resource without changing its response lane", async () => {
    const request = new NextRequest("https://airjam.io/llms.txt");
    const event = makeEvent();
    const response = await proxy(request, event);

    expect(recordAgentResourceRequestBestEffort).toHaveBeenCalledWith({
      resource: "llms_txt",
      request,
    });
    expect(event.waitUntil).toHaveBeenCalledOnce();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("preserves the dashboard authentication redirect", async () => {
    const response = await proxy(
      new NextRequest("https://airjam.io/dashboard/ops/telemetry?days=30"),
      makeEvent(),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "%2Fdashboard%2Fops%2Ftelemetry",
    );
  });

  it("allows an authenticated dashboard request to continue", async () => {
    const response = await proxy(
      new NextRequest("https://airjam.io/dashboard/ops/telemetry", {
        headers: { cookie: "better-auth.session_token=session" },
      }),
      makeEvent(),
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("keeps the matcher aligned with every observed resource", () => {
    expect(config.matcher).toEqual(["/:path*"]);
  });
});

describe("Arcade launch-session navigation", () => {
  const navigationHeaders = {
    accept: "text/html,application/xhtml+xml",
    host: "airjam.io",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
  };

  it("sets a host-only 24-hour capability cookie on a top-level Arcade navigation", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://airjam.io");
    vi.stubEnv("AIR_JAM_HOST_GRANT_SECRET", "host-grant-test-secret");
    try {
      const request = new NextRequest("https://airjam.io/arcade", {
        headers: navigationHeaders,
      });
      expect(isTopLevelArcadeNavigation(request)).toBe(true);

      const response = await proxy(request, makeEvent());
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.get("set-cookie")).toMatch(
        /^__Host-airjam-launch-session=[^;]+; Path=\/; Expires=.*; Max-Age=86400; Secure; HttpOnly; SameSite=strict$/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("preserves an existing valid abuse identity across Arcade navigation", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://airjam.io");
    vi.stubEnv("AIR_JAM_HOST_GRANT_SECRET", "host-grant-test-secret");
    try {
      const existing = await createAirJamLaunchSession({
        secret: "host-grant-test-secret",
      });
      const response = await proxy(
        new NextRequest("https://airjam.io/arcade", {
          headers: {
            ...navigationHeaders,
            cookie: `${AIR_JAM_LAUNCH_SESSION_COOKIE_NAME}=${existing.token}`,
          },
        }),
        makeEvent(),
      );

      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.get("set-cookie")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rotates an invalid launch-session cookie", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://airjam.io");
    vi.stubEnv("AIR_JAM_HOST_GRANT_SECRET", "host-grant-test-secret");
    try {
      const response = await proxy(
        new NextRequest("https://airjam.io/arcade", {
          headers: {
            ...navigationHeaders,
            cookie: `${AIR_JAM_LAUNCH_SESSION_COOKIE_NAME}=invalid.token`,
          },
        }),
        makeEvent(),
      );

      expect(response.headers.get("set-cookie")).toMatch(
        /^__Host-airjam-launch-session=[^;]+;/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not mint launch authority for subresources or iframe navigations", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://airjam.io");
    vi.stubEnv("AIR_JAM_HOST_GRANT_SECRET", "host-grant-test-secret");
    try {
      const iframeRequest = new NextRequest("https://airjam.io/arcade", {
        headers: { ...navigationHeaders, "sec-fetch-dest": "iframe" },
      });
      const scriptRequest = new NextRequest(
        "https://airjam.io/arcade/assets/app.js",
        {
          headers: {
            accept: "*/*",
            host: "airjam.io",
            "sec-fetch-dest": "script",
            "sec-fetch-mode": "no-cors",
          },
        },
      );

      expect(isTopLevelArcadeNavigation(iframeRequest)).toBe(false);
      expect(isTopLevelArcadeNavigation(scriptRequest)).toBe(false);
      expect(
        (await proxy(iframeRequest, makeEvent())).headers.get("set-cookie"),
      ).toBeNull();
      expect(
        (await proxy(scriptRequest, makeEvent())).headers.get("set-cookie"),
      ).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed when production cannot sign an Arcade launch session", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://airjam.io");
    vi.stubEnv("AIR_JAM_HOST_GRANT_SECRET", "");
    try {
      const response = await proxy(
        new NextRequest("https://airjam.io/arcade", {
          headers: navigationHeaders,
        }),
        makeEvent(),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

const releaseEnv = {
  NODE_ENV: "production",
  NEXT_PUBLIC_APP_URL: "https://airjam.io",
  AIRJAM_RELEASES_PUBLIC_ORIGIN: "https://airjamusercontent.net",
} as NodeJS.ProcessEnv;

describe("hosted release request routing", () => {
  it("serves only release paths requested directly from the release origin", () => {
    expect(
      resolveHostedReleaseRequestDisposition(
        "https://airjamusercontent.net/releases/g/game-1/r/release-1/generations/generation-1/index.html",
        "airjamusercontent.net",
        releaseEnv,
      ),
    ).toEqual({ kind: "serve_release" });
    expect(
      resolveHostedReleaseRequestDisposition(
        "https://airjamusercontent.net/dashboard",
        "airjamusercontent.net",
        releaseEnv,
      ),
    ).toEqual({ kind: "block_release_origin" });
  });

  it("redirects platform release paths to the isolated origin without losing query state", () => {
    expect(
      resolveHostedReleaseRequestDisposition(
        "https://airjam.io/releases/g/game-1/r/release-1/generations/generation-1/?controller=abc%201",
        "airjam.io",
        releaseEnv,
      ),
    ).toEqual({
      kind: "redirect_release",
      destination:
        "https://airjamusercontent.net/releases/g/game-1/r/release-1/generations/generation-1/?controller=abc%201",
    });
  });

  it("keeps non-release platform requests on the platform lane", () => {
    expect(
      resolveHostedReleaseRequestDisposition(
        "https://airjam.io/play/example",
        "airjam.io",
        releaseEnv,
      ),
    ).toEqual({ kind: "platform" });
    expect(
      resolveHostedReleaseRequestDisposition(
        "https://www.airjam.io/docs",
        "www.airjam.io",
        releaseEnv,
      ),
    ).toEqual({ kind: "platform" });
  });

  it("applies fail-closed host policy in Railway previews without breaking local development", () => {
    const previewEnv = {
      NODE_ENV: "production",
      RAILWAY_ENVIRONMENT_NAME: "air-jam-pr-76",
      RAILWAY_PUBLIC_DOMAIN: "air-jam-platform-air-jam-pr-76.up.railway.app",
    } as NodeJS.ProcessEnv;

    expect(
      resolveHostedReleaseRequestDisposition(
        "http://0.0.0.0:3000/api/readiness",
        "attacker.example",
        previewEnv,
      ),
    ).toEqual({ kind: "block_unknown_host" });
    expect(
      resolveHostedReleaseRequestDisposition(
        "http://0.0.0.0:3000/api/readiness",
        "air-jam-platform-air-jam-pr-76.up.railway.app",
        previewEnv,
      ),
    ).toEqual({ kind: "platform" });
    expect(
      resolveHostedReleaseRequestDisposition(
        "http://192.168.1.20:3000/controller",
        "192.168.1.20:3000",
        { NODE_ENV: "development" } as NodeJS.ProcessEnv,
      ),
    ).toEqual({ kind: "platform" });
  });

  it("makes a renamed Railway production environment fail closed on the canonical host", () => {
    const renamedProductionEnv = {
      NODE_ENV: "production",
      RAILWAY_ENVIRONMENT_NAME: "Production",
      RAILWAY_PUBLIC_DOMAIN: "air-jam-platform-production.up.railway.app",
      NEXT_PUBLIC_APP_URL: "https://airjam.io",
    } as NodeJS.ProcessEnv;

    expect(
      resolveHostedReleaseRequestDisposition(
        "http://0.0.0.0:3000/docs",
        "airjam.io",
        renamedProductionEnv,
      ),
    ).toEqual({ kind: "block_unknown_host" });
    expect(
      resolveHostedReleaseRequestDisposition(
        "http://0.0.0.0:3000/docs",
        "air-jam-platform-production.up.railway.app",
        renamedProductionEnv,
      ),
    ).toEqual({ kind: "platform" });
  });

  it("fails closed when a release path is requested without a ready origin", () => {
    const disposition = resolveHostedReleaseRequestDisposition(
      "https://airjam.io/releases/g/game-1/r/release-1/generations/generation-1/",
      "airjam.io",
      {
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://airjam.io",
      },
    );

    expect(disposition.kind).toBe("release_unavailable");
    if (disposition.kind === "release_unavailable") {
      expect(disposition.reason).toContain("delivery is disabled");
    }
  });

  it("uses the incoming Host rather than Next's server-derived request URL", () => {
    expect(
      resolveHostedReleaseRequestDisposition(
        "http://0.0.0.0:3000/dashboard",
        "airjamusercontent.net",
        releaseEnv,
      ),
    ).toEqual({ kind: "block_release_origin" });
    expect(
      resolveHostedReleaseRequestDisposition(
        "http://0.0.0.0:3000/releases",
        "airjamusercontent.net",
        releaseEnv,
      ),
    ).toEqual({ kind: "serve_release" });
    expect(
      resolveHostedReleaseRequestDisposition(
        "http://0.0.0.0:3000/dashboard",
        "attacker.example",
        releaseEnv,
      ),
    ).toEqual({ kind: "block_unknown_host" });
  });

  it("keeps only the exact liveness path host-independent under production policy", () => {
    const productionWithoutReleaseOrigin = {
      NODE_ENV: "production",
      RAILWAY_ENVIRONMENT_NAME: "production",
      NEXT_PUBLIC_APP_URL: "https://airjam.io",
    } as NodeJS.ProcessEnv;

    expect(
      resolveHostedReleaseRequestDisposition(
        "http://0.0.0.0:3000/api/health",
        "unknown-provider-probe.example",
        productionWithoutReleaseOrigin,
      ),
    ).toEqual({ kind: "platform" });
    expect(
      resolveHostedReleaseRequestDisposition(
        "http://0.0.0.0:3000/api/readiness",
        "healthcheck.railway.app",
        productionWithoutReleaseOrigin,
      ),
    ).toEqual({ kind: "block_unknown_host" });
    expect(
      resolveHostedReleaseRequestDisposition(
        "http://0.0.0.0:3000/api/health",
        "airjamusercontent.example",
        {
          ...productionWithoutReleaseOrigin,
          AIRJAM_RELEASES_PUBLIC_ORIGIN: "https://airjamusercontent.example",
        },
      ),
    ).toEqual({ kind: "block_release_origin" });
    expect(
      resolveHostedReleaseRequestDisposition(
        "http://0.0.0.0:3000/api/health",
        "airjamusercontent.example",
        {
          ...productionWithoutReleaseOrigin,
          AIRJAM_RELEASES_PUBLIC_ORIGIN:
            "https://airjamusercontent.example/invalid-path",
        },
      ),
    ).toEqual({ kind: "block_unknown_host" });
    expect(
      resolveHostedReleaseRequestDisposition(
        "http://0.0.0.0:3000/login",
        "healthcheck.railway.app",
        productionWithoutReleaseOrigin,
      ),
    ).toEqual({ kind: "block_unknown_host" });
  });

  it("returns the security disposition as concrete proxy responses", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "production");
    vi.stubEnv("RAILWAY_PUBLIC_DOMAIN", "");
    vi.stubEnv("NEXT_PUBLIC_AIR_JAM_PUBLIC_HOST", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://airjam.io");
    vi.stubEnv("BETTER_AUTH_URL", "https://airjam.io");
    vi.stubEnv("BETTER_AUTH_TRUSTED_ORIGINS", "https://airjam.io");
    vi.stubEnv(
      "AIRJAM_RELEASES_PUBLIC_ORIGIN",
      "https://airjamusercontent.net",
    );

    try {
      const direct = await proxy(
        new NextRequest(
          "https://airjamusercontent.net/releases/g/game-1/r/release-1/generations/generation-1/",
          { headers: { host: "airjamusercontent.net" } },
        ),
        makeEvent(),
      );
      const blocked = await proxy(
        new NextRequest("https://airjamusercontent.net/login", {
          headers: { host: "airjamusercontent.net" },
        }),
        makeEvent(),
      );
      const redirected = await proxy(
        new NextRequest(
          "https://airjam.io/releases/g/game-1/r/release-1/generations/generation-1/",
          {
            headers: { host: "airjam.io" },
          },
        ),
        makeEvent(),
      );

      expect(direct.headers.get("x-middleware-next")).toBe("1");
      expect(direct.headers.get("x-airjam-content-class")).toBe(
        "untrusted-release",
      );
      expect(blocked.status).toBe(404);
      expect(blocked.headers.get("cache-control")).toBe("no-store");
      expect(blocked.headers.get("x-airjam-content-class")).toBe(
        "untrusted-release",
      );
      expect(redirected.status).toBe(307);
      expect(redirected.headers.get("cache-control")).toBe("no-store");
      expect(redirected.headers.get("location")).toBe(
        "https://airjamusercontent.net/releases/g/game-1/r/release-1/generations/generation-1/",
      );

      vi.stubEnv("AIRJAM_RELEASES_PUBLIC_ORIGIN", "");
      const unavailable = await proxy(
        new NextRequest(
          "https://airjam.io/releases/g/game-1/r/release-1/generations/generation-1/",
          {
            headers: { host: "airjam.io" },
          },
        ),
        makeEvent(),
      );
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("cache-control")).toBe("no-store");
      expect(unavailable.headers.get("x-airjam-release-status")).toBe(
        "unavailable",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
