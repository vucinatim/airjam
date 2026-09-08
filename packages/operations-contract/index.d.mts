import type { ZodType } from "zod";

export declare const OPERATIONS_CONTRACT_VERSION: 1;
export declare const OPERATIONS_CONTRACT_NAME: "air-jam-operations";
export declare const OPERATIONS_EVENT_MAX_PAYLOAD_BYTES: number;
export declare const DEFAULT_OPERATIONAL_EVENT_DELIVERY_MAX_ATTEMPTS: 8;
export declare const DEFAULT_OPERATIONAL_ALERT_ISSUE_MAX_ATTEMPTS: 8;
export declare const OPERATIONAL_ALERT_ISSUE_LABEL: "airjam:operational-alert";
export declare const operationalIdentifierSchema: ZodType<string>;

export declare const deploymentEnvironments: readonly [
  "production",
  "preview",
  "development",
  "test",
];
export declare const operationalServices: readonly [
  "platform",
  "realtime_server",
  "operational_worker",
  "browser_worker",
  "hosted_runtime",
  "repository",
  "provider",
];
export declare const operationalEventAuthorities: readonly [
  "airjam_authoritative",
  "provider_attested",
  "synthetic_observation",
  "operator_attested",
  "runtime_reported",
];
export declare const operationalEventSeverities: readonly [
  "debug",
  "info",
  "warning",
  "error",
  "critical",
];
export declare const operationalEventOutcomes: readonly [
  "observed",
  "started",
  "succeeded",
  "failed",
  "degraded",
  "recovered",
  "blocked",
  "canceled",
];
export declare const operationalFailureClasses: readonly [
  "invalid_input",
  "authorization",
  "conflict",
  "dependency",
  "timeout",
  "capacity",
  "unavailable",
  "internal",
];
export declare const operationalSloStatuses: readonly [
  "insufficient_data",
  "healthy",
  "breaching",
];
export declare const operationalSyntheticRunStatuses: readonly [
  "passed",
  "failed",
  "error",
];
export declare const operationalAlertStatuses: readonly ["open", "recovered"];
export declare const operationalAlertIssueProjectionStatuses: readonly [
  "pending",
  "delivering",
  "delivered",
  "dead_letter",
];
export declare const operationalAlertIssueStates: readonly ["open", "closed"];
export declare const operationalSubjectTypes: readonly [
  "platform",
  "service",
  "deployment",
  "request",
  "user_session",
  "room",
  "runtime_session",
  "controller",
  "game",
  "release",
  "release_generation",
  "operational_job",
  "provider_operation",
  "repository",
  "package",
  "synthetic_check",
];
export declare const evidenceKinds: readonly [
  "log",
  "metric",
  "trace",
  "event",
  "job",
  "deployment",
  "artifact",
  "snapshot",
  "command",
  "url",
];
export declare const incidentSeverities: readonly [
  "sev1",
  "sev2",
  "sev3",
  "sev4",
];
export declare const incidentStatuses: readonly [
  "open",
  "investigating",
  "mitigating",
  "monitoring",
  "resolved",
  "escalated",
];
export declare const runbookAuthorities: readonly [
  "observe",
  "recommend",
  "approval_required",
  "bounded_auto",
];
export declare const runbookMutationClasses: readonly [
  "read_only",
  "reversible",
  "destructive",
];
export declare const runbookInvocationModes: readonly ["preview", "apply"];
export declare const runbookActionStatuses: readonly [
  "scheduled",
  "running",
  "succeeded",
  "failed",
  "rolled_back",
  "rejected",
  "escalated",
];
export declare const operationsContractSchemaNames: readonly [
  "operational_event",
  "operational_failure",
  "slo_definition",
  "slo_evaluation",
  "synthetic_check",
  "synthetic_run",
  "alert",
  "alert_issue_projection",
  "incident_fingerprint_input",
  "incident",
  "runbook",
  "runbook_preview",
  "runbook_invocation",
  "runbook_action",
];

