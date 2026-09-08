import { createHash } from "node:crypto";
import { toJSONSchema, z } from "zod";

export const OPERATIONS_CONTRACT_VERSION = 1;
export const OPERATIONS_CONTRACT_NAME = "air-jam-operations";
export const OPERATIONS_EVENT_MAX_PAYLOAD_BYTES = 64 * 1024;
export const DEFAULT_OPERATIONAL_EVENT_DELIVERY_MAX_ATTEMPTS = 8;
export const DEFAULT_OPERATIONAL_ALERT_ISSUE_MAX_ATTEMPTS = 8;
export const OPERATIONAL_ALERT_ISSUE_LABEL = "airjam:operational-alert";

export const deploymentEnvironments = Object.freeze([
  "production",
  "preview",
  "development",
  "test",
]);

export const operationalServices = Object.freeze([
  "platform",
  "realtime_server",
  "operational_worker",
  "browser_worker",
  "hosted_runtime",
  "repository",
  "provider",
]);

export const operationalEventAuthorities = Object.freeze([
  "airjam_authoritative",
  "provider_attested",
  "synthetic_observation",
  "operator_attested",
  "runtime_reported",
]);

export const operationalEventSeverities = Object.freeze([
  "debug",
  "info",
  "warning",
  "error",
  "critical",
]);

export const operationalEventOutcomes = Object.freeze([
  "observed",
  "started",
  "succeeded",
  "failed",
  "degraded",
  "recovered",
  "blocked",
  "canceled",
]);

export const operationalFailureClasses = Object.freeze([
  "invalid_input",
  "authorization",
  "conflict",
  "dependency",
  "timeout",
  "capacity",
  "unavailable",
  "internal",
]);

export const operationalSloStatuses = Object.freeze([
  "insufficient_data",
  "healthy",
  "breaching",
]);

export const operationalSyntheticRunStatuses = Object.freeze([
  "passed",
  "failed",
  "error",
]);

export const operationalAlertStatuses = Object.freeze(["open", "recovered"]);

export const operationalAlertIssueProjectionStatuses = Object.freeze([
  "pending",
  "delivering",
  "delivered",
  "dead_letter",
]);

export const operationalAlertIssueStates = Object.freeze(["open", "closed"]);

export const operationalSubjectTypes = Object.freeze([
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
]);

export const evidenceKinds = Object.freeze([
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
]);

export const incidentSeverities = Object.freeze([
  "sev1",
  "sev2",
  "sev3",
  "sev4",
]);

export const incidentStatuses = Object.freeze([
  "open",
  "investigating",
  "mitigating",
  "monitoring",
  "resolved",
  "escalated",
]);

export const incidentStatusTransitions = Object.freeze({
  open: Object.freeze(["investigating", "resolved", "escalated"]),
  investigating: Object.freeze([
    "mitigating",
    "monitoring",
    "resolved",
    "escalated",
  ]),
  mitigating: Object.freeze([
    "investigating",
    "monitoring",
    "resolved",
    "escalated",
  ]),
  monitoring: Object.freeze([
    "investigating",
    "mitigating",
    "resolved",
    "escalated",
  ]),
  resolved: Object.freeze(["open"]),
  escalated: Object.freeze([
    "investigating",
    "mitigating",
    "monitoring",
    "resolved",
  ]),
});

export const runbookAuthorities = Object.freeze([
  "observe",
  "recommend",
  "approval_required",
  "bounded_auto",
]);

export const runbookMutationClasses = Object.freeze([
  "read_only",
  "reversible",
  "destructive",
]);

export const runbookInvocationModes = Object.freeze(["preview", "apply"]);

export const runbookActionStatuses = Object.freeze([
  "scheduled",
  "running",
  "succeeded",
  "failed",
  "rolled_back",
  "rejected",
  "escalated",
]);

export const runbookActionStatusTransitions = Object.freeze({
  scheduled: Object.freeze(["running", "rejected", "escalated"]),
  running: Object.freeze(["succeeded", "failed", "rolled_back", "escalated"]),
  succeeded: Object.freeze([]),
  failed: Object.freeze(["rolled_back", "escalated"]),
  rolled_back: Object.freeze(["escalated"]),
  rejected: Object.freeze([]),
  escalated: Object.freeze([]),
});

export const operationsContractSchemaNames = Object.freeze([
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
]);

const contractVersionSchema = z.literal(OPERATIONS_CONTRACT_VERSION);
const isoDateTimeSchema = z.string().datetime();
const nonEmptyTextSchema = z.string().trim().min(1);
export const operationalIdentifierSchema = nonEmptyTextSchema
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const identifierSchema = operationalIdentifierSchema;
const eventKindSchema = nonEmptyTextSchema
  .max(160)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const uniqueValues = (values) => new Set(values).size === values.length;

const canonicalizeJson = (value) => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nestedValue]) => [key, canonicalizeJson(nestedValue)]),
    );
  }
  return value;
};

export const serializeCanonicalOperationsJson = (value) =>
  JSON.stringify(canonicalizeJson(value));

export const createOperationsDocumentDigest = (value) =>
  createHash("sha256")
    .update(serializeCanonicalOperationsJson(value), "utf8")
    .digest("hex");

export const areOperationalEventEnvelopesIdempotentlyEquivalent = (
  left,
  right,
) => {
  const normalize = (value) => {
    const envelope = operationalEventEnvelopeSchemaV1.parse(value);
    const {
      occurredAt: _occurredAt,
      observedAt: _observedAt,
      ...identity
    } = envelope;
    return identity;
  };
  return (
    serializeCanonicalOperationsJson(normalize(left)) ===
    serializeCanonicalOperationsJson(normalize(right))
  );
};

export const resolveDeploymentEnvironment = (env = process.env) => {
  const railway = env.RAILWAY_ENVIRONMENT_NAME?.trim();
  if (railway === "production") return "production";
  if (railway) return "preview";
  const explicit = env.AIRJAM_OPERATIONAL_ENVIRONMENT?.trim();
  if (deploymentEnvironments.includes(explicit)) return explicit;
  return env.NODE_ENV === "test" ? "test" : "development";
};

export const resolveOperationalBudgetRequirement = (env = process.env) =>
  resolveDeploymentEnvironment(env) === "production"
    ? "required"
    : "not_applicable";

const jsonPrimitiveSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const jsonValueSchema = z.lazy(() =>
  z.union([
    jsonPrimitiveSchema,
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const boundedJsonRecordSchema = z
  .record(z.string().min(1).max(80), jsonValueSchema)
  .superRefine((value, context) => {
    const size = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (size > OPERATIONS_EVENT_MAX_PAYLOAD_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `JSON payload exceeds ${OPERATIONS_EVENT_MAX_PAYLOAD_BYTES} bytes`,
      });
    }
  });

export const operationalCorrelationSchemaV1 = z
  .object({
    contractVersion: contractVersionSchema,
    correlationId: identifierSchema,
    causationEventId: identifierSchema.optional(),
    requestId: identifierSchema.optional(),
    userSessionId: identifierSchema.optional(),
    roomId: identifierSchema.optional(),
    runtimeSessionId: identifierSchema.optional(),
    controllerId: identifierSchema.optional(),
    gameId: identifierSchema.optional(),
    releaseId: identifierSchema.optional(),
    generationId: identifierSchema.optional(),
    jobId: identifierSchema.optional(),
    deploymentId: identifierSchema.optional(),
    providerOperationId: identifierSchema.optional(),
  })
  .strict();

export const operationalActorSchemaV1 = z.discriminatedUnion("type", [
  z.object({ type: z.literal("system"), id: identifierSchema }).strict(),
  z.object({ type: z.literal("agent"), id: identifierSchema }).strict(),
  z.object({ type: z.literal("operator"), id: identifierSchema }).strict(),
  z.object({ type: z.literal("user"), id: identifierSchema }).strict(),
  z.object({ type: z.literal("provider"), id: identifierSchema }).strict(),
]);

export const operationalEvidenceSchemaV1 = z
  .object({
    kind: z.enum(evidenceKinds),
    reference: nonEmptyTextSchema.max(2048),
    digestSha256: sha256Schema.optional(),
    collectedAt: isoDateTimeSchema,
  })
  .strict();

export const operationalEventEnvelopeSchemaV1 = z
  .object({
    contractVersion: contractVersionSchema,
    plane: z.literal("lifecycle_runtime"),
    eventId: identifierSchema,
    kind: eventKindSchema,
    severity: z.enum(operationalEventSeverities),
    outcome: z.enum(operationalEventOutcomes),
    authority: z.enum(operationalEventAuthorities),
    source: z
      .object({
        service: z.enum(operationalServices),
        component: identifierSchema,
        environment: z.enum(deploymentEnvironments),
        instanceId: identifierSchema.optional(),
        version: nonEmptyTextSchema.max(120).optional(),
      })
      .strict(),
    subject: z
      .object({
        type: z.enum(operationalSubjectTypes),
        id: identifierSchema,
      })
      .strict(),
    actor: operationalActorSchemaV1.optional(),
    correlation: operationalCorrelationSchemaV1,
    occurredAt: isoDateTimeSchema,
    observedAt: isoDateTimeSchema,
    payload: boundedJsonRecordSchema.default({}),
    evidence: z.array(operationalEvidenceSchemaV1).max(32).default([]),
  })
  .strict()
  .superRefine((event, context) => {
    if (Date.parse(event.observedAt) < Date.parse(event.occurredAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedAt"],
        message: "observedAt must not precede occurredAt",
      });
    }
  });

export const operationalFailureSchemaV1 = z
  .object({
    contractVersion: contractVersionSchema,
    code: eventKindSchema,
    class: z.enum(operationalFailureClasses),
    summary: nonEmptyTextSchema.max(500),
    retryable: z.boolean(),
    stage: identifierSchema.optional(),
    causeCode: eventKindSchema.optional(),
    details: boundedJsonRecordSchema.default({}),
  })
  .strict();

const operationalSecretKeyTokens = [
  "authorization",
  "cookie",
  "credential",
  "password",
  "private",
  "secret",
  "session",
  "token",
];
const operationalSecretKeyQualifiers = [
  "access",
  "api",
  "auth",
  "encryption",
  "private",
  "secret",
  "session",
  "signing",
];
const operationalCompactSecretKeys = new Set(
  [...operationalSecretKeyQualifiers, "hmac", "jwt", "webhook"].flatMap(
    (qualifier) => [`${qualifier}key`, `${qualifier}keys`],
  ),
);
const operationalPublicDetailKeys = new Set(["targetkey"]);
const operationalCodePattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const operationalIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

const isOperationalSecretKey = (key) => {
  const compactKey = key.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  if (operationalPublicDetailKeys.has(compactKey)) return false;
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  if (tokens.some((token) => token === "key" || token === "keys")) return true;
  if (
    tokens.some(
      (token) =>
        operationalSecretKeyTokens.some((secretToken) =>
          token.includes(secretToken),
        ) || operationalCompactSecretKeys.has(token),
    )
  ) {
    return true;
  }
  return false;
};

const sanitizeOperationalJson = (value, depth = 0) => {
  if (depth > 8) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, 1_000);
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) => sanitizeOperationalJson(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;
  const sanitized = {};
  for (const [key, nested] of Object.entries(value).slice(0, 100)) {
    if (isOperationalSecretKey(key)) continue;
    const safe = sanitizeOperationalJson(nested, depth + 1);
    if (safe !== undefined) sanitized[key.slice(0, 80)] = safe;
  }
  return sanitized;
};

const safeOperationalCode = (value, fallback) => {
  const normalized = value.trim().toLowerCase();
  return operationalCodePattern.test(normalized) && normalized.length <= 160
    ? normalized
    : fallback;
};

const safeOperationalIdentifier = (value) => {
  const normalized = value?.trim();
  return normalized &&
    normalized.length <= 200 &&
    operationalIdentifierPattern.test(normalized)
    ? normalized
    : undefined;
};

export const createStructuredOperationalFailure = ({
  code,
  failureClass,
  summary,
  retryable,
  stage,
  causeCode,
  details = {},
}) => {
  const safeStage = safeOperationalIdentifier(stage);
  return operationalFailureSchemaV1.parse({
    contractVersion: 1,
    code: safeOperationalCode(code, "internal.unclassified"),
    class: failureClass,
    summary: summary.trim().slice(0, 500) || "An operational action failed.",
    retryable,
    ...(safeStage ? { stage: safeStage } : {}),
    ...(causeCode
      ? {
          causeCode: safeOperationalCode(causeCode, "internal.unclassified"),
        }
      : {}),
    details: sanitizeOperationalJson(details) ?? {},
  });
};

export const normalizeUnknownOperationalFailure = ({
  error,
  code = "internal.unexpected",
  summary = "An unexpected operational failure occurred.",
  retryable = true,
  stage,
  details,
}) =>
  createStructuredOperationalFailure({
    code,
    failureClass: "internal",
    summary,
    retryable,
    stage,
    causeCode:
      error instanceof Error
        ? safeOperationalCode(error.name, "internal.error")
        : "internal.non_error_throw",
    details,
  });

