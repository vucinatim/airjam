import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  platformMachineListReleasesResultSchema,
  platformMachineLogoutResultSchema,
  platformMachineMeResultSchema,
} from "@air-jam/sdk/platform-machine";
import postgres from "postgres";

const identityLifetimeMs = 4 * 60 * 60 * 1_000;

const writePrivateJson = (targetPath, value) => {
  // Keep this run-scoped synchronous writer aligned with the canonical session
  // store in packages/devtools-core/src/platform-auth.ts. Importing that source
  // would add a new root runtime dependency to the repo maintainer CLI.
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(targetPath), 0o700);
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(targetPath, 0o600);
};

const requestMachineApi = async ({
  stagingUrl,
  pathname,
  token,
  method = "GET",
  schema,
  fetchImpl = fetch,
}) => {
  const response = await fetchImpl(new URL(pathname, stagingUrl), {
    method,
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `Golden-path staging machine API ${pathname} failed with HTTP ${response.status}.`,
    );
  }
  return schema.parse(payload);
};

export const provisionGoldenPathStagingIdentity = async ({
  databaseUrl,
  stagingTarget,
  runId,
  stateDirectory,
  now = new Date(),
  postgresFactory = postgres,
  fetchImpl = fetch,
}) => {
  if (!databaseUrl) {
    throw new Error(
      "Golden-path staging did not expose its attested database target.",
    );
  }

  const userId = `golden-path-${runId}`;
  const user = {
    id: userId,
    name: `Golden Path ${runId}`,
    email: `${userId}@example.com`,
    role: "creator",
  };
  const session = {
    id: randomUUID(),
    token: randomBytes(32).toString("hex"),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + identityLifetimeMs).toISOString(),
    userAgent: `airjam-cli/golden-path-${runId}`,
  };
  const sql = postgresFactory(databaseUrl, {
    connect_timeout: 20,
    max: 1,
    prepare: false,
    ssl: "require",
  });
  try {
    await sql.begin(async (transaction) => {
      await transaction`
        insert into users (
          id, name, email, email_verified, role, created_at, updated_at
        ) values (
          ${user.id}, ${user.name}, ${user.email}, true, ${user.role},
          ${now}, ${now}
        )
        on conflict (id) do update set
          name = excluded.name,
          email = excluded.email,
          email_verified = excluded.email_verified,
          role = excluded.role,
          updated_at = excluded.updated_at
      `;
      await transaction`
        insert into sessions (
          id, user_id, token, expires_at, user_agent, created_at, updated_at
        ) values (
          ${session.id}, ${user.id}, ${session.token}, ${session.expiresAt},
          ${session.userAgent}, ${session.createdAt}, ${session.createdAt}
        )
      `;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }

  const storedAt = new Date().toISOString();
  try {
    writePrivateJson(
      path.join(stateDirectory, "auth", "platform-session.json"),
      {
        version: 1,
        platformBaseUrl: stagingTarget.url,
        clientName: `golden-path-${runId}`,
        storedAt,
        user,
        session,
      },
    );

    const profile = await requestMachineApi({
      stagingUrl: stagingTarget.url,
      pathname: "/api/cli/auth/me",
      token: session.token,
      schema: platformMachineMeResultSchema,
      fetchImpl,
    });
    if (profile?.user?.id !== user.id || profile?.user?.role !== "creator") {
      throw new Error(
        "Golden-path staging returned an unexpected machine identity after provisioning.",
      );
    }
  } catch (error) {
    await requestMachineApi({
      stagingUrl: stagingTarget.url,
      pathname: "/api/cli/auth/logout",
      method: "POST",
      token: session.token,
      schema: platformMachineLogoutResultSchema,
      fetchImpl,
    }).catch(() => undefined);
    fs.rmSync(path.join(stateDirectory, "auth", "platform-session.json"), {
      force: true,
    });
    throw error;
  }

  return {
    token: session.token,
    record: {
      provisioned: true,
      validated: true,
      platformBaseUrl: stagingTarget.url,
      userId: user.id,
      role: user.role,
      sessionId: session.id,
      storedAt,
      expiresAt: session.expiresAt,
    },
  };
};

export const verifyGoldenPathHiddenRelease = async ({
  stagingTarget,
  runId,
  token,
  fetchImpl = fetch,
}) => {
  const slug = `signal-relay-${runId}`;
  const payload = await requestMachineApi({
    stagingUrl: stagingTarget.url,
    pathname: `/api/cli/games/${encodeURIComponent(slug)}/releases`,
    token,
    schema: platformMachineListReleasesResultSchema,
    fetchImpl,
  });
  const releases = Array.isArray(payload?.releases) ? payload.releases : [];
  const release = releases.find(
    (candidate) =>
      candidate?.status === "ready" &&
      candidate?.game?.arcadeVisibility === "hidden" &&
      candidate?.publishedAt == null,
  );
  if (!release) {
    throw new Error(
      `Golden-path staging has no ready hidden unpublished release for ${slug}.`,
    );
  }
  if (release.hostUrl !== null || release.controllerUrl !== null) {
    throw new Error(
      "Golden-path hidden release unexpectedly exposed public runtime URLs.",
    );
  }

  return {
    verifiedAt: new Date().toISOString(),
    gameId: release.gameId,
    gameSlug: release.game.slug,
    releaseId: release.id,
    generationId: release.promotedGenerationId,
    status: release.status,
    arcadeVisibility: release.game.arcadeVisibility,
    publishedAt: release.publishedAt,
    publicRuntimeExposed: false,
    productionAllowed: false,
  };
};

export const revokeGoldenPathStagingIdentity = async ({
  stagingTarget,
  token,
  fetchImpl = fetch,
}) => {
  try {
    await requestMachineApi({
      stagingUrl: stagingTarget.url,
      pathname: "/api/cli/auth/logout",
      method: "POST",
      token,
      schema: platformMachineLogoutResultSchema,
      fetchImpl,
    });
    return "revoked";
  } catch {
    return "already-unavailable";
  }
};
