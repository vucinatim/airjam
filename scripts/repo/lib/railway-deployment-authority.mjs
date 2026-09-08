import {
  createRailwayApiClient,
  RailwayApiError,
  resolveRailwayApiToken,
} from "./railway-api.mjs";

const commitPattern = /^[0-9a-f]{40}$/u;

const normalizedCommit = (value) => {
  const commit = typeof value === "string" ? value.trim() : "";
  return commitPattern.test(commit) ? commit : null;
};

const normalizedText = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const resolveHostname = (value) => {
  const candidate = normalizedText(value);
  if (!candidate) return null;
  try {
    return new URL(
      candidate.includes("://") ? candidate : `https://${candidate}`,
    ).hostname;
  } catch {
    return null;
  }
};

const emptyAuthority = Object.freeze({
  status: "failed",
  provider: "railway",
  failureCode: null,
  reason: null,
  projectId: null,
  environmentId: null,
  environmentName: null,
  serviceId: null,
  deploymentId: null,
  deploymentStatus: null,
  currentDeploymentId: null,
  revision: null,
  currentRevision: null,
  domainHostnames: [],
  successfulDeployment: false,
  currentServiceDeployment: false,
  expectedProjectMatched: false,
  expectedEnvironmentMatched: false,
  exactRevisionAvailable: false,
  checks: [],
});

const failedAuthority = (reason, failureCode) => ({
  ...emptyAuthority,
  failureCode,
  reason,
});

const providerFailure = (error) => {
  const message = normalizedText(
    error instanceof Error ? error.message : String(error),
  );
  const failureCode =
    error instanceof RailwayApiError && message?.startsWith("Missing Railway")
      ? "credentials_missing"
      : error instanceof RailwayApiError && message?.includes("timed out")
        ? "request_timeout"
        : error instanceof RailwayApiError &&
            (error.status === 401 || error.status === 403)
          ? "authorization_failed"
          : "provider_request_failed";
  return failedAuthority(
    message
      ? `Railway deployment authority lookup failed: ${message.slice(0, 500)}`
      : "Railway deployment authority lookup failed.",
    failureCode,
  );
};

export const railwayDeploymentAuthorityCredentialsAvailable = (
  env = process.env,
) => Boolean(resolveRailwayApiToken(env).token);

export const resolveCurrentRailwayDeploymentAuthority = async (
  {
    deploymentId,
    expectedProjectId,
    expectedEnvironmentId = null,
    expectedEnvironmentName = null,
    requireFullRevision = false,
  },
  { client = null, createClient = createRailwayApiClient } = {},
) => {
  const expectedDeploymentId = normalizedText(deploymentId);
  const projectId = normalizedText(expectedProjectId);
  const environmentId = normalizedText(expectedEnvironmentId);
  const environmentName = normalizedText(expectedEnvironmentName);
  if (!expectedDeploymentId || !projectId) {
    return failedAuthority(
      "Railway deployment authority requires an exact deployment and project ID.",
      "invalid_request",
    );
  }

  try {
    const railway = client ?? createClient();
    const deployment = await railway.getDeployment(expectedDeploymentId);
    if (!deployment) {
      return failedAuthority(
        "Railway did not return the requested deployment authority.",
        "deployment_not_found",
      );
    }
    const providerEnvironmentId = normalizedText(deployment.environmentId);
    const environment = await railway.getEnvironment(
      environmentId ?? providerEnvironmentId,
    );
    const serviceId = normalizedText(deployment.serviceId);
    const service = environment?.serviceInstances?.find(
      (candidate) => candidate.serviceId === serviceId,
    );
    const revision = normalizedCommit(deployment.meta?.commitHash);
    const currentRevision = normalizedCommit(
      service?.latestDeployment?.meta?.commitHash,
    );
    const successfulDeployment = deployment.status === "SUCCESS";
    const currentServiceDeployment =
      Boolean(service) &&
      service?.latestDeployment?.id === expectedDeploymentId;
    const expectedProjectMatched = environment?.projectId === projectId;
    const expectedEnvironmentMatched =
      providerEnvironmentId === environment?.id &&
      (environmentId === null || environment?.id === environmentId) &&
      (environmentName === null || environment?.name === environmentName);
    const exactRevisionAvailable =
      Boolean(revision) && currentRevision === revision;
    const checks = [
      { check: "provider:railway-project", passed: expectedProjectMatched },
      {
        check: "provider:railway-environment",
        passed: expectedEnvironmentMatched,
      },
      {
        check: "provider:railway-deployment",
        passed:
          deployment.id === expectedDeploymentId &&
          successfulDeployment &&
          Boolean(serviceId),
      },
      {
        check: "provider:railway-current-service-deployment",
        passed: currentServiceDeployment,
      },
      ...(requireFullRevision
        ? [
            {
              check: "provider:railway-exact-revision",
              passed: exactRevisionAvailable,
            },
          ]
        : []),
    ];
    const domainHostnames = [
      ...(service?.domains?.customDomains ?? []).map((entry) => entry.domain),
      ...(service?.domains?.serviceDomains ?? []).map((entry) => entry.domain),
      service?.latestDeployment?.staticUrl ?? null,
      service?.latestDeployment?.url ?? null,
    ]
      .map(resolveHostname)
      .filter(Boolean);

    return {
      status: checks.every((check) => check.passed) ? "verified" : "mismatch",
      provider: "railway",
      failureCode: null,
      reason: null,
      projectId: environment?.projectId ?? null,
      environmentId: environment?.id ?? null,
      environmentName: environment?.name ?? null,
      serviceId,
      deploymentId: deployment.id ?? null,
      deploymentStatus: deployment.status ?? null,
      currentDeploymentId: service?.latestDeployment?.id ?? null,
      revision,
      currentRevision,
      domainHostnames,
      successfulDeployment,
      currentServiceDeployment,
      expectedProjectMatched,
      expectedEnvironmentMatched,
      exactRevisionAvailable,
      checks,
    };
  } catch (error) {
    return providerFailure(error);
  }
};

export const resolveRailwayMigrationDeploymentAuthority = (
  { databaseTarget, deploymentId },
  dependencies = {},
) => {
  if (databaseTarget.kind !== "railway") {
    return Promise.resolve(
      failedAuthority(
        "Migration deployment authority requires a Railway database target.",
        "unsupported_target",
      ),
    );
  }
  return resolveCurrentRailwayDeploymentAuthority(
    {
      deploymentId,
      expectedProjectId: databaseTarget.projectId,
      expectedEnvironmentId: databaseTarget.environmentId,
      expectedEnvironmentName: databaseTarget.environmentName,
      requireFullRevision: true,
    },
    dependencies,
  );
};
