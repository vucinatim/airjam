import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deployGoldenPathStaging,
  emptyGoldenPathStagingBucket,
  provisionGoldenPathStaging,
} from "../lib/golden-path-staging-lifecycle.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const cliPath = path.join(repoRoot, "scripts", "repo", "cli.mjs");
const projectId = "project-airjam";
const productionId = "environment-production";
const stagingId = "environment-staging";
const serviceNames = [
  "air-jam-platform",
  "air-jam-platform-worker",
  "air-jam-release-browser-worker",
  "air-jam-server",
];

const createEnvironment = ({ production }) => {
  const suffix = production ? "production" : "staging";
  return {
    id: production ? productionId : stagingId,
    name: production ? "production" : "staging-golden-path-test",
    projectId,
    isEphemeral: !production,
    sourceEnvironment: production ? null : { id: productionId },
    serviceInstances: [
      ...serviceNames.map((serviceName) => ({
        id: `${serviceName}-instance-${suffix}`,
        serviceId: `${serviceName}-service`,
        serviceName,
        railwayConfigFile:
          serviceName === "air-jam-platform"
            ? "/apps/platform/railway.json"
            : serviceName === "air-jam-server"
              ? "/packages/server/railway.json"
              : serviceName === "air-jam-release-browser-worker"
                ? "/packages/release-browser-worker/railway.json"
                : null,
        latestDeployment: null,
        domains: {
          serviceDomains: [
            { domain: `${serviceName}-${suffix}.up.railway.app` },
          ],
          customDomains:
            !production && serviceName === "air-jam-platform"
              ? [{ domain: "games-staging.air-jam.app" }]
              : [],
        },
      })),
      {
        id: `postgres-instance-${suffix}`,
        serviceId: "postgres-service",
        serviceName: "Postgres",
        railwayConfigFile: null,
        latestDeployment: null,
        domains: { serviceDomains: [], customDomains: [] },
      },
    ],
  };
};

const initialVariables = ({ environmentId, serviceName }) => {
  const production = environmentId === productionId;
  const suffix = production ? "production" : "staging";
  const common = {
    RAILWAY_ENVIRONMENT_ID: environmentId,
    RAILWAY_ENVIRONMENT_NAME: production
      ? "production"
      : "staging-golden-path-test",
    RAILWAY_PROJECT_ID: projectId,
    RAILWAY_SERVICE_ID: `${serviceName}-service`,
    NODE_ENV: "production",
  };
  if (serviceName === "air-jam-platform") {
    return {
      ...common,
      DATABASE_URL: `postgresql://${suffix}.railway.internal/railway`,
      AIRJAM_RELEASES_R2_ACCOUNT_ID: "cloudflare-account",
      AIRJAM_RELEASES_R2_BUCKET: "air-jam-releases",
      AIRJAM_RELEASES_R2_ACCESS_KEY_ID: "parent-access",
      AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY: "parent-secret",
      AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN: "production-internal",
      AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN: "production-browser",
      AIRJAM_RELEASES_BROWSER_WS_ENDPOINT:
        "wss://browser-production.example/ws",
      AIRJAM_RELEASES_PUBLIC_ORIGIN: "https://games.air-jam.app",
      AIR_JAM_HOST_GRANT_SECRET: "production-host",
      AIR_JAM_MASTER_KEY: "production-master",
      AIR_JAM_SYSTEM_APP_ID: "production-app",
      BETTER_AUTH_SECRET: "production-auth",
      BETTER_AUTH_URL: "https://airjam.io",
      GITHUB_CLIENT_ID: "production-github-id",
      GITHUB_CLIENT_SECRET: "production-github-secret",
      NEXT_PUBLIC_AIR_JAM_APP_ID: "production-app",
      NEXT_PUBLIC_AIR_JAM_PUBLIC_HOST: "https://airjam.io",
      NEXT_PUBLIC_AIR_JAM_SERVER_URL: "https://api.airjam.io",
      NEXT_PUBLIC_APP_URL: "https://airjam.io",
      NEXT_PUBLIC_AUTH_GITHUB_ENABLED: "true",
      OPENAI_API_KEY: "production-openai",
    };
  }
  if (serviceName === "air-jam-platform-worker") {
    return {
      ...common,
      DATABASE_URL: `postgresql://${suffix}.railway.internal/railway`,
      AIRJAM_RELEASES_R2_ACCOUNT_ID: "cloudflare-account",
      AIRJAM_RELEASES_R2_BUCKET: "air-jam-releases",
      AIRJAM_RELEASES_R2_ACCESS_KEY_ID: "parent-access",
      AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY: "parent-secret",
      AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN: "production-internal",
      AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN: "production-browser",
      AIRJAM_RELEASES_BROWSER_WS_ENDPOINT:
        "wss://browser-production.example/ws",
      AIRJAM_RELEASES_PUBLIC_ORIGIN: "https://games.air-jam.app",
      AIRJAM_PLATFORM_WORKER_CONTROL_TOKEN: "production-worker",
      AIRJAM_SYNTHETIC_APP_ID: "production-app",
      AIRJAM_SYNTHETIC_BROWSER_WORKER_ORIGIN:
        "https://browser-production.example",
      AIRJAM_SYNTHETIC_HOSTED_RELEASE_URL:
        "https://games.air-jam.app/releases/example",
      AIRJAM_SYNTHETIC_WORKER_ORIGIN: "https://worker-production.example",
      AIR_JAM_SYSTEM_APP_ID: "production-app",
      NEXT_PUBLIC_AIR_JAM_APP_ID: "production-app",
      NEXT_PUBLIC_AIR_JAM_PUBLIC_HOST: "https://airjam.io",
      NEXT_PUBLIC_AIR_JAM_SERVER_URL: "https://api.airjam.io",
      NEXT_PUBLIC_APP_URL: "https://airjam.io",
    };
  }
  if (serviceName === "air-jam-server") {
    return {
      ...common,
      DATABASE_URL: `postgresql://${suffix}.railway.internal/railway`,
      AIR_JAM_ALLOWED_ORIGINS: "https://airjam.io",
      AIR_JAM_AUTH_MODE: "required",
      AIR_JAM_HOST_GRANT_SECRET: "production-host",
      AIR_JAM_MASTER_KEY: "production-master",
    };
  }
  return {
    ...common,
    AIRJAM_BROWSER_WORKER_ACCESS_TOKEN: "production-browser",
  };
};

