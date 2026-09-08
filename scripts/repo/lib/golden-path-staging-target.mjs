import { verifyCloudflareR2TemporaryCredentials } from "./cloudflare-r2-temporary-credentials.mjs";
import { createRailwayApiClient } from "./railway-api.mjs";

const railwayPlatformConfigFile = "/apps/platform/railway.json";
const railwayBrowserWorkerConfigFile =
  "/packages/release-browser-worker/railway.json";
export const canonicalGoldenPathApplicationServiceNames = Object.freeze([
  "air-jam-platform",
  "air-jam-platform-worker",
  "air-jam-release-browser-worker",
  "air-jam-server",
]);
const canonicalApplicationServiceNames = new Set(
  canonicalGoldenPathApplicationServiceNames,
);
const railwayReadyDeploymentStatuses = new Set(["SUCCESS", "SLEEPING"]);

// Equal production/staging values fail closed unless the variable is explicitly
// known to be provider metadata or non-sensitive process configuration.
const allowedSharedVariableNames = new Set([
  "AIRJAM_BROWSER_WORKER_CHROMIUM_SANDBOX",
  "AIRJAM_BROWSER_WORKER_EXECUTABLE_PATH",
  "AIRJAM_BROWSER_WORKER_HEADLESS",
  "AIRJAM_BROWSER_WORKER_HOST",
  "AIRJAM_BROWSER_WORKER_PORT",
  "AIRJAM_PLATFORM_WORKER_BUDGET_REFRESH_MS",
  "AIRJAM_RELEASES_BROWSER_EXECUTABLE_PATH",
  "AIRJAM_RELEASES_BROWSER_NAVIGATION_TIMEOUT_MS",
  "AIRJAM_RELEASES_BROWSER_VIEWPORT_HEIGHT",
  "AIRJAM_RELEASES_BROWSER_VIEWPORT_WIDTH",
  "AIRJAM_RELEASES_BROWSER_WAIT_AFTER_LOAD_MS",
  "AIRJAM_RELEASES_IMAGE_MODERATION_MODE",
  "AIRJAM_RELEASES_OPENAI_BASE_URL",
  "AIRJAM_RELEASES_OPENAI_MODERATION_MODEL",
  "AIRJAM_RELEASES_OPENAI_TIMEOUT_MS",
  "AIRJAM_RELEASES_R2_ACCOUNT_ID",
  "AIRJAM_RELEASES_R2_ACCESS_KEY_ID",
  "AIRJAM_RELEASES_R2_ENDPOINT",
  "AIRJAM_RELEASES_UPLOAD_URL_TTL_SECONDS",
  "AIRJAM_DEV_LOG_EVENTS",
  "AIR_JAM_ALLOW_REMOTE_DATABASE",
  "AIR_JAM_AUTH_MODE",
  "AIR_JAM_CHILD_HOST_CAPABILITY_TTL_MS",
  "AIR_JAM_CHILD_HOST_TEARDOWN_MS",
  "AIR_JAM_CONTROLLER_CAPABILITY_TTL_MS",
  "AIR_JAM_CONTROLLER_JOIN_RATE_LIMIT_MAX",
  "AIR_JAM_CONTROLLER_RESUME_LEASE_MS",
  "AIR_JAM_DEV_LOG_COLLECTOR",
  "AIR_JAM_DEV_LOG_DIR",
  "AIR_JAM_DEV_LOG_FILE",
  "AIR_JAM_DEV_LOG_SUMMARY_WINDOW_MS",
  "AIR_JAM_HOST_REGISTRATION_RATE_LIMIT_MAX",
  "AIR_JAM_LOG_LEVEL",
  "AIR_JAM_MAINTENANCE_MODE",
  "AIR_JAM_RATE_LIMIT_WINDOW_MS",
  "AIR_JAM_STATIC_APP_RATE_LIMIT_MAX",
  "AIR_JAM_SYSTEM_APP_ID",
  "AIR_JAM_TRUST_PROXY_HEADERS",
  "AIR_JAM_WORKSPACE_ROOT",
  "AIRJAM_DEPLOYMENT_DEPENDS_ON_PLATFORM",
  "HOSTNAME",
  "NEXT_PUBLIC_AUTH_GITHUB_ENABLED",
  "NODE_ENV",
  "PORT",
  "RAILWAY_DOCKERFILE_PATH",
  "RAILWAY_PROJECT_ID",
  "RAILWAY_PROJECT_NAME",
  "RAILWAY_PRIVATE_DOMAIN",
  "RAILWAY_SERVICE_ID",
  "RAILWAY_SERVICE_NAME",
]);

