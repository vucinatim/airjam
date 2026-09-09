import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCodexPermissionArgs,
  buildGoldenPathCommandEnv,
  eventRequiresSessionBroker,
  isPassingEvaluationEvent,
  sanitizeEvidenceTree,
  startProjectScopedSessionBroker,
  verifyPrimaryRun,
} from "../lib/golden-path-primary-run.mjs";
import {
  defaultGoldenPathManifestPath,
  readGoldenPathProgram,
  validateGoldenPathProgram,
} from "../lib/golden-path-program.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const cliPath = path.join(repoRoot, "scripts", "repo", "cli.mjs");

const runJson = (...args) =>
  JSON.parse(
    execFileSync(process.execPath, [cliPath, ...args, "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  );

test("golden path is a discoverable machine-readable repo CLI surface", () => {
  const rootHelp = execFileSync(process.execPath, [cliPath, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const help = execFileSync(
    process.execPath,
    [cliPath, "golden-path", "--help"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.match(rootHelp, /golden-path/);
  assert.match(help, /spec/);
  assert.match(help, /validate/);
  assert.match(help, /bootstrap/);
  assert.match(help, /run-primary/);
});

test("canonical golden-path program validates its clients, stages, and evidence contract", () => {
  const program = readGoldenPathProgram(defaultGoldenPathManifestPath);
  const spec = runJson("golden-path", "spec");
  const validation = runJson("golden-path", "validate");

  assert.equal(spec.id, program.id);
  assert.equal(spec.clients.primary.profile, "codex");
  assert.equal(spec.clients.secondary.profile, "claude-desktop");
  assert.equal(spec.publication.productionAllowed, false);
  assert.equal(spec.stages[0].id, "preflight");
  assert.equal(spec.stages.at(-1).id, "verify");
  assert.deepEqual(validation, {
    ok: true,
    id: program.id,
    manifest: "scripts/repo/programs/v1-external-agent-golden-path.json",
    stages: program.stages.length,
    evidenceFormat: "air-jam-golden-path-evidence/v1",
  });
});

test("primary prompt discloses every agent-owned evidence index", () => {
  const program = readGoldenPathProgram(defaultGoldenPathManifestPath);
  const prompt = execFileSync("sed", ["-n", "1,260p", program.promptTemplate], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const controllerOwned = new Set([
    "manifest.json",
    "inputs/scenario.json",
    "inputs/prompt.md",
    "environment/toolchain.json",
    "environment/isolation.json",
    "transcript/events.ndjson",
    "project/git/initial.json",
    "project/git/final.json",
    "verifier/report.json",
  ]);

  for (const evidencePath of program.evidenceBundle.requiredPaths) {
    if (!controllerOwned.has(evidencePath)) {
      assert.match(prompt, new RegExp(evidencePath.replace(".", "\\."), "u"));
    }
  }
  assert.match(prompt, /air-jam-golden-path-evidence\/v1/u);
  assert.match(prompt, /Never create placeholder success records/u);
});

test("golden-path validation rejects unsafe publication and malformed stage order", () => {
  const source = readGoldenPathProgram(defaultGoldenPathManifestPath);
  const productionProgram = structuredClone(source);
  productionProgram.publication.productionAllowed = true;
  assert.throws(
    () =>
      validateGoldenPathProgram(productionProgram, {
        validateReferencedFiles: false,
      }),
    /productionAllowed must be false/,
  );

  const malformedProgram = structuredClone(source);
  malformedProgram.stages[0].id = "bootstrap";
  assert.throws(
    () =>
      validateGoldenPathProgram(malformedProgram, {
        validateReferencedFiles: false,
      }),
    /Golden-path stages must be exactly/,
  );
});

test("primary-run isolation permits only run-owned writes and declared network targets", () => {
  const runRoot = "/tmp/airjam-golden-path-contract-run";
  const stagingUrl = "https://air-jam-platform-pr-123.example.test";
  const permissions = buildCodexPermissionArgs({
    runRoot,
    stagingUrl,
    additionalNetworkHostnames: ["cloudflare-account.r2.cloudflarestorage.com"],
  });
  const joinedArgs = permissions.args.join("\n");
  const joinedProbeArgs = permissions.globalArgs.join("\n");

  assert.match(joinedArgs, /network_proxy/);
  assert.match(joinedArgs, /approval_policy="never"/);
  assert.doesNotMatch(joinedArgs, /approve-for-me/);
  assert.match(joinedArgs, /allow_local_binding=true/);
  assert.match(joinedArgs, /network\.unix_sockets/);
  assert.match(joinedArgs, /air-jam-platform-pr-123\.example\.test/);
  assert.match(joinedArgs, /cloudflare-account\.r2\.cloudflarestorage\.com/);
  assert.match(joinedArgs, /127\.0\.0\.1/);
  assert.match(joinedArgs, /localhost/);
  assert.match(joinedArgs, /--add-dir/u);
  assert.doesNotMatch(joinedProbeArgs, /--add-dir/u);
  assert.deepEqual(permissions.profile.deniedReadRoots, ["<repo>"]);
  assert.equal(permissions.profile.network.managedProxy, true);
  assert.equal(permissions.profile.network.allowLocalBinding, true);
  assert.equal(permissions.profile.loginShellAllowed, false);
  assert.deepEqual(permissions.profile.writableRoots, [
    "<run>/evidence",
    "<run>/state",
    "<run>/tmp",
    "<run>/cache",
    "<run>/npm-cache",
    "<run>/pnpm-store",
  ]);
});

test("primary-run child environment drops inherited credentials and isolates caches", () => {
  const runRoot = "/tmp/airjam-golden-path-contract-run";
  const environment = buildGoldenPathCommandEnv({
    stagingUrl: "https://air-jam-platform-pr-123.example.test",
    runRoot,
    registryUrl: "http://127.0.0.1:4873",
    serverPort: 4400,
    gamePort: 5573,
    sourceEnv: {
      PATH: process.env.PATH,
      USER: "external-agent",
      OPENAI_API_KEY: "must-not-cross-boundary",
      RAILWAY_TOKEN: "must-not-cross-boundary",
    },
  });

  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.RAILWAY_TOKEN, undefined);
  assert.equal(environment.AIRJAM_STATE_DIR, `${runRoot}/state`);
  assert.equal(environment.TMPDIR, `${runRoot}/tmp`);
  assert.equal(environment.XDG_CACHE_HOME, `${runRoot}/cache`);
  assert.equal(environment.npm_config_cache, `${runRoot}/npm-cache`);
  assert.equal(environment.pnpm_config_store_dir, `${runRoot}/pnpm-store`);
  assert.equal(environment.AIR_JAM_SERVER_PORT, "4400");
  assert.equal(environment.VITE_PORT, "5573");
  assert.equal(environment.VITE_AIR_JAM_PUBLIC_HOST, "http://127.0.0.1:5573");
  assert.equal(environment.VITE_AIR_JAM_SERVER_URL, undefined);
  assert.equal(environment.AIR_JAM_DEV_PROXY_BACKEND_URL, undefined);
  assert.equal(environment.AIRJAM_DEVTOOLS_KNOWN_PORTS, "4400,5573");
});

test("primary-run launches the installed session broker outside the agent sandbox with project scope", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "airjam-g2-broker-"));
  const projectDir = path.join(root, "project");
  const entryPath = path.join(
    projectDir,
    "node_modules",
    "@air-jam",
    "cli",
    "dist",
    "index.js",
  );
  const logPath = path.join(root, "evidence", "broker.log");
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, "// installed candidate CLI\n");

  let invocation;
  const child = { pid: 4321 };
  const launched = startProjectScopedSessionBroker({
    projectDir,
    commandEnv: { AIR_JAM_SERVER_PORT: "4400" },
    logPath,
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      return child;
    },
  });

  assert.equal(launched?.child, child);
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [
    fs.realpathSync(entryPath),
    "__session-broker",
    "--dir",
    projectDir,
  ]);
  assert.equal(invocation.options.cwd, projectDir);
  assert.equal(invocation.options.env.AIR_JAM_SERVER_PORT, "4400");
  assert.deepEqual(invocation.options.stdio.slice(0, 1), ["ignore"]);
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);

  fs.rmSync(root, { recursive: true, force: true });
});