export type DeploymentEnvironment = (typeof deploymentEnvironments)[number];
export type OperationalBudgetRequirement = "required" | "not_applicable";
export type OperationalService = (typeof operationalServices)[number];
export type OperationalEventAuthority =
  (typeof operationalEventAuthorities)[number];
export type OperationalEventSeverity =
  (typeof operationalEventSeverities)[number];
export type OperationalEventOutcome = (typeof operationalEventOutcomes)[number];
export type OperationalFailureClass =
  (typeof operationalFailureClasses)[number];
export type OperationalSloStatus = (typeof operationalSloStatuses)[number];
export type OperationalSyntheticRunStatus =
  (typeof operationalSyntheticRunStatuses)[number];
export type OperationalAlertStatus = (typeof operationalAlertStatuses)[number];
export type OperationalAlertIssueProjectionStatus =
  (typeof operationalAlertIssueProjectionStatuses)[number];
export type OperationalAlertIssueState =
  (typeof operationalAlertIssueStates)[number];
export type OperationalSubjectType = (typeof operationalSubjectTypes)[number];
export type OperationalEvidenceKind = (typeof evidenceKinds)[number];
export type IncidentSeverity = (typeof incidentSeverities)[number];
export type IncidentStatus = (typeof incidentStatuses)[number];
export type RunbookAuthority = (typeof runbookAuthorities)[number];
export type RunbookMutationClass = (typeof runbookMutationClasses)[number];
export type RunbookInvocationMode = (typeof runbookInvocationModes)[number];
export type RunbookActionStatus = (typeof runbookActionStatuses)[number];
export type OperationsContractSchemaName =
  (typeof operationsContractSchemaNames)[number];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface OperationalCorrelationV1 {
  contractVersion: 1;
  correlationId: string;
  causationEventId?: string;
  requestId?: string;
  userSessionId?: string;
  roomId?: string;
  runtimeSessionId?: string;
  controllerId?: string;
  gameId?: string;
  releaseId?: string;
  generationId?: string;
  jobId?: string;
  deploymentId?: string;
  providerOperationId?: string;
}

export type OperationalActorV1 = {
  type: "system" | "agent" | "operator" | "user" | "provider";
  id: string;
};

export interface OperationalEvidenceV1 {
  kind: OperationalEvidenceKind;
  reference: string;
  digestSha256?: string;
  collectedAt: string;
}

export interface OperationalEventEnvelopeV1 {
  contractVersion: 1;
  plane: "lifecycle_runtime";
  eventId: string;
  kind: string;
  severity: OperationalEventSeverity;
  outcome: OperationalEventOutcome;
  authority: OperationalEventAuthority;
  source: {
    service: OperationalService;
    component: string;
    environment: DeploymentEnvironment;
    instanceId?: string;
    version?: string;
  };
  subject: { type: OperationalSubjectType; id: string };
  actor?: OperationalActorV1;
  correlation: OperationalCorrelationV1;
  occurredAt: string;
  observedAt: string;
  payload: Record<string, JsonValue>;
  evidence: OperationalEvidenceV1[];
}

export interface OperationalFailureV1 {
  contractVersion: 1;
  code: string;
  class: OperationalFailureClass;
  summary: string;
  retryable: boolean;
  stage?: string;
  causeCode?: string;
  details: Record<string, JsonValue>;
}

export interface OperationalSloDefinitionV1 {
  contractVersion: 1;
  sloId: string;
  title: string;
  description: string;
  service: OperationalService;
  indicator: "synthetic_success_ratio";
  syntheticCheckIds: string[];
  objectiveBasisPoints: number;
  windowSeconds: number;
  minimumSamples: number;
  alerting: {
    severity: "warning" | "error" | "critical";
    consecutiveBreaches: number;
    consecutiveRecoveries: number;
  };
}

