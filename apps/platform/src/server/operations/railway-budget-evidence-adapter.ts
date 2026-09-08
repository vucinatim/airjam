const DEFAULT_RAILWAY_API_ENDPOINT =
  "https://backboard.railway.com/graphql/v2";
const DEFAULT_RAILWAY_API_REQUEST_TIMEOUT_MS = 10_000;

export const RAILWAY_USAGE_EVIDENCE_CONTRACT_VERSION = 1;
export const RAILWAY_USAGE_SOURCE_VERSION =
  "railway-graphql-v2-usage@2026-09-08";
export const RAILWAY_USAGE_RATE_CARD = Object.freeze({
  id: "railway-public-pricing@2026-08-29",
  currency: "USD",
  minutesInMonth: 43_200,
  memoryGbMonthUsd: 10,
  cpuVcpuMonthUsd: 20,
  networkEgressGbUsd: 0.05,
  volumeGbMonthUsd: 0.15,
  backupGbMonthUsd: 0.15,
});

export const RAILWAY_USAGE_MEASUREMENTS = Object.freeze([
  "MEMORY_USAGE_GB",
  "CPU_USAGE",
  "NETWORK_TX_GB",
  "DISK_USAGE_GB",
  "BACKUP_USAGE_GB",
] as const);

const railwayUsageCostRates: Record<
  (typeof RAILWAY_USAGE_MEASUREMENTS)[number],
  number
> = {
  MEMORY_USAGE_GB: 10 / 43_200,
  CPU_USAGE: 20 / 43_200,
  NETWORK_TX_GB: 0.05,
  DISK_USAGE_GB: 0.15 / 43_200,
  BACKUP_USAGE_GB: 0.15 / 43_200,
};

type RailwayUsageMeasurement = {
  measurement: (typeof RAILWAY_USAGE_MEASUREMENTS)[number];
  value: number;
};

export type RailwayBudgetEvidence = {
  contractVersion: 1;
  provider: "railway";
  scope: {
    kind: "project";
    id: string;
    name: string;
    workspaceId: string;
    workspaceName: string;
    environmentId: string;
  };
  billingPeriod: { start: string; end: string };
  observedAt: string;
  currency: "USD";
  actualAmountMicrousd: number;
  projectedAmountMicrousd: number;
  measurements: {
    actual: RailwayUsageMeasurement[];
    projected: RailwayUsageMeasurement[];
  };
  costBreakdownMicrousd: {
    actual: Record<string, number>;
    projected: Record<string, number>;
  };
  rateCard: typeof RAILWAY_USAGE_RATE_CARD;
  sourceVersion: string;
};

export type RailwayBudgetEvidenceCollector = {
  collect: (input: { observedAt: Date }) => Promise<RailwayBudgetEvidence>;
};

export class RailwayBudgetEvidenceError extends Error {
  readonly errors: unknown[];
  readonly status: number | null;
  readonly payload: unknown;

  constructor(
    message: string,
    {
      errors = [],
      status = null,
      payload = null,
    }: { errors?: unknown[]; status?: number | null; payload?: unknown } = {},
  ) {
    super(message);
    this.name = "RailwayBudgetEvidenceError";
    this.errors = errors;
    this.status = status;
    this.payload = payload;
  }
}

const requiredText = (value: string | undefined, label: string): string => {
  const normalized = value?.trim();
  if (!normalized) {
    throw new RailwayBudgetEvidenceError(`${label} is required.`);
  }
  return normalized;
};

export const resolveRailwayBudgetEvidenceConfig = ({
  env = process.env,
  projectId = env.RAILWAY_PROJECT_ID,
  environmentId = env.RAILWAY_ENVIRONMENT_ID,
}: {
  env?: Record<string, string | undefined>;
  projectId?: string;
  environmentId?: string;
} = {}) => ({
  token: requiredText(
    env.RAILWAY_PROJECT_TOKEN,
    "RAILWAY_PROJECT_TOKEN (a sealed, environment-scoped project token)",
  ),
  projectId: requiredText(projectId, "Railway project id"),
  environmentId: requiredText(environmentId, "Railway environment id"),
});

const toMicrousd = (dollars: number) => Math.round(dollars * 1_000_000);

