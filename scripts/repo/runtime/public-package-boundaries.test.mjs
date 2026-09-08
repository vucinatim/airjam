import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { generatePlatformAiPackArtifacts } from "../../platform/lib/platform-ai-pack-artifacts.mjs";
import { resolvePublicPackages } from "../../release/public-packages.mjs";
import { listLocalScaffoldDirectDependencyNames } from "../lib/local-scaffold-packages.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));

test("public package ownership has one canonical project CLI", () => {
  const cli = readJson("packages/cli/package.json");
  const createAirJam = readJson("packages/create-airjam/package.json");
  const server = readJson("packages/server/package.json");

  assert.deepEqual(cli.bin, { airjam: "./bin/airjam.mjs" });
  assert.deepEqual(Object.keys(cli.exports).sort(), [
    "./scaffold",
    "./vite-config",
  ]);
  assert.ok(cli.files.includes("template-assets"));
  assert.ok(cli.files.includes("runtime/local-network.mjs"));

  assert.deepEqual(createAirJam.bin, {
    "create-airjam": "./dist/index.js",
  });
  assert.ok(createAirJam.dependencies["@air-jam/cli"]);
  assert.ok(!createAirJam.files.includes("runtime"));
  assert.ok(!createAirJam.files.includes("template-assets"));

  assert.deepEqual(server.bin, {
    "air-jam-server": "./bin/air-jam-server.mjs",
  });
  assert.equal(server.exports, undefined);
  assert.equal(server.main, undefined);
  assert.equal(server.module, undefined);
});

test("shipped CLI runtime modules close over shipped relative imports", () => {
  const cli = readJson("packages/cli/package.json");
  const shippedFiles = new Set(cli.files);
  const runtimeEntries = [...shippedFiles].filter(
    (entry) => entry.startsWith("runtime/") && entry.endsWith(".mjs"),
  );

  for (const entry of runtimeEntries) {
    const source = fs.readFileSync(path.join(repoRoot, "packages/cli", entry), "utf8");
    for (const match of source.matchAll(/\bfrom\s+["'](\.\/[^"']+)["']/gu)) {
      const importedPath = path.posix.normalize(
        path.posix.join(path.posix.dirname(entry), match[1]),
      );
      assert.ok(
        shippedFiles.has(importedPath),
        `${entry} imports ${importedPath}, but the CLI package does not ship it`,
      );
    }
  }
});

test("obsolete project CLI implementations are fully removed", () => {
  for (const relativePath of [
    "packages/create-airjam/template-assets",
    "packages/server/src/project-cli",
    "packages/create-airjam/runtime/game-dev.mjs",
    "packages/create-airjam/runtime/runtime-env.mjs",
    "packages/create-airjam/runtime/topology.mjs",
    "packages/create-airjam/runtime/vite-config.mjs",
  ]) {
    assert.equal(
      fs.existsSync(path.join(repoRoot, relativePath)),
      false,
      `${relativePath} must not survive the ownership cut`,
    );
  }
});

test("raw SDK runtimes are isolated behind explicit expert subpaths", () => {
  const sdk = readJson("packages/sdk/package.json");
  const rootSource = fs.readFileSync(
    path.join(repoRoot, "packages/sdk/src/index.ts"),
    "utf8",
  );

  assert.ok(sdk.exports["./arcade/runtime"]);
  assert.ok(sdk.exports["./runtime-inspection"]);
  assert.doesNotMatch(rootSource, /host-runtime|controller-runtime/u);
  assert.doesNotMatch(rootSource, /arcade\/runtime/u);
  assert.doesNotMatch(rootSource, /runtime-inspection/u);
});

test("the canonical CLI participates in the public release set", () => {
  const releaseSource = fs.readFileSync(
    path.join(repoRoot, "scripts/release/public-packages.mjs"),
    "utf8",
  );
  assert.match(releaseSource, /packages\/cli/u);
});

test("public agent hosts share one canonical devtools-helper build", () => {
  for (const packagePath of [
    "packages/cli/package.json",
    "packages/mcp-server/package.json",
  ]) {
    const manifest = readJson(packagePath);
    assert.match(
      manifest.scripts.build,
      /scripts\/build-devtools-helpers\.mjs --out-dir dist\/tooling/u,
    );
    assert.ok(manifest.files.includes("dist"));
  }
  assert.equal(
    fs.existsSync(path.join(repoRoot, "packages/cli/tsup.tooling.config.ts")),
    false,
  );
});

test("the local candidate package set matches the public release graph", () => {
  assert.deepEqual(
    listLocalScaffoldDirectDependencyNames().sort(),
    resolvePublicPackages()
      .map((entry) => entry.packageName)
      .sort(),
  );
});

test("the public server bundles private workspace runtime dependencies", () => {
  const server = readJson("packages/server/package.json");
  const privateWorkspaceDependencies = Object.entries(server.dependencies ?? {})
    .filter(([, specifier]) => specifier.startsWith("workspace:"))
    .map(([dependencyName]) => dependencyName)
    .filter((dependencyName) => {
      const packageDirectory = dependencyName.replace("@air-jam/", "");
      const dependencyManifest = readJson(
        `packages/${packageDirectory}/package.json`,
      );
      return dependencyManifest.private === true;
    });
  const buildConfig = fs.readFileSync(
    path.join(repoRoot, "packages/server/tsup.config.ts"),
    "utf8",
  );

  assert.deepEqual(privateWorkspaceDependencies.sort(), [
    "@air-jam/database-contract",
    "@air-jam/operations-contract",
  ]);
  for (const dependencyName of privateWorkspaceDependencies) {
    assert.match(
      buildConfig,
      new RegExp(`noExternal:[\\s\\S]*["']${dependencyName}["']`, "u"),
      `${dependencyName} must be bundled because publish preparation removes private workspace dependencies`,
    );
  }
});

test("the canonical AI pack manifest is committed with the CLI assets", () => {
  const manifestPath =
    "packages/cli/template-assets/managed/.airjam/ai-pack.json";
  const trackedFiles = execFileSync(
    "git",
    ["ls-files", "--error-unmatch", manifestPath],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(trackedFiles.trim(), manifestPath);
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.packVersion, "0.1.0");
  assert.deepEqual(manifest.source, {
    mode: "packaged-snapshot",
    package: "@air-jam/cli",
  });
  assert.equal(manifest.update, undefined);
  assert.ok(manifest.managedFiles.length > 0);
  assert.match(manifest.contentDigest, /^[a-f0-9]{64}$/u);
});

test("the hosted AI pack is an exact read-only mirror, not a second manifest model", async () => {
  const targetRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "airjam-hosted-ai-pack-"),
  );
  try {
    const result = await generatePlatformAiPackArtifacts({ targetRoot });
    const packagedManifest = readJson(
      "packages/cli/template-assets/managed/.airjam/ai-pack.json",
    );
    const hostedManifest = JSON.parse(
      fs.readFileSync(path.join(targetRoot, "manifest.json"), "utf8"),
    );
    assert.deepEqual(hostedManifest, packagedManifest);
    assert.equal(result.contentDigest, packagedManifest.contentDigest);
    assert.equal(fs.existsSync(path.join(targetRoot, "stable")), false);
    for (const file of packagedManifest.managedFiles) {
      assert.equal(
        fs.readFileSync(path.join(targetRoot, "files", file.path), "utf8"),
        fs.readFileSync(
          path.join(
            repoRoot,
            "packages/cli/template-assets/managed",
            file.path,
          ),
          "utf8",
        ),
      );
    }
  } finally {
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
});