const createFixture = () => {
  const production = createEnvironment({ production: true });
  const staging = createEnvironment({ production: false });
  const variables = new Map();
  for (const environment of [production, staging]) {
    for (const serviceName of serviceNames) {
      variables.set(
        `${environment.id}:${serviceName}-service`,
        initialVariables({ environmentId: environment.id, serviceName }),
      );
    }
  }
  const writes = [];
  const deployments = [];
  return {
    staging,
    writes,
    deployments,
    variables,
    client: {
      getProject: async () => ({
        id: projectId,
        name: "air-jam",
        primaryEnvironmentId: productionId,
        baseEnvironmentId: productionId,
      }),
      getEnvironment: async (id) =>
        id === productionId ? production : staging,
      getVariables: async ({ environmentId, serviceId }) => ({
        ...variables.get(`${environmentId}:${serviceId}`),
      }),
      upsertVariableCollection: async ({
        environmentId,
        serviceId,
        variables: updates,
        skipDeploys,
      }) => {
        assert.equal(environmentId, stagingId);
        assert.equal(skipDeploys, true);
        const key = `${environmentId}:${serviceId}`;
        variables.set(key, { ...variables.get(key), ...updates });
        writes.push({ serviceId, names: Object.keys(updates).sort() });
        return true;
      },
      triggerServiceDeployment: async ({ serviceId, commitSha }) => {
        const deploymentId = `deployment-${serviceId}`;
        deployments.push({ serviceId, commitSha, deploymentId });
        return deploymentId;
      },
      waitForDeployment: async ({ deploymentId }) => {
        const deployment = deployments.find(
          (candidate) => candidate.deploymentId === deploymentId,
        );
        const service = staging.serviceInstances.find(
          (candidate) => candidate.serviceId === deployment.serviceId,
        );
        service.latestDeployment = { id: deploymentId, status: "SUCCESS" };
        return { ok: true, deployment: service.latestDeployment };
      },
    },
  };
};