export const normalizeOperationalJobFailure = ({
  error,
  retryable,
  jobKind,
}) => {
  const rawCode =
    typeof error.code === "string" ? error.code : "job.unexpected";
  const code = safeOperationalCode(rawCode, "job.unexpected");
  const failureClass = /timeout|expired/u.test(code)
    ? "timeout"
    : /capacity|quota|limit/u.test(code)
      ? "capacity"
      : /invalid|malformed|unsupported/u.test(code)
        ? "invalid_input"
        : /storage|browser|moderation|provider|network|unavailable/u.test(code)
          ? "dependency"
          : "internal";
  return createStructuredOperationalFailure({
    code,
    failureClass,
    summary: `Operational job ${jobKind} failed.`,
    retryable,
    stage: typeof error.stage === "string" ? error.stage : undefined,
    details: { jobKind },
  });
};

export const operationalSloDefinitionSchemaV1 = z
  .object({
    contractVersion: contractVersionSchema,
    sloId: identifierSchema,
    title: nonEmptyTextSchema.max(200),
    description: nonEmptyTextSchema.max(2000),
    service: z.enum(operationalServices),
    indicator: z.literal("synthetic_success_ratio"),
    syntheticCheckIds: z.array(identifierSchema).min(1).max(32),
    objectiveBasisPoints: z.number().int().min(1).max(10_000),
    windowSeconds: z.number().int().min(60).max(2_592_000),
    minimumSamples: z.number().int().min(1).max(100_000),
    alerting: z
      .object({
        severity: z.enum(["warning", "error", "critical"]),
        consecutiveBreaches: z.number().int().min(1).max(20),
        consecutiveRecoveries: z.number().int().min(1).max(20),
      })
      .strict(),
  })
  .strict()
  .superRefine((definition, context) => {
    if (!uniqueValues(definition.syntheticCheckIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["syntheticCheckIds"],
        message: "syntheticCheckIds must not contain duplicates",
      });
    }
  });

export const operationalSloEvaluationSchemaV1 = z
  .object({
    contractVersion: contractVersionSchema,
    evaluationId: identifierSchema,
    sloId: identifierSchema,
    environment: z.enum(deploymentEnvironments),
    service: z.enum(operationalServices),
    windowStartedAt: isoDateTimeSchema,
    windowEndedAt: isoDateTimeSchema,
    sampleCount: z.number().int().min(0),
    successCount: z.number().int().min(0),
    successRatioBasisPoints: z.number().int().min(0).max(10_000).nullable(),
    objectiveBasisPoints: z.number().int().min(1).max(10_000),
    status: z.enum(operationalSloStatuses),
    consecutiveBreaches: z.number().int().min(0),
    consecutiveRecoveries: z.number().int().min(0),
    evaluatedAt: isoDateTimeSchema,
    evidence: z.array(operationalEvidenceSchemaV1).max(64).default([]),
  })
  .strict()
  .superRefine((evaluation, context) => {
    if (
      Date.parse(evaluation.windowEndedAt) <=
      Date.parse(evaluation.windowStartedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["windowEndedAt"],
        message: "windowEndedAt must be later than windowStartedAt",
      });
    }
    if (
      Date.parse(evaluation.evaluatedAt) < Date.parse(evaluation.windowEndedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evaluatedAt"],
        message: "evaluatedAt must not precede windowEndedAt",
      });
    }
    if (evaluation.successCount > evaluation.sampleCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["successCount"],
        message: "successCount must not exceed sampleCount",
      });
    }
    const expectedRatio =
      evaluation.sampleCount === 0
        ? null
        : Math.floor(
            (evaluation.successCount * 10_000) / evaluation.sampleCount,
          );
    if (evaluation.successRatioBasisPoints !== expectedRatio) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["successRatioBasisPoints"],
        message: "successRatioBasisPoints must match the sample counts",
      });
    }
    if (
      evaluation.status === "insufficient_data" &&
      (evaluation.consecutiveBreaches !== 0 ||
        evaluation.consecutiveRecoveries !== 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "insufficient_data evaluations cannot advance alert streaks",
      });
    }
    if (
      evaluation.status === "healthy" &&
      (evaluation.successRatioBasisPoints === null ||
        evaluation.successRatioBasisPoints < evaluation.objectiveBasisPoints)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "healthy evaluations must meet their objective",
      });
    }
    if (
      evaluation.status === "breaching" &&
      (evaluation.successRatioBasisPoints === null ||
        evaluation.successRatioBasisPoints >= evaluation.objectiveBasisPoints)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "breaching evaluations must be below their objective",
      });
    }
  });

export const operationalSyntheticCheckSchemaV1 = z
  .object({
    contractVersion: contractVersionSchema,
    checkId: identifierSchema,
    title: nonEmptyTextSchema.max(200),
    description: nonEmptyTextSchema.max(2000),
    story: z.enum([
      "landing_docs",
      "arcade_hosted_release",
      "platform_realtime_health",
      "room_controller",
      "semantic_gameplay",
      "release_dependencies",
    ]),
    service: z.enum(operationalServices),
    executor: z.enum(["http", "airjam_semantic", "release_dependency"]),
    intervalSeconds: z.number().int().min(30).max(86_400),
    timeoutMilliseconds: z.number().int().min(100).max(120_000),
    sloId: identifierSchema,
    steps: z
      .array(
        z
          .object({
            stepId: identifierSchema,
            targetKey: identifierSchema,
            assertion: z.enum([
              "http_2xx",
              "json_ok",
              "html_marker",
              "airjam_session",
              "dependency_ready",
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((check, context) => {
    if (!uniqueValues(check.steps.map((step) => step.stepId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps"],
        message: "synthetic step ids must be unique",
      });
    }
  });

const operationalSyntheticObservationSchemaV1 = z
  .object({
    stepId: identifierSchema,
    status: z.enum(["passed", "failed", "error"]),
    latencyMilliseconds: z.number().int().min(0),
    httpStatus: z.number().int().min(100).max(599).optional(),
    failure: operationalFailureSchemaV1.optional(),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.status === "passed" && observation.failure) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failure"],
        message: "passed observations must not contain a failure",
      });
    }
    if (observation.status !== "passed" && !observation.failure) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failure"],
        message: "failed observations require a structured failure",
      });
    }
  });

