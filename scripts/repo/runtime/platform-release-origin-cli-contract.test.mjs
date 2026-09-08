import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { verifyRailwayReleaseOriginAttestation } from "../commands/platform.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const cliPath = path.join(repoRoot, "scripts", "repo", "cli.mjs");
const deploymentIdentity = {
  provider: "railway",
  environment: "production",
  deploymentId: "fixture-deployment",
  revision: "fixture-revision",
};

const baseEnv = (overrides = {}) => ({
  PATH: process.env.PATH,
  CI: "1",
  NODE_ENV: "development",
  NEXT_PUBLIC_AIR_JAM_PUBLIC_HOST: "https://airjam.example",
  BETTER_AUTH_URL: "https://airjam.example",
  AIRJAM_RELEASES_PUBLIC_ORIGIN: "",
  ...overrides,
});

const readHelp = (...args) =>
  execFileSync(process.execPath, [cliPath, ...args, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

const inspectLocalReleaseOrigin = (overrides = {}) => {
  const output = execFileSync(
    process.execPath,
    [cliPath, "platform", "release-origin", "inspect", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: baseEnv(overrides),
    },
  );

  return JSON.parse(output);
};

const withReadinessServer = async (handler, run, hostname = "127.0.0.1") => {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, hostname, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const urlHostname = hostname.includes(":") ? `[${hostname}]` : hostname;

  try {
    return await run(`http://${urlHostname}:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
};

const inspectRemoteReleaseOrigin = async (platformUrl) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "platform",
      "release-origin",
      "inspect",
      "--platform-url",
      platformUrl,
      "--json",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: baseEnv(),
    },
  );
  return JSON.parse(stdout);
};

const attestReleaseOrigin = async ({ platformUrl, releaseUrl }) => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "platform",
      "release-origin",
      "attest",
      "--platform-url",
      platformUrl,
      "--release-url",
      releaseUrl,
      "--json",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: baseEnv(),
    },
  );
  return JSON.parse(stdout);
};

const startHttpServer = async (handler, hostname) => {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, hostname, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    origin: `http://${hostname}:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

const platformRequestPolicyFor = (request) => {
  assert.equal(typeof request.headers.host, "string");
  const platformPublicOrigin = `http://${request.headers.host}`;
  return {
    platformPublicOrigin,
    isRailwayPreviewEnvironment: false,
    platformRequestHosts: [new URL(platformPublicOrigin).host],
  };
};

const withAttestationFixture = async (
  { validReleasePolicy = true } = {},
  run,
) => {
  let platformOrigin = null;
  const releaseServer = await startHttpServer((request, response) => {
    const pathname = new URL(request.url, "http://fixture.invalid").pathname;
    if (pathname === "/dashboard") {
      response.writeHead(404, {
        "cache-control": "private, no-store",
        "content-type": "text/plain",
        "x-airjam-content-class": "untrusted-release",
      });
      response.end("not found");
      return;
    }

    if (
      pathname ===
        "/releases/g/fixture-game/r/fixture-release/generations/fixture-generation" ||
      pathname ===
        "/releases/g/fixture-game/r/fixture-release/generations/fixture-generation/controller"
    ) {
      assert.ok(platformOrigin);
      const policyIsValid =
        validReleasePolicy ||
        pathname ===
          "/releases/g/fixture-game/r/fixture-release/generations/fixture-generation/controller";
      response.writeHead(200, {
        "content-security-policy": [
          "default-src 'self' data: blob:",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
          "style-src 'self' 'unsafe-inline' https:",
          "img-src 'self' data: blob: https:",
          "font-src 'self' data: https:",
          "connect-src 'self' http: https: ws: wss:",
          "media-src 'self' blob: https:",
          "worker-src 'self' blob:",
          "frame-src 'self' http: https:",
          `frame-ancestors ${platformOrigin}`,
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self' https:",
        ].join("; "),
        "content-type": "text/html",
        "cross-origin-resource-policy": "same-origin",
        "permissions-policy": policyIsValid
          ? [
              "accelerometer=(self)",
              "autoplay=(self)",
              "camera=()",
              "encrypted-media=(self)",
              "fullscreen=(self)",
              "gamepad=(self)",
              "geolocation=()",
              "gyroscope=(self)",
              "microphone=()",
              "payment=()",
              "picture-in-picture=(self)",
              "usb=()",
            ].join(", ")
          : "x-camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        "referrer-policy": "no-referrer",
        "x-airjam-content-class": "untrusted-release",
        "x-content-type-options": "nosniff",
      });
      response.end("<!doctype html><title>Fixture release</title>");
      return;
    }

    response.writeHead(404);
    response.end();
  }, "localhost");

  const releaseUrl = `${releaseServer.origin}/releases/g/fixture-game/r/fixture-release/generations/fixture-generation`;
  const platformServer = await startHttpServer((request, response) => {
    const pathname = new URL(request.url, "http://fixture.invalid").pathname;
    if (pathname === "/api/readiness") {
      assert.equal(request.headers.accept, "application/json");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          service: "platform",
          deployment: deploymentIdentity,
          boundaries: {
            platformRequestPolicy: platformRequestPolicyFor(request),
            hostedReleaseOrigin: {
              required: true,
              status: "ready",
              publicOrigin: releaseServer.origin,
              reason: null,
            },
          },
        }),
      );
      return;
    }

    if (
      pathname ===
        "/releases/g/fixture-game/r/fixture-release/generations/fixture-generation" ||
      pathname ===
        "/releases/g/fixture-game/r/fixture-release/generations/fixture-generation/controller"
    ) {
      response.writeHead(307, {
        "cache-control": "no-store",
        location:
          pathname ===
          "/releases/g/fixture-game/r/fixture-release/generations/fixture-generation"
            ? releaseUrl
            : `${releaseUrl}/controller`,
      });
      response.end();
      return;
    }

    const expectedCorsStatus =
      pathname === "/api/auth/get-session"
        ? 200
        : pathname === "/api/cli/auth/me" || pathname === "/api/trpc/game.list"
          ? 401
          : pathname === "/api/cli/auth/device/poll"
            ? 400
            : pathname === "/api/cli/auth/device/approve"
              ? 401
              : null;
    if (expectedCorsStatus !== null) {
      assert.equal(request.headers.origin, releaseServer.origin);
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
      const errorCode =
        pathname === "/api/trpc/game.list"
          ? "UNAUTHORIZED"
          : pathname === "/api/cli/auth/device/poll"
            ? "validation_failed"
            : "unauthorized";
      response.writeHead(expectedCorsStatus, {
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      response.end(
        pathname === "/api/auth/get-session"
          ? "null"
          : JSON.stringify({ error: errorCode }),
      );
      return;
    }

    response.writeHead(404);
    response.end();
  }, "127.0.0.1");
  platformOrigin = platformServer.origin;

  try {
    return await run({
      platformOrigin,
      releaseOrigin: releaseServer.origin,
      releaseUrl,
    });
  } finally {
    await Promise.all([platformServer.close(), releaseServer.close()]);
  }
};

test("platform release-origin inspection is a discoverable repo CLI surface", () => {
  const platformHelp = readHelp("platform");
  const releaseOriginHelp = readHelp("platform", "release-origin");
  const inspectHelp = readHelp("platform", "release-origin", "inspect");

  assert.match(platformHelp, /release-origin/);
  assert.match(releaseOriginHelp, /inspect/);
  assert.match(inspectHelp, /AIRJAM_RELEASES_PUBLIC_ORIGIN/);
  assert.match(inspectHelp, /--platform-url/);
  assert.match(inspectHelp, /--json/);
  assert.match(inspectHelp, /without exposing credentials/);
});

test("platform release-origin attestation exposes the minimal deployed transport evidence contract", () => {
  const releaseOriginHelp = readHelp("platform", "release-origin");
  const attestHelp = readHelp("platform", "release-origin", "attest");

  assert.match(releaseOriginHelp, /attest/);
  assert.match(
    attestHelp,
    /Collect deployed transport evidence for routing, response policy, and auth\s+isolation/,
  );
  assert.match(attestHelp, /without executing\s+creator code/);
  assert.match(attestHelp, /--platform-url <origin>/);
  assert.match(attestHelp, /--release-url <url>/);
  assert.match(attestHelp, /--railway-project <id>/);
  assert.match(attestHelp, /required for production\s+evidence eligibility/);
  assert.match(attestHelp, /--json/);
  assert.doesNotMatch(attestHelp, /--play-url/);
  assert.doesNotMatch(attestHelp, /--profile/);
  assert.doesNotMatch(attestHelp, /--browser-executable-path/);
  assert.doesNotMatch(attestHelp, /closure eligible/i);
});

test("local inspection returns a stable secret-free ready assessment", () => {
  const result = inspectLocalReleaseOrigin({
    AIRJAM_RELEASES_PUBLIC_ORIGIN: "https://airjamusercontent.example",
    AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY: "must-not-appear",
  });

  assert.deepEqual(result, {
    contractVersion: 2,
    command: "release-origin.inspect",
    environmentKey: "AIRJAM_RELEASES_PUBLIC_ORIGIN",
    source: { type: "local" },
    assessment: {
      status: "ready",
      publicOrigin: "https://airjamusercontent.example",
      platformOrigin: "https://airjam.example",
      cookieSite: "airjamusercontent.example",
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /must-not-appear/);
});

test("local inspection reports disabled and invalid configuration without failing open", () => {
  const disabled = inspectLocalReleaseOrigin();
  assert.equal(disabled.assessment.status, "disabled");
  assert.equal(disabled.assessment.publicOrigin, null);
  assert.match(disabled.assessment.reason, /delivery is disabled/);

  const invalid = inspectLocalReleaseOrigin({
    AIRJAM_RELEASES_PUBLIC_ORIGIN: "https://games.airjam.example",
  });
  assert.equal(invalid.assessment.status, "invalid");
  assert.equal(invalid.assessment.publicOrigin, null);
  assert.match(invalid.assessment.reason, /separate cookie site/);
});

test("remote inspection reads the deployed readiness boundary through the same stable contract", async () => {
  await withReadinessServer(
    (request, response) => {
      assert.equal(request.url, "/api/readiness");
      assert.equal(request.headers.accept, "application/json");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          service: "platform",
          deployment: deploymentIdentity,
          boundaries: {
            platformRequestPolicy: platformRequestPolicyFor(request),
            hostedReleaseOrigin: {
              required: true,
              status: "ready",
              publicOrigin: "https://airjamusercontent.example",
              reason: null,
            },
          },
        }),
      );
    },
    async (platformUrl) => {
      const result = await inspectRemoteReleaseOrigin(platformUrl);
      assert.deepEqual(result, {
        contractVersion: 2,
        command: "release-origin.inspect",
        environmentKey: "AIRJAM_RELEASES_PUBLIC_ORIGIN",
        source: { type: "remote", platformOrigin: platformUrl },
        readiness: { httpStatus: 200, ok: true },
        deployment: deploymentIdentity,
        requestPolicy: platformRequestPolicyFor({
          headers: { host: new URL(platformUrl).host },
        }),
        assessment: {
          required: true,
          status: "ready",
          publicOrigin: "https://airjamusercontent.example",
          reason: null,
        },
      });
    },
  );
});

test("remote inspection returns valid unready 503 disabled and invalid boundaries", async () => {
  for (const status of ["disabled", "invalid"]) {
    await withReadinessServer(
      (request, response) => {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            service: "platform",
            deployment: deploymentIdentity,
            boundaries: {
              platformRequestPolicy: platformRequestPolicyFor(request),
              hostedReleaseOrigin: {
                required: true,
                status,
                publicOrigin: null,
                reason: `Hosted release origin is ${status}.`,
              },
            },
          }),
        );
      },
      async (platformUrl) => {
        const result = await inspectRemoteReleaseOrigin(platformUrl);
        assert.deepEqual(result, {
          contractVersion: 2,
          command: "release-origin.inspect",
          environmentKey: "AIRJAM_RELEASES_PUBLIC_ORIGIN",
          source: { type: "remote", platformOrigin: platformUrl },
          readiness: { httpStatus: 503, ok: false },
          deployment: deploymentIdentity,
          requestPolicy: platformRequestPolicyFor({
            headers: { host: new URL(platformUrl).host },
          }),
          assessment: {
            required: true,
            status,
            publicOrigin: null,
            reason: `Hosted release origin is ${status}.`,
          },
        });
      },
    );
  }
});