export const calculateRailwayUsageCost = (
  measurements: RailwayUsageMeasurement[],
) => {
  if (!Array.isArray(measurements)) {
    throw new RailwayBudgetEvidenceError(
      "Railway usage measurements must be an array.",
    );
  }
  const values = new Map<string, number>();
  for (const entry of measurements) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !RAILWAY_USAGE_MEASUREMENTS.includes(entry.measurement)
    ) {
      throw new RailwayBudgetEvidenceError(
        `Unsupported Railway usage measurement ${entry?.measurement ?? "<missing>"}.`,
      );
    }
    if (values.has(entry.measurement)) {
      throw new RailwayBudgetEvidenceError(
        `Railway usage measurement ${entry.measurement} was returned more than once.`,
      );
    }
    if (!Number.isFinite(entry.value) || entry.value < 0) {
      throw new RailwayBudgetEvidenceError(
        `Railway usage measurement ${entry.measurement} must be a non-negative finite number.`,
      );
    }
    values.set(entry.measurement, entry.value);
  }
  const breakdownMicrousd = Object.fromEntries(
    RAILWAY_USAGE_MEASUREMENTS.map((measurement) => [
      measurement,
      toMicrousd(
        (values.get(measurement) ?? 0) * railwayUsageCostRates[measurement],
      ),
    ]),
  );
  return {
    amountMicrousd: Object.values(breakdownMicrousd).reduce(
      (total, value) => total + value,
      0,
    ),
    breakdownMicrousd,
  };
};

const normalizeMeasurements = ({
  entries,
  valueKey,
  label,
}: {
  entries: unknown;
  valueKey: "value" | "estimatedValue";
  label: string;
}): RailwayUsageMeasurement[] => {
  if (!Array.isArray(entries)) {
    throw new RailwayBudgetEvidenceError(
      `Railway ${label} usage must be an array.`,
    );
  }
  return entries.map((entry) => {
    const record = entry as Record<string, unknown> | null;
    return {
      measurement: record?.measurement as RailwayUsageMeasurement["measurement"],
      value: record?.[valueKey] as number,
    };
  });
};