const listRailwayServiceDomains = (instance) =>
  [
    ...(instance?.domains?.customDomains ?? []).map((entry) => entry.domain),
    ...(instance?.domains?.serviceDomains ?? []).map((entry) => entry.domain),
    instance?.latestDeployment?.staticUrl,
    instance?.latestDeployment?.url,
  ].filter((value) => typeof value === "string" && value.trim().length > 0);

const normalizeHttpsOrigin = (domain) => {
  const url = new URL(
    /^https?:\/\//u.test(domain) ? domain : `https://${domain}`,
  );
  if (url.protocol !== "https:") {
    throw new Error("The Railway staging platform must expose HTTPS.");
  }
  return url.origin;
};

const tryNormalizeHttpsOrigin = (domain) => {
  try {
    return normalizeHttpsOrigin(domain);
  } catch {
    return null;
  }
};

const variableValue = (variables, name) => variables[name]?.trim() || null;

const requireRailwayVariable = (
  variables,
  name,
  environmentName,
  serviceName,
) => {
  const value = variableValue(variables, name);
  if (!value) {
    throw new Error(
      `Railway ${environmentName} ${serviceName} is missing required ${name}.`,
    );
  }
  return value;
};

const isRailwayEnvironmentScopedUrl = (value) => {
  try {
    return new URL(value).hostname.endsWith(".railway.internal");
  } catch {
    return false;
  }
};

const assertProviderEnvironmentIdentity = ({
  environment,
  variables,
  serviceName,
}) => {
  const providerEnvironmentId = requireRailwayVariable(
    variables,
    "RAILWAY_ENVIRONMENT_ID",
    environment.name,
    serviceName,
  );
  const providerEnvironmentName = requireRailwayVariable(
    variables,
    "RAILWAY_ENVIRONMENT_NAME",
    environment.name,
    serviceName,
  );
  if (
    providerEnvironmentId !== environment.id ||
    providerEnvironmentName !== environment.name
  ) {
    throw new Error(
      `Railway ${serviceName} variables do not match the requested ${environment.name} environment identity.`,
    );
  }
};

const assertProductionValuesNotReused = ({
  serviceName,
  stagingVariables,
  primaryVariables,
}) => {
  for (const [name, rawStagingValue] of Object.entries(stagingVariables)) {
    const stagingValue = rawStagingValue?.trim();
    const primaryValue = primaryVariables[name]?.trim();
    if (!stagingValue || !primaryValue || stagingValue !== primaryValue)
      continue;
    if (
      allowedSharedVariableNames.has(name) ||
      isRailwayEnvironmentScopedUrl(stagingValue)
    ) {
      continue;
    }
    throw new Error(
      `Railway staging ${serviceName} reuses production value for ${name}.`,
    );
  }
};

export const findGoldenPathPostgresInstance = (environment) =>
  environment.serviceInstances.find(
    (instance) =>
      !instance.railwayConfigFile &&
      instance.serviceName?.toLowerCase().includes("postgres"),
  );