test("remote inspection rejects request-policy identity drift", async () => {
  await withReadinessServer(
    (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          service: "platform",
          deployment: deploymentIdentity,
          boundaries: {
            platformRequestPolicy: {
              platformPublicOrigin: "https://other.airjam.example",
              isRailwayPreviewEnvironment: false,
              platformRequestHosts: ["other.airjam.example"],
            },
            hostedReleaseOrigin: {
              required: true,
              status: "ready",
              publicOrigin: "https://airjamusercontent.example",
              reason: null,
            },
          },
        }),
      );
    },
    async (platformUrl) => {
      await assert.rejects(inspectRemoteReleaseOrigin(platformUrl), (error) => {
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.error.code, "REMOTE_CONTRACT_INVALID");
        assert.match(payload.error.message, /not the inspected origin/);
        return true;
      });
    },
  );
});

test("remote inspection fails on malformed readiness responses and unsupported non-2xx statuses", async () => {
  await withReadinessServer(
    (request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: false,
          service: "platform",
          deployment: deploymentIdentity,
          boundaries: {
            platformRequestPolicy: platformRequestPolicyFor(request),
            hostedReleaseOrigin: {
              required: false,
              status: "disabled",
              publicOrigin: null,
              reason: "Hosted release origin is disabled.",
            },
          },
        }),
      );
    },
    async (platformUrl) => {
      await assert.rejects(inspectRemoteReleaseOrigin(platformUrl), (error) => {
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.error.code, "REMOTE_CONTRACT_INVALID");
        assert.match(payload.error.message, /does not match/);
        return true;
      });
    },
  );

  await withReadinessServer(
    (request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    },
    async (platformUrl) => {
      await assert.rejects(inspectRemoteReleaseOrigin(platformUrl), (error) => {
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.error.code, "REMOTE_CONTRACT_INVALID");
        assert.match(
          payload.error.message,
          /deployment, request-policy, and hosted-release boundary contracts/,
        );
        return true;
      });
    },
  );

  await withReadinessServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "platform" }));
    },
    async (platformUrl) => {
      await assert.rejects(inspectRemoteReleaseOrigin(platformUrl), (error) => {
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.error.code, "REMOTE_CONTRACT_INVALID");
        assert.match(
          payload.error.message,
          /deployment, request-policy, and hosted-release boundary contracts/,
        );
        return true;
      });
    },
  );

  await withReadinessServer(
    (_request, response) => {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    },
    async (platformUrl) => {
      await assert.rejects(inspectRemoteReleaseOrigin(platformUrl), (error) => {
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.error.code, "REMOTE_HTTP_ERROR");
        assert.match(payload.error.message, /HTTP 502/);
        return true;
      });
    },
  );
});

