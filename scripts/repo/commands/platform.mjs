import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertGeneratedContentBlogSourceIsFresh } from "../../content/lib/content-blog-source-generator.mjs";
import { assertGeneratedContentDocsSourceIsFresh } from "../../content/lib/content-docs-source-generator.mjs";
import {
  generatePlatformAiPackArtifacts,
  readRelativeTree,
} from "../../platform/lib/platform-ai-pack-artifacts.mjs";
import { preparePlatformGeneratedArtifacts } from "../../platform/lib/platform-generated-prepare.mjs";
import { assertPlatformSchemaHeadIsFresh } from "../../platform/lib/platform-schema-head-generator.mjs";
import {
  resolvePlatformDatabaseTarget,
  resolveRailwayPlatformDatabaseTarget,
} from "../lib/platform-database-target.mjs";
import {
  inspectPlatformRecovery,
  rollbackPlatformDeployment,
  setPlatformBackupSchedule,
  writePlatformRecoveryEvidence,
} from "../lib/platform-recovery.mjs";
import {
  createRailwayApiClient,
  resolveRailwayApiToken,
} from "../lib/railway-api.mjs";
import { runCommand, runCommandResult } from "../lib/shell.mjs";
import { registerOperationsContractCommands } from "./operations-contract.mjs";

const logGeneratedPrepareResult = (result) => {
  console.log(
    `✓ Platform generated artifacts are ready (${result.channel}@${result.packVersion}, ${result.fileCount} files)`,
  );
};

const runPlatformGeneratedPrepare = async () => {
  const result = await preparePlatformGeneratedArtifacts();
  logGeneratedPrepareResult(result);
};

const assertPlatformAiPackGenerationIsDeterministic = async () => {
  const firstRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "airjam-platform-ai-pack-check-a-"),
  );
  const secondRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "airjam-platform-ai-pack-check-b-"),
  );

  try {
    const [firstResult, secondResult] = await Promise.all([
      generatePlatformAiPackArtifacts({ targetRoot: firstRoot }),
      generatePlatformAiPackArtifacts({ targetRoot: secondRoot }),
    ]);
    const [firstTree, secondTree] = await Promise.all([
      readRelativeTree(firstRoot),
      readRelativeTree(secondRoot),
    ]);
    const firstPaths = [...firstTree.keys()].sort();
    const secondPaths = [...secondTree.keys()].sort();

    if (JSON.stringify(firstPaths) !== JSON.stringify(secondPaths)) {
      throw new Error("Hosted AI pack generation produced unstable file sets.");
    }

    for (const relativePath of firstPaths) {
      if (firstTree.get(relativePath) !== secondTree.get(relativePath)) {
        throw new Error(
          `Hosted AI pack generation is nondeterministic: ${relativePath}.`,
        );
      }
    }

    const requiredManifestPaths = ["manifest.json"];
    for (const relativePath of requiredManifestPaths) {
      if (!firstTree.has(relativePath)) {
        throw new Error(
          `Hosted AI pack generation omitted required artifact: ${relativePath}.`,
        );
      }
    }

    if (
      firstResult.channel !== secondResult.channel ||
      firstResult.packVersion !== secondResult.packVersion ||
      firstResult.contentDigest !== secondResult.contentDigest ||
      firstResult.fileCount !== secondResult.fileCount ||
      firstPaths.length !== firstResult.fileCount + requiredManifestPaths.length
    ) {
      throw new Error(
        "Hosted AI pack generation returned inconsistent metadata.",
      );
    }

    return firstResult;
  } finally {
    await Promise.all([
      fs.promises.rm(firstRoot, { recursive: true, force: true }),
      fs.promises.rm(secondRoot, { recursive: true, force: true }),
    ]);
  }
};

const runPlatformGeneratedCheck = async () => {
  runCommand("pnpm", ["--filter", "@air-jam/cli", "ai-pack:check"]);
  await Promise.all([
    assertGeneratedContentDocsSourceIsFresh(),
    assertGeneratedContentBlogSourceIsFresh(),
    assertPlatformSchemaHeadIsFresh(),
  ]);

  const result = await assertPlatformAiPackGenerationIsDeterministic();
  console.log(
    `✓ Platform generated sources are fresh and AI pack generation is deterministic (${result.channel}@${result.packVersion}, ${result.fileCount} files)`,
  );
};

const runPlatformAiPackCheck = async () => {
  const result = await assertPlatformAiPackGenerationIsDeterministic();
  console.log(
    `✓ Hosted platform AI pack generation is deterministic (${result.channel}@${result.packVersion}, ${result.fileCount} files)`,
  );
};

const platformDatabaseOperatorInvocation = async ({
  script,
  operation,
  options,
  includeTarget = false,
  silent = false,
}) => {
  const resolved = includeTarget
    ? await resolvePlatformDatabaseTarget({
        railwayEnvironment: options.railwayEnvironment,
        railwayProject: options.railwayProject,
      })
    : options.railwayEnvironment
      ? await resolveRailwayPlatformDatabaseTarget({
          environmentId: options.railwayEnvironment,
          projectId: options.railwayProject ?? null,
        })
      : null;
  return {
    args: [
      ...(silent ? ["--silent"] : []),
      "--filter",
      "platform",
      "exec",
      "tsx",
      "--env-file-if-exists=.env.local",
      script,
      JSON.stringify(
        includeTarget ? { ...operation, target: resolved.target } : operation,
      ),
    ],
    env: resolved ? { DATABASE_URL: resolved.databaseUrl } : undefined,
  };
};

