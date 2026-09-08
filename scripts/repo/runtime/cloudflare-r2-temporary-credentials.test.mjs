import assert from "node:assert/strict";
import test from "node:test";

import {
  createCloudflareR2TemporaryCredentials,
  verifyCloudflareR2TemporaryCredentials,
} from "../lib/cloudflare-r2-temporary-credentials.mjs";

const fixture = {
  endpoint: "https://account-1.r2.cloudflarestorage.com",
  accountId: "account-1",
  parentAccessKeyId: "parent-access",
  parentSecretAccessKey: "parent-secret",
  bucket: "air-jam-preview-releases",
  ttlSeconds: 3_600,
  now: Date.parse("2026-09-08T12:00:00.000Z"),
};

test("creates and verifies a bucket-scoped Cloudflare R2 session", () => {
  const credential = createCloudflareR2TemporaryCredentials(fixture);

  assert.deepEqual(
    verifyCloudflareR2TemporaryCredentials({
      ...fixture,
      ...credential,
      now: fixture.now + 1_000,
    }),
    {
      bucket: fixture.bucket,
      scope: "object-read-write",
      issuedAt: "2026-09-08T12:00:00.000Z",
      expiresAt: "2026-09-08T13:00:00.000Z",
      ttlSeconds: 3_600,
    },
  );
});

test("rejects a session when its staging bucket identity changes", () => {
  const credential = createCloudflareR2TemporaryCredentials(fixture);

  assert.throws(
    () =>
      verifyCloudflareR2TemporaryCredentials({
        ...fixture,
        ...credential,
        bucket: "air-jam-releases",
        now: fixture.now + 1_000,
      }),
    /identity or bucket scope does not match staging/u,
  );
});

test("rejects tampered session and derived secret material", () => {
  const credential = createCloudflareR2TemporaryCredentials(fixture);

  assert.throws(
    () =>
      verifyCloudflareR2TemporaryCredentials({
        ...fixture,
        ...credential,
        secretAccessKey: `${credential.secretAccessKey.slice(0, -1)}0`,
        now: fixture.now + 1_000,
      }),
    /not bound to its session token/u,
  );
  assert.throws(
    () =>
      verifyCloudflareR2TemporaryCredentials({
        ...fixture,
        ...credential,
        parentSecretAccessKey: "wrong-parent-secret",
        now: fixture.now + 1_000,
      }),
    /signature is invalid/u,
  );
});

test("rejects expired and overlong sessions", () => {
  const credential = createCloudflareR2TemporaryCredentials(fixture);
  assert.throws(
    () =>
      verifyCloudflareR2TemporaryCredentials({
        ...fixture,
        ...credential,
        now: fixture.now + fixture.ttlSeconds * 1_000,
      }),
    /has expired/u,
  );

  assert.throws(
    () =>
      createCloudflareR2TemporaryCredentials({
        ...fixture,
        ttlSeconds: 7 * 24 * 60 * 60 + 1,
      }),
    /TTL must be between/u,
  );
});
