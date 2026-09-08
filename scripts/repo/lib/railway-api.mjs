const DEFAULT_RAILWAY_API_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const DEFAULT_RAILWAY_API_REQUEST_TIMEOUT_MS = 10_000;

const TERMINAL_SUCCESS_DEPLOYMENT_STATUSES = new Set(["SUCCESS", "SLEEPING"]);
const TERMINAL_FAILURE_DEPLOYMENT_STATUSES = new Set([
  "FAILED",
  "CRASHED",
  "REMOVED",
  "REMOVING",
  "SKIPPED",
  "NEEDS_APPROVAL",
]);

export const resolveRailwayApiToken = (env = process.env) => {
  const projectToken = env.RAILWAY_PROJECT_TOKEN?.trim();
  if (projectToken) {
    return {
      token: projectToken,
      kind: "project",
      source: "env:RAILWAY_PROJECT_TOKEN",
    };
  }

  const explicitApiToken = env.RAILWAY_API_TOKEN?.trim();
  if (explicitApiToken) {
    return {
      token: explicitApiToken,
      kind: "account",
      source: "env:RAILWAY_API_TOKEN",
    };
  }

  const explicitToken = env.RAILWAY_TOKEN?.trim();
  if (explicitToken) {
    return {
      token: explicitToken,
      kind: "account",
      source: "env:RAILWAY_TOKEN",
    };
  }

  return {
    token: null,
    kind: null,
    source: null,
  };
};

const connectionNodes = (connection) =>
  Array.isArray(connection?.edges)
    ? connection.edges
        .map((edge) => edge?.node ?? null)
        .filter((value) => value != null)
    : [];

const normalizeDeployment = (deployment) =>
  deployment
    ? {
        ...deployment,
        meta:
          deployment.meta && typeof deployment.meta === "object"
            ? deployment.meta
            : {},
        canRedeploy: Boolean(deployment.canRedeploy),
        canRollback: Boolean(deployment.canRollback),
      }
    : null;

const firstNonEmptyString = (...values) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
};

export class RailwayApiError extends Error {
  constructor(message, { errors = [], status = null, payload = null } = {}) {
    super(message);
    this.name = "RailwayApiError";
    this.errors = errors;
    this.status = status;
    this.payload = payload;
  }
}

