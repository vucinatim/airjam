import {
  operationalSloDefinitionSchemaV1,
  operationalSyntheticCheckSchemaV1,
  type OperationalSloDefinitionV1,
  type OperationalSyntheticCheckV1,
} from "@air-jam/operations-contract";

const check = (
  value: OperationalSyntheticCheckV1,
): OperationalSyntheticCheckV1 =>
  Object.freeze(operationalSyntheticCheckSchemaV1.parse(value));

const slo = (value: OperationalSloDefinitionV1): OperationalSloDefinitionV1 =>
  Object.freeze(operationalSloDefinitionSchemaV1.parse(value));

export const OPERATIONAL_SYNTHETIC_CHECKS = Object.freeze([
  check({
    contractVersion: 1,
    checkId: "landing-docs",
    title: "Landing and documentation",
    description: "Proves the public landing page and documentation render.",
    story: "landing_docs",
    service: "platform",
    executor: "http",
    intervalSeconds: 60,
    timeoutMilliseconds: 10_000,
    sloId: "public-web-availability",
    steps: [
      { stepId: "landing", targetKey: "platform.home", assertion: "http_2xx" },
      { stepId: "docs", targetKey: "platform.docs", assertion: "http_2xx" },
    ],
  }),
  check({
    contractVersion: 1,
    checkId: "arcade-hosted-release",
    title: "Arcade and hosted release",
    description:
      "Proves Arcade discovery and one immutable hosted release render.",
    story: "arcade_hosted_release",
    service: "hosted_runtime",
    executor: "http",
    intervalSeconds: 60,
    timeoutMilliseconds: 15_000,
    sloId: "public-web-availability",
    steps: [
      { stepId: "arcade", targetKey: "platform.arcade", assertion: "http_2xx" },
      {
        stepId: "release",
        targetKey: "hosted.release",
        assertion: "html_marker",
      },
    ],
  }),
  check({
    contractVersion: 1,
    checkId: "platform-realtime-health",
    title: "Platform and realtime health",
    description: "Proves both launch-critical public health boundaries.",
    story: "platform_realtime_health",
    service: "platform",
    executor: "http",
    intervalSeconds: 30,
    timeoutMilliseconds: 10_000,
    sloId: "control-plane-availability",
    steps: [
      {
        stepId: "platform",
        targetKey: "platform.health",
        assertion: "json_ok",
      },
      {
        stepId: "realtime",
        targetKey: "realtime.health",
        assertion: "json_ok",
      },
    ],
  }),
  check({
    contractVersion: 1,
    checkId: "room-controller",
    title: "Room creation and controller connection",
    description:
      "Creates a real room and joins a synthetic controller over the production protocol.",
    story: "room_controller",
    service: "realtime_server",
    executor: "airjam_semantic",
    intervalSeconds: 60,
    timeoutMilliseconds: 15_000,
    sloId: "multiplayer-session-availability",
    steps: [
      {
        stepId: "session",
        targetKey: "realtime.room_controller",
        assertion: "airjam_session",
      },
    ],
  }),
  check({
    contractVersion: 1,
    checkId: "semantic-gameplay",
    title: "Semantic gameplay loop",
    description:
      "Routes replicated state and one controller action through an authoritative synthetic host.",
    story: "semantic_gameplay",
    service: "realtime_server",
    executor: "airjam_semantic",
    intervalSeconds: 60,
    timeoutMilliseconds: 15_000,
    sloId: "multiplayer-session-availability",
    steps: [
      {
        stepId: "semantic-action",
        targetKey: "realtime.semantic_action",
        assertion: "airjam_session",
      },
    ],
  }),
  check({
    contractVersion: 1,
    checkId: "release-dependencies",
    title: "Release submission dependencies",
    description:
      "Proves the platform reports every required release-delivery boundary ready.",
    story: "release_dependencies",
    service: "platform",
    executor: "release_dependency",
    intervalSeconds: 60,
    timeoutMilliseconds: 10_000,
    sloId: "release-dependency-availability",
    steps: [
      {
        stepId: "release-boundaries",
        targetKey: "platform.readiness",
        assertion: "dependency_ready",
      },
      {
        stepId: "operational-worker",
        targetKey: "worker.ready",
        assertion: "json_ok",
      },
      {
        stepId: "browser-worker",
        targetKey: "browser_worker.health",
        assertion: "json_ok",
      },
    ],
  }),
] satisfies readonly OperationalSyntheticCheckV1[]);

export const OPERATIONAL_SLO_DEFINITIONS = Object.freeze([
  slo({
    contractVersion: 1,
    sloId: "public-web-availability",
    title: "Public web availability",
    description:
      "Landing, docs, Arcade, and an immutable hosted release remain reachable.",
    service: "platform",
    indicator: "synthetic_success_ratio",
    syntheticCheckIds: ["landing-docs", "arcade-hosted-release"],
    objectiveBasisPoints: 9_900,
    windowSeconds: 3_600,
    minimumSamples: 2,
    alerting: {
      severity: "error",
      consecutiveBreaches: 2,
      consecutiveRecoveries: 2,
    },
  }),
  slo({
    contractVersion: 1,
    sloId: "control-plane-availability",
    title: "Control plane availability",
    description: "Platform and realtime health boundaries remain ready.",
    service: "platform",
    indicator: "synthetic_success_ratio",
    syntheticCheckIds: ["platform-realtime-health"],
    objectiveBasisPoints: 9_950,
    windowSeconds: 1_800,
    minimumSamples: 2,
    alerting: {
      severity: "critical",
      consecutiveBreaches: 2,
      consecutiveRecoveries: 2,
    },
  }),
  slo({
    contractVersion: 1,
    sloId: "multiplayer-session-availability",
    title: "Multiplayer session availability",
    description:
      "Room, controller, replicated state, and semantic action paths remain usable.",
    service: "realtime_server",
    indicator: "synthetic_success_ratio",
    syntheticCheckIds: ["room-controller", "semantic-gameplay"],
    objectiveBasisPoints: 9_900,
    windowSeconds: 3_600,
    minimumSamples: 2,
    alerting: {
      severity: "critical",
      consecutiveBreaches: 2,
      consecutiveRecoveries: 2,
    },
  }),
  slo({
    contractVersion: 1,
    sloId: "release-dependency-availability",
    title: "Release dependency availability",
    description:
      "Every required release submission and publish dependency remains ready.",
    service: "platform",
    indicator: "synthetic_success_ratio",
    syntheticCheckIds: ["release-dependencies"],
    objectiveBasisPoints: 9_900,
    windowSeconds: 3_600,
    minimumSamples: 2,
    alerting: {
      severity: "error",
      consecutiveBreaches: 2,
      consecutiveRecoveries: 2,
    },
  }),
] satisfies readonly OperationalSloDefinitionV1[]);

export const getOperationalSyntheticCheck = (checkId: string) => {
  const found = OPERATIONAL_SYNTHETIC_CHECKS.find(
    (item) => item.checkId === checkId,
  );
  if (!found)
    throw new Error(`Unknown operational synthetic check ${checkId}.`);
  return found;
};

export const getOperationalSloDefinition = (sloId: string) => {
  const found = OPERATIONAL_SLO_DEFINITIONS.find(
    (item) => item.sloId === sloId,
  );
  if (!found) throw new Error(`Unknown operational SLO ${sloId}.`);
  return found;
};

export const getOperationalReliabilityCatalog = () => ({
  contractVersion: 1 as const,
  checks: structuredClone(OPERATIONAL_SYNTHETIC_CHECKS),
  slos: structuredClone(OPERATIONAL_SLO_DEFINITIONS),
});
