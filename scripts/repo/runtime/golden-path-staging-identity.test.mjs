import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  provisionGoldenPathStagingIdentity,
  revokeGoldenPathStagingIdentity,
  verifyGoldenPathHiddenRelease,
} from "../lib/golden-path-staging-identity.mjs";

const stagingTarget = {
  projectId: "project-staging-proof",
  environmentId: "environment-staging-proof",
  url: "https://staging.example.test",
  productionAllowed: false,
};

test("golden-path identity is isolated, private, and validated before use", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "airjam-g2-identity-"));
  const statements = [];
  const postgresFactory = (databaseUrl, options) => ({
    begin: async (callback) =>
      callback((strings, ...values) => {
        statements.push({ strings: [...strings], values });
      }),
    end: async () => undefined,
    databaseUrl,
    options,
  });
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(
      JSON.stringify({
        platformBaseUrl: stagingTarget.url,
        user: {
          id: "golden-path-g2-auth-proof",
          name: "Golden Path g2-auth-proof",
          email: "golden-path-g2-auth-proof@example.com",
          role: "creator",
        },
        session: {
          id: "session-proof",
          createdAt: "2026-09-09T00:00:00.000Z",
          expiresAt: "2026-09-09T04:00:00.000Z",
          userAgent: "airjam-cli/golden-path-g2-auth-proof",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const result = await provisionGoldenPathStagingIdentity({
      databaseUrl: "postgresql://staging.example/db",
      stagingTarget,
      runId: "g2-auth-proof",
      stateDirectory: path.join(root, "state"),
      now: new Date("2026-09-09T00:00:00.000Z"),
      postgresFactory,
      fetchImpl,
    });
    const sessionPath = path.join(
      root,
      "state",
      "auth",
      "platform-session.json",
    );
    const stored = JSON.parse(fs.readFileSync(sessionPath, "utf8"));

    assert.equal(statements.length, 2);
    assert.equal(stored.user.id, "golden-path-g2-auth-proof");
    assert.equal(stored.session.token, result.token);
    assert.equal(result.record.validated, true);
    assert.equal("token" in result.record, false);
    assert.equal(fs.statSync(sessionPath).mode & 0o777, 0o600);
    assert.equal(
      requests[0].url,
      "https://staging.example.test/api/cli/auth/me",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("golden-path identity requires an attested staging database target", async () => {
  await assert.rejects(
    () =>
      provisionGoldenPathStagingIdentity({
        stagingTarget,
        runId: "g2-shared-database",
        stateDirectory: "/tmp/unused-golden-path-state",
      }),
    /did not expose its attested database target/u,
  );
});

test("controller verifies only a ready hidden unpublished staging release", async () => {
  const game = {
    id: "game-ready",
    slug: "signal-relay-g2-release-proof",
    name: "Signal Relay",
    description: null,
    url: null,
    arcadeVisibility: "hidden",
    sourceUrl: null,
    templateId: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  };
  const release = {
    id: "release-ready",
    gameId: "game-ready",
    sourceKind: "upload",
    status: "ready",
    candidateGenerationId: "generation-ready",
    promotedGenerationId: "generation-ready",
    versionLabel: "g2-release-proof",
    createdAt: "2026-09-09T00:00:00.000Z",
    uploadedAt: "2026-09-09T00:01:00.000Z",
    checkedAt: "2026-09-09T00:02:00.000Z",
    publishedAt: null,
    quarantinedAt: null,
    archivedAt: null,
    game,
    candidateGeneration: null,
    promotedGeneration: null,
    generations: [],
    checks: [],
    jobs: [],
    reports: [],
    hostUrl: null,
    controllerUrl: null,
  };
  const fetchImpl = async () =>
    new Response(JSON.stringify({ game, releases: [release] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const result = await verifyGoldenPathHiddenRelease({
    stagingTarget,
    runId: "g2-release-proof",
    token: "session-secret",
    fetchImpl,
  });

  assert.deepEqual(
    {
      status: result.status,
      arcadeVisibility: result.arcadeVisibility,
      publicRuntimeExposed: result.publicRuntimeExposed,
      productionAllowed: result.productionAllowed,
    },
    {
      status: "ready",
      arcadeVisibility: "hidden",
      publicRuntimeExposed: false,
      productionAllowed: false,
    },
  );
});

test("golden-path identity cleanup uses the public logout contract", async () => {
  let request;
  const result = await revokeGoldenPathStagingIdentity({
    stagingTarget,
    token: "session-secret",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result, "revoked");
  assert.equal(request.url, "https://staging.example.test/api/cli/auth/logout");
  assert.equal(request.options.method, "POST");
});