test("remote inspection rejects a URL that is not a credential-free origin", async () => {
  await assert.rejects(
    inspectRemoteReleaseOrigin("https://user:secret@airjam.io/private"),
    (error) => {
      const payload = JSON.parse(error.stdout);
      assert.equal(payload.error.code, "INVALID_PLATFORM_URL");
      assert.doesNotMatch(error.stdout, /user:secret/);
      return true;
    },
  );
});

test("remote inspection rejects non-public destinations before connecting", async () => {
  await assert.rejects(
    inspectRemoteReleaseOrigin("https://10.0.0.1"),
    (error) => {
      const payload = JSON.parse(error.stdout);
      assert.equal(payload.error.code, "REMOTE_REQUEST_FAILED");
      assert.match(payload.error.message, /allowed address set/);
      return true;
    },
  );
});

test("remote inspection supports explicit IPv6 loopback diagnostics", async () => {
  await withReadinessServer(
    (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          service: "platform",
          deployment: deploymentIdentity,
          boundaries: {
            platformRequestPolicy: platformRequestPolicyFor(request),
            hostedReleaseOrigin: {
              required: false,
              status: "ready",
              publicOrigin: "http://localhost:3001",
              reason: null,
            },
          },
        }),
      );
    },
    async (platformUrl) => {
      const result = await inspectRemoteReleaseOrigin(platformUrl);
      assert.equal(result.source.platformOrigin, platformUrl);
      assert.equal(result.readiness.ok, true);
    },
    "::1",
  );
});