export const operationalSyntheticRunSchemaV1 = z
  .object({
    contractVersion: contractVersionSchema,
    runId: identifierSchema,
    checkId: identifierSchema,
    environment: z.enum(deploymentEnvironments),
    status: z.enum(operationalSyntheticRunStatuses),
    startedAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema,
    durationMilliseconds: z.number().int().min(0),
    eventId: identifierSchema,
    observations: z
      .array(operationalSyntheticObservationSchemaV1)
      .min(1)
      .max(32),
    evidence: z.array(operationalEvidenceSchemaV1).max(64).default([]),
  })
  .strict()
  .superRefine((run, context) => {
    if (Date.parse(run.completedAt) < Date.parse(run.startedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completedAt must not precede startedAt",
      });
    }
    if (
      !uniqueValues(run.observations.map((observation) => observation.stepId))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observations"],
        message: "synthetic observations must have unique step ids",
      });
    }
    const expectedStatus = run.observations.some(
      (observation) => observation.status === "error",
    )
      ? "error"
      : run.observations.some((observation) => observation.status === "failed")
        ? "failed"
        : "passed";
    if (run.status !== expectedStatus) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "synthetic run status must match its observations",
      });
    }
  });

export const operationalAlertSchemaV1 = z
  .object({
    contractVersion: contractVersionSchema,
    alertId: identifierSchema,
    alertKey: identifierSchema,
    policyId: identifierSchema,
    environment: z.enum(deploymentEnvironments),
    service: z.enum(operationalServices),
    severity: z.enum(["warning", "error", "critical"]),
    status: z.enum(operationalAlertStatuses),
    summary: nonEmptyTextSchema.max(1000),
    firstTriggeredAt: isoDateTimeSchema,
    lastObservedAt: isoDateTimeSchema,
    occurrenceCount: z.number().int().min(1),
    latestEventId: identifierSchema,
    latestEvaluationId: identifierSchema,
    recoveredAt: isoDateTimeSchema.optional(),
    revision: z.number().int().min(1),
  })
  .strict()
  .superRefine((alert, context) => {
    if (Date.parse(alert.lastObservedAt) < Date.parse(alert.firstTriggeredAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastObservedAt"],
        message: "lastObservedAt must not precede firstTriggeredAt",
      });
    }
    if (alert.status === "recovered" && !alert.recoveredAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recoveredAt"],
        message: "recovered alerts require recoveredAt",
      });
    }
    if (alert.status === "open" && alert.recoveredAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recoveredAt"],
        message: "open alerts must not contain recoveredAt",
      });
    }
    if (
      alert.recoveredAt &&
      (Date.parse(alert.recoveredAt) < Date.parse(alert.firstTriggeredAt) ||
        Date.parse(alert.recoveredAt) > Date.parse(alert.lastObservedAt))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recoveredAt"],
        message: "recoveredAt must fall within the alert observation window",
      });
    }
  });

export const githubRepositorySchema = nonEmptyTextSchema
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);

export const operationalAlertIssueProjectionSchemaV1 = z
  .object({
    contractVersion: contractVersionSchema,
    projectionId: identifierSchema,
    provider: z.literal("github"),
    repository: githubRepositorySchema,
    alertKey: identifierSchema,
    targetAlertRevision: z.number().int().min(1),
    projectedAlertRevision: z.number().int().min(0),
    status: z.enum(operationalAlertIssueProjectionStatuses),
    attemptCount: z.number().int().min(0),
    maxAttempts: z.number().int().min(1).max(20),
    availableAt: isoDateTimeSchema,
    leaseOwner: identifierSchema.nullable(),
    leaseExpiresAt: isoDateTimeSchema.nullable(),
    issue: z
      .object({
        number: z.number().int().positive(),
        url: z.string().url(),
        state: z.enum(operationalAlertIssueStates),
      })
      .strict()
      .nullable(),
    managedBodyHash: sha256Schema.nullable(),
    projectedAt: isoDateTimeSchema.nullable(),
    lastError: operationalFailureSchemaV1.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict()
  .superRefine((projection, context) => {
    if (projection.projectedAlertRevision > projection.targetAlertRevision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projectedAlertRevision"],
        message: "projectedAlertRevision must not exceed targetAlertRevision",
      });
    }
    if (projection.attemptCount > projection.maxAttempts) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attemptCount"],
        message: "attemptCount must not exceed maxAttempts",
      });
    }
    const leased = projection.status === "delivering";
    if (
      leased !== Boolean(projection.leaseOwner && projection.leaseExpiresAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message:
          "only delivering projections require a lease owner and expiration",
      });
    }
    if (projection.projectedAlertRevision > 0 && !projection.issue) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issue"],
        message: "a projected alert revision requires GitHub issue identity",
      });
    }
    if (projection.status === "delivered") {
      if (
        projection.projectedAlertRevision !== projection.targetAlertRevision ||
        !projection.issue ||
        !projection.managedBodyHash ||
        !projection.projectedAt ||
        projection.lastError
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status"],
          message:
            "delivered projections require exact issue, body, chronology, and revision evidence",
        });
      }
    }
    if (projection.status === "dead_letter" && !projection.lastError) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastError"],
        message: "dead-letter projections require a structured failure",
      });
    }
  });

export const incidentFingerprintInputSchemaV1 = z
  .object({
    contractVersion: contractVersionSchema,
    environment: z.enum(deploymentEnvironments),
    service: z.enum(operationalServices),
    symptomKind: eventKindSchema,
    failureClass: eventKindSchema,
    scope: z.enum(["global", "service", "game", "release", "room"]),
    scopeKey: identifierSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope === "global" && value.scopeKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeKey"],
        message: "global incident fingerprints must not have a scopeKey",
      });
    }
    if (value.scope !== "global" && !value.scopeKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeKey"],
        message: "scoped incident fingerprints require a scopeKey",
      });
    }
  });

const createIncidentFingerprintFromParsedInput = (input) =>
  createHash("sha256")
    .update(
      [
        input.contractVersion,
        input.environment,
        input.service,
        input.symptomKind,
        input.failureClass,
        input.scope,
        input.scopeKey ?? "",
      ].join("\n"),
      "utf8",
    )
    .digest("hex");

const incidentOwnerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("unassigned") }).strict(),
  z.object({ type: z.literal("agent"), id: identifierSchema }).strict(),
  z.object({ type: z.literal("operator"), id: identifierSchema }).strict(),
  z.object({ type: z.literal("team"), id: identifierSchema }).strict(),
]);

