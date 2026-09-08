import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPlatformMigrationCatalog } from "../../platform/lib/platform-migration-catalog.mjs";
import { inspectPlatformMigrationDeploymentProvenance } from "../../platform/lib/platform-migration-deployment-provenance.mjs";

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
  assert.match(verifyHelp, /--deployed-revision/u);
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
  assert.throws(
    () =>
      inspectPlatformMigrationDeploymentProvenance({
        repoRoot: root,
        sourceCommit: "HEAD",
        deployedCommit,
      }),
    /full lowercase Git commit SHA/u,
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