test("golden-path staging CLI exposes non-secret provisioning and cleanup", () => {
  const help = execFileSync(
    process.execPath,
    [cliPath, "golden-path", "staging", "--help"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.match(help, /provision/u);
  assert.match(help, /status/u);
  assert.match(help, /empty-storage/u);
});

test("provision rotates every authority before deployment and proves R2 isolation", async () => {
  const fixture = createFixture();
  let probeCalled = false;
  const result = await provisionGoldenPathStaging({
    projectId,
    environmentId: stagingId,
    releaseOrigin: "https://games-staging.air-jam.app",
    r2Bucket: "air-jam-preview-releases",
    ttlSeconds: 3_600,
    client: fixture.client,
    probeR2Isolation: async ({
      stagingBucket,
      productionBucket,
      temporaryCredentials,
    }) => {
      probeCalled = true;
      assert.equal(stagingBucket, "air-jam-preview-releases");
      assert.equal(productionBucket, "air-jam-releases");
      assert.ok(temporaryCredentials.sessionToken);
      return {
        stagingWrite: true,
        productionReadDenied: true,
        productionWriteDenied: true,
        probeObjectRemoved: true,
      };
    },
  });

  assert.equal(probeCalled, true);
  assert.equal(fixture.writes.length, 4);
  assert.equal(result.ok, true);
  assert.equal(result.deploymentStarted, false);
  assert.equal(result.r2.bucket, "air-jam-preview-releases");
  assert.equal(result.r2.scope, "object-read-write");
  assert.equal(result.isolation.releaseStorageIsolated, true);
  assert.equal(result.isolation.applicationServiceInstancesDistinct, true);
  assert.doesNotMatch(JSON.stringify(result), /parent-secret|sessionToken/u);

  const platform = fixture.variables.get(
    `${stagingId}:air-jam-platform-service`,
  );
  const worker = fixture.variables.get(
    `${stagingId}:air-jam-platform-worker-service`,
  );
  const server = fixture.variables.get(`${stagingId}:air-jam-server-service`);
  const browser = fixture.variables.get(
    `${stagingId}:air-jam-release-browser-worker-service`,
  );
  assert.equal(platform.AIRJAM_RELEASES_R2_BUCKET, "air-jam-preview-releases");
  assert.ok(platform.AIRJAM_RELEASES_R2_SESSION_TOKEN);
  assert.equal(
    worker.AIRJAM_RELEASES_R2_SESSION_TOKEN,
    platform.AIRJAM_RELEASES_R2_SESSION_TOKEN,
  );
  assert.equal(
    browser.AIRJAM_BROWSER_WORKER_ACCESS_TOKEN,
    platform.AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN,
  );
  assert.equal(server.AIR_JAM_MASTER_KEY, platform.AIR_JAM_MASTER_KEY);
  assert.notEqual(server.AIR_JAM_MASTER_KEY, "production-master");
  assert.equal(platform.NEXT_PUBLIC_AUTH_GITHUB_ENABLED, "false");
  assert.equal(platform.OPENAI_API_KEY, "");
});

test("deploy starts data and application services in dependency order", async () => {
  const fixture = createFixture();
  await provisionGoldenPathStaging({
    projectId,
    environmentId: stagingId,
    releaseOrigin: "https://games-staging.air-jam.app",
    r2Bucket: "air-jam-preview-releases",
    ttlSeconds: 3_600,
    client: fixture.client,
    probeR2Isolation: async () => ({
      stagingWrite: true,
      productionReadDenied: true,
      productionWriteDenied: true,
      probeObjectRemoved: true,
    }),
  });
  const commitSha = "a".repeat(40);
  const stages = [];
  const result = await deployGoldenPathStaging({
    projectId,
    environmentId: stagingId,
    commitSha,
    client: fixture.client,
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      url: url.toString(),
      json: async () => ({ ok: true, service: "platform" }),
    }),
    onProgress: (stage) => stages.push(stage),
  });

  assert.equal(result.ok, true);
  assert.equal(result.commitSha, commitSha);
  assert.equal(result.deployments.length, 5);
  assert.deepEqual(
    fixture.deployments.map(({ serviceId, commitSha: sha }) => ({
      serviceId,
      commitSha: sha,
    })),
    [
      { serviceId: "postgres-service", commitSha: null },
      { serviceId: "air-jam-platform-service", commitSha },
      { serviceId: "air-jam-server-service", commitSha },
      { serviceId: "air-jam-release-browser-worker-service", commitSha },
      { serviceId: "air-jam-platform-worker-service", commitSha },
    ],
  );
  assert.equal(stages.at(0), "deploy:Postgres:trigger");
  assert.equal(stages.at(-1), "deploy:air-jam-platform-worker:success");
  assert.equal(result.target.isolation.releaseStorageIsolated, true);
});

test("deploy can safely retry an already-started isolated environment", async () => {
  const fixture = createFixture();
  await provisionGoldenPathStaging({
    projectId,
    environmentId: stagingId,
    releaseOrigin: "https://games-staging.air-jam.app",
    r2Bucket: "air-jam-preview-releases",
    ttlSeconds: 3_600,
    client: fixture.client,
    probeR2Isolation: async () => ({
      stagingWrite: true,
      productionReadDenied: true,
      productionWriteDenied: true,
      probeObjectRemoved: true,
    }),
  });
  fixture.staging.serviceInstances.find(
    (service) => service.serviceName === "air-jam-platform",
  ).latestDeployment = {
    id: "interrupted-platform-deployment",
    status: "FAILED",
  };

  const result = await deployGoldenPathStaging({
    projectId,
    environmentId: stagingId,
    commitSha: "b".repeat(40),
    client: fixture.client,
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      url: url.toString(),
      json: async () => ({ ok: true, service: "platform" }),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.deployments.length, 5);
});

test("destructive storage cleanup refuses Railway production explicitly", async () => {
  const production = createEnvironment({ production: true });
  await assert.rejects(
    emptyGoldenPathStagingBucket({
      projectId,
      environmentId: productionId,
      client: {
        getProject: async () => ({
          id: projectId,
          primaryEnvironmentId: productionId,
          baseEnvironmentId: productionId,
        }),
        getEnvironment: async () => production,
      },
    }),
    /cannot target Railway's primary or base environment/u,
  );
});