export const operationalIncidentSchemaV1 = z
  .object({
    contractVersion: contractVersionSchema,
    incidentId: identifierSchema,
    fingerprint: sha256Schema,
    fingerprintInput: incidentFingerprintInputSchemaV1,
    severity: z.enum(incidentSeverities),
    status: z.enum(incidentStatuses),
    title: nonEmptyTextSchema.max(200),
    summary: nonEmptyTextSchema.max(4000),
    owner: incidentOwnerSchema,
    firstSeenAt: isoDateTimeSchema,
    lastSeenAt: isoDateTimeSchema,
    occurrenceCount: z.number().int().min(1),
    latestEventId: identifierSchema,
    correlationIds: z.array(identifierSchema).min(1).max(32),
    evidence: z.array(operationalEvidenceSchemaV1).max(64).default([]),
    activeRunbookActionId: identifierSchema.optional(),
    externalIssue: z
      .object({
        provider: z.literal("github"),
        repository: nonEmptyTextSchema.max(200),
        number: z.number().int().positive(),
        url: z.string().url(),
      })
      .strict()
      .optional(),
    resolution: z
      .object({
        code: eventKindSchema,
        summary: nonEmptyTextSchema.max(2000),
        resolvedAt: isoDateTimeSchema,
        resolvedBy: operationalActorSchemaV1,
      })
      .strict()
      .optional(),
    revision: z.number().int().min(0),
  })
  .strict()
  .superRefine((incident, context) => {
    if (
      incident.fingerprint !==
      createIncidentFingerprintFromParsedInput(incident.fingerprintInput)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fingerprint"],
        message: "fingerprint must match fingerprintInput",
      });
    }
    if (!uniqueValues(incident.correlationIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correlationIds"],
        message: "correlationIds must not contain duplicates",
      });
    }
    if (Date.parse(incident.lastSeenAt) < Date.parse(incident.firstSeenAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastSeenAt"],
        message: "lastSeenAt must not precede firstSeenAt",
      });
    }
    if (incident.status === "resolved" && !incident.resolution) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution"],
        message: "resolved incidents require a resolution",
      });
    }
    if (incident.status !== "resolved" && incident.resolution) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution"],
        message: "only resolved incidents may contain a resolution",
      });
    }
  });

const runbookBlastRadiusSchema = z
  .object({
    environments: z.array(z.enum(deploymentEnvironments)).min(1).max(4),
    services: z.array(z.enum(operationalServices)).min(1).max(7),
    maxResources: z.number().int().positive().max(1000),
    maxEstimatedCostUsd: z.number().min(0),
  })
  .strict()
  .superRefine((blastRadius, context) => {
    for (const field of ["environments", "services"]) {
      if (!uniqueValues(blastRadius[field])) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must not contain duplicates`,
        });
      }
    }
  });

const runbookPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(5),
    cooldownSeconds: z.number().int().min(0).max(86400),
    timeoutSeconds: z.number().int().min(1).max(3600),
    requiresApproval: z.boolean(),
  })
  .strict();

export const operationalRunbookSchemaV1 = z
  .object({
    contractVersion: contractVersionSchema,
    runbookId: identifierSchema,
    runbookVersion: nonEmptyTextSchema.max(40).regex(/^\d+\.\d+\.\d+$/u),
    title: nonEmptyTextSchema.max(200),
    description: nonEmptyTextSchema.max(4000),
    authority: z.enum(runbookAuthorities),
    mutationClass: z.enum(runbookMutationClasses),
    blastRadius: runbookBlastRadiusSchema,
    policy: runbookPolicySchema,
    parameters: z
      .array(
        z
          .object({
            name: identifierSchema,
            type: z.enum([
              "string",
              "integer",
              "boolean",
              "enum",
              "resource_ref",
            ]),
            required: z.boolean(),
            description: nonEmptyTextSchema.max(500),
            allowedValues: z
              .array(nonEmptyTextSchema.max(200))
              .max(64)
              .optional(),
          })
          .strict(),
      )
      .max(32)
      .default([]),
    actions: z
      .array(
        z
          .object({
            id: identifierSchema,
            action: eventKindSchema,
            description: nonEmptyTextSchema.max(500),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    verificationAction: eventKindSchema.optional(),
    rollbackRunbookId: identifierSchema.optional(),
  })
  .strict()
  .superRefine((runbook, context) => {
    const parameterNames = runbook.parameters.map(
      (parameter) => parameter.name,
    );
    if (!uniqueValues(parameterNames)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parameters"],
        message: "runbook parameter names must be unique",
      });
    }
    for (const [index, parameter] of runbook.parameters.entries()) {
      if (parameter.type === "enum" && !parameter.allowedValues?.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parameters", index, "allowedValues"],
          message: "enum parameters require allowedValues",
        });
      }
      if (parameter.type !== "enum" && parameter.allowedValues) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parameters", index, "allowedValues"],
          message: "only enum parameters may define allowedValues",
        });
      }
      if (parameter.allowedValues && !uniqueValues(parameter.allowedValues)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parameters", index, "allowedValues"],
          message: "allowedValues must not contain duplicates",
        });
      }
    }
    const actionIds = runbook.actions.map((action) => action.id);
    if (!uniqueValues(actionIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actions"],
        message: "runbook action ids must be unique",
      });
    }
    const applyAuthority = ["approval_required", "bounded_auto"].includes(
      runbook.authority,
    );
    if (!applyAuthority && runbook.mutationClass !== "read_only") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mutationClass"],
        message: "observe and recommend runbooks must be read_only",
      });
    }
    if (
      runbook.authority === "approval_required" &&
      !runbook.policy.requiresApproval
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["policy", "requiresApproval"],
        message: "approval_required runbooks must require approval",
      });
    }
    if (runbook.authority === "bounded_auto") {
      if (runbook.policy.requiresApproval) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["policy", "requiresApproval"],
          message: "bounded_auto runbooks must not require per-run approval",
        });
      }
      if (runbook.mutationClass !== "reversible") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mutationClass"],
          message: "bounded_auto runbooks must be reversible",
        });
      }
      if (!runbook.rollbackRunbookId || !runbook.verificationAction) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rollbackRunbookId"],
          message:
            "bounded_auto runbooks require rollbackRunbookId and verificationAction",
        });
      }
    }
    if (runbook.mutationClass !== "read_only" && !runbook.verificationAction) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verificationAction"],
        message: "mutating runbooks require a verificationAction",
      });
    }
    if (
      runbook.mutationClass === "destructive" &&
      runbook.authority !== "approval_required"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authority"],
        message: "destructive runbooks require explicit approval",
      });
    }
  });

const runbookPreviewBlastRadiusSchema = z
  .object({
    environments: z.array(z.enum(deploymentEnvironments)).min(1).max(4),
    services: z.array(z.enum(operationalServices)).min(1).max(7),
    resourceReferences: z.array(identifierSchema).max(1000),
    estimatedCostUsd: z.number().min(0),
  })
  .strict()
  .superRefine((blastRadius, context) => {
    for (const field of ["environments", "services", "resourceReferences"]) {
      if (!uniqueValues(blastRadius[field])) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must not contain duplicates`,
        });
      }
    }
  });