export const createRailwayApiClient = ({
  env = process.env,
  token = undefined,
  tokenKind = undefined,
  endpoint = env.RAILWAY_API_ENDPOINT ?? DEFAULT_RAILWAY_API_ENDPOINT,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_RAILWAY_API_REQUEST_TIMEOUT_MS,
} = {}) => {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new RailwayApiError(
      "Railway API requestTimeoutMs must be a positive finite number.",
    );
  }
  const resolved = resolveRailwayApiToken(env);
  const resolvedToken = token ?? resolved.token ?? null;
  const resolvedKind = tokenKind ?? resolved.kind ?? "account";

  const assertToken = () => {
    if (!resolvedToken) {
      throw new RailwayApiError(
        "Missing Railway API token. Set RAILWAY_API_TOKEN, RAILWAY_TOKEN, or RAILWAY_PROJECT_TOKEN.",
      );
    }
  };

  const authHeaders = () =>
    resolvedKind === "project"
      ? { "Project-Access-Token": resolvedToken }
      : { Authorization: `Bearer ${resolvedToken}` };

  const request = async ({ query, variables = {} }) => {
    assertToken();
    const controller = new AbortController();
    let timedOut = false;
    let timeout = null;
    const timeoutError = () =>
      new RailwayApiError(
        `Railway API request timed out after ${requestTimeoutMs}ms.`,
      );
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError());
      }, requestTimeoutMs);
    });
    const performRequest = async () => {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      const rawBody = await response.text();
      let payload;
      try {
        payload = JSON.parse(rawBody || "null");
      } catch (error) {
        throw new RailwayApiError(
          `Failed to parse Railway API response JSON: ${error.message}`,
          {
            status: response.status,
            payload: rawBody,
          },
        );
      }

      if (!response.ok || payload?.errors?.length) {
        const errors = payload?.errors ?? [];
        const message =
          errors
            .map((entry) => entry.message)
            .filter(Boolean)
            .join(" | ") ||
          `Railway API request failed with HTTP ${response.status}`;
        throw new RailwayApiError(message, {
          errors,
          status: response.status,
          payload,
        });
      }

      return payload?.data ?? null;
    };

    try {
      return await Promise.race([performRequest(), deadline]);
    } catch (error) {
      if (timedOut) throw timeoutError();
      if (error instanceof RailwayApiError) throw error;
      throw new RailwayApiError(
        `Railway API request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const getCurrentViewer = async () => {
    const data = await request({
      query: `
        query RailwayViewer {
          me {
            name
            email
            workspaces {
              id
              name
            }
          }
        }
      `,
    });

    return data.me;
  };

  const listProjects = async ({
    workspaceId = null,
    includeDeleted = false,
    first = 100,
  } = {}) => {
    const data = await request({
      query: `
        query RailwayProjects(
          $workspaceId: String
          $includeDeleted: Boolean
          $first: Int
        ) {
          projects(
            workspaceId: $workspaceId
            includeDeleted: $includeDeleted
            first: $first
          ) {
            edges {
              node {
                id
                name
                workspace {
                  id
                  name
                }
                updatedAt
                deletedAt
              }
            }
          }
        }
      `,
      variables: {
        workspaceId,
        includeDeleted,
        first,
      },
    });

    return connectionNodes(data.projects);
  };

  const getProject = async (projectId) => {
    const data = await request({
      query: `
        query RailwayProject($id: String!) {
          project(id: $id) {
            id
            name
            prDeploys
            focusedPrEnvironments
            botPrEnvironments
            baseEnvironmentId
            primaryEnvironmentId
            workspace {
              id
              name
              customer {
                billingPeriod {
                  start
                  end
                }
              }
            }
            environments {
              edges {
                node {
                  id
                  name
                  isEphemeral
                  canAccess
                }
              }
            }
            services {
              edges {
                node {
                  id
                  name
                }
              }
            }
          }
        }
      `,
      variables: {
        id: projectId,
      },
    });

    const project = data.project;
    return {
      ...project,
      environments: connectionNodes(project.environments),
      services: connectionNodes(project.services),
    };
  };

  const listEnvironments = async ({ projectId, isEphemeral = undefined }) => {
    const data = await request({
      query: `
        query RailwayEnvironments($projectId: String!, $isEphemeral: Boolean) {
          environments(projectId: $projectId, isEphemeral: $isEphemeral) {
            edges {
              node {
                id
                name
                isEphemeral
                canAccess
                projectId
              }
            }
          }
        }
      `,
      variables: {
        projectId,
        isEphemeral,
      },
    });

    return connectionNodes(data.environments);
  };

  const getEnvironment = async (environmentId) => {
    const data = await request({
      query: `
        query RailwayEnvironment($id: String!) {
          environment(id: $id) {
            id
            name
            isEphemeral
            canAccess
            projectId
            sourceEnvironment {
              id
              name
            }
            serviceInstances {
              edges {
                node {
                  id
                  environmentId
                  serviceId
                  serviceName
                  rootDirectory
                  railwayConfigFile
                  startCommand
                  healthcheckPath
                  source {
                    repo
                    image
                  }
                  latestDeployment {
                    id
                    status
                    url
                    staticUrl
                    createdAt
                    updatedAt
                    meta
                    canRedeploy
                    canRollback
                  }
                  domains {
                    serviceDomains {
                      domain
                    }
                    customDomains {
                      domain
                    }
                  }
                }
              }
            }
            volumeInstances {
              edges {
                node {
                  id
                  environmentId
                  serviceId
                  mountPath
                  currentSizeMB
                  sizeMB
                  state
                  volume {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      `,
      variables: {
        id: environmentId,
      },
    });

    const environment = data.environment;
    return {
      ...environment,
      serviceInstances: connectionNodes(environment.serviceInstances).map(
        (instance) => ({
          ...instance,
          latestDeployment: normalizeDeployment(instance.latestDeployment),
        }),
      ),
      volumeInstances: connectionNodes(environment.volumeInstances),
    };
  };

  const listVolumeBackups = async ({ volumeInstanceId }) => {
    const data = await request({
      query: `
        query RailwayVolumeBackups($volumeInstanceId: String!) {
          volumeInstanceBackupList(volumeInstanceId: $volumeInstanceId) {
            id
            name
            createdAt
            expiresAt
            usedMB
            referencedMB
          }
        }
      `,
      variables: { volumeInstanceId },
    });
    return data.volumeInstanceBackupList ?? [];
  };

  const createVolume = async ({
    projectId,
    environmentId,
    serviceId,
    mountPath,
  }) => {
    const data = await request({
      query: `
        mutation RailwayVolumeCreate($input: VolumeCreateInput!) {
          volumeCreate(input: $input) {
            id
            name
            projectId
          }
        }
      `,
      variables: {
        input: { projectId, environmentId, serviceId, mountPath },
      },
    });
    return data.volumeCreate;
  };

  const listVolumeBackupSchedules = async ({ volumeInstanceId }) => {
    const data = await request({
      query: `
        query RailwayVolumeBackupSchedules($volumeInstanceId: String!) {
          volumeInstanceBackupScheduleList(volumeInstanceId: $volumeInstanceId) {
            id
            name
            cron
            kind
            retentionSeconds
            createdAt
          }
        }
      `,
      variables: { volumeInstanceId },
    });
    return data.volumeInstanceBackupScheduleList ?? [];
  };

  const updateVolumeBackupSchedules = async ({ volumeInstanceId, kinds }) => {
    const data = await request({
      query: `
        mutation RailwayVolumeBackupScheduleUpdate(
          $volumeInstanceId: String!
          $kinds: [VolumeInstanceBackupScheduleKind!]!
        ) {
          volumeInstanceBackupScheduleUpdate(
            volumeInstanceId: $volumeInstanceId
            kinds: $kinds
          )
        }
      `,
      variables: { volumeInstanceId, kinds },
    });
    return data.volumeInstanceBackupScheduleUpdate;
  };

  const listDeployments = async ({
    projectId,
    environmentId,
    serviceId,
    first = 20,
  }) => {
    const data = await request({
      query: `
        query RailwayDeployments($input: DeploymentListInput!, $first: Int) {
          deployments(input: $input, first: $first) {
            edges {
              node {
                id
                status
                createdAt
                updatedAt
                url
                staticUrl
                serviceId
                environmentId
                meta
                canRedeploy
                canRollback
              }
            }
          }
        }
      `,
      variables: {
        input: { projectId, environmentId, serviceId },
        first,
      },
    });
    return connectionNodes(data.deployments).map(normalizeDeployment);
  };

  const createEnvironment = async ({
    projectId,
    name,
    sourceEnvironmentId = null,
    ephemeral = false,
    skipInitialDeploys = false,
    stageInitialChanges = false,
    applyChangesInBackground = false,
  }) => {
    const data = await request({
      query: `
        mutation RailwayEnvironmentCreate($input: EnvironmentCreateInput!) {
          environmentCreate(input: $input) {
            id
            name
            isEphemeral
          }
        }
      `,
      variables: {
        input: {
          projectId,
          name,
          sourceEnvironmentId,
          ephemeral,
          skipInitialDeploys,
          stageInitialChanges,
          applyChangesInBackground,
        },
      },
    });

    return data.environmentCreate;
  };

  const deleteEnvironment = async ({ environmentId }) => {
    const data = await request({
      query: `
        mutation RailwayEnvironmentDelete($id: String!) {
          environmentDelete(id: $id)
        }
      `,
      variables: {
        id: environmentId,
      },
    });

    return data.environmentDelete;
  };

  const getVariables = async ({
    projectId,
    environmentId,
    serviceId = null,
    unrendered = false,
  }) => {
    const data = await request({
      query: `
        query RailwayVariables(
          $projectId: String!
          $environmentId: String!
          $serviceId: String
          $unrendered: Boolean
        ) {
          variables(
            projectId: $projectId
            environmentId: $environmentId
            serviceId: $serviceId
            unrendered: $unrendered
          )
        }
      `,
      variables: {
        projectId,
        environmentId,
        serviceId,
        unrendered,
      },
    });

    return data.variables ?? {};
  };

  const upsertVariableCollection = async ({
    projectId,
    environmentId,
    serviceId = null,
    variables,
    skipDeploys = true,
    replace = false,
  }) => {
    const data = await request({
      query: `
        mutation RailwayVariableCollectionUpsert(
          $input: VariableCollectionUpsertInput!
        ) {
          variableCollectionUpsert(input: $input)
        }
      `,
      variables: {
        input: {
          projectId,
          environmentId,
          serviceId,
          variables,
          skipDeploys,
          replace,
        },
      },
    });

    return data.variableCollectionUpsert;
  };

  const triggerServiceDeployment = async ({
    environmentId,
    serviceId,
    commitSha = null,
  }) => {
    const data = await request({
      query: `
        mutation RailwayServiceInstanceDeploy(
          $environmentId: String!
          $serviceId: String!
          $commitSha: String
        ) {
          serviceInstanceDeployV2(
            environmentId: $environmentId
            serviceId: $serviceId
            commitSha: $commitSha
          )
        }
      `,
      variables: {
        environmentId,
        serviceId,
        commitSha,
      },
    });

    return data.serviceInstanceDeployV2;
  };

  const getDeployment = async (deploymentId) => {
    const data = await request({
      query: `
        query RailwayDeployment($id: String!) {
          deployment(id: $id) {
            id
            status
            url
            staticUrl
            serviceId
            environmentId
            createdAt
            updatedAt
            meta
            canRedeploy
            canRollback
          }
        }
      `,
      variables: {
        id: deploymentId,
      },
    });

    return normalizeDeployment(data.deployment);
  };

  const rollbackDeployment = async ({ deploymentId }) => {
    const data = await request({
      query: `
        mutation RailwayDeploymentRollback($id: String!) {
          deploymentRollback(id: $id)
        }
      `,
      variables: { id: deploymentId },
    });
    return data.deploymentRollback;
  };

  const waitForServiceDeployment = async ({
    environmentId,
    serviceId,
    matches,
    retries = 180,
    retryDelayMs = 2000,
  }) => {
    let lastDeployment = null;
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const environment = await getEnvironment(environmentId);
        const service = environment.serviceInstances.find(
          (candidate) => candidate.serviceId === serviceId,
        );
        if (!service) {
          return {
            deployment: lastDeployment,
            attempt,
            matched: false,
            error: `Service ${serviceId} is not present in Railway environment ${environmentId}.`,
          };
        }
        lastDeployment = service.latestDeployment;
        if (lastDeployment && matches(lastDeployment)) {
          return { deployment: lastDeployment, attempt, matched: true };
        }
        lastError = null;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    return {
      deployment: lastDeployment,
      attempt: retries,
      matched: false,
      timeout: true,
      ...(lastError ? { error: lastError } : {}),
    };
  };

  const waitForDeployment = async ({
    deploymentId,
    retries = 180,
    retryDelayMs = 2000,
  }) => {
    let lastDeployment = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      lastDeployment = await getDeployment(deploymentId);
      if (
        TERMINAL_SUCCESS_DEPLOYMENT_STATUSES.has(lastDeployment.status) ||
        TERMINAL_FAILURE_DEPLOYMENT_STATUSES.has(lastDeployment.status)
      ) {
        return {
          deployment: lastDeployment,
          attempt,
          ok: TERMINAL_SUCCESS_DEPLOYMENT_STATUSES.has(lastDeployment.status),
        };
      }

      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    return {
      deployment: lastDeployment,
      attempt: retries,
      ok: false,
      timeout: true,
    };
  };

  const resolveServicePublicDomain = async ({
    environmentId,
    serviceId = null,
    serviceName = null,
  }) => {
    const environment = await getEnvironment(environmentId);
    const instance = environment.serviceInstances.find(
      (entry) =>
        (serviceId && entry.serviceId === serviceId) ||
        (serviceName && entry.serviceName === serviceName),
    );
    if (!instance) {
      return null;
    }

    return firstNonEmptyString(
      instance.domains?.customDomains?.[0]?.domain,
      instance.domains?.serviceDomains?.[0]?.domain,
      instance.latestDeployment?.staticUrl,
      instance.latestDeployment?.url,
    );
  };

  const waitForServicePublicDomain = async ({
    environmentId,
    serviceId = null,
    serviceName = null,
    retries = 30,
    retryDelayMs = 2000,
  }) => {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const domain = await resolveServicePublicDomain({
        environmentId,
        serviceId,
        serviceName,
      });
      if (domain) {
        return domain;
      }

      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    return null;
  };

  return {
    endpoint,
    request,
    getCurrentViewer,
    listProjects,
    getProject,
    listEnvironments,
    getEnvironment,
    createVolume,
    listVolumeBackups,
    listVolumeBackupSchedules,
    updateVolumeBackupSchedules,
    createEnvironment,
    deleteEnvironment,
    getVariables,
    upsertVariableCollection,
    triggerServiceDeployment,
    getDeployment,
    listDeployments,
    rollbackDeployment,
    waitForServiceDeployment,
    waitForDeployment,
    resolveServicePublicDomain,
    waitForServicePublicDomain,
  };
};
