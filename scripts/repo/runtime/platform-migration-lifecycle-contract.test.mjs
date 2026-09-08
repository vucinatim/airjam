import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPlatformMigrationCatalog } from "../../platform/lib/platform-migration-catalog.mjs";
import {
  assertPlatformMigrationPlanAuthority,
  inspectPlatformMigrationDeploymentProvenance,
  matchesPlatformMigrationApplicationDeploymentAuthority,
  matchesPlatformMigrationProductionOrigin,
} from "../../platform/lib/platform-migration-deployment-provenance.mjs";
import { resolveRailwayMigrationDeploymentAuthority } from "../lib/railway-deployment-authority.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

test("platform migration CLI exposes one inspect-plan-apply-verify lifecycle", () => {
  const help = execFileSync(
    process.execPath,
    ["scripts/repo/cli.mjs", "platform", "database", "migration", "--help"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.match(help, /inspect/);
  assert.match(help, /plan/);
  assert.match(help, /apply/);
  assert.match(help, /verify/);
  assert.match(help, /immutable plan/);

  const applyHelp = execFileSync(
    process.execPath,
    [
      "scripts/repo/cli.mjs",
      "platform",
      "database",
      "migration",
      "apply",
      "--help",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  for (const option of [
    "--plan",
    "--plan-digest",
    "--authority",
    "--actor",
    "--reason",
    "--idempotency-key",
    "--apply",
    "--railway-environment",
  ]) {
    assert.match(applyHelp, new RegExp(option));
  }

  const verifyHelp = execFileSync(
    process.execPath,
    [
      "scripts/repo/cli.mjs",
      "platform",
      "database",
      "migration",
      "verify",
      "--help",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.match(verifyHelp, /--deployment-id/u);
  assert.doesNotMatch(verifyHelp, /--deployed-revision/u);
});

test("production migration deployment authority composes provider and application identity", async () => {
  const databaseTarget = {
    kind: "railway",
    projectId: "project-production",
    environmentId: "environment-production",
    environmentName: "production",
  };
  const deployment = {
    id: "deployment-current",
    status: "SUCCESS",
    serviceId: "service-platform",
    environmentId: "environment-production",
    meta: { commitHash: "a".repeat(40) },
  };
  const environment = {
    id: "environment-production",
    name: "production",
    projectId: "project-production",
    serviceInstances: [
      {
        serviceId: "service-platform",
        latestDeployment: {
          id: "deployment-current",
          meta: { commitHash: "a".repeat(40) },
        },
      },
    ],
  };
  const providerAuthority = await resolveRailwayMigrationDeploymentAuthority(
    { databaseTarget, deploymentId: "deployment-current" },
    {
      client: {
        getDeployment: async () => deployment,
        getEnvironment: async () => environment,
      },
    },
  );
  assert.equal(providerAuthority.status, "verified");
  assert.equal(providerAuthority.revision, "a".repeat(40));
  assert.equal(
    matchesPlatformMigrationApplicationDeploymentAuthority({
      providerAuthority,
      applicationDeployment: {
        provider: "railway",
        environment: "production",
        deploymentId: "deployment-current",
        revision: null,
      },
    }),
    true,
  );
  assert.equal(
    matchesPlatformMigrationApplicationDeploymentAuthority({
      providerAuthority,
      applicationDeployment: {
        provider: "railway",
        environment: "production",
        deploymentId: "deployment-current",
        revision: "a".repeat(40),
      },
    }),
    true,
  );

  for (const applicationDeployment of [
    {
      provider: "railway",
      environment: "production",
      deploymentId: "deployment-other",
      revision: null,
    },
    {
      provider: "railway",
      environment: "production",
      deploymentId: "deployment-current",
      revision: "b".repeat(40),
    },
  ]) {
    assert.equal(
      matchesPlatformMigrationApplicationDeploymentAuthority({
        providerAuthority,
        applicationDeployment,
      }),
      false,
    );
  }

  const staleProvider = await resolveRailwayMigrationDeploymentAuthority(
    { databaseTarget, deploymentId: "deployment-current" },
    {
      client: {
        getDeployment: async () => deployment,
        getEnvironment: async () => ({
          ...environment,
          serviceInstances: [
            {
              serviceId: "service-platform",
              latestDeployment: {
                id: "deployment-newer",
                meta: { commitHash: "b".repeat(40) },
              },
            },
          ],
        }),
      },
    },
  );
  assert.equal(staleProvider.status, "mismatch");
  assert.equal(
    matchesPlatformMigrationApplicationDeploymentAuthority({
      providerAuthority: staleProvider,
      applicationDeployment: {
        provider: "railway",
        environment: "production",
        deploymentId: "deployment-current",
        revision: null,
      },
    }),
    false,
  );

  for (const override of [
    {
      deployment: { ...deployment, status: "FAILED" },
      environment,
    },
    {
      deployment: {
        ...deployment,
        environmentId: "environment-other",
      },
      environment,
    },
    {
      deployment: { ...deployment, meta: {} },
      environment,
    },
    {
      deployment,
      environment: { ...environment, projectId: "project-other" },
    },
  ]) {
    assert.equal(
      (
        await resolveRailwayMigrationDeploymentAuthority(
          { databaseTarget, deploymentId: "deployment-current" },
          {
            client: {
              getDeployment: async () => override.deployment,
              getEnvironment: async () => override.environment,
            },
          },
        )
      ).status,
      "mismatch",
    );
  }

  const providerFailure = await resolveRailwayMigrationDeploymentAuthority(
    { databaseTarget, deploymentId: "deployment-current" },
    {
      client: {
        getDeployment: async () => {
          throw new Error("provider unavailable");
        },
        getEnvironment: async () => environment,
      },
    },
  );
  assert.equal(providerFailure.status, "failed");
  assert.equal(providerFailure.failureCode, "provider_request_failed");
  assert.match(providerFailure.reason, /provider unavailable/u);

  const unsupported = await resolveRailwayMigrationDeploymentAuthority(
    {
      databaseTarget: { kind: "unclassified" },
      deploymentId: "deployment-current",
    },
    { client: {} },
  );
  assert.equal(unsupported.status, "failed");
  assert.equal(unsupported.failureCode, "unsupported_target");
});

test("production migration planning refuses unverifiable targets and missing provider credentials", () => {
  assert.throws(
    () =>
      assertPlatformMigrationPlanAuthority({
        authority: "production",
        databaseTarget: { kind: "unclassified" },
        providerCredentialsAvailable: true,
      }),
    /provider-attested Railway target/u,
  );
  assert.throws(
    () =>
      assertPlatformMigrationPlanAuthority({
        authority: "local",
        databaseTarget: {
          kind: "railway",
          environmentName: "production",
        },
        providerCredentialsAvailable: true,
      }),
    /requires --authority production/u,
  );
  assert.throws(
    () =>
      assertPlatformMigrationPlanAuthority({
        authority: "production",
        databaseTarget: {
          kind: "railway",
          environmentName: "production",
        },
        providerCredentialsAvailable: false,
      }),
    /RAILWAY_PROJECT_TOKEN/u,
  );
  assert.doesNotThrow(() =>
    assertPlatformMigrationPlanAuthority({
      authority: "production",
      databaseTarget: {
        kind: "railway",
        environmentName: "production",
      },
      providerCredentialsAvailable: true,
    }),
  );
  assert.doesNotThrow(() =>
    assertPlatformMigrationPlanAuthority({
      authority: "local",
      databaseTarget: { kind: "local" },
      providerCredentialsAvailable: false,
    }),
  );
});

test("deployment provenance accepts an exact reviewed tree wrapped by a merge commit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "airjam-migration-git-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Air Jam Test");
  git("config", "user.email", "test@airjam.invalid");
  fs.writeFileSync(path.join(root, "contract.txt"), "base\n");
  git("add", "contract.txt");
  git("commit", "--quiet", "-m", "base");
  const baseCommit = git("rev-parse", "HEAD");
  git("switch", "--quiet", "-c", "reviewed");
  fs.writeFileSync(path.join(root, "contract.txt"), "reviewed\n");
  git("add", "contract.txt");
  git("commit", "--quiet", "-m", "reviewed");
  const sourceCommit = git("rev-parse", "HEAD");
  git("switch", "--quiet", "main");
  git("merge", "--quiet", "--no-ff", "reviewed", "-m", "merge reviewed");
  const deployedCommit = git("rev-parse", "HEAD");

  const accepted = inspectPlatformMigrationDeploymentProvenance({
    repoRoot: root,
    sourceCommit,
    deployedCommit,
  });
  assert.equal(accepted.sourceIsAncestor, true);
  assert.equal(accepted.treesMatch, true);

  fs.writeFileSync(path.join(root, "unreviewed.txt"), "later\n");
  git("add", "unreviewed.txt");
  git("commit", "--quiet", "-m", "later change");
  const changedCommit = git("rev-parse", "HEAD");
  const rejected = inspectPlatformMigrationDeploymentProvenance({
    repoRoot: root,
    sourceCommit,
    deployedCommit: changedCommit,
  });
  assert.equal(rejected.sourceIsAncestor, true);
  assert.equal(rejected.treesMatch, false);

  git("switch", "--quiet", "-c", "sibling", baseCommit);
  fs.writeFileSync(path.join(root, "contract.txt"), "reviewed\n");
  git("add", "contract.txt");
  git("commit", "--quiet", "-m", "sibling with identical tree");
  const siblingCommit = git("rev-parse", "HEAD");
  const unrelated = inspectPlatformMigrationDeploymentProvenance({
    repoRoot: root,
    sourceCommit,
    deployedCommit: siblingCommit,
  });
  assert.equal(unrelated.treesMatch, true);
  assert.equal(unrelated.sourceIsAncestor, false);

  assert.throws(
    () =>
      inspectPlatformMigrationDeploymentProvenance({
        repoRoot: root,
        sourceCommit: "HEAD",
        deployedCommit,
      }),
    /full lowercase Git commit SHA/u,
  );
  assert.throws(
    () =>
      inspectPlatformMigrationDeploymentProvenance({
        repoRoot: root,
        sourceCommit,
        deployedCommit: "0".repeat(40),
      }),
    /Deployed revision .* is not present locally/u,
  );
});

test("production migration origin authority rejects preview and mismatched origins", () => {
  const base = {
    platformOrigin: "https://airjam.io",
    requestPolicy: {
      platformPublicOrigin: "https://airjam.io",
      isRailwayPreviewEnvironment: false,
    },
  };
  assert.equal(matchesPlatformMigrationProductionOrigin(base), true);
  assert.equal(
    matchesPlatformMigrationProductionOrigin({
      ...base,
      requestPolicy: {
        ...base.requestPolicy,
        isRailwayPreviewEnvironment: true,
      },
    }),
    false,
  );
  assert.equal(
    matchesPlatformMigrationProductionOrigin({
      ...base,
      platformOrigin: "https://preview.example",
    }),
    false,
  );
});

test("new migrations require explicit mode and verification policy", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "airjam-migration-catalog-"),
  );
  fs.mkdirSync(path.join(root, "meta"));
  fs.writeFileSync(
    path.join(root, "meta/_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: Array.from({ length: 37 }, (_, idx) => ({
        idx,
        when: idx + 1,
        tag: String(idx).padStart(4, "0") + "_migration",
        breakpoints: true,
      })),
    }),
  );
  for (let idx = 0; idx < 37; idx += 1) {
    fs.writeFileSync(
      path.join(root, `${String(idx).padStart(4, "0")}_migration.sql`),
      idx === 36
        ? "create table policy_required(id text);\n"
        : `select ${idx};\n`,
    );
  }
  assert.throws(
    () => readPlatformMigrationCatalog({ migrationsRoot: root }),
    /must declare exactly one.*migration-mode/u,
  );
  fs.writeFileSync(
    path.join(root, "0036_migration.sql"),
    "-- airjam:migration-mode=operational_lanes\n-- airjam:affected-lanes=release_processing\n-- airjam:verify=table:policy_required\ncreate table policy_required(id text);\n",
  );
  const catalog = readPlatformMigrationCatalog({
    migrationsRoot: root,
    allowedOperationalLanes: ["release_processing"],
  });
  assert.deepEqual(catalog.head.affectedLanes, ["release_processing"]);
  assert.deepEqual(catalog.head.verificationChecks, ["table:policy_required"]);

  const journalPath = path.join(root, "meta/_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  journal.entries[35].when = 100;
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  assert.throws(
    () => readPlatformMigrationCatalog({ migrationsRoot: root }),
    /must have a newer timestamp than the preceding journal entry/u,
  );
});