export const createRailwayBudgetEvidenceAdapter = ({
  token,
  projectId,
  environmentId,
  endpoint = DEFAULT_RAILWAY_API_ENDPOINT,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_RAILWAY_API_REQUEST_TIMEOUT_MS,
}: {
  token: string;
  projectId: string;
  environmentId: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}): RailwayBudgetEvidenceCollector => {
  const exactToken = requiredText(token, "Railway project token");
  const exactProjectId = requiredText(projectId, "Railway project id");
  const exactEnvironmentId = requiredText(
    environmentId,
    "Railway environment id",
  );
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new RailwayBudgetEvidenceError(
      "Railway API requestTimeoutMs must be a positive finite number.",
    );
  }

  const request = async <T>({
    query,
    variables = {},
  }: {
    query: string;
    variables?: Record<string, unknown>;
  }): Promise<T> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    timeout.unref();
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Project-Access-Token": exactToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      const rawBody = await response.text();
      type RailwayGraphqlPayload = { data?: T; errors?: unknown[] };
      let payload: RailwayGraphqlPayload | null = null;
      try {
        payload = JSON.parse(rawBody || "null") as RailwayGraphqlPayload | null;
      } catch (error) {
        throw new RailwayBudgetEvidenceError(
          `Failed to parse Railway API response JSON: ${error instanceof Error ? error.message : String(error)}`,
          { status: response.status },
        );
      }
      if (!response.ok || payload?.errors?.length || !payload?.data) {
        throw new RailwayBudgetEvidenceError(
          `Railway API request failed with status ${response.status}.`,
          {
            errors: payload?.errors ?? [],
            status: response.status,
            payload,
          },
        );
      }
      return payload.data;
    } catch (error) {
      if (error instanceof RailwayBudgetEvidenceError) throw error;
      if (controller.signal.aborted) {
        throw new RailwayBudgetEvidenceError(
          `Railway API request timed out after ${requestTimeoutMs}ms.`,
        );
      }
      throw new RailwayBudgetEvidenceError(
        `Railway API request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  let attestation: Promise<void> | null = null;
  const attestIdentity = () => {
    if (attestation) return attestation;
    const pending = request<{
      projectToken?: { projectId?: string; environmentId?: string } | null;
    }>({
      query: `
        query RailwayBudgetProjectTokenIdentity {
          projectToken {
            projectId
            environmentId
          }
        }
      `,
    }).then((data) => {
      const identity = data.projectToken;
      if (
        identity?.projectId !== exactProjectId ||
        identity.environmentId !== exactEnvironmentId
      ) {
        throw new RailwayBudgetEvidenceError(
          "Railway project token identity did not exactly match the configured project and environment.",
          {
            payload: {
              expectedProjectId: exactProjectId,
              expectedEnvironmentId: exactEnvironmentId,
              observedProjectId: identity?.projectId ?? null,
              observedEnvironmentId: identity?.environmentId ?? null,
            },
          },
        );
      }
    });
    attestation = pending;
    void pending.catch(() => {
      if (attestation === pending) attestation = null;
    });
    return pending;
  };

  return {
    collect: async ({ observedAt }) => {
      if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
        throw new RailwayBudgetEvidenceError(
          "Railway usage observedAt must be a valid Date.",
        );
      }
      await attestIdentity();
      const projectData = await request<{
        project?: {
          id?: string;
          name?: string;
          workspace?: {
            id?: string;
            name?: string;
            customer?: {
              billingPeriod?: { start?: string; end?: string } | null;
            } | null;
          } | null;
        } | null;
      }>({
        query: `
          query RailwayBudgetProject($id: String!) {
            project(id: $id) {
              id
              name
              workspace {
                id
                name
                customer {
                  billingPeriod { start end }
                }
              }
            }
          }
        `,
        variables: { id: exactProjectId },
      });
      const project = projectData.project;
      if (project?.id !== exactProjectId) {
        throw new RailwayBudgetEvidenceError(
          "Railway project query did not return the exactly attested project.",
        );
      }
      const billingPeriod = project.workspace?.customer?.billingPeriod;
      if (!billingPeriod?.start || !billingPeriod.end) {
        throw new RailwayBudgetEvidenceError(
          `Railway did not return a billing period for project ${exactProjectId}.`,
        );
      }
      const periodStart = new Date(billingPeriod.start);
      const periodEnd = new Date(billingPeriod.end);
      if (
        Number.isNaN(periodStart.getTime()) ||
        Number.isNaN(periodEnd.getTime()) ||
        periodEnd <= periodStart
      ) {
        throw new RailwayBudgetEvidenceError(
          `Railway returned an invalid billing period for project ${exactProjectId}.`,
        );
      }

      const usageData = await request<{
        usage?: unknown;
        estimatedUsage?: unknown;
      }>({
        query: `
          query RailwayProjectUsageEvidence(
            $projectId: String!
            $measurements: [MetricMeasurement!]!
            $startDate: DateTime!
            $endDate: DateTime!
          ) {
            usage(
              projectId: $projectId
              measurements: $measurements
              startDate: $startDate
              endDate: $endDate
              includeDeleted: true
            ) { measurement value }
            estimatedUsage(
              projectId: $projectId
              measurements: $measurements
              includeDeleted: true
            ) { measurement estimatedValue }
          }
        `,
        variables: {
          projectId: exactProjectId,
          measurements: RAILWAY_USAGE_MEASUREMENTS,
          startDate: billingPeriod.start,
          endDate: billingPeriod.end,
        },
      });
      const actualMeasurements = normalizeMeasurements({
        entries: usageData.usage,
        valueKey: "value",
        label: "actual",
      });
      const projectedMeasurements = normalizeMeasurements({
        entries: usageData.estimatedUsage,
        valueKey: "estimatedValue",
        label: "projected",
      });
      const actual = calculateRailwayUsageCost(actualMeasurements);
      const projected = calculateRailwayUsageCost(projectedMeasurements);

      return {
        contractVersion: RAILWAY_USAGE_EVIDENCE_CONTRACT_VERSION,
        provider: "railway",
        scope: {
          kind: "project",
          id: exactProjectId,
          name: requiredText(project.name, "Railway project name"),
          workspaceId: requiredText(
            project.workspace?.id,
            "Railway workspace id",
          ),
          workspaceName: requiredText(
            project.workspace?.name,
            "Railway workspace name",
          ),
          environmentId: exactEnvironmentId,
        },
        billingPeriod: {
          start: periodStart.toISOString(),
          end: periodEnd.toISOString(),
        },
        observedAt: observedAt.toISOString(),
        currency: "USD",
        actualAmountMicrousd: actual.amountMicrousd,
        projectedAmountMicrousd: projected.amountMicrousd,
        measurements: {
          actual: actualMeasurements,
          projected: projectedMeasurements,
        },
        costBreakdownMicrousd: {
          actual: actual.breakdownMicrousd,
          projected: projected.breakdownMicrousd,
        },
        rateCard: RAILWAY_USAGE_RATE_CARD,
        sourceVersion: RAILWAY_USAGE_SOURCE_VERSION,
      };
    },
  };
};