export const operationalRunbookPreviewSchemaV1 = z
  .object({
    contractVersion: contractVersionSchema,
    previewId: identifierSchema,
    runbookId: identifierSchema,
    runbookVersion: nonEmptyTextSchema.max(40).regex(/^\d+\.\d+\.\d+$/u),
    runbookDigestSha256: sha256Schema,
    parametersDigestSha256: sha256Schema,
    incidentId: identifierSchema.optional(),
    correlation: operationalCorrelationSchemaV1,
    createdAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    blastRadius: runbookPreviewBlastRadiusSchema,
    actionIds: z.array(identifierSchema).min(1).max(32),
    beforeEvidence: z.array(operationalEvidenceSchemaV1).min(1).max(32),
    warnings: z.array(nonEmptyTextSchema.max(500)).max(32).default([]),
  })
  .strict()
  .superRefine((preview, context) => {
    if (Date.parse(preview.expiresAt) <= Date.parse(preview.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must be later than createdAt",
      });
    }
    if (!uniqueValues(preview.actionIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actionIds"],
        message: "actionIds must not contain duplicates",
      });
    }
  });

const runbookInvocationBase = {
  contractVersion: contractVersionSchema,
  runbookId: identifierSchema,
  runbookVersion: nonEmptyTextSchema.max(40).regex(/^\d+\.\d+\.\d+$/u),
  idempotencyKey: identifierSchema,
  reason: nonEmptyTextSchema.max(2000),
  incidentId: identifierSchema.optional(),
  actor: operationalActorSchemaV1,
  correlation: operationalCorrelationSchemaV1,
  parameters: boundedJsonRecordSchema.default({}),
  requestedAt: isoDateTimeSchema,
};

export const operationalRunbookInvocationSchemaV1 = z.discriminatedUnion(
  "mode",
  [
    z.object({ ...runbookInvocationBase, mode: z.literal("preview") }).strict(),
    z
      .object({
        ...runbookInvocationBase,
        mode: z.literal("apply"),
        previewId: identifierSchema,
        previewDigestSha256: sha256Schema,
        approval: z
          .object({
            approvedBy: operationalActorSchemaV1,
            approvedAt: isoDateTimeSchema,
            decisionReference: nonEmptyTextSchema.max(2048),
          })
          .strict()
          .optional(),
      })
      .strict(),
  ],
);

export const operationalRunbookActionSchemaV1 = z
  .object({
    contractVersion: contractVersionSchema,
    actionId: identifierSchema,
    runbookId: identifierSchema,
    runbookVersion: nonEmptyTextSchema.max(40).regex(/^\d+\.\d+\.\d+$/u),
    incidentId: identifierSchema.optional(),
    previewId: identifierSchema,
    previewDigestSha256: sha256Schema,
    idempotencyKey: identifierSchema,
    actor: operationalActorSchemaV1,
    correlation: operationalCorrelationSchemaV1,
    status: z.enum(runbookActionStatuses),
    attempt: z.number().int().min(1).max(5),
    requestedAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.optional(),
    completedAt: isoDateTimeSchema.optional(),
    beforeEvidence: z.array(operationalEvidenceSchemaV1).min(1).max(32),
    afterEvidence: z.array(operationalEvidenceSchemaV1).max(32),
    result: z
      .object({
        code: eventKindSchema,
        summary: nonEmptyTextSchema.max(2000),
        details: boundedJsonRecordSchema.default({}),
      })
      .strict()
      .optional(),
    rollbackActionId: identifierSchema.optional(),
  })
  .strict()
  .superRefine((action, context) => {
    if (
      action.startedAt &&
      Date.parse(action.startedAt) < Date.parse(action.requestedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startedAt"],
        message: "startedAt must not precede requestedAt",
      });
    }
    if (
      action.completedAt &&
      Date.parse(action.completedAt) <
        Date.parse(action.startedAt ?? action.requestedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "completedAt must not precede action start",
      });
    }
    if (
      action.status === "scheduled" &&
      (action.startedAt || action.completedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "scheduled actions must not claim start or completion times",
      });
    }
    if (action.status === "running" && !action.startedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startedAt"],
        message: "running actions require startedAt",
      });
    }
    if (
      ["scheduled", "running"].includes(action.status) &&
      (action.completedAt || action.result || action.rollbackActionId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "nonterminal actions must not claim terminal result state",
      });
    }
    if (
      ["succeeded", "failed", "rolled_back"].includes(action.status) &&
      !action.startedAt
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startedAt"],
        message: "executed terminal actions require startedAt",
      });
    }
    if (
      ["succeeded", "failed", "rolled_back", "rejected", "escalated"].includes(
        action.status,
      ) &&
      (!action.completedAt || !action.result)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "terminal runbook actions require completedAt and result",
      });
    }
    if (
      ["succeeded", "rolled_back"].includes(action.status) &&
      action.afterEvidence.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["afterEvidence"],
        message:
          "successful or rolled-back actions require verification evidence",
      });
    }
    if (action.status === "rolled_back" && !action.rollbackActionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rollbackActionId"],
        message: "rolled-back actions require rollbackActionId",
      });
    }
    if (action.status !== "rolled_back" && action.rollbackActionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rollbackActionId"],
        message: "only rolled-back actions may contain rollbackActionId",
      });
    }
  });

const schemaByName = Object.freeze({
  operational_event: operationalEventEnvelopeSchemaV1,
  operational_failure: operationalFailureSchemaV1,
  slo_definition: operationalSloDefinitionSchemaV1,
  slo_evaluation: operationalSloEvaluationSchemaV1,
  synthetic_check: operationalSyntheticCheckSchemaV1,
  synthetic_run: operationalSyntheticRunSchemaV1,
  alert: operationalAlertSchemaV1,
  alert_issue_projection: operationalAlertIssueProjectionSchemaV1,
  incident_fingerprint_input: incidentFingerprintInputSchemaV1,
  incident: operationalIncidentSchemaV1,
  runbook: operationalRunbookSchemaV1,
  runbook_preview: operationalRunbookPreviewSchemaV1,
  runbook_invocation: operationalRunbookInvocationSchemaV1,
  runbook_action: operationalRunbookActionSchemaV1,
});

export const createIncidentFingerprint = (rawInput) => {
  const input = incidentFingerprintInputSchemaV1.parse(rawInput);
  return createIncidentFingerprintFromParsedInput(input);
};

