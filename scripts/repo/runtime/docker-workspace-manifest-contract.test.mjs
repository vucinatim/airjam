import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import { repoRoot } from "../lib/paths.mjs";

const workspaceConfigPath = path.join(repoRoot, "pnpm-workspace.yaml");
const rootPackageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const listDockerfiles = (rootDir, currentDir = rootDir) => {
  const files = [];
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listDockerfiles(rootDir, absolutePath));
    } else if (entry.isFile() && entry.name === "Dockerfile") {
      files.push(
        path.relative(rootDir, absolutePath).replaceAll(path.sep, "/"),
      );
    }
  }
  return files.sort();
};

const readManifestInstallStage = (dockerfile) => {
  const stages = dockerfile.split(/(?=^FROM\s)/mu).filter(Boolean);
  return (
    stages.find(
      (stage) =>
        stage.includes("pnpm install --frozen-lockfile") &&
        /^COPY\s+\S+\/package\.json\s+/mu.test(stage),
    ) ?? null
  );
};

const findMissingDependencyStageManifests = (stage, workspaceManifests) => {
  const installIndex = stage.indexOf("pnpm install --frozen-lockfile");
  assert.ok(installIndex >= 0, "dependency stage must run frozen pnpm install");

  return workspaceManifests.filter((manifest) => {
    const copy = new RegExp(
      `^COPY\\s+${escapeRegExp(manifest)}\\s+`,
      "mu",
    ).exec(stage);
    return !copy || copy.index >= installIndex;
  });
};

const readWorkspaceManifestPaths = () => {
  const config = parseYaml(fs.readFileSync(workspaceConfigPath, "utf8"));
  const patterns = config?.packages;
  assert.ok(Array.isArray(patterns), "pnpm-workspace.yaml must list packages");

  const excludedRoots = new Set(
    patterns
      .filter((pattern) => pattern.startsWith("!"))
      .map((pattern) => pattern.slice(1)),
  );
  const manifests = [];

  for (const pattern of patterns.filter((entry) => !entry.startsWith("!"))) {
    assert.match(
      pattern,
      /^[^*]+\/\*$/u,
      `Docker manifest validation does not understand workspace pattern ${pattern}`,
    );
    const parent = pattern.slice(0, -2);
    const parentPath = path.join(repoRoot, parent);
    for (const entry of fs.readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workspaceRoot = `${parent}/${entry.name}`;
      if (excludedRoots.has(workspaceRoot)) continue;
      const manifest = `${workspaceRoot}/package.json`;
      if (fs.existsSync(path.join(repoRoot, manifest)))
        manifests.push(manifest);
    }
  }

  return manifests.sort();
};

test("dependency-stage Dockerfiles copy every pnpm workspace manifest", () => {
  const workspaceManifests = readWorkspaceManifestPaths();
  assert.ok(workspaceManifests.length > 0, "pnpm workspace must not be empty");

  const dependencyStageDockerfiles = listDockerfiles(repoRoot).filter(
    (dockerfilePath) => {
      const source = fs.readFileSync(
        path.join(repoRoot, dockerfilePath),
        "utf8",
      );
      return readManifestInstallStage(source) !== null;
    },
  );
  assert.ok(
    dependencyStageDockerfiles.length > 0,
    "at least one Dockerfile must use a manifest-only dependency stage",
  );

  for (const dockerfilePath of dependencyStageDockerfiles) {
    const dockerfile = fs.readFileSync(
      path.join(repoRoot, dockerfilePath),
      "utf8",
    );
    const dependencyStage = readManifestInstallStage(dockerfile);
    assert.ok(dependencyStage, `${dockerfilePath} has no dependency stage`);
    const missing = findMissingDependencyStageManifests(
      dependencyStage,
      workspaceManifests,
    );

    assert.deepEqual(
      missing,
      [],
      `${dockerfilePath} would hide workspace dependencies from pnpm install`,
    );
  }
});

test("repository-owned Node base images meet the runtime floor", () => {
  const minimumNodeMajor = Number.parseInt(
    /^>=(\d+)/u.exec(rootPackageJson.engines?.node ?? "")?.[1] ?? "",
    10,
  );
  assert.ok(
    Number.isSafeInteger(minimumNodeMajor),
    "root package must declare an exact minimum Node major",
  );

  for (const dockerfilePath of listDockerfiles(repoRoot)) {
    const source = fs.readFileSync(path.join(repoRoot, dockerfilePath), "utf8");
    const configuredMajor = /^ARG NODE_IMAGE=node:(\d+)-/mu.exec(source)?.[1];
    if (!configuredMajor) continue;
    assert.ok(
      Number.parseInt(configuredMajor, 10) >= minimumNodeMajor,
      `${dockerfilePath} must meet the repository minimum Node major`,
    );
  }
});

test("production Docker cache mounts do not embed provider service identities", () => {
  for (const dockerfilePath of listDockerfiles(repoRoot)) {
    const source = fs.readFileSync(path.join(repoRoot, dockerfilePath), "utf8");
    assert.doesNotMatch(
      source,
      /--mount=type=cache,[^\n]*\bid=s\/[0-9a-f-]{36}/u,
      `${dockerfilePath} must remain reusable across provider services`,
    );
  }
});

test("workspace manifest copies after install do not satisfy the dependency contract", () => {
  const dockerfile = [
    "FROM node AS deps",
    "COPY packages/sdk/package.json ./packages/sdk/",
    "RUN pnpm install --frozen-lockfile",
    "COPY packages/database-contract/package.json ./packages/database-contract/",
    "FROM node AS runtime",
    "COPY --from=deps /app /app",
  ].join("\n");
  const dependencyStage = readManifestInstallStage(dockerfile);
  assert.ok(dependencyStage);
  assert.deepEqual(
    findMissingDependencyStageManifests(dependencyStage, [
      "packages/sdk/package.json",
      "packages/database-contract/package.json",
    ]),
    ["packages/database-contract/package.json"],
  );
});