test("primary-run quality checkpoint accepts only a successful complete evaluation", () => {
  const evaluationEvent = (item) => ({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: "pnpm exec airjam evaluate --dir .",
      ...item,
    },
  });

  assert.equal(
    isPassingEvaluationEvent(
      evaluationEvent({
        exit_code: 0,
        aggregated_output:
          '{"contract":"air-jam-complete-evaluation/v1","status":"passed"}',
      }),
    ),
    true,
  );
  assert.equal(
    isPassingEvaluationEvent(
      evaluationEvent({
        exit_code: 1,
        aggregated_output:
          '{"contract":"air-jam-complete-evaluation/v1","status":"failed"}',
      }),
    ),
    false,
  );
  assert.equal(
    isPassingEvaluationEvent(
      evaluationEvent({ exit_code: 0, aggregated_output: "not json" }),
    ),
    false,
  );
});

test("a stopped controller broker is rearmed only for semantic session work", () => {
  const commandEvent = (command) => ({
    type: "item.started",
    item: { type: "command_execution", command },
  });
  assert.equal(
    eventRequiresSessionBroker(
      commandEvent("pnpm exec airjam session open --dir ."),
    ),
    true,
  );
  assert.equal(
    eventRequiresSessionBroker(commandEvent("pnpm exec airjam status --dir .")),
    false,
  );
  assert.equal(
    eventRequiresSessionBroker(
      commandEvent("pnpm exec airjam session broker stop --dir ."),
    ),
    false,
  );
  assert.equal(
    eventRequiresSessionBroker({
      type: "item.started",
      item: {
        type: "mcp_tool_call",
        tool_name: "airjam.capture_game_session_visuals",
      },
    }),
    true,
  );
});

