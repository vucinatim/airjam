import { spawnSync } from "node:child_process";
import path from "node:path";

import { runGoldenPathBootstrap } from "../lib/golden-path-bootstrap.mjs";
import { runGoldenPathPrimary } from "../lib/golden-path-primary-run.mjs";
import {
  defaultGoldenPathManifestPath,
  readGoldenPathProgram,
  summarizeGoldenPathProgram,
  validateGoldenPathProgram,
} from "../lib/golden-path-program.mjs";
import {
  deployGoldenPathStaging,
  emptyGoldenPathStagingBucket,
  provisionGoldenPathStaging,
} from "../lib/golden-path-staging-lifecycle.mjs";
import { resolveGoldenPathRailwayStagingTarget } from "../lib/golden-path-staging-target.mjs";
import { repoRoot } from "../lib/paths.mjs";

const resolveManifestPath = (value) => {
  if (!value) return defaultGoldenPathManifestPath;
  const resolved = path.resolve(repoRoot, value);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("--manifest must resolve inside the repository.");
  }
  return resolved;
};

const printJson = (value) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const resolveLocalCommit = (value) => {
  const commit = String(value ?? "").trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("--commit must be a full lowercase 40-character Git SHA.");
  }
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", `${commit}^{commit}`],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0 || result.stdout.trim() !== commit) {
    throw new Error(
      `--commit does not resolve to a local Git commit: ${commit}. Fetch or push the intended commit before deploying.`,
    );
  }
  return commit;
};

const addManifestOption = (command) =>
  command.option("--manifest <path>", "Repo-relative scenario manifest path");