export const createRunbookDescriptorDigest = (rawRunbook) =>
  createOperationsDocumentDigest(operationalRunbookSchemaV1.parse(rawRunbook));

export const createRunbookParametersDigest = (rawParameters) =>
  createOperationsDocumentDigest(boundedJsonRecordSchema.parse(rawParameters));

export const createRunbookPreviewDigest = (rawPreview) =>
  createOperationsDocumentDigest(
    operationalRunbookPreviewSchemaV1.parse(rawPreview),
  );

export const assertIncidentStatusTransition = (fromStatus, toStatus) => {
  const from = z.enum(incidentStatuses).parse(fromStatus);
  const to = z.enum(incidentStatuses).parse(toStatus);
  if (!incidentStatusTransitions[from].includes(to)) {
    throw new Error(`Unsupported incident transition: ${from} -> ${to}`);
  }
  return { from, to };
};

export const assertRunbookActionStatusTransition = (fromStatus, toStatus) => {
  const from = z.enum(runbookActionStatuses).parse(fromStatus);
  const to = z.enum(runbookActionStatuses).parse(toStatus);
  if (!runbookActionStatusTransitions[from].includes(to)) {
    throw new Error(`Unsupported runbook action transition: ${from} -> ${to}`);
  }
  return { from, to };
};

export const assertRunbookInvocationAuthorized = (
  rawRunbook,
  rawInvocation,
  rawPreview,
) => {
  const runbook = operationalRunbookSchemaV1.parse(rawRunbook);
  const invocation = operationalRunbookInvocationSchemaV1.parse(rawInvocation);
  if (
    runbook.runbookId !== invocation.runbookId ||
    runbook.runbookVersion !== invocation.runbookVersion
  ) {
    throw new Error("Runbook invocation does not match the exact descriptor.");
  }
  const parameterDefinitions = new Map(
    runbook.parameters.map((parameter) => [parameter.name, parameter]),
  );
  for (const parameter of runbook.parameters) {
    if (
      parameter.required &&
      !Object.hasOwn(invocation.parameters, parameter.name)
    ) {
      throw new Error(`Runbook parameter ${parameter.name} is required.`);
    }
  }
  for (const [name, value] of Object.entries(invocation.parameters)) {
    const parameter = parameterDefinitions.get(name);
    if (!parameter) {
      throw new Error(`Runbook parameter ${name} is not declared.`);
    }
    const validType =
      (parameter.type === "string" && typeof value === "string") ||
      (parameter.type === "integer" && Number.isInteger(value)) ||
      (parameter.type === "boolean" && typeof value === "boolean") ||
      (parameter.type === "enum" &&
        typeof value === "string" &&
        parameter.allowedValues.includes(value)) ||
      (parameter.type === "resource_ref" &&
        typeof value === "string" &&
        identifierSchema.safeParse(value).success);
    if (!validType) {
      throw new Error(
        `Runbook parameter ${name} does not satisfy type ${parameter.type}.`,
      );
    }
  }
  if (invocation.mode === "apply") {
    if (["observe", "recommend"].includes(runbook.authority)) {
      throw new Error(`${runbook.authority} runbooks cannot be applied.`);
    }
    if (!rawPreview) {
      throw new Error("Runbook apply requires the exact preview record.");
    }
    const preview = operationalRunbookPreviewSchemaV1.parse(rawPreview);
    if (
      preview.previewId !== invocation.previewId ||
      createRunbookPreviewDigest(preview) !== invocation.previewDigestSha256
    ) {
      throw new Error("Runbook apply does not match the exact preview.");
    }
    if (
      preview.runbookId !== runbook.runbookId ||
      preview.runbookVersion !== runbook.runbookVersion ||
      preview.runbookDigestSha256 !== createRunbookDescriptorDigest(runbook)
    ) {
      throw new Error("Runbook preview does not match the exact descriptor.");
    }
    if (
      preview.parametersDigestSha256 !==
      createRunbookParametersDigest(invocation.parameters)
    ) {
      throw new Error("Runbook apply parameters do not match the preview.");
    }
    if (
      preview.incidentId !== invocation.incidentId ||
      preview.correlation.correlationId !== invocation.correlation.correlationId
    ) {
      throw new Error("Runbook apply context does not match the preview.");
    }
    const requestedAt = Date.parse(invocation.requestedAt);
    if (
      requestedAt < Date.parse(preview.createdAt) ||
      requestedAt > Date.parse(preview.expiresAt)
    ) {
      throw new Error("Runbook preview is not valid at apply time.");
    }
    if (
      preview.blastRadius.resourceReferences.length >
        runbook.blastRadius.maxResources ||
      preview.blastRadius.estimatedCostUsd >
        runbook.blastRadius.maxEstimatedCostUsd ||
      preview.blastRadius.environments.some(
        (environment) =>
          !runbook.blastRadius.environments.includes(environment),
      ) ||
      preview.blastRadius.services.some(
        (service) => !runbook.blastRadius.services.includes(service),
      )
    ) {
      throw new Error("Runbook preview exceeds the descriptor blast radius.");
    }
    if (
      preview.actionIds.length !== runbook.actions.length ||
      preview.actionIds.some(
        (actionId, index) => actionId !== runbook.actions[index].id,
      )
    ) {
      throw new Error("Runbook preview actions do not match the descriptor.");
    }
    if (
      runbook.mutationClass !== "read_only" &&
      preview.beforeEvidence.length === 0
    ) {
      throw new Error("Mutating runbook previews require before evidence.");
    }
    if (runbook.policy.requiresApproval && !invocation.approval) {
      throw new Error("Runbook apply requires an explicit approval record.");
    }
    if (invocation.approval) {
      if (invocation.approval.approvedBy.type !== "operator") {
        throw new Error("Runbook approval must be issued by an operator.");
      }
      const approvedAt = Date.parse(invocation.approval.approvedAt);
      if (
        approvedAt < Date.parse(preview.createdAt) ||
        approvedAt > requestedAt
      ) {
        throw new Error(
          "Runbook approval is outside the preview apply window.",
        );
      }
    }
    if (
      runbook.authority === "bounded_auto" &&
      !["agent", "system"].includes(invocation.actor.type)
    ) {
      throw new Error(
        "Bounded automatic apply requires an agent or system actor.",
      );
    }
    return { runbook, invocation, preview };
  }
  return { runbook, invocation, preview: undefined };
};