export interface OperationalSloEvaluationV1 {
  contractVersion: 1;
  evaluationId: string;
  sloId: string;
  environment: DeploymentEnvironment;
  service: OperationalService;
  windowStartedAt: string;
  windowEndedAt: string;
  sampleCount: number;
  successCount: number;
  successRatioBasisPoints: number | null;
  objectiveBasisPoints: number;
  status: OperationalSloStatus;
  consecutiveBreaches: number;
  consecutiveRecoveries: number;
  evaluatedAt: string;
  evidence: OperationalEvidenceV1[];
}

export interface OperationalSyntheticCheckV1 {
  contractVersion: 1;
  checkId: string;
  title: string;
  description: string;
  story:
    | "landing_docs"
    | "arcade_hosted_release"
    | "platform_realtime_health"
    | "room_controller"
    | "semantic_gameplay"
    | "release_dependencies";
  service: OperationalService;
  executor: "http" | "airjam_semantic" | "release_dependency";
  intervalSeconds: number;
  timeoutMilliseconds: number;
  sloId: string;
  steps: Array<{
    stepId: string;
    targetKey: string;
    assertion:
      | "http_2xx"
      | "json_ok"
      | "html_marker"
      | "airjam_session"
      | "dependency_ready";
  }>;
}

export interface OperationalSyntheticRunV1 {
  contractVersion: 1;
  runId: string;
  checkId: string;
  environment: DeploymentEnvironment;
  status: OperationalSyntheticRunStatus;
  startedAt: string;
  completedAt: string;
  durationMilliseconds: number;
  eventId: string;
  observations: Array<{
    stepId: string;
    status: "passed" | "failed" | "error";
    latencyMilliseconds: number;
    httpStatus?: number;
    failure?: OperationalFailureV1;
  }>;
  evidence: OperationalEvidenceV1[];
}

export interface OperationalAlertV1 {
  contractVersion: 1;
  alertId: string;
  alertKey: string;
  policyId: string;
  environment: DeploymentEnvironment;
  service: OperationalService;
  severity: "warning" | "error" | "critical";
  status: OperationalAlertStatus;
  summary: string;
  firstTriggeredAt: string;
  lastObservedAt: string;
  occurrenceCount: number;
  latestEventId: string;
  latestEvaluationId: string;
  recoveredAt?: string;
  revision: number;
}

export interface OperationalAlertIssueProjectionV1 {
  contractVersion: 1;
  projectionId: string;
  provider: "github";
  repository: string;
  alertKey: string;
  targetAlertRevision: number;
  projectedAlertRevision: number;
  status: OperationalAlertIssueProjectionStatus;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  issue: {
    number: number;
    url: string;
    state: OperationalAlertIssueState;
  } | null;
  managedBodyHash: string | null;
  projectedAt: string | null;
  lastError: OperationalFailureV1 | null;
  createdAt: string;
  updatedAt: string;
}

export declare const githubRepositorySchema: ZodType<string>;

export interface IncidentFingerprintInputV1 {
  contractVersion: 1;
  environment: DeploymentEnvironment;
  service: OperationalService;
  symptomKind: string;
  failureClass: string;
  scope: "global" | "service" | "game" | "release" | "room";
  scopeKey?: string;
}

export interface OperationalIncidentV1 {
  contractVersion: 1;
  incidentId: string;
  fingerprint: string;
  fingerprintInput: IncidentFingerprintInputV1;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  summary: string;
  owner:
    | { type: "unassigned" }
    | { type: "agent" | "operator" | "team"; id: string };
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  latestEventId: string;
  correlationIds: string[];
  evidence: OperationalEvidenceV1[];
  activeRunbookActionId?: string;
  externalIssue?: {
    provider: "github";
    repository: string;
    number: number;
    url: string;
  };
  resolution?: {
    code: string;
    summary: string;
    resolvedAt: string;
    resolvedBy: OperationalActorV1;
  };
  revision: number;
}