test("attestation independently rejects a sibling cookie-site release origin", async () => {
  await assert.rejects(
    attestReleaseOrigin({
      platformUrl: "http://platform.airjam.localhost",
      releaseUrl:
        "http://games.airjam.localhost/releases/g/game/r/release/generations/generation",
    }),
    (error) => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.status, "failed");
      assert.equal(result.productionEvidenceEligible, false);
      assert.deepEqual(
        result.checks.find(
          (item) => item.id === "boundary.cookie-site-isolation",
        ),
        {
          id: "boundary.cookie-site-isolation",
          status: "failed",
          summary:
            "The release origin uses a cookie site distinct from the authenticated platform.",
          evidence: {
            platformCookieSite: "airjam.localhost",
            releaseCookieSite: "airjam.localhost",
          },
        },
      );
      return true;
    },
  );
});

test("loopback HTTP attestation proves the multi-origin contract as diagnostic evidence", async () => {
  await withAttestationFixture(
    {},
    async ({ platformOrigin, releaseOrigin, releaseUrl }) => {
      const result = await attestReleaseOrigin({
        platformUrl: platformOrigin,
        releaseUrl,
      });

      assert.deepEqual(
        {
          contractVersion: result.contractVersion,
          command: result.command,
          status: result.status,
          evidenceKind: result.evidenceKind,
          productionEvidenceCandidate: result.productionEvidenceCandidate,
          productionEvidenceEligible: result.productionEvidenceEligible,
          providerVerification: result.providerVerification,
          attestedAt: result.attestedAt,
          source: result.source,
          summary: result.summary,
        },
        {
          contractVersion: 2,
          command: "release-origin.attest",
          status: "passed",
          evidenceKind: "diagnostic",
          productionEvidenceCandidate: false,
          productionEvidenceEligible: false,
          providerVerification: {
            status: "not-performed",
            provider: "railway",
          },
          attestedAt: result.attestedAt,
          source: {
            platformOrigin,
            releaseOrigin,
            releaseUrl,
            controllerUrl: `${releaseUrl}/controller`,
            deployment: deploymentIdentity,
          },
          summary: { passed: 19, failed: 0 },
        },
      );
      assert.equal(
        new Date(result.attestedAt).toISOString(),
        result.attestedAt,
      );

      assert.deepEqual(
        result.checks.map(({ id, status }) => ({ id, status })),
        [
          { id: "boundary.cookie-site-isolation", status: "passed" },
          { id: "network.127.0.0.1.dns", status: "passed" },
          { id: "network.localhost.dns", status: "passed" },
          { id: "network.127.0.0.1.tls", status: "passed" },
          { id: "network.localhost.tls", status: "passed" },
          { id: "platform.readiness-boundary", status: "passed" },
          { id: "routing.platform-host-to-release", status: "passed" },
          { id: "routing.platform-controller-to-release", status: "passed" },
          { id: "routing.release-host-platform-block", status: "passed" },
          { id: "response.host-release-policy", status: "passed" },
          { id: "response.controller-release-policy", status: "passed" },
          { id: "cors.machine-auth", status: "passed" },
          { id: "cors.browser-session", status: "passed" },
          { id: "cors.dashboard-api", status: "passed" },
          { id: "cors.device-poll", status: "passed" },
          { id: "cors.device-approval", status: "passed" },
          { id: "cors.device-poll-preflight", status: "passed" },
          { id: "cors.device-approval-preflight", status: "passed" },
          { id: "platform.deployment-stability", status: "passed" },
        ],
      );
      assert.deepEqual(result.summary, { passed: 19, failed: 0 });

      const cookieSite = result.checks.find(
        (item) => item.id === "boundary.cookie-site-isolation",
      );
      assert.deepEqual(cookieSite.evidence, {
        platformCookieSite: "127.0.0.1",
        releaseCookieSite: "localhost",
      });

      const tlsChecks = result.checks.filter((item) =>
        item.id.endsWith(".tls"),
      );
      assert.equal(tlsChecks.length, 2);
      assert.ok(
        tlsChecks.every((item) => item.evidence?.mode === "loopback-http"),
      );

      const redirect = result.checks.find(
        (item) => item.id === "routing.platform-host-to-release",
      );
      assert.deepEqual(redirect.evidence, {
        httpStatus: 307,
        cacheControl: "no-store",
        contentClass: null,
        location: releaseUrl,
      });

      const releaseHostBlock = result.checks.find(
        (item) => item.id === "routing.release-host-platform-block",
      );
      assert.deepEqual(releaseHostBlock.evidence, {
        httpStatus: 404,
        cacheControl: "private, no-store",
        contentClass: "untrusted-release",
        setCookiePresent: false,
      });

      const releasePolicy = result.checks.find(
        (item) => item.id === "response.host-release-policy",
      );
      assert.deepEqual(releasePolicy.evidence, {
        httpStatus: 200,
        cacheControl: null,
        contentClass: "untrusted-release",
        contentType: "text/html",
        exactPolicy: true,
        contentTypeOptionsExact: true,
        setCookiePresent: false,
      });

      const cors = result.checks.find(
        (item) => item.id === "cors.machine-auth",
      );
      assert.deepEqual(cors.evidence, {
        httpStatus: 401,
        expectedStatus: 401,
        jsonContentType: true,
        errorCodeMatched: true,
        releaseOriginAllowed: false,
        credentialsAllowed: false,
      });

      const browserSession = result.checks.find(
        (item) => item.id === "cors.browser-session",
      );
      assert.deepEqual(browserSession.evidence, {
        httpStatus: 200,
        jsonContentType: true,
        anonymousSession: true,
        releaseOriginAllowed: false,
        credentialsAllowed: false,
        setCookiePresent: false,
      });
    },
  );
});