export const parseOperationsContractValue = (schemaName, value) => {
  const schema = schemaByName[schemaName];
  if (!schema) {
    throw new Error(
      `Unknown operations contract schema ${String(schemaName)}. Expected one of: ${operationsContractSchemaNames.join(", ")}.`,
    );
  }
  return schema.parse(value);
};

export const getOperationsContractJsonSchema = (schemaName) => {
  const schema = schemaByName[schemaName];
  if (!schema) {
    throw new Error(
      `Unknown operations contract schema ${String(schemaName)}. Expected one of: ${operationsContractSchemaNames.join(", ")}.`,
    );
  }
  const jsonSchema = toJSONSchema(schema, { target: "draft-7" });
  return {
    name: OPERATIONS_CONTRACT_NAME,
    contractVersion: OPERATIONS_CONTRACT_VERSION,
    schema: schemaName,
    runtimeValidationRequired: true,
    jsonSchema: {
      ...jsonSchema,
      $id: `https://airjam.dev/contracts/operations/v1/${schemaName}.schema.json`,
      title: `Air Jam operations v1 ${schemaName}`,
    },
  };
};

const operationsContractCatalog = Object.freeze({
  name: OPERATIONS_CONTRACT_NAME,
  contractVersion: OPERATIONS_CONTRACT_VERSION,
  planes: Object.freeze([
    Object.freeze({
      id: "product_telemetry",
      authority: "approximate",
      contract: "docs/contracts/product-telemetry-contract.md",
      allowedUses: Object.freeze(["discovery", "intent", "aggregate trends"]),
      forbiddenUses: Object.freeze([
        "correctness decisions",
        "billing authority",
        "automatic remediation",
        "incident confirmation without authoritative evidence",
      ]),
    }),
    Object.freeze({
      id: "lifecycle_runtime",
      authority:
        "airjam_authoritative | provider_attested | synthetic_observation | operator_attested | runtime_reported",
      envelope: "operational_event",
      allowedUses: Object.freeze([
        "incident evidence",
        "SLO evaluation",
        "diagnosis",
        "verified remediation",
      ]),
    }),
    Object.freeze({
      id: "operational_incident",
      authority: "durable correlated incident state",
      envelope: "incident",
      allowedUses: Object.freeze([
        "deduplication",
        "ownership",
        "notification policy",
        "runbook selection",
        "GitHub issue maintenance",
      ]),
    }),
  ]),
  correlation: Object.freeze({
    version: OPERATIONS_CONTRACT_VERSION,
    root: "correlationId",
    causalLink: "causationEventId",
    propagationFields: Object.freeze([
      "requestId",
      "userSessionId",
      "roomId",
      "runtimeSessionId",
      "controllerId",
      "gameId",
      "releaseId",
      "generationId",
      "jobId",
      "deploymentId",
      "providerOperationId",
    ]),
    rules: Object.freeze([
      "preserve the root correlationId across process and provider boundaries",
      "create a new eventId for every fact",
      "set causationEventId only to the direct causal event",
      "use opaque user-safe identifiers; never include email, IP address, tokens, or secrets",
    ]),
  }),
  event: Object.freeze({
    schema: "operational_event",
    version: OPERATIONS_CONTRACT_VERSION,
    plane: "lifecycle_runtime",
    authorities: operationalEventAuthorities,
    severities: operationalEventSeverities,
    outcomes: operationalEventOutcomes,
    maxPayloadBytes: OPERATIONS_EVENT_MAX_PAYLOAD_BYTES,
    kindConvention: "lowercase dotted semantic names",
  }),
  reliability: Object.freeze({
    failureSchema: "operational_failure",
    sloDefinitionSchema: "slo_definition",
    sloEvaluationSchema: "slo_evaluation",
    syntheticCheckSchema: "synthetic_check",
    syntheticRunSchema: "synthetic_run",
    alertSchema: "alert",
    alertIssueProjectionSchema: "alert_issue_projection",
    failureClasses: operationalFailureClasses,
    sloStatuses: operationalSloStatuses,
    syntheticRunStatuses: operationalSyntheticRunStatuses,
    alertStatuses: operationalAlertStatuses,
    alertIssueProjectionStatuses: operationalAlertIssueProjectionStatuses,
    rules: Object.freeze([
      "unknown exceptions become bounded internal failures without raw messages or stacks",
      "SLO state is derived from retained authoritative synthetic runs",
      "alert state changes only after source-owned breach and recovery streaks",
      "external notification adapters consume durable alert state rather than producer calls",
    ]),
  }),
  incident: Object.freeze({
    schema: "incident",
    fingerprintSchema: "incident_fingerprint_input",
    version: OPERATIONS_CONTRACT_VERSION,
    severities: incidentSeverities,
    statuses: incidentStatuses,
    transitions: incidentStatusTransitions,
    fingerprintFields: Object.freeze([
      "contractVersion",
      "environment",
      "service",
      "symptomKind",
      "failureClass",
      "scope",
      "scopeKey",
    ]),
  }),
  runbook: Object.freeze({
    descriptorSchema: "runbook",
    invocationSchema: "runbook_invocation",
    actionSchema: "runbook_action",
    version: OPERATIONS_CONTRACT_VERSION,
    modes: runbookInvocationModes,
    authorities: runbookAuthorities,
    mutationClasses: runbookMutationClasses,
    actionStatuses: runbookActionStatuses,
    actionTransitions: runbookActionStatusTransitions,
    rules: Object.freeze([
      "preview is read-only and never implies approval",
      "apply binds to one exact unexpired preview through previewId and previewDigestSha256",
      "descriptor, parameter, context, action order, and blast radius are revalidated at apply time",
      "approval-required actions retain who, when, and decision reference",
      "bounded automatic actions are reversible, idempotent, attempt-limited, cooldown-limited, cost-limited, and verified",
      "destructive actions always require explicit approval",
      "every action retains before and after evidence and escalates after failed verification",
    ]),
  }),
  safety: Object.freeze({
    forbiddenPayloadData: Object.freeze([
      "credentials",
      "tokens",
      "cookies",
      "authorization headers",
      "raw personal identifiers",
      "unredacted provider responses",
      "unbounded stack traces",
    ]),
    automationRules: Object.freeze([
      "product telemetry cannot authorize remediation",
      "one confirmed fingerprint maps to one active incident",
      "unknown contract versions fail closed",
      "failed remediation never loops beyond maxAttempts",
      "verification failure rolls back when safe and otherwise escalates",
      "code-changing repair delivery remains outside automatic 1.0 authority",
    ]),
  }),
  schemas: operationsContractSchemaNames,
});

export const getOperationsContractCatalog = () =>
  structuredClone(operationsContractCatalog);