const resolveApplicationServicePairs = ({
  environment,
  primaryEnvironment,
}) => {
  const stagingInstances = environment.serviceInstances.filter((instance) =>
    canonicalApplicationServiceNames.has(instance.serviceName),
  );
  const primaryInstances = primaryEnvironment.serviceInstances.filter(
    (instance) => canonicalApplicationServiceNames.has(instance.serviceName),
  );
  const stagingServiceIds = new Set(
    stagingInstances.map((instance) => instance.serviceId),
  );
  const primaryServiceIds = new Set(
    primaryInstances.map((instance) => instance.serviceId),
  );
  if (
    stagingInstances.length !== canonicalApplicationServiceNames.size ||
    primaryInstances.length !== canonicalApplicationServiceNames.size ||
    stagingServiceIds.size !== primaryServiceIds.size ||
    [...stagingServiceIds].some(
      (serviceId) => !primaryServiceIds.has(serviceId),
    )
  ) {
    throw new Error(
      "Railway staging must contain the same canonical application services as production.",
    );
  }

  return stagingInstances.map((stagingInstance) => {
    const primaryInstance = primaryInstances.find(
      (candidate) => candidate.serviceId === stagingInstance.serviceId,
    );
    if (
      !primaryInstance?.id ||
      !stagingInstance.id ||
      primaryInstance.id === stagingInstance.id
    ) {
      throw new Error(
        `Railway staging ${stagingInstance.serviceName} must use a service instance distinct from production.`,
      );
    }
    return { stagingInstance, primaryInstance };
  });
};

const assertDatabaseIsolation = ({
  environment,
  primaryEnvironment,
  serviceVariablePairs,
}) => {
  const stagingPostgres = findGoldenPathPostgresInstance(environment);
  const primaryPostgres = findGoldenPathPostgresInstance(primaryEnvironment);
  if (
    !stagingPostgres?.id ||
    !primaryPostgres?.id ||
    stagingPostgres.id === primaryPostgres.id
  ) {
    throw new Error(
      "Railway staging must expose a Postgres service instance distinct from production.",
    );
  }

  for (const {
    serviceName,
    stagingVariables,
    primaryVariables,
  } of serviceVariablePairs) {
    const stagingDatabaseUrl = variableValue(stagingVariables, "DATABASE_URL");
    const primaryDatabaseUrl = variableValue(primaryVariables, "DATABASE_URL");
    if (
      stagingDatabaseUrl &&
      primaryDatabaseUrl &&
      stagingDatabaseUrl === primaryDatabaseUrl &&
      !isRailwayEnvironmentScopedUrl(stagingDatabaseUrl)
    ) {
      throw new Error(
        `Railway staging ${serviceName} DATABASE_URL resolves to the same non-scoped database as production.`,
      );
    }
  }
};

