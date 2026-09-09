import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCloudflareR2TemporaryCredentials } from "../lib/cloudflare-r2-temporary-credentials.mjs";
import {
  assertGoldenPathStagingEnvironmentIsolation,
  resolveGoldenPathRailwayStagingRuntime,
  resolveGoldenPathRailwayStagingTarget,
} from "../lib/golden-path-staging-target.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const cliPath = path.join(repoRoot, "scripts", "repo", "cli.mjs");
const projectId = "project-airjam";
const productionEnvironmentId = "environment-production";
const stagingEnvironmentId = "environment-pr-52";
const databaseUrl =
  "postgresql://postgres:secret@postgres.railway.internal:5432/railway";
const r2AccountId = "cloudflare-account";
const r2Endpoint = `https://${r2AccountId}.r2.cloudflarestorage.com`;
const r2ParentAccessKeyId = "production-parent-access-key";
const r2ParentSecretAccessKey = "production-parent-secret-key";
const r2Now = Date.now();
const stagingR2Credential = createCloudflareR2TemporaryCredentials({
  endpoint: r2Endpoint,
  accountId: r2AccountId,
  parentAccessKeyId: r2ParentAccessKeyId,
  parentSecretAccessKey: r2ParentSecretAccessKey,
  bucket: "air-jam-staging-releases",
  ttlSeconds: 24 * 60 * 60,
  now: r2Now,
});
const applicationServices = [
  {
    serviceId: "service-platform",
    serviceName: "air-jam-platform",
    railwayConfigFile: "/apps/platform/railway.json",
  },
  {
    serviceId: "service-server",
    serviceName: "air-jam-server",
    railwayConfigFile: "/packages/server/railway.json",
  },
  {
    serviceId: "service-browser-worker",
    serviceName: "air-jam-release-browser-worker",
    railwayConfigFile: "/packages/release-browser-worker/railway.json",
  },
  {
    serviceId: "service-operational-worker",
    serviceName: "air-jam-platform-worker",
    railwayConfigFile: null,
  },
];

const createEnvironment = (id) => {
  const production = id === productionEnvironmentId;
  const suffix = production ? "production" : "staging";
  return {
    id,
    name: production ? "production" : "air-jam-pr-52",
    projectId,
    isEphemeral: !production,
    canAccess: true,
    sourceEnvironment: production ? null : { id: productionEnvironmentId },
    serviceInstances: [
      ...applicationServices.map((service) => ({
        ...service,
        id: `${service.serviceId}-instance-${suffix}`,
        latestDeployment: {
          id: `deployment-${service.serviceId}-${suffix}`,
          status: "SUCCESS",
        },
        domains: {
          customDomains:
            production && service.serviceId === "service-platform"
              ? [{ domain: "airjam.io" }]
              : [],
          serviceDomains: [
            {
              domain: `${service.serviceName}-${suffix}.up.railway.app`,
            },
          ],
        },
      })),
      {
        id: `postgres-instance-${suffix}`,
        serviceId: "service-postgres",
        serviceName: "Postgres",
        railwayConfigFile: null,
      },
    ],
  };
};

const createServiceVariables = ({ environmentId, serviceId }) => {
  const production = environmentId === productionEnvironmentId;
  const environmentName = production ? "production" : "air-jam-pr-52";
  const suffix = production ? "production" : "staging";
  const common = {
    RAILWAY_ENVIRONMENT_ID: environmentId,
    RAILWAY_ENVIRONMENT_NAME: environmentName,
    RAILWAY_PROJECT_ID: projectId,
    RAILWAY_SERVICE_ID: serviceId,
    NODE_ENV: "production",
  };
  if (serviceId === "service-postgres") {
    return {
      ...common,
      DATABASE_PUBLIC_URL: `postgresql://${suffix}.example.test/airjam`,
    };
  }
  if (serviceId === "service-platform") {
    return {
      ...common,
      DATABASE_URL: databaseUrl,
      AIRJAM_RELEASES_R2_BUCKET: `air-jam-${suffix}-releases`,
      AIRJAM_RELEASES_R2_ACCOUNT_ID: r2AccountId,
      AIRJAM_RELEASES_R2_ACCESS_KEY_ID: r2ParentAccessKeyId,
      AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY: production
        ? r2ParentSecretAccessKey
        : stagingR2Credential.secretAccessKey,
      ...(production
        ? {}
        : {
            AIRJAM_RELEASES_R2_SESSION_TOKEN: stagingR2Credential.sessionToken,
          }),
      AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN: `${suffix}-internal-token`,
      AIRJAM_RELEASES_BROWSER_WS_ENDPOINT: `wss://air-jam-release-browser-worker-${suffix}.up.railway.app/ws`,
      AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN: `${suffix}-browser-token`,
      BETTER_AUTH_SECRET: `${suffix}-auth-secret`,
    };
  }
  if (serviceId === "service-server") {
    return {
      ...common,
      DATABASE_URL: databaseUrl,
      AIR_JAM_MASTER_KEY: `${suffix}-master-key`,
      AIR_JAM_HOST_GRANT_SECRET: `${suffix}-host-secret`,
    };
  }
  if (serviceId === "service-operational-worker") {
    return {
      ...common,
      DATABASE_URL: databaseUrl,
      AIRJAM_RELEASES_R2_BUCKET: `air-jam-${suffix}-releases`,
      AIRJAM_RELEASES_R2_ACCOUNT_ID: r2AccountId,
      AIRJAM_RELEASES_R2_ACCESS_KEY_ID: r2ParentAccessKeyId,
      AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY: production
        ? r2ParentSecretAccessKey
        : stagingR2Credential.secretAccessKey,
      ...(production
        ? {}
        : {
            AIRJAM_RELEASES_R2_SESSION_TOKEN: stagingR2Credential.sessionToken,
          }),
      AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN: `${suffix}-internal-token`,
      AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN: `${suffix}-browser-token`,
      AIRJAM_RELEASES_BROWSER_WS_ENDPOINT: `wss://air-jam-release-browser-worker-${suffix}.up.railway.app/ws`,
      AIRJAM_PLATFORM_WORKER_CONTROL_TOKEN: `${suffix}-worker-token`,
    };
  }
  return {
    ...common,
    AIRJAM_BROWSER_WORKER_ACCESS_TOKEN: `${suffix}-browser-token`,
    AIRJAM_BROWSER_WORKER_HEADLESS: "true",
  };
};