test("HTTP attestation emits stable failed JSON and exits nonzero when the live release policy drifts", async () => {
  await withAttestationFixture(
    { validReleasePolicy: false },
    async ({ platformOrigin, releaseOrigin, releaseUrl }) => {
      await assert.rejects(
        attestReleaseOrigin({ platformUrl: platformOrigin, releaseUrl }),
        (error) => {
          assert.equal(error.code, 1);
          assert.equal(error.stderr, "");
          const result = JSON.parse(error.stdout);
          assert.deepEqual(
            {
              contractVersion: result.contractVersion,
              command: result.command,
              status: result.status,
              evidenceKind: result.evidenceKind,
              productionEvidenceCandidate: result.productionEvidenceCandidate,
              productionEvidenceEligible: result.productionEvidenceEligible,
              providerVerification: result.providerVerification,
              attestedAt: result.attestedAt,
              source: result.source,
              summary: result.summary,
            },
            {
              contractVersion: 2,
              command: "release-origin.attest",
              status: "failed",
              evidenceKind: "diagnostic",
              productionEvidenceCandidate: false,
              productionEvidenceEligible: false,
              providerVerification: {
                status: "not-performed",
                provider: "railway",
              },
              attestedAt: result.attestedAt,
              source: {
                platformOrigin,
                releaseOrigin,
                releaseUrl,
                controllerUrl: `${releaseUrl}/controller`,
                deployment: deploymentIdentity,
              },
              summary: { passed: 18, failed: 1 },
            },
          );
          assert.equal(
            new Date(result.attestedAt).toISOString(),
            result.attestedAt,
          );
          assert.equal(result.checks.length, 19);
          assert.deepEqual(
            result.checks.find(
              (item) => item.id === "response.host-release-policy",
            ),
            {
              id: "response.host-release-policy",
              status: "failed",
              summary:
                "The exact live release document carries the isolated HTML policy and sets no cookie.",
              evidence: {
                httpStatus: 200,
                cacheControl: null,
                contentClass: "untrusted-release",
                contentType: "text/html",
                exactPolicy: false,
                contentTypeOptionsExact: true,
                setCookiePresent: false,
              },
            },
          );
          return true;
        },
      );
    },
  );
});

