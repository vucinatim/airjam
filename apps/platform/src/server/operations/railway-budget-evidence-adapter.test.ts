import { describe, expect, it, vi } from "vitest";
import {
  calculateRailwayUsageCost,
  createRailwayBudgetEvidenceAdapter,
  RAILWAY_USAGE_SOURCE_VERSION,
  resolveRailwayBudgetEvidenceConfig,
} from "./railway-budget-evidence-adapter";

const response = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Railway budget evidence adapter", () => {
  it("requires only an explicit project token and exact target ids", () => {
    expect(() =>
      resolveRailwayBudgetEvidenceConfig({
        env: {
          RAILWAY_API_TOKEN: "account-token",
          RAILWAY_TOKEN: "ambiguous-token",
        },
        projectId: "project-1",
        environmentId: "environment-1",
      }),
    ).toThrow(/RAILWAY_PROJECT_TOKEN/u);
    expect(
      resolveRailwayBudgetEvidenceConfig({
        env: { RAILWAY_PROJECT_TOKEN: "project-token" },
        projectId: " project-1 ",
        environmentId: " environment-1 ",
      }),
    ).toEqual({
      token: "project-token",
      projectId: "project-1",
      environmentId: "environment-1",
    });
  });

  it("attests project-token identity once and collects normalized evidence", async () => {
    const actualMeasurements = [
      { measurement: "MEMORY_USAGE_GB", value: 43_200 },
      { measurement: "CPU_USAGE", value: 43_200 },
      { measurement: "NETWORK_TX_GB", value: 2 },
      { measurement: "DISK_USAGE_GB", value: 43_200 },
      { measurement: "BACKUP_USAGE_GB", value: 43_200 },
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      expect(new Headers(init?.headers).get("Project-Access-Token")).toBe(
        "project-token",
      );
      expect(new Headers(init?.headers).get("Authorization")).toBeNull();
      if (body.query.includes("RailwayBudgetProjectTokenIdentity")) {
        return response({
          data: {
            projectToken: {
              projectId: "project-1",
              environmentId: "environment-1",
            },
          },
        });
      }
      if (body.query.includes("RailwayBudgetProject(")) {
        return response({
          data: {
            project: {
              id: "project-1",
              name: "air-jam",
              workspace: {
                id: "workspace-1",
                name: "Air Jam",
                customer: {
                  billingPeriod: {
                    start: "2026-09-01T00:00:00.000Z",
                    end: "2026-10-01T00:00:00.000Z",
                  },
                },
              },
            },
          },
        });
      }
      expect(body.variables).toMatchObject({
        projectId: "project-1",
        startDate: "2026-09-01T00:00:00.000Z",
        endDate: "2026-10-01T00:00:00.000Z",
      });
      return response({
        data: {
          usage: actualMeasurements,
          estimatedUsage: actualMeasurements.map((entry) => ({
            measurement: entry.measurement,
            estimatedValue: entry.value * 2,
          })),
        },
      });
    });
    const adapter = createRailwayBudgetEvidenceAdapter({
      token: "project-token",
      projectId: "project-1",
      environmentId: "environment-1",
      fetchImpl,
    });

    const first = await adapter.collect({
      observedAt: new Date("2026-09-08T12:00:00.000Z"),
    });
    await adapter.collect({
      observedAt: new Date("2026-09-08T12:15:00.000Z"),
    });

    expect(first).toMatchObject({
      provider: "railway",
      sourceVersion: RAILWAY_USAGE_SOURCE_VERSION,
      actualAmountMicrousd: 30_400_000,
      projectedAmountMicrousd: 60_800_000,
      scope: {
        id: "project-1",
        environmentId: "environment-1",
      },
    });
    expect(
      fetchImpl.mock.calls.filter(([_, init]) =>
        String(init?.body).includes("RailwayBudgetProjectTokenIdentity"),
      ),
    ).toHaveLength(1);
  });

  it("rejects identity mismatch before querying usage", async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        data: {
          projectToken: {
            projectId: "project-other",
            environmentId: "environment-1",
          },
        },
      }),
    );
    const adapter = createRailwayBudgetEvidenceAdapter({
      token: "project-token",
      projectId: "project-1",
      environmentId: "environment-1",
      fetchImpl,
    });

    await expect(
      adapter.collect({ observedAt: new Date("2026-09-08T12:00:00.000Z") }),
    ).rejects.toThrow(/did not exactly match/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown, duplicate, invalid, and incomplete measurements", () => {
    expect(() =>
      calculateRailwayUsageCost([
        { measurement: "NETWORK_RX_GB", value: 1 },
      ] as never),
    ).toThrow(/Unsupported Railway usage measurement/u);
    expect(() =>
      calculateRailwayUsageCost([
        { measurement: "MEMORY_USAGE_GB", value: Number.NaN },
      ]),
    ).toThrow(/non-negative finite number/u);
    expect(() =>
      calculateRailwayUsageCost([
        { measurement: "MEMORY_USAGE_GB", value: 1 },
        { measurement: "MEMORY_USAGE_GB", value: 2 },
      ]),
    ).toThrow(/returned more than once/u);
    expect(() =>
      calculateRailwayUsageCost([{ measurement: "MEMORY_USAGE_GB", value: 1 }]),
    ).toThrow(/omitted required measurements/u);
  });
});