export interface OperationalRunbookV1 {
  contractVersion: 1;
  runbookId: string;
  runbookVersion: string;
  title: string;
  description: string;
  authority: RunbookAuthority;
  mutationClass: RunbookMutationClass;
  blastRadius: {
    environments: DeploymentEnvironment[];
    services: OperationalService[];
    maxResources: number;
    maxEstimatedCostUsd: number;
  };
  policy: {
    maxAttempts: number;
    cooldownSeconds: number;
    timeoutSeconds: number;
    requiresApproval: boolean;
  };
  parameters: Array<{
    name: string;
    type: "string" | "integer" | "boolean" | "enum" | "resource_ref";
    required: boolean;
    description: string;
    allowedValues?: string[];
  }>;
  actions: Array<{ id: string; action: string; description: string }>;
  verificationAction?: string;
  rollbackRunbookId?: string;
}

export interface OperationalRunbookPreviewV1 {
  contractVersion: 1;
  previewId: string;
  runbookId: string;
  runbookVersion: string;
  runbookDigestSha256: string;
  parametersDigestSha256: string;
  incidentId?: string;
  correlation: OperationalCorrelationV1;
  createdAt: string;
  expiresAt: string;
  blastRadius: {
    environments: DeploymentEnvironment[];
    services: OperationalService[];
    resourceReferences: string[];
    estimatedCostUsd: number;
  };
  actionIds: string[];
  beforeEvidence: OperationalEvidenceV1[];
  warnings: string[];
}

interface RunbookInvocationBaseV1 {
  contractVersion: 1;
  runbookId: string;
  runbookVersion: string;
  idempotencyKey: string;
  reason: string;
  incidentId?: string;
  actor: OperationalActorV1;
  correlation: OperationalCorrelationV1;
  parameters: Record<string, JsonValue>;
  requestedAt: string;
}

export type OperationalRunbookInvocationV1 =
  | (RunbookInvocationBaseV1 & { mode: "preview" })
  | (RunbookInvocationBaseV1 & {
      mode: "apply";
      previewId: string;
      previewDigestSha256: string;
      approval?: {
        approvedBy: OperationalActorV1;
        approvedAt: string;
        decisionReference: string;
      };
    });

export interface OperationalRunbookActionV1 {
  contractVersion: 1;
  actionId: string;
  runbookId: string;
  runbookVersion: string;
  incidentId?: string;
  previewId: string;
  previewDigestSha256: string;
  idempotencyKey: string;
  actor: OperationalActorV1;
  correlation: OperationalCorrelationV1;
  status: RunbookActionStatus;
  attempt: number;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  beforeEvidence: OperationalEvidenceV1[];
  afterEvidence: OperationalEvidenceV1[];
  result?: {
    code: string;
    summary: string;
    details: Record<string, JsonValue>;
  };
  rollbackActionId?: string;
}

export declare const incidentStatusTransitions: Readonly<
  Record<IncidentStatus, readonly IncidentStatus[]>
>;
export declare const runbookActionStatusTransitions: Readonly<
  Record<RunbookActionStatus, readonly RunbookActionStatus[]>
>;