test("attestation rejects non-canonical release URLs without echoing query credentials", async () => {
  const token = "must-not-appear-in-machine-output";
  const invalidReleaseUrls = [
    `http://localhost:1/releases/g/game/r/release/generations/generation/?token=${token}`,
    "http://localhost:1/releases/g/game/r/release/generations/generation/",
    "http://localhost:1/releases/g/game/r/release/generations/generation/index.html",
  ];

  for (const releaseUrl of invalidReleaseUrls) {
    await assert.rejects(
      attestReleaseOrigin({
        platformUrl: "http://127.0.0.1:1",
        releaseUrl,
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stderr, "");
        const result = JSON.parse(error.stdout);
        assert.deepEqual(
          {
            contractVersion: result.contractVersion,
            command: result.command,
            error: result.error,
          },
          {
            contractVersion: 2,
            command: "release-origin.attest",
            error: {
              code: "INVALID_RELEASE_URL",
              message:
                "--release-url must use HTTPS except for loopback diagnostics and identify the exact /releases/g/{gameId}/r/{releaseId}/generations/{generationId} host root without credentials, a query, a fragment, or a trailing slash.",
            },
          },
        );
        assert.doesNotMatch(error.stdout, new RegExp(token));
        assert.doesNotMatch(error.stdout, /index\.html/);
        return true;
      },
    );
  }
});

