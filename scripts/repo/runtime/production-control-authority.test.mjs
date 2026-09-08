import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepoSource = (path) =>
  readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

test("cost-creating platform work shares one production-control authority", async () => {
  const [
    releaseApplication,
    mediaApplication,
    workerAuthority,
    jobPolicy,
    telemetry,
    releaseRouter,
    mediaRouter,
    machineRelease,
    machineMedia,
  ] = await Promise.all([
    readRepoSource(
      "apps/platform/src/server/releases/release-application-service.ts",
    ),
    readRepoSource(
      "apps/platform/src/server/media/game-media-application-service.ts",
    ),
    readRepoSource(
      "apps/platform/src/server/jobs/operational-job-worker-authority.ts",
    ),
    readRepoSource("apps/platform/src/server/jobs/operational-job-policy.ts"),
    readRepoSource("apps/platform/src/server/product-telemetry/ingestion.ts"),
    readRepoSource("apps/platform/src/server/api/routers/release.ts"),
    readRepoSource("apps/platform/src/server/api/routers/game-media.ts"),
    readRepoSource("apps/platform/src/server/releases/machine-release.ts"),
    readRepoSource("apps/platform/src/server/games/machine-game-media.ts"),
  ]);

  for (const source of [releaseApplication, mediaApplication]) {
    assert.match(source, /production-control-service/u);
  }

  for (const lane of [
    "release_submission",
    "artifact_ingestion",
    "release_processing",
  ]) {
    assert.match(
      releaseApplication,
      new RegExp(`assertOperationalLaneAccepting\\(\\{ lane: "${lane}" \\}\\)`),
    );
  }
  assert.match(
    mediaApplication,
    /assertOperationalLaneAccepting\(\{ lane: "media_ingestion" \}\)/u,
  );
  assert.match(
    workerAuthority,
    /acquireOperationalLaneLock\(tx, policy\.lane\)/u,
  );
  assert.match(workerAuthority, /laneControl\?\.mode === "paused"/u);
  assert.match(jobPolicy, /lane: "browser_validation"/u);
  assert.match(jobPolicy, /lane: "moderation"/u);
  assert.match(
    telemetry,
    /assertOperationalLaneAccepting\(\{ lane: "product_telemetry" \}\)/u,
  );

  for (const transport of [
    releaseRouter,
    mediaRouter,
    machineRelease,
    machineMedia,
  ]) {
    assert.doesNotMatch(transport, /assertOperationalLaneAccepting/u);
  }
});

test("production controls have one persistent schema and one canonical CLI", async () => {
  const [
    databaseContract,
    laneMigration,
    budgetMigration,
    quotaLaneMigration,
    repoPlatformCommand,
    controlCli,
    budgetService,
    budgetRefreshService,
    railwayBudgetAdapter,
    budgetPolicy,
    quotaPolicy,
    quotaService,
  ] = await Promise.all([
    readRepoSource("packages/database-contract/src/index.ts"),
    readRepoSource("apps/platform/drizzle/0023_nappy_maria_hill.sql"),
    readRepoSource("apps/platform/drizzle/0024_white_deadpool.sql"),
    readRepoSource("apps/platform/drizzle/0025_majestic_selene.sql"),
    readRepoSource("scripts/repo/commands/platform.mjs"),
    readRepoSource("apps/platform/scripts/production-control-cli.ts"),
    readRepoSource(
      "apps/platform/src/server/operations/production-budget-service.ts",
    ),
    readRepoSource(
      "apps/platform/src/server/operations/production-budget-refresh-service.ts",
    ),
    readRepoSource(
      "apps/platform/src/server/operations/railway-budget-evidence-adapter.ts",
    ),
    readRepoSource(
      "apps/platform/src/server/operations/production-budget-policy.ts",
    ),
    readRepoSource(
      "apps/platform/src/server/operations/production-quota-policy.ts",
    ),
    readRepoSource(
      "apps/platform/src/server/operations/production-quota-service.ts",
    ),
  ]);

  for (const table of [
    "operational_lane_controls",
    "operational_control_events",
  ]) {
    assert.equal(
      databaseContract.match(new RegExp(`pgTable\\(\\s*"${table}"`, "gu"))
        ?.length,
      1,
      `${table} must have one shared declaration`,
    );
    assert.match(laneMigration, new RegExp(`"${table}"`, "u"));
  }
  for (const table of [
    "operational_budget_cycles",
    "operational_budget_evidence",
  ]) {
    assert.equal(
      databaseContract.match(new RegExp(`pgTable\\(\\s*"${table}"`, "gu"))
        ?.length,
      1,
      `${table} must have one shared declaration`,
    );
    assert.match(budgetMigration, new RegExp(`"${table}"`, "u"));
  }
  assert.doesNotMatch(laneMigration, /\$\d+/u);
  assert.doesNotMatch(budgetMigration, /\$\d+/u);
  assert.match(quotaLaneMigration, /'game_creation'/u);
  assert.match(quotaLaneMigration, /'game_listing'/u);
  assert.doesNotMatch(quotaLaneMigration, /\$\d+/u);
  assert.match(repoPlatformCommand, /\.command\("operations"\)/u);
  assert.match(repoPlatformCommand, /\.command\("budget"\)/u);
  assert.match(repoPlatformCommand, /\.command\("quota"\)/u);
  assert.match(repoPlatformCommand, /production-control-cli\.ts/u);
  assert.match(controlCli, /listOperationalLaneControls/u);
  assert.match(controlCli, /setOperationalLaneControl/u);
  assert.match(controlCli, /syncRailwayOperationalBudgetEvidence/u);
  assert.doesNotMatch(controlCli, /recordOperationalBudgetEvidence/u);
  assert.match(budgetRefreshService, /recordOperationalBudgetEvidence/u);
  assert.match(budgetRefreshService, /RailwayBudgetEvidenceCollector/u);
  assert.match(railwayBudgetAdapter, /RailwayBudgetEvidenceCollector/u);
  assert.match(controlCli, /listOperationalQuotaUsage/u);
  assert.match(controlCli, /decideOperationalQuotaAdmissionWithDatabase/u);
  assert.match(controlCli, /if \(!input\.apply\)/u);
  assert.match(budgetPolicy, /OPERATIONAL_BUDGET_POLICIES/u);
  assert.match(budgetPolicy, /resolveOperationalBudgetState/u);
  assert.match(budgetService, /normalizeOperationalBudgetEvidenceInput/u);
  assert.match(quotaPolicy, /OPERATIONAL_QUOTA_POLICIES/u);
  assert.match(quotaPolicy, /shadow_denied/u);
  assert.match(quotaService, /runtimeUsageGameSegments/u);
  assert.doesNotMatch(quotaPolicy, /process\.env/u);
  assert.doesNotMatch(quotaService, /productTelemetry/u);
  assert.doesNotMatch(budgetPolicy, /process\.env/u);
  assert.doesNotMatch(budgetService, /process\.env/u);
});
