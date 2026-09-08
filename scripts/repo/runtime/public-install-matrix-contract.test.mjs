import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { resolvePublicPackages } from "../../release/public-packages.mjs";
import {
  aggregatePublicInstallMatrixEvidence,
  readCommandVersion,
  readPublicInstallMatrix,
  readScaffoldResourceBudgets,
  summarizePublicInstallMatrix,
} from "../lib/public-install-matrix.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const cliPath = path.join(repoRoot, "scripts/repo/cli.mjs");
const rootManifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);

test("public install matrix exactly covers the supported OS and Node pairs", () => {
  const summary = summarizePublicInstallMatrix(readPublicInstallMatrix());

  assert.deepEqual(summary.cells, [
    {
      id: "linux-node-22",
      operatingSystem: "linux",
      nodePlatform: "linux",
      githubRunner: "ubuntu-latest",
      nodeMajor: 22,
    },
    {
      id: "linux-node-24",
      operatingSystem: "linux",
      nodePlatform: "linux",
      githubRunner: "ubuntu-latest",
      nodeMajor: 24,
    },
    {
      id: "macos-node-22",
      operatingSystem: "macos",
      nodePlatform: "darwin",
      githubRunner: "macos-latest",
      nodeMajor: 22,
    },
    {
      id: "macos-node-24",
      operatingSystem: "macos",
      nodePlatform: "darwin",
      githubRunner: "macos-latest",
      nodeMajor: 24,
    },
    {
      id: "windows-node-22",
      operatingSystem: "windows",
      nodePlatform: "win32",
      githubRunner: "windows-latest",
      nodeMajor: 22,
    },
    {
      id: "windows-node-24",
      operatingSystem: "windows",
      nodePlatform: "win32",
      githubRunner: "windows-latest",
      nodeMajor: 24,
    },
  ]);
  assert.deepEqual(
    [...summary.packages].sort(),
    resolvePublicPackages()
      .map((entry) => entry.packageName)
      .sort(),
  );
});

test("every public package declares the supported Node floor", () => {
  const minimumSupportedNodeMajor = Math.min(
    ...summarizePublicInstallMatrix(readPublicInstallMatrix()).cells.map(
      (cell) => cell.nodeMajor,
    ),
  );
  assert.equal(
    rootManifest.engines?.node,
    `>=${minimumSupportedNodeMajor}.0.0`,
    "root Node floor must match the canonical install matrix",
  );
  for (const packageDefinition of resolvePublicPackages()) {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, packageDefinition.workingDirectory, "package.json"),
        "utf8",
      ),
    );
    assert.equal(
      manifest.engines?.node,
      rootManifest.engines?.node,
      manifest.name,
    );
  }
});

test("GitHub workflow executes the canonical support matrix", () => {
  const matrix = readPublicInstallMatrix();
  const workflow = parseYaml(
    fs.readFileSync(
      path.join(repoRoot, ".github/workflows/public-install-matrix.yml"),
      "utf8",
    ),
  );
  assert.deepEqual(workflow.jobs.verify.strategy.matrix.node, [22, 24]);
  assert.deepEqual(
    workflow.jobs.verify.strategy.matrix.system,
    matrix.support.operatingSystems.map((entry) => ({
      id: entry.id,
      runner: entry.githubRunner,
    })),
  );
  assert.match(
    workflow.jobs.verify.steps.find(
      (entry) => entry.name === "Verify public installation cell",
    ).run,
    /release install-matrix verify/u,
  );
  assert.match(
    workflow.jobs.aggregate.steps.find(
      (entry) => entry.name === "Aggregate exact matrix evidence",
    ).run,
    /release install-matrix aggregate/u,
  );
});

test("release install-matrix spec is discoverable as stable JSON", () => {
  const output = execFileSync(
    process.execPath,
    [cliPath, "release", "install-matrix", "spec", "--json"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const result = JSON.parse(output);
  assert.equal(result.contract, "air-jam-public-install-matrix/v1");
  assert.equal(result.cells.length, 6);
  assert.deepEqual(
    result.scaffold.resourceBudgets,
    readScaffoldResourceBudgets(),
  );
});

test("matrix evidence reads package-manager commands through the portable launcher", () => {
  assert.match(readCommandVersion("pnpm", ["--version"]), /^9\.9\.0$/u);
});

test("create-airjam ships the canonical scaffold resource budget contract", () => {
  const packageManifest = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "packages/create-airjam/package.json"),
      "utf8",
    ),
  );
  assert.ok(packageManifest.files.includes("scaffold-resource-budgets.json"));
  const budgets = readScaffoldResourceBudgets();
  assert.equal(budgets.schemaVersion, 1);
  assert.ok(budgets.archive.maxCompressedBytes > 0);
  assert.ok(budgets.archive.maxEntries > 0);
  assert.ok(budgets.archive.maxTotalUncompressedBytes > 0);
  assert.ok(budgets.archive.maxSingleFileUncompressedBytes > 0);
  assert.ok(budgets.archive.maxCompressionRatio > 0);
});

const createCellEvidence = ({ cell, commit = "a".repeat(40) }) => ({
  ok: true,
  contract: "air-jam-public-install-matrix-cell/v1",
  matrix: "air-jam-public-install-matrix",
  commit,
  candidate: {
    digest: "d".repeat(64),
  },
  cell,
  environment: {
    platform: cell.nodePlatform,
    architecture: "x64",
    node: `${cell.nodeMajor}.0.0`,
    pnpm: "9.9.0",
    npm: "11.0.0",
  },
  scaffoldResourceBudgets: readScaffoldResourceBudgets(),
  budgets: {
    packages: [],
    totalTarballBytes: { observed: 1, maximum: 2 },
    scaffoldInstallMs: { observed: 1, maximum: 2 },
    cellTotalMs: { observed: 1, maximum: 2 },
  },
  proof: {
    packageVersion: resolvePublicPackages()[0].version,
    registry: {
      published: resolvePublicPackages().map((entry) => ({
        name: entry.packageName,
        version: entry.version,
        sha256: "e".repeat(64),
        integrity: `sha512-${Buffer.from(entry.packageName).toString("base64")}`,
      })),
    },
    discovery: { mcpTools: ["airjam.inspect_project"] },
    quality: {
      typecheck: "passed",
      lint: "passed",
      tests: "passed",
      build: "passed",
    },
  },
});

test("matrix aggregation requires every cell at one exact commit", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "airjam-public-install-matrix-test-"),
  );
  try {
    const summary = summarizePublicInstallMatrix(readPublicInstallMatrix());
    for (const cell of summary.cells) {
      fs.writeFileSync(
        path.join(temporaryRoot, `${cell.id}.json`),
        JSON.stringify(createCellEvidence({ cell })),
      );
    }
    const result = aggregatePublicInstallMatrixEvidence({
      evidenceRoot: temporaryRoot,
    });
    assert.equal(result.ok, true);
    assert.equal(result.cells.length, 6);

    fs.rmSync(path.join(temporaryRoot, "windows-node-24.json"));
    assert.throws(
      () =>
        aggregatePublicInstallMatrixEvidence({
          evidenceRoot: temporaryRoot,
        }),
      /Missing: windows-node-24/u,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