test("HTTPS loopback can only produce failed diagnostic evidence", async () => {
  await assert.rejects(
    attestReleaseOrigin({
      platformUrl: "https://127.0.0.1:1",
      releaseUrl:
        "https://127.0.0.1:1/releases/g/fixture-game/r/fixture-release/generations/fixture-generation",
    }),
    (error) => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.contractVersion, 2);
      assert.equal(result.command, "release-origin.attest");
      assert.equal(result.status, "failed");
      assert.equal(result.evidenceKind, "diagnostic");
      assert.equal(result.productionEvidenceCandidate, false);
      assert.equal(result.productionEvidenceEligible, false);
      assert.deepEqual(result.providerVerification, {
        status: "not-performed",
        provider: "railway",
      });
      assert.ok(result.summary.failed > 0);
      assert.ok(
        result.checks
          .filter((item) => item.id.endsWith(".tls"))
          .every((item) => item.status === "failed"),
      );
      return true;
    },
  );
});

const productionAttestationCandidate = () => ({
  contractVersion: 2,
  command: "release-origin.attest",
  status: "passed",
  evidenceKind: "diagnostic",
  productionEvidenceCandidate: true,
  productionEvidenceEligible: false,
  providerVerification: {
    status: "not-performed",
    provider: "railway",
  },
  attestedAt: "2026-08-30T07:00:00.000Z",
  source: {
    platformOrigin: "https://airjam.io",
    releaseOrigin: "https://airjamusercontent.example",
    releaseUrl:
      "https://airjamusercontent.example/releases/g/game/r/release/generations/generation",
    controllerUrl:
      "https://airjamusercontent.example/releases/g/game/r/release/generations/generation/controller",
    deployment: {
      provider: "railway",
      environment: "production",
      deploymentId: "deployment-platform",
      revision: "commit-sha",
    },
  },
  checks: [],
  summary: { passed: 0, failed: 0 },
});

const railwayProviderClient = ({
  domains = ["airjam.io", "airjamusercontent.example"],
} = {}) => ({
  getDeployment: async () => ({
    id: "deployment-platform",
    status: "SUCCESS",
    environmentId: "environment-production",
    serviceId: "service-platform",
  }),
  getEnvironment: async () => ({
    id: "environment-production",
    name: "production",
    projectId: "project-airjam",
    serviceInstances: [
      {
        serviceId: "service-platform",
        latestDeployment: { id: "deployment-platform" },
        domains: {
          customDomains: domains.map((domain) => ({ domain })),
          serviceDomains: [],
        },
      },
    ],
  }),
});