const createServiceVariablePairs = () => {
  const staging = createEnvironment(stagingEnvironmentId);
  const production = createEnvironment(productionEnvironmentId);
  return applicationServices.map((service) => ({
    serviceName: service.serviceName,
    stagingInstance: staging.serviceInstances.find(
      (instance) => instance.serviceId === service.serviceId,
    ),
    primaryInstance: production.serviceInstances.find(
      (instance) => instance.serviceId === service.serviceId,
    ),
    stagingVariables: createServiceVariables({
      environmentId: stagingEnvironmentId,
      serviceId: service.serviceId,
    }),
    primaryVariables: createServiceVariables({
      environmentId: productionEnvironmentId,
      serviceId: service.serviceId,
    }),
  }));
};

const createStagingFixture = () => ({
  client: {
    getProject: async (id) => {
      assert.equal(id, projectId);
      return {
        id: projectId,
        name: "air-jam",
        primaryEnvironmentId: productionEnvironmentId,
        baseEnvironmentId: productionEnvironmentId,
      };
    },
    getEnvironment: async (id) => createEnvironment(id),
    getVariables: async ({ environmentId, serviceId }) =>
      createServiceVariables({ environmentId, serviceId }),
  },
  fetchImpl: async (url) => {
    assert.equal(
      url.toString(),
      "https://air-jam-platform-staging.up.railway.app/api/health",
    );
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, service: "platform" }),
    };
  },
});

const isolationInput = () => ({
  environment: createEnvironment(stagingEnvironmentId),
  primaryEnvironment: createEnvironment(productionEnvironmentId),
  stagingDatabaseUrl: "postgresql://staging.example.test/airjam",
  primaryDatabaseUrl: "postgresql://production.example.test/airjam",
  serviceVariablePairs: createServiceVariablePairs(),
});