export declare const jsonValueSchema: ZodType<JsonValue>;
export declare const serializeCanonicalOperationsJson: (
  value: unknown,
) => string;
export declare const createOperationsDocumentDigest: (value: unknown) => string;
export declare const areOperationalEventEnvelopesIdempotentlyEquivalent: (
  left: unknown,
  right: unknown,
) => boolean;
export declare const resolveDeploymentEnvironment: (
  env?: Record<string, string | undefined>,
) => DeploymentEnvironment;
export declare const resolveOperationalBudgetRequirement: (
  env?: Record<string, string | undefined>,
) => OperationalBudgetRequirement;
export declare const operationalCorrelationSchemaV1: ZodType<OperationalCorrelationV1>;
export declare const operationalActorSchemaV1: ZodType<OperationalActorV1>;
export declare const operationalEvidenceSchemaV1: ZodType<OperationalEvidenceV1>;
export declare const operationalEventEnvelopeSchemaV1: ZodType<OperationalEventEnvelopeV1>;
export declare const operationalFailureSchemaV1: ZodType<OperationalFailureV1>;
export declare const createStructuredOperationalFailure: (input: {
  code: string;
  failureClass: OperationalFailureClass;
  summary: string;
  retryable: boolean;
  stage?: string | null;
  causeCode?: string | null;
  details?: Record<string, unknown>;
}) => OperationalFailureV1;
export declare const normalizeUnknownOperationalFailure: (input: {
  error: unknown;
  code?: string;
  summary?: string;
  retryable?: boolean;
  stage?: string | null;
  details?: Record<string, unknown>;
}) => OperationalFailureV1;
export declare const normalizeOperationalJobFailure: (input: {
  error: Record<string, unknown>;
  retryable: boolean;
  jobKind: string;
}) => OperationalFailureV1;
export declare const operationalSloDefinitionSchemaV1: ZodType<OperationalSloDefinitionV1>;
export declare const operationalSloEvaluationSchemaV1: ZodType<OperationalSloEvaluationV1>;
export declare const operationalSyntheticCheckSchemaV1: ZodType<OperationalSyntheticCheckV1>;
export declare const operationalSyntheticRunSchemaV1: ZodType<OperationalSyntheticRunV1>;
export declare const operationalAlertSchemaV1: ZodType<OperationalAlertV1>;
export declare const operationalAlertIssueProjectionSchemaV1: ZodType<OperationalAlertIssueProjectionV1>;
export declare const incidentFingerprintInputSchemaV1: ZodType<IncidentFingerprintInputV1>;
export declare const operationalIncidentSchemaV1: ZodType<OperationalIncidentV1>;
export declare const operationalRunbookSchemaV1: ZodType<OperationalRunbookV1>;
export declare const operationalRunbookPreviewSchemaV1: ZodType<OperationalRunbookPreviewV1>;
export declare const operationalRunbookInvocationSchemaV1: ZodType<OperationalRunbookInvocationV1>;
export declare const operationalRunbookActionSchemaV1: ZodType<OperationalRunbookActionV1>;

export declare const createIncidentFingerprint: (
  input: IncidentFingerprintInputV1,
) => string;
export declare const createRunbookDescriptorDigest: (
  runbook: unknown,
) => string;
export declare const createRunbookParametersDigest: (
  parameters: unknown,
) => string;
export declare const createRunbookPreviewDigest: (preview: unknown) => string;
export declare const assertIncidentStatusTransition: (
  fromStatus: IncidentStatus,
  toStatus: IncidentStatus,
) => { from: IncidentStatus; to: IncidentStatus };
export declare const assertRunbookActionStatusTransition: (
  fromStatus: RunbookActionStatus,
  toStatus: RunbookActionStatus,
) => { from: RunbookActionStatus; to: RunbookActionStatus };
export declare const assertRunbookInvocationAuthorized: (
  runbook: unknown,
  invocation: unknown,
  preview?: unknown,
) => {
  runbook: OperationalRunbookV1;
  invocation: OperationalRunbookInvocationV1;
  preview: OperationalRunbookPreviewV1 | undefined;
};
export declare const parseOperationsContractValue: (
  schemaName: OperationsContractSchemaName,
  value: unknown,
) => unknown;

export interface OperationsContractJsonSchema {
  name: "air-jam-operations";
  contractVersion: 1;
  schema: OperationsContractSchemaName;
  runtimeValidationRequired: true;
  jsonSchema: Record<string, JsonValue>;
}

export declare const getOperationsContractJsonSchema: (
  schemaName: OperationsContractSchemaName,
) => OperationsContractJsonSchema;

export interface OperationsContractCatalog {
  name: "air-jam-operations";
  contractVersion: 1;
  planes: ReadonlyArray<Record<string, JsonValue>>;
  correlation: Record<string, JsonValue>;
  event: Record<string, JsonValue>;
  reliability: Record<string, JsonValue>;
  incident: Record<string, JsonValue>;
  runbook: Record<string, JsonValue>;
  safety: Record<string, JsonValue>;
  schemas: readonly OperationsContractSchemaName[];
}

export declare const getOperationsContractCatalog: () => OperationsContractCatalog;
