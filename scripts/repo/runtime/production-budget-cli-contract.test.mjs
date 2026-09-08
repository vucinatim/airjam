import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const cliPath = path.join(repoRoot, "scripts", "repo", "cli.mjs");
const platformCliPath = path.join(
  repoRoot,
  "apps",
  "platform",
  "scripts",
  "production-control-cli.ts",
);

const readHelp = (...args) =>
  execFileSync(process.execPath, [cliPath, ...args, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

test("production budget lifecycle is discoverable through one repo CLI", () => {
  const operationsHelp = readHelp("platform", "operations");
  const budgetHelp = readHelp("platform", "operations", "budget");
  const statusHelp = readHelp("platform", "operations", "budget", "status");
  const syncHelp = readHelp("platform", "operations", "budget", "sync");

  assert.match(operationsHelp, /budget/u);
  assert.match(budgetHelp, /status/u);
  assert.match(budgetHelp, /sync/u);
  assert.match(statusHelp, /--json/u);
  assert.match(syncHelp, /--actor/u);
  assert.match(syncHelp, /--reason/u);
  assert.match(syncHelp, /--idempotency-key/u);
  assert.match(syncHelp, /--apply/u);
  assert.match(syncHelp, /read-only preview/u);
  assert.match(syncHelp, /--railway-project/u);
  assert.match(syncHelp, /--railway-environment/u);
  assert.doesNotMatch(syncHelp, /--state/u);
  assert.doesNotMatch(syncHelp, /--threshold/u);
  assert.doesNotMatch(syncHelp, /--ceiling/u);
});

test("budget sync child contract requires exact project and environment ids", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      platformCliPath,
      JSON.stringify({
        command: "budget-sync",
        projectId: "project-1",
        reason: "Contract test",
        actor: "test:budget-cli",
        idempotencyKey: "budget-cli-contract",
        apply: false,
        json: true,
      }),
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: "apps/platform/tsconfig.json",
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /environmentId is required/u);
});
