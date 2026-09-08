import assert from "node:assert/strict";
import test from "node:test";
import { createRailwayApiClient } from "../lib/railway-api.mjs";

const createMockFetch = (handler) => async (_url, init) => {
  const body = JSON.parse(init.body);
  const payload = await handler(body);
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  };
};

test("getProject flattens Railway connection fields", async () => {
  const client = createRailwayApiClient({
    token: "token",
    fetchImpl: createMockFetch((body) => {
      assert.match(body.query, /query RailwayProject/);
      return {
        data: {
          project: {
            id: "project-1",
            name: "air-jam",
            workspace: { id: "workspace-1", name: "Tim Vucina's Projects" },
            environments: {
              edges: [
                {
                  node: { id: "env-1", name: "production", isEphemeral: false },
                },
              ],
            },
            services: {
              edges: [{ node: { id: "service-1", name: "air-jam-server" } }],
            },
          },
        },
      };
    }),
  });

  const project = await client.getProject("project-1");
  assert.equal(project.name, "air-jam");
  assert.deepEqual(
    project.environments.map((entry) => entry.name),
    ["production"],
  );
  assert.deepEqual(
    project.services.map((entry) => entry.name),
    ["air-jam-server"],
  );
});

test("resolveServicePublicDomain prefers custom domains, then service domains, then deployment URLs", async () => {
  const client = createRailwayApiClient({
    token: "token",
    fetchImpl: createMockFetch(() => ({
      data: {
        environment: {
          id: "env-1",
          name: "preview-pr-42",
          serviceInstances: {
            edges: [
              {
                node: {
                  serviceId: "service-1",
                  serviceName: "air-jam-server",
                  domains: {
                    customDomains: [{ domain: "api.airjam.io" }],
                    serviceDomains: [
                      { domain: "air-jam-server-preview-pr-42.up.railway.app" },
                    ],
                  },
                  latestDeployment: {
                    staticUrl: "fallback.up.railway.app",
                    url: "https://fallback.up.railway.app",
                  },
                },
              },
            ],
          },
        },
      },
    })),
  });

  const domain = await client.resolveServicePublicDomain({
    environmentId: "env-1",
    serviceName: "air-jam-server",
  });
  assert.equal(domain, "api.airjam.io");
});