const assertReleaseIsolation = ({
  environment,
  primaryEnvironment,
  serviceVariablePairs,
}) => {
  const platformPair = serviceVariablePairs.find(
    (pair) =>
      pair.stagingInstance.railwayConfigFile === railwayPlatformConfigFile,
  );
  const browserWorkerPair = serviceVariablePairs.find(
    (pair) =>
      pair.stagingInstance.railwayConfigFile === railwayBrowserWorkerConfigFile,
  );
  const operationalWorkerPair = serviceVariablePairs.find(
    (pair) => pair.stagingInstance.serviceName === "air-jam-platform-worker",
  );
  if (!platformPair || !browserWorkerPair || !operationalWorkerPair) {
    throw new Error(
      "Railway staging must include the canonical platform, operational worker, and release browser worker services.",
    );
  }

  const stagingBucket = requireRailwayVariable(
    platformPair.stagingVariables,
    "AIRJAM_RELEASES_R2_BUCKET",
    environment.name,
    platformPair.serviceName,
  );
  const primaryBucket = requireRailwayVariable(
    platformPair.primaryVariables,
    "AIRJAM_RELEASES_R2_BUCKET",
    primaryEnvironment.name,
    platformPair.serviceName,
  );
  if (stagingBucket === primaryBucket) {
    throw new Error(
      "Railway staging release storage bucket must be distinct from production.",
    );
  }

  for (const name of [
    "AIRJAM_RELEASES_R2_ACCESS_KEY_ID",
    "AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY",
    "AIRJAM_RELEASES_R2_SESSION_TOKEN",
    "AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN",
  ]) {
    requireRailwayVariable(
      platformPair.stagingVariables,
      name,
      environment.name,
      platformPair.serviceName,
    );
  }

  const stagingAccountId = requireRailwayVariable(
    platformPair.stagingVariables,
    "AIRJAM_RELEASES_R2_ACCOUNT_ID",
    environment.name,
    platformPair.serviceName,
  );
  const primaryAccountId = requireRailwayVariable(
    platformPair.primaryVariables,
    "AIRJAM_RELEASES_R2_ACCOUNT_ID",
    primaryEnvironment.name,
    platformPair.serviceName,
  );
  if (stagingAccountId !== primaryAccountId) {
    throw new Error(
      "Railway staging and production R2 account identities do not match the delegated credential authority.",
    );
  }
  const endpoint =
    variableValue(
      platformPair.stagingVariables,
      "AIRJAM_RELEASES_R2_ENDPOINT",
    ) ?? `https://${stagingAccountId}.r2.cloudflarestorage.com`;
  const temporaryCredential = verifyCloudflareR2TemporaryCredentials({
    endpoint,
    accountId: stagingAccountId,
    parentAccessKeyId: requireRailwayVariable(
      platformPair.primaryVariables,
      "AIRJAM_RELEASES_R2_ACCESS_KEY_ID",
      primaryEnvironment.name,
      platformPair.serviceName,
    ),
    parentSecretAccessKey: requireRailwayVariable(
      platformPair.primaryVariables,
      "AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY",
      primaryEnvironment.name,
      platformPair.serviceName,
    ),
    bucket: stagingBucket,
    accessKeyId: platformPair.stagingVariables.AIRJAM_RELEASES_R2_ACCESS_KEY_ID,
    secretAccessKey:
      platformPair.stagingVariables.AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY,
    sessionToken:
      platformPair.stagingVariables.AIRJAM_RELEASES_R2_SESSION_TOKEN,
  });
  for (const name of [
    "AIRJAM_RELEASES_R2_BUCKET",
    "AIRJAM_RELEASES_R2_ACCOUNT_ID",
    "AIRJAM_RELEASES_R2_ACCESS_KEY_ID",
    "AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY",
    "AIRJAM_RELEASES_R2_SESSION_TOKEN",
    "AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN",
  ]) {
    if (
      variableValue(operationalWorkerPair.stagingVariables, name) !==
      variableValue(platformPair.stagingVariables, name)
    ) {
      throw new Error(
        `Railway staging operational worker must share platform ${name}.`,
      );
    }
  }

  const browserEndpoint = variableValue(
    platformPair.stagingVariables,
    "AIRJAM_RELEASES_BROWSER_WS_ENDPOINT",
  );
  const browserExecutable = variableValue(
    platformPair.stagingVariables,
    "AIRJAM_RELEASES_BROWSER_EXECUTABLE_PATH",
  );
  if (!browserEndpoint && !browserExecutable) {
    throw new Error(
      `Railway ${environment.name} ${platformPair.serviceName} must configure a browser endpoint or executable.`,
    );
  }
  if (!browserEndpoint) return temporaryCredential;

  if (
    variableValue(
      operationalWorkerPair.stagingVariables,
      "AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN",
    ) !==
    variableValue(
      platformPair.stagingVariables,
      "AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN",
    )
  ) {
    throw new Error(
      "Railway staging operational worker must share platform AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN.",
    );
  }

  requireRailwayVariable(
    platformPair.stagingVariables,
    "AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN",
    environment.name,
    platformPair.serviceName,
  );
  requireRailwayVariable(
    browserWorkerPair.stagingVariables,
    "AIRJAM_BROWSER_WORKER_ACCESS_TOKEN",
    environment.name,
    browserWorkerPair.serviceName,
  );

  let endpointHostname;
  try {
    endpointHostname = new URL(browserEndpoint).hostname;
  } catch {
    throw new Error(
      "Railway staging AIRJAM_RELEASES_BROWSER_WS_ENDPOINT must be a valid URL.",
    );
  }
  const workerHostnames = new Set(
    listRailwayServiceDomains(browserWorkerPair.stagingInstance).flatMap(
      (domain) => {
        try {
          return [
            new URL(/^https?:\/\//u.test(domain) ? domain : `https://${domain}`)
              .hostname,
          ];
        } catch {
          return [];
        }
      },
    ),
  );
  if (
    !endpointHostname.endsWith(".railway.internal") &&
    !workerHostnames.has(endpointHostname)
  ) {
    throw new Error(
      "Railway staging browser endpoint does not target its release browser worker.",
    );
  }

  return temporaryCredential;
};

export const assertGoldenPathStagingEnvironmentIsolation = ({
  environment,
  primaryEnvironment,
  serviceVariablePairs,
}) => {
  for (const pair of serviceVariablePairs) {
    assertProviderEnvironmentIdentity({
      environment,
      variables: pair.stagingVariables,
      serviceName: pair.serviceName,
    });
    assertProviderEnvironmentIdentity({
      environment: primaryEnvironment,
      variables: pair.primaryVariables,
      serviceName: pair.serviceName,
    });
    assertProductionValuesNotReused(pair);
  }
  assertDatabaseIsolation({
    environment,
    primaryEnvironment,
    serviceVariablePairs,
  });
  const releaseStorageCredential = assertReleaseIsolation({
    environment,
    primaryEnvironment,
    serviceVariablePairs,
  });

  return {
    providerEnvironmentIdentity: true,
    applicationServiceInstancesDistinct: true,
    postgresServiceInstanceDistinct: true,
    databaseTargetDistinctOrProviderScoped: true,
    productionVariableValuesNotReused: true,
    releaseStorageIsolated: true,
    releaseStorageCredential,
    releasePipelineIsolated: true,
  };
};

export const resolveGoldenPathStagingEnvironmentPair = async ({
  projectId,
  environmentId,
  client,
}) => {
  if (!projectId || !environmentId) {
    throw new Error(
      "Golden-path staging requires Railway project and environment identities.",
    );
  }

  const project = await client.getProject(projectId);
  if (project.id !== projectId) {
    throw new Error(`Railway returned an unexpected project for ${projectId}.`);
  }
  if (
    environmentId === project.primaryEnvironmentId ||
    environmentId === project.baseEnvironmentId
  ) {
    throw new Error(
      "The golden-path run cannot target Railway's primary or base environment.",
    );
  }
  const primaryEnvironmentId =
    project.primaryEnvironmentId ?? project.baseEnvironmentId;
  if (!primaryEnvironmentId) {
    throw new Error(
      `Railway project ${projectId} has no primary environment identity.`,
    );
  }

  const [environment, primaryEnvironment] = await Promise.all([
    client.getEnvironment(environmentId),
    client.getEnvironment(primaryEnvironmentId),
  ]);
  if (
    environment.projectId !== projectId ||
    primaryEnvironment.projectId !== projectId
  ) {
    throw new Error("Railway returned an environment from another project.");
  }
  const stagingNamed =
    environment.name.toLowerCase().includes("staging") ||
    /(?:^|-)pr-\d+(?:$|-)/u.test(environment.name.toLowerCase());
  if (!stagingNamed) {
    throw new Error(
      "The Railway environment must be explicitly named as staging or a PR environment.",
    );
  }
  if (environment.canAccess === false) {
    throw new Error(`Railway environment ${environmentId} is not accessible.`);
  }
  if (environment.isEphemeral !== true) {
    throw new Error(
      "Golden-path staging must be an ephemeral Railway environment.",
    );
  }
  if (environment.sourceEnvironment?.id !== primaryEnvironment.id) {
    throw new Error(
      "Golden-path staging must be cloned from the canonical production topology.",
    );
  }

  const servicePairs = resolveApplicationServicePairs({
    environment,
    primaryEnvironment,
  });
  const stagingPostgres = findGoldenPathPostgresInstance(environment);
  const primaryPostgres = findGoldenPathPostgresInstance(primaryEnvironment);
  if (
    !stagingPostgres?.id ||
    !primaryPostgres?.id ||
    stagingPostgres.id === primaryPostgres.id
  ) {
    throw new Error(
      "Railway staging must expose a Postgres service instance distinct from production.",
    );
  }

  return {
    project,
    environment,
    primaryEnvironment,
    primaryEnvironmentId,
    servicePairs,
    stagingPostgres,
  };
};

export const collectGoldenPathServiceVariablePairs = async ({
  client,
  projectId,
  environmentId,
  primaryEnvironmentId,
  servicePairs,
}) =>
  Promise.all(
    servicePairs.map(async ({ stagingInstance, primaryInstance }) => {
      const [stagingVariables, primaryVariables] = await Promise.all([
        client.getVariables({
          projectId,
          environmentId,
          serviceId: stagingInstance.serviceId,
        }),
        client.getVariables({
          projectId,
          environmentId: primaryEnvironmentId,
          serviceId: primaryInstance.serviceId,
        }),
      ]);
      return {
        serviceName: stagingInstance.serviceName,
        stagingInstance,
        primaryInstance,
        stagingVariables,
        primaryVariables,
      };
    }),
  );

export const resolveGoldenPathRailwayStagingTarget = async ({
  projectId,
  environmentId,
  client = createRailwayApiClient(),
  fetchImpl = fetch,
}) => {
  const {
    project,
    environment,
    primaryEnvironment,
    primaryEnvironmentId,
    servicePairs,
  } = await resolveGoldenPathStagingEnvironmentPair({
    projectId,
    environmentId,
    client,
  });
  const platformPair = servicePairs.find(
    (pair) =>
      pair.stagingInstance.railwayConfigFile === railwayPlatformConfigFile,
  );
  if (!platformPair) {
    throw new Error(
      `Railway environment ${environmentId} has no canonical Air Jam platform service.`,
    );
  }
  for (const pair of servicePairs) {
    const serviceDeployment = pair.stagingInstance.latestDeployment;
    if (
      !serviceDeployment ||
      !railwayReadyDeploymentStatuses.has(serviceDeployment.status)
    ) {
      throw new Error(
        `Railway staging ${pair.serviceName} deployment is ${serviceDeployment?.status ?? "missing"}; expected SUCCESS or SLEEPING.`,
      );
    }
  }
  const deployment = platformPair.stagingInstance.latestDeployment;

  const serviceVariablePairs = await collectGoldenPathServiceVariablePairs({
    client,
    projectId,
    environmentId,
    primaryEnvironmentId,
    servicePairs,
  });
  const environmentIsolation = assertGoldenPathStagingEnvironmentIsolation({
    environment,
    primaryEnvironment,
    serviceVariablePairs,
  });

  const primaryOrigins = new Set(
    primaryEnvironment.serviceInstances
      .flatMap(listRailwayServiceDomains)
      .map(tryNormalizeHttpsOrigin)
      .filter(Boolean),
  );
  const stagingUrl = listRailwayServiceDomains(platformPair.stagingInstance)
    .map(normalizeHttpsOrigin)
    .find((origin) => !primaryOrigins.has(origin));
  if (!stagingUrl) {
    throw new Error(
      "Railway staging platform has no public domain distinct from production.",
    );
  }
  const healthUrl = new URL("/api/health", stagingUrl);
  const response = await fetchImpl(healthUrl, {
    signal: AbortSignal.timeout(20_000),
  });
  const responseOrigin = response.url
    ? new URL(response.url).origin
    : stagingUrl;
  if (responseOrigin !== stagingUrl) {
    throw new Error(
      `Railway staging health redirected to a different origin: ${responseOrigin}.`,
    );
  }
  let health = null;
  try {
    health = await response.json();
  } catch {
    // The explicit health assertion below owns the operator-facing failure.
  }
  if (!response.ok || health?.ok !== true || health?.service !== "platform") {
    throw new Error(
      `Railway staging platform health check failed with HTTP ${response.status}.`,
    );
  }

  return {
    provider: "railway",
    projectId,
    projectName: project.name,
    environmentId,
    environmentName: environment.name,
    isEphemeral: environment.isEphemeral === true,
    serviceId: platformPair.stagingInstance.serviceId,
    serviceName: platformPair.stagingInstance.serviceName,
    deploymentId: deployment.id,
    deploymentStatus: deployment.status,
    url: stagingUrl,
    health: { ok: true, service: "platform" },
    isolation: { ...environmentIsolation, publicOriginDistinct: true },
    verifiedAt: new Date().toISOString(),
    productionAllowed: false,
  };
};