test("provider verification independently promotes only the matching Railway production deployment", async () => {
  const result = await verifyRailwayReleaseOriginAttestation({
    result: productionAttestationCandidate(),
    expectedProjectId: "project-airjam",
    client: railwayProviderClient(),
    tokenAvailable: true,
  });

  assert.equal(result.status, "passed");
  assert.equal(result.evidenceKind, "production-deployment");
  assert.equal(result.productionEvidenceEligible, true);
  assert.equal(result.providerVerification.status, "verified");
  assert.deepEqual(result.summary, { passed: 1, failed: 0 });
  assert.deepEqual(result.checks.at(-1), {
    id: "provider.railway-deployment",
    status: "passed",
    summary:
      "Railway independently confirms the production project, service, current deployment, and both public domains.",
    evidence: {
      productionEnvironment: true,
      successfulDeployment: true,
      currentServiceDeployment: true,
      platformDomainMatched: true,
      releaseDomainMatched: true,
      expectedProjectMatched: true,
    },
  });
});

test("provider verification fails closed on a mismatched platform domain", async () => {
  const result = await verifyRailwayReleaseOriginAttestation({
    result: productionAttestationCandidate(),
    expectedProjectId: "project-airjam",
    client: railwayProviderClient({
      domains: ["attacker.example", "airjamusercontent.example"],
    }),
    tokenAvailable: true,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.evidenceKind, "diagnostic");
  assert.equal(result.productionEvidenceEligible, false);
  assert.equal(result.providerVerification.status, "mismatch");
  assert.deepEqual(result.summary, { passed: 0, failed: 1 });
  assert.equal(result.checks.at(-1).status, "failed");
});

test("provider verification fails closed on a mismatched release domain", async () => {
  const result = await verifyRailwayReleaseOriginAttestation({
    result: productionAttestationCandidate(),
    expectedProjectId: "project-airjam",
    client: railwayProviderClient({
      domains: ["airjam.io", "attacker.example"],
    }),
    tokenAvailable: true,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.evidenceKind, "diagnostic");
  assert.equal(result.productionEvidenceEligible, false);
  assert.equal(result.providerVerification.status, "mismatch");
  assert.equal(result.providerVerification.platformDomainMatched, true);
  assert.equal(result.providerVerification.releaseDomainMatched, false);
});

test("provider verification distinguishes lookup failure from identity mismatch", async () => {
  const result = await verifyRailwayReleaseOriginAttestation({
    result: productionAttestationCandidate(),
    expectedProjectId: "project-airjam",
    client: {
      getDeployment: async () => {
        throw new Error("provider unavailable");
      },
      getEnvironment: async () => {
        throw new Error("not reached");
      },
    },
    tokenAvailable: true,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.evidenceKind, "diagnostic");
  assert.equal(result.productionEvidenceEligible, false);
  assert.equal(result.providerVerification.status, "failed");
  assert.equal(
    result.providerVerification.failureCode,
    "provider_request_failed",
  );
  assert.match(result.providerVerification.reason, /provider unavailable/u);
  assert.deepEqual(result.summary, { passed: 0, failed: 1 });
  assert.deepEqual(result.checks.at(-1), {
    id: "provider.railway-deployment",
    status: "failed",
    summary: "Railway provider verification could not be completed.",
    evidence: { failureCode: "provider_request_failed" },
  });
});

test("a public production claim stays diagnostic without an expected Railway project", async () => {
  const result = await verifyRailwayReleaseOriginAttestation({
    result: productionAttestationCandidate(),
    expectedProjectId: null,
    client: railwayProviderClient(),
    tokenAvailable: true,
  });

  assert.equal(result.status, "passed");
  assert.equal(result.evidenceKind, "diagnostic");
  assert.equal(result.productionEvidenceEligible, false);
  assert.deepEqual(result.providerVerification, {
    status: "unavailable",
    provider: "railway",
    reason:
      "An expected Railway project ID is required for production evidence eligibility.",
  });
});

test("a public production claim stays diagnostic when provider credentials are unavailable", async () => {
  const result = await verifyRailwayReleaseOriginAttestation({
    result: productionAttestationCandidate(),
    expectedProjectId: "project-airjam",
    tokenAvailable: false,
  });

  assert.equal(result.status, "passed");
  assert.equal(result.evidenceKind, "diagnostic");
  assert.equal(result.productionEvidenceEligible, false);
  assert.deepEqual(result.providerVerification, {
    status: "unavailable",
    provider: "railway",
    reason: "No Railway API token is configured for provider verification.",
  });
});