test("primary run requires provider identities instead of a trusted-looking URL", () => {
  const help = execFileSync(
    process.execPath,
    [cliPath, "golden-path", "run-primary", "--help"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.match(help, /--railway-project/);
  assert.match(help, /--railway-environment/);
  assert.doesNotMatch(help, /--staging-url/);
});

test("primary run proves environment-wide isolation before health-checking staging", async () => {
  const runtime = await resolveGoldenPathRailwayStagingRuntime({
    projectId,
    environmentId: stagingEnvironmentId,
    ...createStagingFixture(),
  });
  const { target } = runtime;

  assert.equal(target.provider, "railway");
  assert.equal(target.environmentId, stagingEnvironmentId);
  assert.equal(target.deploymentId, "deployment-service-platform-staging");
  assert.equal(target.url, "https://air-jam-platform-staging.up.railway.app");
  assert.equal(runtime.databaseUrl, "postgresql://staging.example.test/airjam");
  assert.equal(JSON.stringify(target).includes("postgresql://"), false);
  assert.deepEqual(target.isolation, {
    providerEnvironmentIdentity: true,
    applicationServiceInstancesDistinct: true,
    postgresServiceInstanceDistinct: true,
    databaseTargetDistinctOrProviderScoped: true,
    productionVariableValuesNotReused: true,
    releaseStorageIsolated: true,
    releaseStorageCredential: {
      bucket: "air-jam-staging-releases",
      scope: "object-read-write",
      issuedAt: stagingR2Credential.issuedAt,
      expiresAt: stagingR2Credential.expiresAt,
      ttlSeconds: 86_400,
      endpointHostname: "cloudflare-account.r2.cloudflarestorage.com",
    },
    releasePipelineIsolated: true,
    publicOriginDistinct: true,
  });
});

test("public staging status never returns its private database target", async () => {
  const target = await resolveGoldenPathRailwayStagingTarget({
    projectId,
    environmentId: stagingEnvironmentId,
    ...createStagingFixture(),
  });

  assert.equal("databaseUrl" in target, false);
  assert.equal(JSON.stringify(target).includes("postgresql://"), false);
});

test("primary run rejects Railway's production environment before resolution", async () => {
  const fixture = createStagingFixture();
  fixture.client.getEnvironment = async () => {
    assert.fail("production rejection must happen before environment reads");
  };
  await assert.rejects(
    resolveGoldenPathRailwayStagingTarget({
      projectId,
      environmentId: productionEnvironmentId,
      ...fixture,
    }),
    /cannot target Railway's primary or base environment/u,
  );
});

test("environment proof rejects reused production values on every service", () => {
  const input = isolationInput();
  const server = input.serviceVariablePairs.find(
    (pair) => pair.stagingInstance.serviceId === "service-server",
  );
  server.stagingVariables.AIR_JAM_MASTER_KEY =
    server.primaryVariables.AIR_JAM_MASTER_KEY;
  assert.throws(
    () => assertGoldenPathStagingEnvironmentIsolation(input),
    /air-jam-server reuses production value for AIR_JAM_MASTER_KEY/u,
  );
});

test("environment proof rejects release storage without a signed bucket session", () => {
  const input = isolationInput();
  delete input.serviceVariablePairs[0].stagingVariables
    .AIRJAM_RELEASES_R2_SESSION_TOKEN;
  assert.throws(
    () => assertGoldenPathStagingEnvironmentIsolation(input),
    /missing required AIRJAM_RELEASES_R2_SESSION_TOKEN/u,
  );
});

test("environment proof fails closed for an unknown shared variable", () => {
  const input = isolationInput();
  const platform = input.serviceVariablePairs[0];
  platform.stagingVariables.FUTURE_SENSITIVE_SETTING = "shared-value";
  platform.primaryVariables.FUTURE_SENSITIVE_SETTING = "shared-value";
  assert.throws(
    () => assertGoldenPathStagingEnvironmentIsolation(input),
    /reuses production value for FUTURE_SENSITIVE_SETTING/u,
  );
});

test("environment proof permits absent optional production secrets", () => {
  const input = isolationInput();
  const platform = input.serviceVariablePairs[0];
  delete platform.stagingVariables.GITHUB_CLIENT_SECRET;
  platform.primaryVariables.GITHUB_CLIENT_SECRET = "production-only";
  assert.doesNotThrow(() => assertGoldenPathStagingEnvironmentIsolation(input));
});

test("browser access tokens are conditional on a remote browser endpoint", () => {
  const input = isolationInput();
  const platform = input.serviceVariablePairs[0];
  delete platform.stagingVariables.AIRJAM_RELEASES_BROWSER_WS_ENDPOINT;
  delete platform.stagingVariables.AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN;
  platform.stagingVariables.AIRJAM_RELEASES_BROWSER_EXECUTABLE_PATH =
    "/usr/bin/chromium";
  assert.doesNotThrow(() => assertGoldenPathStagingEnvironmentIsolation(input));
});

test("environment proof rejects a browser endpoint outside staging", () => {
  const input = isolationInput();
  input.serviceVariablePairs[0].stagingVariables.AIRJAM_RELEASES_BROWSER_WS_ENDPOINT =
    "wss://unrelated-browser.example/ws";
  assert.throws(
    () => assertGoldenPathStagingEnvironmentIsolation(input),
    /browser endpoint does not target its release browser worker/u,
  );
});

test("environment proof rejects shared non-scoped databases", () => {
  const input = isolationInput();
  const platform = input.serviceVariablePairs[0];
  platform.stagingVariables.DATABASE_URL = "postgresql://shared.example/airjam";
  platform.primaryVariables.DATABASE_URL = "postgresql://shared.example/airjam";
  assert.throws(
    () => assertGoldenPathStagingEnvironmentIsolation(input),
    /reuses production value for DATABASE_URL/u,
  );
});

test("environment proof rejects a shared public Postgres target", () => {
  const input = isolationInput();
  input.stagingDatabaseUrl = input.primaryDatabaseUrl;
  assert.throws(
    () => assertGoldenPathStagingEnvironmentIsolation(input),
    /same public target as production/u,
  );
});