const runPlatformOperator = async ({
  script,
  operation,
  options,
  includeTarget = false,
  silent = false,
  errorLabel = "platform database operator",
}) => {
  const invocation = await platformDatabaseOperatorInvocation({
    script,
    operation,
    options,
    includeTarget,
    silent,
  });
  const capturesStructuredOutput = Boolean(operation.json);
  const result = runCommandResult("pnpm", invocation.args, {
    env: invocation.env,
    stdio: capturesStructuredOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: capturesStructuredOutput ? 20 * 1024 * 1024 : undefined,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    if (result.error.code === "ENOBUFS") {
      throw new Error(
        `${errorLabel} exceeded the 20 MiB structured-output limit. Narrow the requested result rather than accepting truncated JSON.`,
      );
    }
    throw new Error(`Could not start ${errorLabel}: ${result.error.message}`);
  }
  if (result.status !== 0) process.exitCode = result.status ?? 1;
};

const platformMigrationOperator = Object.freeze({
  script: "scripts/platform-database-migration-cli.ts",
  includeTarget: true,
  silent: true,
  errorLabel: "database migration operator",
});

const platformRestoreOperator = Object.freeze({
  script: "scripts/platform-database-restore-cli.ts",
  includeTarget: true,
  silent: true,
  errorLabel: "database restore operator",
});

const attachPlatformRecoveryEvidence = ({ kind, result }) => {
  try {
    return {
      ...result,
      evidence: writePlatformRecoveryEvidence({ kind, result }),
      evidencePersistence: { status: "verified" },
    };
  } catch (error) {
    return {
      ...result,
      evidence: null,
      evidencePersistence: {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
};

const resolveDomainHostname = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return null;
  }
};

export const verifyRailwayReleaseOriginAttestation = async ({
  result,
  expectedProjectId,
  client = null,
  tokenAvailable = null,
}) => {
  if (!result.productionEvidenceCandidate) return result;

  if (typeof expectedProjectId !== "string" || !expectedProjectId.trim()) {
    return {
      ...result,
      providerVerification: {
        status: "unavailable",
        provider: "railway",
        reason:
          "An expected Railway project ID is required for production evidence eligibility.",
      },
    };
  }

  const auth = resolveRailwayApiToken();
  if (!(tokenAvailable ?? Boolean(auth.token))) {
    return {
      ...result,
      providerVerification: {
        status: "unavailable",
        provider: "railway",
        reason: "No Railway API token is configured for provider verification.",
      },
    };
  }

  const deploymentId = result.source.deployment.deploymentId;
  try {
    const railwayClient = client ?? createRailwayApiClient();
    const deployment = await railwayClient.getDeployment(deploymentId);
    const environment = await railwayClient.getEnvironment(
      deployment.environmentId,
    );
    const instance = environment.serviceInstances.find(
      (entry) => entry.serviceId === deployment.serviceId,
    );
    const domainHostnames = [
      ...(instance?.domains?.customDomains ?? []).map((entry) => entry.domain),
      ...(instance?.domains?.serviceDomains ?? []).map((entry) => entry.domain),
      instance?.latestDeployment?.staticUrl ?? null,
      instance?.latestDeployment?.url ?? null,
    ]
      .map(resolveDomainHostname)
      .filter(Boolean);
    const platformHostname = new URL(result.source.platformOrigin).hostname;
    const releaseHostname = new URL(result.source.releaseOrigin).hostname;
    const platformDomainMatched = domainHostnames.includes(platformHostname);
    const releaseDomainMatched = domainHostnames.includes(releaseHostname);
    const expectedProjectMatched =
      environment.projectId === expectedProjectId.trim();
    const verified =
      deployment.id === deploymentId &&
      deployment.status === "SUCCESS" &&
      environment.name === "production" &&
      expectedProjectMatched &&
      instance?.latestDeployment?.id === deploymentId &&
      platformDomainMatched &&
      releaseDomainMatched;
    const providerVerification = {
      status: verified ? "verified" : "mismatch",
      provider: "railway",
      projectId: environment.projectId,
      environmentId: environment.id,
      serviceId: deployment.serviceId,
      deploymentId,
      productionEnvironment: environment.name === "production",
      successfulDeployment: deployment.status === "SUCCESS",
      currentServiceDeployment: instance?.latestDeployment?.id === deploymentId,
      platformDomainMatched,
      releaseDomainMatched,
      expectedProjectMatched,
    };
    const providerCheck = {
      id: "provider.railway-deployment",
      status: verified ? "passed" : "failed",
      summary: verified
        ? "Railway independently confirms the production project, service, current deployment, and both public domains."
        : "Railway provider state does not match the deployment's public identity claim.",
      evidence: {
        productionEnvironment: providerVerification.productionEnvironment,
        successfulDeployment: providerVerification.successfulDeployment,
        currentServiceDeployment: providerVerification.currentServiceDeployment,
        platformDomainMatched: providerVerification.platformDomainMatched,
        releaseDomainMatched: providerVerification.releaseDomainMatched,
        expectedProjectMatched: providerVerification.expectedProjectMatched,
      },
    };
    return {
      ...result,
      status: verified ? result.status : "failed",
      evidenceKind: verified ? "production-deployment" : "diagnostic",
      productionEvidenceEligible: verified,
      providerVerification,
      checks: [...result.checks, providerCheck],
      summary: {
        passed: result.summary.passed + (verified ? 1 : 0),
        failed: result.summary.failed + (verified ? 0 : 1),
      },
    };
  } catch {
    return {
      ...result,
      status: "failed",
      providerVerification: {
        status: "failed",
        provider: "railway",
        reason: "Railway provider verification failed.",
      },
      checks: [
        ...result.checks,
        {
          id: "provider.railway-deployment",
          status: "failed",
          summary: "Railway provider verification failed.",
        },
      ],
      summary: {
        passed: result.summary.passed,
        failed: result.summary.failed + 1,
      },
    };
  }
};

const printReleaseOriginAttestation = (result, json) => {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Hosted release origin attestation: ${result.status}`);
  console.log(`Evidence kind: ${result.evidenceKind}`);
  console.log(`Attested at: ${result.attestedAt}`);
  console.log(`Platform origin: ${result.source.platformOrigin}`);
  console.log(`Release origin: ${result.source.releaseOrigin}`);
  for (const item of result.checks) {
    console.log(
      `${item.status === "passed" ? "✓" : "✗"} ${item.id}: ${item.summary}`,
    );
  }
  console.log(
    `Checks: ${result.summary.passed} passed, ${result.summary.failed} failed`,
  );
  console.log(
    `Production deployment evidence: ${result.productionEvidenceEligible ? "eligible" : "diagnostic only"}`,
  );
};

const runPlatformReleaseOriginOperator = async (
  operation,
  { railwayProjectId = null } = {},
) => {
  const childOperation =
    operation.command === "attest" ? { ...operation, json: true } : operation;
  const platformEnvFile = "apps/platform/.env.local";
  const platformEnvArgs = fs.existsSync(platformEnvFile)
    ? [`--env-file=${platformEnvFile}`]
    : [];
  const result = runCommandResult(
    process.execPath,
    [
      ...platformEnvArgs,
      "--import",
      "tsx",
      "apps/platform/scripts/release-origin-cli.ts",
      JSON.stringify(childOperation),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { TSX_TSCONFIG_PATH: "apps/platform/tsconfig.json" },
    },
  );

  if (operation.command === "attest" && result.stdout) {
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      throw new Error("Release-origin attestation emitted invalid JSON.");
    }
    if (payload.error) {
      if (operation.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.error(payload.error.message);
      }
      process.exitCode = 1;
    } else {
      const verified = await verifyRailwayReleaseOriginAttestation({
        result: payload,
        expectedProjectId: railwayProjectId,
      });
      printReleaseOriginAttestation(verified, operation.json);
      if (verified.status === "failed") process.exitCode = 1;
    }
  } else if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    throw new Error(
      `Could not start release-origin inspection: ${result.error.message}`,
    );
  }
  if (result.status !== 0) process.exitCode = result.status ?? 1;
};

const addPlatformDatabaseTargetOption = (command) =>
  command
    .option(
      "--railway-environment <id>",
      "Operate an explicit Railway environment without printing its database credentials",
    )
    .option(
      "--railway-project <id>",
      "Railway project id; defaults to RAILWAY_PROJECT_ID",
    );

export const registerPlatformCommands = (program) => {
  const platformCommand = program
    .command("platform")
    .description("Platform maintainer helpers");

  const recoveryCommand = platformCommand
    .command("recovery")
    .description(
      "Inspect and operate exact-target backup, restore, rollback, and replay recovery",
    );

  recoveryCommand
    .command("status")
    .description(
      "Inspect backup policy and exact deployment rollback candidates",
    )
    .requiredOption("--railway-project <id>", "Railway project id")
    .requiredOption("--railway-environment <id>", "Railway environment id")
    .requiredOption(
      "--database-service <id>",
      "Railway service id owning the authoritative database volume",
    )
    .option(
      "--deployment-limit <count>",
      "Maximum deployment history per application service",
      "20",
    )
    .option("--json", "Print the stable machine-readable contract")
    .action(async (options) => {
      const deploymentLimit = Number(options.deploymentLimit);
      if (
        !Number.isSafeInteger(deploymentLimit) ||
        deploymentLimit < 1 ||
        deploymentLimit > 100
      ) {
        throw new Error("--deployment-limit must be an integer from 1 to 100.");
      }
      const result = await inspectPlatformRecovery({
        projectId: options.railwayProject,
        environmentId: options.railwayEnvironment,
        databaseServiceId: options.databaseService,
        deploymentLimit,
      });
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Platform recovery: ${result.status}`);
        console.log(
          `Backup policy: ${result.backup.policy.ready ? "ready" : "incomplete"} (${result.backup.policy.observedKinds.join(", ") || "none"})`,
        );
        console.log(
          `Latest provider backup: ${result.backup.latestBackup?.createdAt ?? "none"}`,
        );
        for (const service of result.deployments) {
          console.log(
            `${service.serviceName}: ${service.current?.id ?? "no current deployment"}; ${service.rollbackCandidates.length} rollback candidate(s)`,
          );
        }
      }
    });

  const recoveryBackupsCommand = recoveryCommand
    .command("backups")
    .description("Inspect and configure recurring provider backups");

  recoveryBackupsCommand
    .command("schedule")
    .description("Preview or apply the exact recurring backup schedule")
    .requiredOption("--railway-project <id>", "Railway project id")
    .requiredOption("--railway-environment <id>", "Railway environment id")
    .requiredOption("--database-service <id>", "Railway database service id")
    .requiredOption(
      "--kind <kind...>",
      "One or more DAILY, WEEKLY, or MONTHLY schedules",
    )
    .requiredOption("--actor <actor>", "Audited operator identity")
    .requiredOption("--reason <reason>", "Auditable change reason")
    .option(
      "--apply",
      "Persist the provider schedule; omission is a read-only preview",
    )
    .option("--json", "Print the stable machine-readable contract")
    .action(async (options) => {
      const result = await setPlatformBackupSchedule({
        projectId: options.railwayProject,
        environmentId: options.railwayEnvironment,
        databaseServiceId: options.databaseService,
        kinds: options.kind,
        actor: options.actor,
        reason: options.reason,
        apply: Boolean(options.apply),
      });
      const output = options.apply
        ? attachPlatformRecoveryEvidence({ kind: "backup-schedule", result })
        : result;
      if (options.json) console.log(JSON.stringify(output, null, 2));
      else {
        console.log(`Recurring backup schedule: ${result.status}`);
        if (output.evidence) console.log(`Evidence: ${output.evidence.path}`);
        if (output.evidencePersistence?.status === "failed") {
          console.error(
            `Evidence persistence failed after the provider operation: ${output.evidencePersistence.error}`,
          );
        }
      }
      if (
        result.status === "verification_failed" ||
        output.evidencePersistence?.status === "failed"
      ) {
        process.exitCode = 1;
      }
    });

  const recoveryDeploymentCommand = recoveryCommand
    .command("deployment")
    .description("Inspect and operate provider deployment recovery");

  recoveryDeploymentCommand
    .command("rollback")
    .description(
      "Preview or apply one exact deployment rollback with verification",
    )
    .requiredOption("--railway-project <id>", "Railway project id")
    .requiredOption("--railway-environment <id>", "Railway environment id")
    .requiredOption("--service <id>", "Exact Railway service id")
    .requiredOption(
      "--current-deployment <id>",
      "Expected current deployment fence",
    )
    .requiredOption("--target-deployment <id>", "Known-good rollback target")
    .requiredOption("--health-url <url>", "Independent application health URL")
    .requiredOption("--actor <actor>", "Audited operator identity")
    .requiredOption("--reason <reason>", "Auditable recovery reason")
    .option("--apply", "Execute the rollback; omission is a read-only preview")
    .option("--json", "Print the stable machine-readable contract")
    .action(async (options) => {
      const result = await rollbackPlatformDeployment({
        projectId: options.railwayProject,
        environmentId: options.railwayEnvironment,
        serviceId: options.service,
        currentDeploymentId: options.currentDeployment,
        targetDeploymentId: options.targetDeployment,
        healthUrl: options.healthUrl,
        actor: options.actor,
        reason: options.reason,
        apply: Boolean(options.apply),
      });
      const output = options.apply
        ? attachPlatformRecoveryEvidence({
            kind: "deployment-rollback",
            result,
          })
        : result;
      if (options.json) console.log(JSON.stringify(output, null, 2));
      else {
        console.log(`Deployment rollback: ${result.status}`);
        if (result.recoveryTimeMs !== undefined) {
          console.log(`Recovery time: ${result.recoveryTimeMs} ms`);
        }
        if (output.evidence) console.log(`Evidence: ${output.evidence.path}`);
        if (output.evidencePersistence?.status === "failed") {
          console.error(
            `Evidence persistence failed after the provider operation: ${output.evidencePersistence.error}`,
          );
        }
      }
      if (
        result.status === "verification_failed" ||
        output.evidencePersistence?.status === "failed"
      ) {
        process.exitCode = 1;
      }
    });

  const recoveryRestoreCommand = recoveryCommand
    .command("restore")
    .description(
      "Plan, apply, and independently verify a logical backup in an isolated database",
    );

  addPlatformDatabaseTargetOption(
    recoveryRestoreCommand
      .command("plan")
      .description("Create an immutable restore plan for an isolated target")
      .requiredOption(
        "--backup-manifest <path>",
        "Recovery-capable backup manifest",
      )
      .option(
        "--attest-isolated-loopback",
        "Attest that a loopback target is disposable and is not a remote tunnel",
      )
      .option("--output <path>", "Explicit immutable plan path")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      ...platformRestoreOperator,
      operation: {
        command: "plan",
        backupManifest: options.backupManifest,
        attestIsolatedLoopback: Boolean(options.attestIsolatedLoopback),
        output: options.output,
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    recoveryRestoreCommand
      .command("apply")
      .description("Apply one exact isolated restore plan and verify its data")
      .requiredOption("--plan <path>", "Immutable restore plan")
      .requiredOption("--plan-digest <sha256>", "Expected restore plan digest")
      .requiredOption("--actor <actor>", "Audited operator identity")
      .requiredOption("--reason <reason>", "Auditable restore reason")
      .requiredOption(
        "--idempotency-key <key>",
        "Stable retry identity for this logical restore",
      )
      .requiredOption("--apply", "Authorize mutation of the isolated target")
      .option(
        "--attest-isolated-loopback",
        "Attest that a loopback target is disposable and is not a remote tunnel",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      ...platformRestoreOperator,
      operation: {
        command: "apply",
        plan: options.plan,
        planDigest: options.planDigest,
        actor: options.actor,
        reason: options.reason,
        idempotencyKey: options.idempotencyKey,
        apply: Boolean(options.apply),
        attestIsolatedLoopback: Boolean(options.attestIsolatedLoopback),
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    recoveryRestoreCommand
      .command("verify")
      .description("Independently re-check one isolated restore target")
      .requiredOption("--plan <path>", "Immutable restore plan")
      .requiredOption("--plan-digest <sha256>", "Expected restore plan digest")
      .option(
        "--attest-isolated-loopback",
        "Attest that a loopback target is disposable and is not a remote tunnel",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      ...platformRestoreOperator,
      operation: {
        command: "verify",
        plan: options.plan,
        planDigest: options.planDigest,
        attestIsolatedLoopback: Boolean(options.attestIsolatedLoopback),
        json: Boolean(options.json),
      },
      options,
    });
  });

  const operationsCommand = platformCommand
    .command("operations")
    .description(
      "Inspect and operate authoritative production lifecycle surfaces",
    );
  registerOperationsContractCommands(operationsCommand);

  const reliabilityCommand = operationsCommand
    .command("reliability")
    .description(
      "Inspect and operate durable events, SLOs, alerts, and launch-critical synthetics",
    );

  reliabilityCommand
    .command("catalog")
    .description(
      "Inspect source-owned SLO and synthetic policies without a database",
    )
    .option("--json", "Print the stable machine-readable contract")
    .action(async (options) => {
      await runPlatformOperator({
        script: "scripts/operational-reliability-cli.ts",
        operation: { command: "catalog", json: Boolean(options.json) },
        options,
      });
    });

  addPlatformDatabaseTargetOption(
    reliabilityCommand
      .command("status")
      .description("Inspect current synthetic, SLO, and alert state")
      .option(
        "--environment <environment>",
        "production, preview, development, or test",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "status",
        environment: options.environment,
        json: Boolean(options.json),
      },
      options,
    });
  });

  const eventDeliveryCommand = reliabilityCommand
    .command("events")
    .description(
      "Inspect and safely advance durable operational-event delivery",
    );

  addPlatformDatabaseTargetOption(
    eventDeliveryCommand
      .command("status")
      .description("Inspect queue, lease, delivery, and dead-letter counts")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: { command: "events-status", json: Boolean(options.json) },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    eventDeliveryCommand
      .command("list")
      .description("List redacted durable delivery records")
      .option(
        "--status <status>",
        "pending, delivering, delivered, or dead_letter",
      )
      .option("--limit <limit>", "Maximum rows from 1 to 500", "100")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "events-list",
        status: options.status,
        limit: options.limit,
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    eventDeliveryCommand
      .command("inspect")
      .description("Inspect one redacted delivery record")
      .requiredOption("--event <event-id>", "Operational event ID")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "events-inspect",
        eventId: options.event,
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    eventDeliveryCommand
      .command("deliver-once")
      .description("Preview or deliver one dependency-ready event")
      .requiredOption("--worker <worker-id>", "Stable worker identity")
      .option("--apply", "Deliver one event; omission is a read-only preview")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "events-deliver-once",
        workerId: options.worker,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    eventDeliveryCommand
      .command("repair-expired")
      .description("Preview or repair expired event-delivery leases")
      .option("--limit <limit>", "Maximum rows from 1 to 500", "100")
      .option(
        "--apply",
        "Repair expired leases; omission is a read-only preview",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "events-repair-expired",
        limit: options.limit,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    eventDeliveryCommand
      .command("requeue-dead-letter")
      .description(
        "Preview or requeue one dead-lettered event with an audited retry budget",
      )
      .requiredOption(
        "--event <event-id>",
        "Dead-lettered operational event ID",
      )
      .requiredOption("--actor <actor>", "Audited agent or operator identity")
      .requiredOption("--reason <reason>", "Durable requeue reason")
      .requiredOption(
        "--idempotency-key <key>",
        "Stable key for this logical requeue command",
      )
      .option("--max-attempts <count>", "Fresh retry budget from 1 to 20", "8")
      .option("--apply", "Requeue the event; omission is a read-only preview")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "events-requeue-dead-letter",
        eventId: options.event,
        actor: options.actor,
        reason: options.reason,
        idempotencyKey: options.idempotencyKey,
        maxAttempts: options.maxAttempts,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  const syntheticCommand = reliabilityCommand
    .command("synthetics")
    .description("Inspect and execute the source-owned launch-critical checks");

  addPlatformDatabaseTargetOption(
    syntheticCommand
      .command("run")
      .description("Preview or execute and retain one synthetic check")
      .requiredOption("--check <check-id>", "Canonical synthetic check ID")
      .requiredOption("--actor <actor>", "Audited agent or operator identity")
      .requiredOption("--reason <reason>", "Durable execution reason")
      .requiredOption(
        "--idempotency-key <key>",
        "Stable key for this logical execution",
      )
      .option("--apply", "Execute the check; omission is a read-only preview")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "synthetics-run",
        checkId: options.check,
        actor: options.actor,
        reason: options.reason,
        idempotencyKey: options.idempotencyKey,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    syntheticCommand
      .command("run-due")
      .description("Preview or execute every due launch-critical check")
      .requiredOption("--actor <actor>", "Audited agent or operator identity")
      .option("--apply", "Execute due checks; omission is a read-only preview")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "synthetics-run-due",
        actor: options.actor,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    syntheticCommand
      .command("list")
      .description("List retained synthetic run documents")
      .option("--check <check-id>", "Canonical synthetic check ID")
      .option(
        "--environment <environment>",
        "production, preview, development, or test",
      )
      .option("--limit <limit>", "Maximum rows from 1 to 500", "100")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "synthetics-list",
        checkId: options.check,
        environment: options.environment,
        limit: options.limit,
        json: Boolean(options.json),
      },
      options,
    });
  });

  const alertsCommand = reliabilityCommand
    .command("alerts")
    .description("Inspect durable internal alert state");

  addPlatformDatabaseTargetOption(
    alertsCommand
      .command("list")
      .description("List durable internal alert state")
      .option(
        "--environment <environment>",
        "production, preview, development, or test",
      )
      .option("--status <status>", "open or recovered")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "alerts-list",
        environment: options.environment,
        status: options.status,
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    alertsCommand
      .command("inspect")
      .description("Inspect one durable internal alert by stable key")
      .requiredOption("--alert-key <alert-key>", "Stable operational alert key")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "alerts-inspect",
        alertKey: options.alertKey,
        json: Boolean(options.json),
      },
      options,
    });
  });

  const issueProjectionCommand = reliabilityCommand
    .command("issues")
    .description("Inspect and safely advance deduplicated GitHub alert issues");

  addPlatformDatabaseTargetOption(
    issueProjectionCommand
      .command("status")
      .description("Inspect GitHub issue projection queue and failures")
      .option("--repository <owner/name>", "Optional target repository filter")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "issues-status",
        repository: options.repository,
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    issueProjectionCommand
      .command("list")
      .description("List redacted GitHub issue projection records")
      .option("--repository <owner/name>", "Optional target repository filter")
      .option(
        "--status <status>",
        "pending, delivering, delivered, or dead_letter",
      )
      .option("--limit <limit>", "Maximum rows from 1 to 500", "100")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "issues-list",
        repository: options.repository,
        status: options.status,
        limit: options.limit,
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    issueProjectionCommand
      .command("inspect")
      .description("Inspect one alert-key and repository projection")
      .requiredOption("--repository <owner/name>", "Target repository")
      .requiredOption("--alert-key <alert-key>", "Stable operational alert key")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "issues-inspect",
        repository: options.repository,
        alertKey: options.alertKey,
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    issueProjectionCommand
      .command("project-once")
      .description("Preview or project one dependency-ready alert to GitHub")
      .requiredOption("--worker <worker-id>", "Stable worker identity")
      .option(
        "--apply",
        "Apply one GitHub issue projection; omission is a read-only preview",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "issues-project-once",
        workerId: options.worker,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    issueProjectionCommand
      .command("repair-expired")
      .description("Preview or repair expired GitHub issue projection leases")
      .option("--repository <owner/name>", "Optional target repository filter")
      .option("--limit <limit>", "Maximum rows from 1 to 500", "100")
      .option(
        "--apply",
        "Repair expired leases; omission is a read-only preview",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "issues-repair-expired",
        repository: options.repository,
        limit: options.limit,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    issueProjectionCommand
      .command("requeue-dead-letter")
      .description(
        "Preview or requeue one dead-lettered GitHub issue projection",
      )
      .requiredOption("--repository <owner/name>", "Target repository")
      .requiredOption("--alert-key <alert-key>", "Stable operational alert key")
      .requiredOption("--actor <actor>", "Audited agent or operator identity")
      .requiredOption("--reason <reason>", "Durable requeue reason")
      .requiredOption(
        "--idempotency-key <key>",
        "Stable key for this logical requeue command",
      )
      .option("--max-attempts <count>", "Fresh retry budget from 1 to 20", "8")
      .option(
        "--apply",
        "Requeue the projection; omission is a read-only preview",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/operational-reliability-cli.ts",
      operation: {
        command: "issues-requeue-dead-letter",
        repository: options.repository,
        alertKey: options.alertKey,
        actor: options.actor,
        reason: options.reason,
        idempotencyKey: options.idempotencyKey,
        maxAttempts: options.maxAttempts,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  const generatedCommand = platformCommand
    .command("generated")
    .description("Prepare or verify generated platform artifacts");

  generatedCommand
    .command("prepare")
    .description(
      "Generate platform content sources and hosted AI pack artifacts",
    )
    .action(runPlatformGeneratedPrepare);

  generatedCommand
    .command("check")
    .description(
      "Verify platform content sources and hosted AI pack artifacts are fresh",
    )
    .action(runPlatformGeneratedCheck);

  const aiPackCommand = platformCommand
    .command("ai-pack")
    .description("Hosted platform AI pack artifact helpers");

  aiPackCommand
    .command("generate")
    .description("Generate hosted platform AI pack artifacts")
    .action(async () => {
      const result = await generatePlatformAiPackArtifacts();
      console.log(
        `✓ Generated hosted AI pack artifacts for ${result.channel}@${result.packVersion} (${result.fileCount} files)`,
      );
    });

  aiPackCommand
    .command("check")
    .description("Verify hosted platform AI pack generation is deterministic")
    .action(async () => {
      await runPlatformAiPackCheck();
    });

  const releaseOriginCommand = platformCommand
    .command("release-origin")
    .description(
      "Inspect the untrusted hosted-release origin through an agent-safe contract",
    );

  releaseOriginCommand
    .command("inspect")
    .description(
      "Assess AIRJAM_RELEASES_PUBLIC_ORIGIN without exposing credentials",
    )
    .option(
      "--platform-url <origin>",
      "Inspect the deployed platform /api/readiness contract instead of local environment variables",
    )
    .option("--json", "Print the stable machine-readable contract")
    .action(async (options) => {
      await runPlatformReleaseOriginOperator({
        command: "inspect",
        json: Boolean(options.json),
        platformUrl: options.platformUrl ?? null,
      });
    });

  releaseOriginCommand
    .command("attest")
    .description(
      "Collect deployed transport evidence for routing, response policy, and auth isolation without executing creator code",
    )
    .requiredOption(
      "--platform-url <origin>",
      "Authenticated deployed platform origin, such as https://airjam.io",
    )
    .requiredOption(
      "--release-url <url>",
      "Exact canonical live /releases/g/{gameId}/r/{releaseId}/generations/{generationId} host-root URL",
    )
    .option(
      "--railway-project <id>",
      "Expected Railway project ID; required for production evidence eligibility",
    )
    .option("--json", "Print the stable machine-readable contract")
    .action(async (options) => {
      await runPlatformReleaseOriginOperator(
        {
          command: "attest",
          json: Boolean(options.json),
          platformUrl: options.platformUrl,
          releaseUrl: options.releaseUrl,
        },
        {
          railwayProjectId:
            options.railwayProject ?? process.env.RAILWAY_PROJECT_ID ?? null,
        },
      );
    });

  const telemetryCommand = platformCommand
    .command("telemetry")
    .description(
      "Inspect and operate first-party product telemetry through agent-safe contracts",
    );

  addPlatformDatabaseTargetOption(
    telemetryCommand
      .command("overview")
      .description(
        "Read the authority-separated product, lifecycle, and runtime overview",
      )
      .option("--days <days>", "Reporting window: 7, 30, or 90", "30")
      .option(
        "--environment <environment>",
        "Deployment environment: production, preview, development, or test",
        "production",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/product-telemetry-cli.ts",
      operation: {
        command: "overview",
        days: options.days,
        deploymentEnvironment: options.environment,
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    telemetryCommand
      .command("health")
      .description(
        "Inspect telemetry storage, projection freshness, and retention eligibility",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/product-telemetry-cli.ts",
      operation: {
        command: "health",
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    telemetryCommand
      .command("rebuild")
      .description(
        "Preview or apply a deterministic projection rebuild from retained raw events",
      )
      .option("--apply", "Apply the rebuild; omission is a read-only preview")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/product-telemetry-cli.ts",
      operation: {
        command: "rebuild",
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    telemetryCommand
      .command("retain")
      .description(
        "Preview or apply the canonical raw-event and session-contribution retention policy",
      )
      .option(
        "--apply",
        "Delete eligible records; omission is a read-only preview",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/product-telemetry-cli.ts",
      operation: {
        command: "retain",
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    operationsCommand
      .command("status")
      .description("Inspect every canonical expensive-lane control")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: { command: "status", json: Boolean(options.json) },
      options,
    });
  });

  const realtimeCommand = operationsCommand
    .command("realtime")
    .description(
      "Inspect shared realtime room, controller, and instance admission authority",
    );

  addPlatformDatabaseTargetOption(
    realtimeCommand
      .command("status")
      .description(
        "Inspect live admission leases against sustained targets and burst ceilings",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: { command: "realtime-status", json: Boolean(options.json) },
      options,
    });
  });

  const laneCommand = operationsCommand
    .command("lane")
    .description("Inspect and mutate one expensive-lane control");

  addPlatformDatabaseTargetOption(
    laneCommand
      .command("set")
      .description("Preview or apply an optimistic, audited lane-mode change")
      .requiredOption("--lane <lane>", "Canonical production lane")
      .requiredOption("--mode <mode>", "normal, restricted, or paused")
      .requiredOption("--reason <reason>", "Durable operator reason")
      .requiredOption("--actor <actor>", "Audited operator identity")
      .requiredOption(
        "--idempotency-key <key>",
        "Stable idempotency key for this logical mutation",
      )
      .requiredOption(
        "--expected-revision <revision>",
        "Revision returned by operations status",
      )
      .option(
        "--retry-after-seconds <seconds>",
        "Positive retry guidance returned while paused",
      )
      .option(
        "--apply",
        "Persist the mutation; omission is a read-only preview",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: {
        command: "lane-set",
        lane: options.lane,
        mode: options.mode,
        reason: options.reason,
        actor: options.actor,
        idempotencyKey: options.idempotencyKey,
        expectedRevision: options.expectedRevision,
        retryAfterSeconds: options.retryAfterSeconds ?? null,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  const budgetCommand = operationsCommand
    .command("budget")
    .description(
      "Inspect and ingest immutable provider spend evidence; state is always derived",
    );

  addPlatformDatabaseTargetOption(
    budgetCommand
      .command("status")
      .description(
        "Inspect the current cycle, evidence freshness, spend, forecast, and derived state",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: { command: "budget-status", json: Boolean(options.json) },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    budgetCommand
      .command("sync")
      .description(
        "Fetch Railway project usage, preview the derived budget result, or persist the evidence",
      )
      .requiredOption("--reason <reason>", "Durable evidence-collection reason")
      .requiredOption("--actor <actor>", "Audited collector identity")
      .requiredOption(
        "--idempotency-key <key>",
        "Stable idempotency key for this logical provider snapshot",
      )
      .option(
        "--apply",
        "Persist the immutable evidence; omission is a read-only preview",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    const projectId =
      options.railwayProject ?? process.env.RAILWAY_PROJECT_ID ?? null;
    const environmentId =
      options.railwayEnvironment ?? process.env.RAILWAY_ENVIRONMENT_ID ?? null;
    if (!projectId?.trim()) {
      throw new Error(
        "Budget sync requires --railway-project or RAILWAY_PROJECT_ID.",
      );
    }
    if (!environmentId?.trim()) {
      throw new Error(
        "Budget sync requires --railway-environment or RAILWAY_ENVIRONMENT_ID for exact token attestation.",
      );
    }
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: {
        command: "budget-sync",
        projectId: projectId.trim(),
        environmentId: environmentId.trim(),
        reason: options.reason,
        actor: options.actor,
        idempotencyKey: options.idempotencyKey,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  const lifecycleCommand = operationsCommand
    .command("lifecycle")
    .description(
      "Inspect and operate automatic product-resource retention through durable jobs",
    );

  addPlatformDatabaseTargetOption(
    lifecycleCommand
      .command("cleanup")
      .description(
        "Preview exact retention-eligible storage or enqueue bounded cleanup jobs",
      )
      .requiredOption("--actor <actor>", "Audited operator identity")
      .requiredOption("--reason <reason>", "Durable operator reason")
      .requiredOption(
        "--idempotency-key <key>",
        "Stable idempotency key for this logical cleanup schedule",
      )
      .option(
        "--limit <limit>",
        "Maximum resources to inspect or schedule, from 1 to 500",
        "100",
      )
      .option(
        "--apply",
        "Enqueue durable cleanup jobs; omission is an exact read-only preview",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: {
        command: "lifecycle-cleanup",
        actor: options.actor,
        reason: options.reason,
        idempotencyKey: options.idempotencyKey,
        limit: options.limit,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  const quotaCommand = operationsCommand
    .command("quota")
    .description(
      "Inspect authoritative free-cloud usage and preview shadow or enforced admission decisions",
    );

  addPlatformDatabaseTargetOption(
    quotaCommand
      .command("status")
      .description(
        "Inspect every ratified creator quota and optional game-scoped quota",
      )
      .requiredOption("--creator <creator-id>", "Authoritative creator ID")
      .option("--game <game-id>", "Owned game ID for game-scoped quotas")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: {
        command: "quota-status",
        creatorId: options.creator,
        gameId: options.game,
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    quotaCommand
      .command("check")
      .description(
        "Evaluate one requested amount against authoritative usage, lane mode, and budget state",
      )
      .requiredOption("--key <quota-key>", "Canonical quota key")
      .requiredOption("--lane <lane>", "Semantic production lane")
      .requiredOption("--creator <creator-id>", "Authoritative creator ID")
      .requiredOption(
        "--amount <amount>",
        "Non-negative integer count, bytes, or seconds requested",
      )
      .option("--game <game-id>", "Owned game ID for game-scoped quotas")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: {
        command: "quota-check",
        key: options.key,
        lane: options.lane,
        creatorId: options.creator,
        gameId: options.game,
        requestedAmount: options.amount,
        json: Boolean(options.json),
      },
      options,
    });
  });

  const jobsCommand = operationsCommand
    .command("jobs")
    .description(
      "Inspect and safely operate the durable platform job authority",
    );

  jobsCommand
    .command("policy")
    .description("Inspect the source-owned policy for every durable job kind")
    .option("--kind <kind>", "Canonical operational job kind")
    .option("--json", "Print the stable machine-readable contract")
    .action(async (options) => {
      await runPlatformOperator({
        script: "scripts/production-control-cli.ts",
        operation: {
          command: "jobs-policy",
          kind: options.kind,
          json: Boolean(options.json),
        },
        options,
      });
    });

  addPlatformDatabaseTargetOption(
    jobsCommand
      .command("status")
      .description(
        "Inspect bounded queue, lease, cancellation, and expiry state",
      )
      .option("--kind <kind>", "Canonical operational job kind")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: {
        command: "jobs-status",
        kind: options.kind,
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    jobsCommand
      .command("list")
      .description("List durable jobs through bounded authority filters")
      .option("--kind <kind>", "Canonical operational job kind")
      .option(
        "--status <status...>",
        "One or more queued, running, cancel_requested, succeeded, failed, or canceled states",
      )
      .option("--creator <creator-id>", "Authoritative creator ID")
      .option("--release <release-id>", "Authoritative release ID")
      .option(
        "--resource-kind <kind>",
        "release_generation or game_media_asset",
      )
      .option("--resource <resource-id>", "Canonical resource ID")
      .option("--limit <limit>", "Maximum jobs to return, from 1 to 500", "100")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: {
        command: "jobs-list",
        kind: options.kind,
        statuses: options.status,
        creatorId: options.creator,
        releaseId: options.release,
        resourceKind: options.resourceKind,
        resourceId: options.resource,
        limit: options.limit,
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    jobsCommand
      .command("inspect")
      .description("Inspect one job and its ordered persisted lifecycle events")
      .requiredOption("--job <job-id>", "Operational job ID")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: {
        command: "jobs-inspect",
        jobId: options.job,
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    jobsCommand
      .command("cancel")
      .description(
        "Preview or apply an optimistic, audited durable-job cancellation",
      )
      .requiredOption("--job <job-id>", "Operational job ID")
      .requiredOption(
        "--expected-revision <revision>",
        "Revision returned by jobs inspect",
      )
      .requiredOption("--actor <actor>", "Audited operator identity")
      .requiredOption("--reason <reason>", "Durable operator reason")
      .requiredOption(
        "--idempotency-key <key>",
        "Stable idempotency key for this logical cancellation",
      )
      .option(
        "--apply",
        "Persist the cancellation; omission is a read-only preview",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: {
        command: "jobs-cancel",
        jobId: options.job,
        expectedRevision: options.expectedRevision,
        actor: options.actor,
        reason: options.reason,
        idempotencyKey: options.idempotencyKey,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    jobsCommand
      .command("replay")
      .description(
        "Preview or enqueue and independently verify one exact terminal-job replay",
      )
      .requiredOption("--job <job-id>", "Terminal operational job ID")
      .requiredOption("--actor <actor>", "Audited operator identity")
      .requiredOption("--reason <reason>", "Durable operator reason")
      .requiredOption(
        "--idempotency-key <key>",
        "Stable idempotency key for this logical replay",
      )
      .option("--apply", "Enqueue the replay; omission is a read-only preview")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: {
        command: "jobs-replay",
        jobId: options.job,
        actor: options.actor,
        reason: options.reason,
        idempotencyKey: options.idempotencyKey,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    jobsCommand
      .command("repair-expired")
      .description(
        "Preview or apply bounded recovery of expired deadlines and leases",
      )
      .requiredOption("--kind <kind>", "Canonical operational job kind")
      .requiredOption("--actor <actor>", "Audited operator identity")
      .requiredOption("--reason <reason>", "Durable operator reason")
      .requiredOption(
        "--idempotency-key <key>",
        "Stable idempotency key for this repair operation",
      )
      .option("--limit <limit>", "Maximum jobs to repair, from 1 to 500", "100")
      .option("--apply", "Persist the repair; omission is a read-only preview")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: {
        command: "jobs-repair-expired",
        kind: options.kind,
        actor: options.actor,
        reason: options.reason,
        idempotencyKey: options.idempotencyKey,
        limit: options.limit,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    jobsCommand
      .command("cleanup-orphans")
      .description(
        "Preview or delete attempt-scoped output left by terminal release jobs",
      )
      .requiredOption("--actor <actor>", "Audited operator identity")
      .requiredOption("--reason <reason>", "Durable operator reason")
      .option(
        "--limit <limit>",
        "Maximum attempts to clean, from 1 to 500",
        "100",
      )
      .option(
        "--apply",
        "Delete orphan output; omission is a read-only preview",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: {
        command: "jobs-cleanup-orphans",
        actor: options.actor,
        reason: options.reason,
        limit: options.limit,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    jobsCommand
      .command("worker-once")
      .description(
        "Preview or execute one durable operational-worker claim and attempt",
      )
      .requiredOption("--kind <kind>", "Canonical operational job kind")
      .requiredOption("--worker <worker-id>", "Stable worker identity")
      .option(
        "--apply",
        "Run one worker cycle; omission is a read-only preview",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      script: "scripts/production-control-cli.ts",
      operation: {
        command: "jobs-worker-once",
        kind: options.kind,
        workerId: options.worker,
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  const databaseCommand = platformCommand
    .command("database")
    .description(
      "Inspect, back up, migrate, and verify the authoritative platform database",
    );

  addPlatformDatabaseTargetOption(
    databaseCommand
      .command("backup")
      .description("Create a fingerprint-bound PostgreSQL backup and manifest")
      .option("--output <path>", "Explicit backup artifact path")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      ...platformMigrationOperator,
      operation: {
        command: "backup",
        output: options.output,
        json: Boolean(options.json),
      },
      options,
    });
  });

  const migrationCommand = databaseCommand
    .command("migration")
    .description(
      "Run the immutable plan, guarded apply, and independent verify lifecycle",
    );

  addPlatformDatabaseTargetOption(
    migrationCommand
      .command("inspect")
      .description(
        "Compare an exact database target with the source migration catalog",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      ...platformMigrationOperator,
      operation: { command: "inspect", json: Boolean(options.json) },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    migrationCommand
      .command("plan")
      .description("Create a backup-bound immutable migration plan")
      .option("--authority <authority>", "local or production", "local")
      .option("--output <path>", "Explicit immutable plan path")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      ...platformMigrationOperator,
      operation: {
        command: "plan",
        authority: options.authority,
        output: options.output,
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    migrationCommand
      .command("apply")
      .description(
        "Apply one exact migration plan; lanes stay paused until verify",
      )
      .requiredOption("--plan <path>", "Immutable plan document")
      .requiredOption("--plan-digest <sha256>", "Expected plan digest")
      .requiredOption("--authority <authority>", "local or production")
      .requiredOption("--actor <actor>", "Stable operator identity")
      .requiredOption("--reason <reason>", "Auditable change reason")
      .requiredOption("--idempotency-key <key>", "Stable retry identity")
      .option(
        "--drain-timeout-seconds <seconds>",
        "Maximum lane drain wait",
        "300",
      )
      .requiredOption("--apply", "Authorize the exact planned mutation")
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      ...platformMigrationOperator,
      operation: {
        command: "apply",
        plan: options.plan,
        planDigest: options.planDigest,
        authority: options.authority,
        actor: options.actor,
        reason: options.reason,
        idempotencyKey: options.idempotencyKey,
        drainTimeoutSeconds: Number(options.drainTimeoutSeconds),
        apply: Boolean(options.apply),
        json: Boolean(options.json),
      },
      options,
    });
  });

  addPlatformDatabaseTargetOption(
    migrationCommand
      .command("verify")
      .description(
        "Verify schema and exact deployed revision, then restore lanes",
      )
      .requiredOption("--plan <path>", "Immutable plan document")
      .requiredOption("--plan-digest <sha256>", "Expected plan digest")
      .requiredOption("--authority <authority>", "local or production")
      .requiredOption("--actor <actor>", "Stable operator identity")
      .requiredOption("--reason <reason>", "Auditable verification reason")
      .option(
        "--platform-url <url>",
        "Deployed platform origin for readiness proof",
      )
      .option("--json", "Print the stable machine-readable contract"),
  ).action(async (options) => {
    await runPlatformOperator({
      ...platformMigrationOperator,
      operation: {
        command: "verify",
        plan: options.plan,
        planDigest: options.planDigest,
        authority: options.authority,
        actor: options.actor,
        reason: options.reason,
        platformUrl: options.platformUrl,
        json: Boolean(options.json),
      },
      options,
    });
  });

  return platformCommand;
};