export const registerGoldenPathCommands = (program) => {
  const goldenPathCommand = program
    .command("golden-path")
    .description(
      "Inspect and validate the external-agent golden-path contract",
    );

  addManifestOption(
    goldenPathCommand
      .command("spec")
      .description("Print the canonical replayable scenario specification")
      .option("--json", "Print stable JSON"),
  ).action((options) => {
    const spec = summarizeGoldenPathProgram(
      readGoldenPathProgram(resolveManifestPath(options.manifest)),
    );
    if (options.json) {
      printJson(spec);
      return;
    }
    console.log(`${spec.title} (${spec.id})`);
    console.log(
      `Clients: ${spec.clients.primary.profile} primary, ${spec.clients.secondary.profile} secondary`,
    );
    console.log(`Stages: ${spec.stages.map((stage) => stage.id).join(" -> ")}`);
    console.log(`Evidence: ${spec.evidenceBundle.format}`);
    console.log(`Contract: ${spec.contract}`);
  });

  addManifestOption(
    goldenPathCommand
      .command("validate")
      .description("Validate scenario structure and referenced contract files")
      .option("--json", "Print stable JSON"),
  ).action((options) => {
    const manifestPath = resolveManifestPath(options.manifest);
    const programState = readGoldenPathProgram(manifestPath);
    validateGoldenPathProgram(programState);
    const result = {
      ok: true,
      id: programState.id,
      manifest: path.relative(repoRoot, manifestPath),
      stages: programState.stages.length,
      evidenceFormat: programState.evidenceBundle.format,
    };
    if (options.json) printJson(result);
    else {
      console.log(
        `Golden-path program is valid: ${result.stages} stages, ${result.evidenceFormat}.`,
      );
    }
  });

  goldenPathCommand
    .command("bootstrap")
    .description(
      "Prove candidate package installation and MCP discovery through an isolated registry",
    )
    .option("--template <id>", "Scaffold template to prove", "minimal")
    .option("--keep-workspace", "Retain the run-owned temporary workspace")
    .option("--json", "Print stable JSON")
    .action(async (options) => {
      const result = await runGoldenPathBootstrap({
        template: options.template,
        keepWorkspace: options.keepWorkspace === true,
        onProgress: (stage) => {
          process.stderr.write(`[golden-path bootstrap] ${stage}\n`);
        },
      });
      if (options.json) {
        printJson(result);
        return;
      }
      console.log(
        `Golden-path bootstrap passed for ${result.project.name} with ${result.discovery.mcpTools.length} MCP tools.`,
      );
      if (result.retainedWorkspace) {
        console.log(`Retained workspace: ${result.retainedWorkspace}`);
      }
    });

  const stagingCommand = goldenPathCommand
    .command("staging")
    .description(
      "Provision, inspect, deploy, and clean the isolated golden-path environment",
    );

  stagingCommand
    .command("status")
    .description(
      "Verify deployed staging health, provider identity, and production isolation",
    )
    .requiredOption("--railway-project <id>", "Railway project id")
    .requiredOption("--railway-environment <id>", "Staging environment id")
    .option("--json", "Print stable non-secret JSON")
    .action(async (options) => {
      const result = await resolveGoldenPathRailwayStagingTarget({
        projectId: options.railwayProject,
        environmentId: options.railwayEnvironment,
      });
      if (options.json) printJson(result);
      else {
        console.log(
          `${result.environmentName} is healthy and isolated at ${result.url}.`,
        );
      }
    });

  stagingCommand
    .command("provision")
    .description(
      "Rotate a dormant Railway staging clone onto short-lived non-production authorities",
    )
    .requiredOption("--railway-project <id>", "Railway project id")
    .requiredOption(
      "--railway-environment <id>",
      "Dormant staging environment id",
    )
    .requiredOption(
      "--release-origin <origin>",
      "Cross-site custom origin attached to the staging platform",
    )
    .requiredOption("--r2-bucket <name>", "Dedicated non-production R2 bucket")
    .option("--ttl-hours <hours>", "Temporary R2 credential lifetime", "24")
    .option("--json", "Print stable non-secret JSON")
    .action(async (options) => {
      const ttlHours = Number.parseInt(options.ttlHours, 10);
      if (!Number.isSafeInteger(ttlHours) || ttlHours <= 0) {
        throw new Error("--ttl-hours must be a positive integer.");
      }
      const result = await provisionGoldenPathStaging({
        projectId: options.railwayProject,
        environmentId: options.railwayEnvironment,
        releaseOrigin: options.releaseOrigin,
        r2Bucket: options.r2Bucket,
        ttlSeconds: ttlHours * 60 * 60,
      });
      if (options.json) printJson(result);
      else {
        console.log(
          `Provisioned ${result.environmentName} with ${result.r2.bucket} until ${result.r2.expiresAt}.`,
        );
        console.log("No deployments were started.");
      }
    });

  stagingCommand
    .command("deploy")
    .description(
      "Deploy an isolated staging environment in dependency order and verify it",
    )
    .requiredOption("--railway-project <id>", "Railway project id")
    .requiredOption(
      "--railway-environment <id>",
      "Provisioned staging environment id",
    )
    .requiredOption("--commit <sha>", "Exact 40-character Git commit to deploy")
    .option("--json", "Print stable non-secret JSON")
    .action(async (options) => {
      const commitSha = resolveLocalCommit(options.commit);
      const result = await deployGoldenPathStaging({
        projectId: options.railwayProject,
        environmentId: options.railwayEnvironment,
        commitSha,
        onProgress: (stage) => {
          process.stderr.write(`[golden-path staging] ${stage}\n`);
        },
      });
      if (options.json) printJson(result);
      else {
        console.log(
          `Deployed ${result.commitSha} to ${result.target.environmentName}.`,
        );
        console.log(`Platform: ${result.target.url}`);
      }
    });

  stagingCommand
    .command("empty-storage")
    .description("Delete every object from the dedicated staging R2 bucket")
    .requiredOption("--railway-project <id>", "Railway project id")
    .requiredOption("--railway-environment <id>", "Staging environment id")
    .option("--apply", "Confirm destructive staging-object cleanup")
    .option("--json", "Print stable non-secret JSON")
    .action(async (options) => {
      if (options.apply !== true) {
        throw new Error(
          "Golden-path staging storage cleanup requires explicit --apply.",
        );
      }
      const result = await emptyGoldenPathStagingBucket({
        projectId: options.railwayProject,
        environmentId: options.railwayEnvironment,
      });
      if (options.json) printJson(result);
      else {
        console.log(
          `Removed ${result.deletedObjects} object(s) from ${result.bucket}.`,
        );
      }
    });

  goldenPathCommand
    .command("run-primary")
    .description(
      "Run the canonical clean-room lifecycle through an external Codex process",
    )
    .requiredOption(
      "--railway-project <id>",
      "Railway project containing the isolated staging environment",
    )
    .requiredOption(
      "--railway-environment <id>",
      "Non-production Railway staging or PR environment",
    )
    .option("--run-id <id>", "Stable run identity")
    .option("--model <model>", "Codex model override")
    .option(
      "--timeout-minutes <minutes>",
      "Primary Codex agent wall-clock limit",
      "120",
    )
    .option(
      "--discard-workspace",
      "Remove the workspace after indexing evidence",
    )
    .option("--json", "Print stable JSON")
    .action(async (options) => {
      const result = await runGoldenPathPrimary({
        runId: options.runId,
        railwayProjectId: options.railwayProject,
        railwayEnvironmentId: options.railwayEnvironment,
        keepWorkspace: options.discardWorkspace !== true,
        model: options.model,
        primaryAgentTimeoutMs:
          Number.parseInt(options.timeoutMinutes, 10) * 60 * 1_000,
        onProgress: (stage) => {
          process.stderr.write(`[golden-path primary] ${stage}\n`);
        },
      });
      if (options.json) printJson(result);
      else {
        console.log(
          `Golden-path primary run ${result.runId}: ${result.result}.`,
        );
        console.log(`Evidence: ${result.evidenceDirectory}`);
      }
      if (!result.ok) process.exitCode = 1;
    });
};