test("waitForDeployment returns success once the deployment reaches a terminal success state", async () => {
  let calls = 0;
  const client = createRailwayApiClient({
    token: "token",
    fetchImpl: createMockFetch(() => {
      calls += 1;
      return {
        data: {
          deployment: {
            id: "deployment-1",
            status: calls === 1 ? "BUILDING" : "SUCCESS",
            url: null,
            staticUrl: "service.up.railway.app",
          },
        },
      };
    }),
  });

  const result = await client.waitForDeployment({
    deploymentId: "deployment-1",
    retries: 2,
    retryDelayMs: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(result.deployment.status, "SUCCESS");
  assert.equal(calls, 2);
});

test("waitForDeployment tolerates a transient provider read failure", async () => {
  let calls = 0;
  const client = createRailwayApiClient({
    token: "token",
    fetchImpl: createMockFetch(() => {
      calls += 1;
      if (calls === 1) throw new Error("transient read failure");
      return {
        data: {
          deployment: {
            id: "deployment-1",
            status: "SUCCESS",
            url: null,
            staticUrl: "service.up.railway.app",
          },
        },
      };
    }),
  });

  const result = await client.waitForDeployment({
    deploymentId: "deployment-1",
    retries: 2,
    retryDelayMs: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempt, 2);
  assert.equal(calls, 2);
});

test("waitForVolumeInstance tolerates delayed Railway attachment visibility", async () => {
  let calls = 0;
  const client = createRailwayApiClient({
    token: "token",
    fetchImpl: createMockFetch(() => {
      calls += 1;
      return {
        data: {
          environment: {
            id: "environment-1",
            name: "staging",
            projectId: "project-1",
            serviceInstances: { edges: [] },
            volumeInstances: {
              edges:
                calls === 1
                  ? []
                  : [
                      {
                        node: {
                          id: "volume-instance-1",
                          serviceId: "service-1",
                          mountPath: "/var/lib/postgresql/data",
                        },
                      },
                    ],
            },
          },
        },
      };
    }),
  });

  const result = await client.waitForVolumeInstance({
    environmentId: "environment-1",
    serviceId: "service-1",
    mountPath: "/var/lib/postgresql/data",
    retries: 2,
    retryDelayMs: 0,
  });

  assert.equal(result.matched, true);
  assert.equal(result.volume.id, "volume-instance-1");
  assert.equal(result.attempt, 2);
});

test("Railway recovery helpers expose backup policy and exact deployment actions", async () => {
  const observed = [];
  const client = createRailwayApiClient({
    token: "token",
    fetchImpl: createMockFetch((body) => {
      observed.push(body);
      if (body.query.includes("RailwayVolumeBackups")) {
        return {
          data: {
            volumeInstanceBackupList: [
              {
                id: "backup-1",
                name: "daily",
                createdAt: "2026-09-04T00:00:00.000Z",
                expiresAt: "2026-09-10T00:00:00.000Z",
                usedMB: 1,
                referencedMB: 2,
              },
            ],
          },
        };
      }
      if (body.query.includes("RailwayVolumeCreate")) {
        return {
          data: {
            volumeCreate: {
              id: "volume-created",
              name: "postgres-volume",
              projectId: "project-1",
            },
          },
        };
      }
      if (body.query.includes("RailwayVolumeBackupSchedules")) {
        return {
          data: {
            volumeInstanceBackupScheduleList: [
              {
                id: "schedule-1",
                name: "daily",
                cron: "0 0 * * *",
                kind: "DAILY",
                retentionSeconds: 518400,
                createdAt: "2026-09-04T00:00:00.000Z",
              },
            ],
          },
        };
      }
      if (body.query.includes("RailwayVolumeBackupScheduleUpdate")) {
        return { data: { volumeInstanceBackupScheduleUpdate: true } };
      }
      if (body.query.includes("RailwayDeployments")) {
        return {
          data: {
            deployments: {
              edges: [
                {
                  node: {
                    id: "deployment-old",
                    status: "REMOVED",
                    serviceId: "service-1",
                    environmentId: "environment-1",
                    meta: { commitHash: "abc123" },
                    canRedeploy: true,
                    canRollback: true,
                  },
                },
              ],
            },
          },
        };
      }
      if (body.query.includes("RailwayDeploymentRollback")) {
        return { data: { deploymentRollback: true } };
      }
      throw new Error(`Unexpected query: ${body.query}`);
    }),
  });

  assert.equal(
    (await client.listVolumeBackups({ volumeInstanceId: "volume-1" }))[0].id,
    "backup-1",
  );
  assert.equal(
    (
      await client.listVolumeBackupSchedules({
        volumeInstanceId: "volume-1",
      })
    )[0].kind,
    "DAILY",
  );
  assert.equal(
    await client.updateVolumeBackupSchedules({
      volumeInstanceId: "volume-1",
      kinds: ["DAILY", "WEEKLY"],
    }),
    true,
  );
  const createdVolume = await client.createVolume({
    projectId: "project-1",
    environmentId: "environment-1",
    serviceId: "service-1",
    mountPath: "/var/lib/postgresql/data",
  });
  assert.equal(createdVolume.id, "volume-created");
  assert.deepEqual(observed[3].variables.input, {
    projectId: "project-1",
    environmentId: "environment-1",
    serviceId: "service-1",
    mountPath: "/var/lib/postgresql/data",
  });
  const deployments = await client.listDeployments({
    projectId: "project-1",
    environmentId: "environment-1",
    serviceId: "service-1",
  });
  assert.equal(deployments[0].canRollback, true);
  assert.equal(deployments[0].meta.commitHash, "abc123");
  const rollback = await client.rollbackDeployment({
    deploymentId: "deployment-old",
  });
  assert.equal(rollback, true);
  assert.doesNotMatch(
    observed[5].query,
    /deploymentRollback\(id: \$id\)\s*\{/u,
  );
  assert.match(
    observed[5].query,
    /mutation RailwayDeploymentRollback[\s\S]*deploymentRollback\(id: \$id\)\s*\}/u,
  );
  assert.deepEqual(observed[2].variables, {
    volumeInstanceId: "volume-1",
    kinds: ["DAILY", "WEEKLY"],
  });
  assert.deepEqual(observed[5].variables, { id: "deployment-old" });
});

test("Railway waits for a new service deployment matching the exact target", async () => {
  let reads = 0;
  const client = createRailwayApiClient({
    token: "token",
    fetchImpl: createMockFetch((body) => {
      assert.match(body.query, /query RailwayEnvironment/u);
      reads += 1;
      if (reads === 1) throw new Error("transient provider read failure");
      const deploymentId =
        reads === 2 ? "deployment-unrelated" : "deployment-rollback";
      const revision =
        deploymentId === "deployment-rollback"
          ? "revision-target"
          : "revision-unrelated";
      return {
        data: {
          environment: {
            id: "environment-1",
            name: "production",
            projectId: "project-1",
            serviceInstances: {
              edges: [
                {
                  node: {
                    serviceId: "service-1",
                    serviceName: "platform",
                    railwayConfigFile: "/railway.json",
                    latestDeployment: {
                      id: deploymentId,
                      status: "INITIALIZING",
                      serviceId: "service-1",
                      environmentId: "environment-1",
                      meta: {
                        commitHash: revision,
                        imageDigest: `sha256:${revision}`,
                      },
                      canRedeploy: false,
                      canRollback: false,
                    },
                    domains: { customDomains: [], serviceDomains: [] },
                  },
                },
              ],
            },
            volumeInstances: { edges: [] },
          },
        },
      };
    }),
  });

  const result = await client.waitForServiceDeployment({
    environmentId: "environment-1",
    serviceId: "service-1",
    matches: (candidate) =>
      candidate.id !== "deployment-current" &&
      candidate.meta.commitHash === "revision-target",
    retries: 3,
    retryDelayMs: 0,
  });

  assert.equal(result.matched, true);
  assert.equal(result.deployment.id, "deployment-rollback");
  assert.equal(result.attempt, 3);
});

test("Railway deployment matching reports timeout and the last observation", async () => {
  const client = createRailwayApiClient({
    token: "token",
    fetchImpl: createMockFetch(() => ({
      data: {
        environment: {
          id: "environment-1",
          name: "production",
          projectId: "project-1",
          serviceInstances: {
            edges: [
              {
                node: {
                  serviceId: "service-1",
                  serviceName: "platform",
                  latestDeployment: {
                    id: "deployment-unrelated",
                    status: "SUCCESS",
                    serviceId: "service-1",
                    environmentId: "environment-1",
                    meta: { commitHash: "revision-unrelated" },
                  },
                  domains: { customDomains: [], serviceDomains: [] },
                },
              },
            ],
          },
          volumeInstances: { edges: [] },
        },
      },
    })),
  });

  const result = await client.waitForServiceDeployment({
    environmentId: "environment-1",
    serviceId: "service-1",
    matches: (candidate) =>
      candidate.id !== "deployment-current" &&
      candidate.meta.commitHash === "revision-target",
    retries: 1,
    retryDelayMs: 0,
  });

  assert.equal(result.matched, false);
  assert.equal(result.timeout, true);
  assert.equal(result.deployment.id, "deployment-unrelated");
  assert.equal(result.attempt, 1);
});

test("Railway deployment matching reports a missing service", async () => {
  const client = createRailwayApiClient({
    token: "token",
    fetchImpl: createMockFetch(() => ({
      data: {
        environment: {
          id: "environment-1",
          name: "production",
          projectId: "project-1",
          serviceInstances: { edges: [] },
          volumeInstances: { edges: [] },
        },
      },
    })),
  });

  const result = await client.waitForServiceDeployment({
    environmentId: "environment-1",
    serviceId: "service-missing",
    matches: () => false,
    retries: 1,
    retryDelayMs: 0,
  });

  assert.equal(result.matched, false);
  assert.match(result.error, /service-missing/u);
});

test("Railway API requests have an absolute aborting deadline", async () => {
  let aborted = false;
  const client = createRailwayApiClient({
    token: "token",
    requestTimeoutMs: 20,
    fetchImpl: async (_url, init) =>
      await new Promise((_resolve) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
        });
      }),
  });

  await assert.rejects(client.getProject("project-1"), (error) => {
    assert.equal(error.name, "RailwayApiError");
    assert.match(error.message, /timed out after 20ms/);
    return true;
  });
  assert.equal(aborted, true);
});

test("Railway API rejects invalid request deadlines before making a request", () => {
  assert.throws(
    () =>
      createRailwayApiClient({
        token: "token",
        requestTimeoutMs: 0,
      }),
    /positive finite number/,
  );
});