test("evidence sanitization preserves declared release and visual artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "airjam-g2-evidence-"));
  try {
    fs.writeFileSync(path.join(root, "trace.txt"), "/run/private\n");
    fs.writeFileSync(path.join(root, "capture.png"), Buffer.from([0, 1, 2]));
    fs.writeFileSync(
      path.join(root, "release.zip"),
      Buffer.from([80, 75, 3, 4]),
    );

    sanitizeEvidenceTree({
      evidenceDir: root,
      runRoot: "/run/private",
      registryUrl: "http://127.0.0.1:4873",
    });

    assert.equal(
      fs.readFileSync(path.join(root, "trace.txt"), "utf8"),
      "<run>\n",
    );
    assert.deepEqual(
      fs.readFileSync(path.join(root, "capture.png")),
      Buffer.from([0, 1, 2]),
    );
    assert.deepEqual(
      fs.readFileSync(path.join(root, "release.zip")),
      Buffer.from([80, 75, 3, 4]),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("primary verifier preserves a complete classified blocker", () => {
  const runId = "g2-contract-blocked";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "airjam-g2-verifier-"));
  const evidenceDir = path.join(root, "evidence");
  const projectDir = path.join(root, "project");
  const program = readGoldenPathProgram(defaultGoldenPathManifestPath);
  try {
    for (const relativePath of program.evidenceBundle.requiredPaths) {
      if (
        relativePath === "manifest.json" ||
        relativePath === "verifier/report.json"
      ) {
        continue;
      }
      const absolutePath = path.join(evidenceDir, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      if (relativePath.endsWith("/index.json")) {
        fs.writeFileSync(
          absolutePath,
          `${JSON.stringify({
            contract: "air-jam-golden-path-evidence/v1",
            runId,
            records:
              relativePath === "failures/index.json"
                ? [
                    {
                      result: "blocked",
                      stage: "semantic-session-open",
                      classification: "environment",
                    },
                    {
                      result: "blocked",
                      firstFailingStage: "create-project",
                      responsibleSurface: "public scaffold CLI",
                      observation: "scaffold command exited before creation",
                      expected: "scaffold creates the project",
                      classification: "client",
                      stagesNotAttempted: ["implementation", "release"],
                    },
                  ]
                : [],
          })}\n`,
        );
      } else {
        fs.writeFileSync(absolutePath, "retained\n");
      }
    }
    const report = verifyPrimaryRun({
      program,
      evidenceDir,
      projectDir,
      runId,
      fault: null,
      codexExitCode: 0,
      controllerQuality: new Set(),
      runRoot: root,
      registryUrl: "http://127.0.0.1:4873",
    });

    assert.equal(report.result, "blocked");
    assert.deepEqual(report.failures, [
      {
        code: "agent_reported_blocker",
        stage: "create-project",
        surface: "public scaffold CLI",
        classification: "client",
        observation: "scaffold command exited before creation",
        expected: "scaffold creates the project",
        path: "failures/index.json",
      },
    ]);
    assert.deepEqual(report.notEvaluated, [
      {
        code: "stage_not_evaluated",
        stage: "implementation",
        path: "failures/index.json",
      },
      {
        code: "stage_not_evaluated",
        stage: "release",
        path: "failures/index.json",
      },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("primary verifier never trusts agent-authored quality or release success", () => {
  const runId = "g2-contract-self-attestation";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "airjam-g2-verifier-"));
  const evidenceDir = path.join(root, "evidence");
  const projectDir = path.join(root, "project");
  const program = readGoldenPathProgram(defaultGoldenPathManifestPath);
  try {
    for (const relativePath of program.evidenceBundle.requiredPaths) {
      if (
        relativePath === "manifest.json" ||
        relativePath === "verifier/report.json"
      ) {
        continue;
      }
      const absolutePath = path.join(evidenceDir, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      if (relativePath.endsWith("/index.json")) {
        fs.writeFileSync(
          absolutePath,
          `${JSON.stringify({
            contract: "air-jam-golden-path-evidence/v1",
            runId,
            records:
              relativePath === "release/index.json"
                ? [{ status: "passed", arcadeVisibility: "hidden" }]
                : [],
          })}\n`,
        );
      } else {
        fs.writeFileSync(absolutePath, "retained\n");
      }
    }
    const rulesPath = path.join(
      projectDir,
      "src",
      "game",
      "domain",
      "rules.ts",
    );
    fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
    fs.writeFileSync(rulesPath, "export const WIN_SCORE = 3;\n");

    const report = verifyPrimaryRun({
      program,
      evidenceDir,
      projectDir,
      runId,
      fault: { id: "declared-win-score-fault" },
      codexExitCode: 0,
      controllerQuality: new Set(["typecheck", "lint", "test", "build"]),
      releaseVerification: null,
      runRoot: root,
      registryUrl: "http://127.0.0.1:4873",
    });

    assert.equal(report.result, "failed");
    assert.ok(
      report.failures.some(
        (failure) => failure.code === "hidden_release_not_controller_verified",
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
