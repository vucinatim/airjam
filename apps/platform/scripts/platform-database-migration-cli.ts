import { db, platformDatabaseClient } from "@/db";
import { operationalJobs } from "@/db/schema";
import { acquirePlatformSchemaMigrationLock } from "@/server/operations/platform-schema-migration-lock";
import {
  beginPlatformSchemaMigrationRun,
  getPlatformSchemaMigrationRun,
  markPlatformSchemaMigrationApplied,
  markPlatformSchemaMigrationApplyFailed,
  markPlatformSchemaMigrationVerificationFailed,
  markPlatformSchemaMigrationVerified,
  restartFailedPlatformSchemaMigrationRun,
} from "@/server/operations/platform-schema-migration-run-service";
import {
  getOperationalLaneControl,
  setOperationalLaneControl,
} from "@/server/operations/production-control-service";
import type {
  OperationalLane,
  OperationalLaneControlSnapshot,
} from "@air-jam/database-contract";
import { operationalLaneValues } from "@air-jam/database-contract";
import { and, sql as drizzleSql, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  parsePlatformOrigin,
  parseRemoteReleaseOriginReadiness,
} from "./release-origin-attestation";

// This is a Node-owned source contract shared by generation and the operator.
import {
  canonicalJson,
  digestCanonicalJson,
  readPlatformMigrationCatalog,
} from "../../../scripts/platform/lib/platform-migration-catalog.mjs";
import {
  assertPlatformMigrationPlanAuthority,
  inspectPlatformMigrationDeploymentProvenance,
  matchesPlatformMigrationApplicationDeploymentAuthority,
  matchesPlatformMigrationProductionOrigin,
} from "../../../scripts/platform/lib/platform-migration-deployment-provenance.mjs";
import {
  railwayDeploymentAuthorityCredentialsAvailable,
  resolveRailwayMigrationDeploymentAuthority,
} from "../../../scripts/repo/lib/railway-deployment-authority.mjs";
import {
  createPlatformDatabaseDump,
  platformBackupContractVersion,
  readPlatformDatabaseIdentity,
  sha256File,
  type PlatformBackupEvidence,
  type PlatformDatabaseTarget,
} from "./lib/platform-postgres-tooling";

const contractVersion = 1 as const;
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const migrationsRoot = path.join(repoRoot, "apps/platform/drizzle");
const operationsRoot = path.join(
  repoRoot,
  ".airjam/operations/database-migrations",
);
type Operation = {
  command: "inspect" | "backup" | "plan" | "apply" | "verify";
  target: PlatformDatabaseTarget;
  json?: boolean;
  output?: string;
  plan?: string;
  planDigest?: string;
  authority?: "local" | "production";
  actor?: string;
  reason?: string;
  idempotencyKey?: string;
  platformUrl?: string;
  deploymentId?: string;
  apply?: boolean;
  drainTimeoutSeconds?: number;
};

type CatalogEntry = {
  index: number;
  tag: string;
  createdAt: number;
  hash: string;
  mode: "legacy" | "online" | "operational_lanes" | "exclusive";
  affectedLanes: string[];
  verificationChecks: string[];
};

type Catalog = {
  contractVersion: number;
  digest: string;
  policyRequiredAfterIndex: number;
  entries: CatalogEntry[];
  head: CatalogEntry;
};

type Inspection = Awaited<ReturnType<typeof inspectDatabase>>;
type DatabaseIdentity = Inspection["target"];
type CompletePlatformBackupEvidence = PlatformBackupEvidence & {
  manifestPath: string;
  manifestSha256: string;
};
type MigrationPlan = {
  contractVersion: number;
  command: "platform.database.migration";
  createdAt: string;
  authority: "local" | "production";
  source: { commit: string; catalogDigest: string; head: CatalogEntry };
  target: DatabaseIdentity;
  before: {
    status: Inspection["status"];
    observed: Inspection["observed"];
    appliedCount: number;
  };
  pending: CatalogEntry[];
  drain: {
    affectedLanes: OperationalLane[];
    laneControls: OperationalLaneControlSnapshot[];
  };
  verificationChecks: string[];
  backup: CompletePlatformBackupEvidence;
  digest: string;
};
type MigrationRun = NonNullable<
  Awaited<ReturnType<typeof getPlatformSchemaMigrationRun>>
>;

const requireText = (value: string | undefined, label: string) => {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
};

const git = (...args: string[]) => {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed.`);
  }
  return result.stdout.trim();
};

const sourceIdentity = () => ({
  commit: git("rev-parse", "HEAD"),
  clean: git("status", "--porcelain").length === 0,
});

const inspectDatabase = async ({
  client,
  catalog,
  target,
}: {
  client: ReturnType<typeof postgres>;
  catalog: Catalog;
  target: PlatformDatabaseTarget;
}) => {
  const [relation] = await client<{ relation: string | null }[]>`
    select to_regclass('drizzle.__drizzle_migrations')::text as relation
  `;
  const applied = relation?.relation
    ? await client<{ id: number; hash: string; created_at: string }[]>`
        select id, hash, created_at::text
        from drizzle.__drizzle_migrations
        order by created_at asc, id asc
      `
    : [];
  const knownByTimestamp = new Map(
    catalog.entries.map((entry) => [String(entry.createdAt), entry]),
  );
  const unknown = applied.filter((row) => {
    const expected = knownByTimestamp.get(row.created_at);
    return !expected || expected.hash !== row.hash;
  });
  const appliedTimestamps = new Set(applied.map((row) => row.created_at));
  const pending = catalog.entries.filter(
    (entry) => !appliedTimestamps.has(String(entry.createdAt)),
  );
  const observed = applied.at(-1) ?? null;
  const blockedPending = observed
    ? pending.filter((entry) => entry.createdAt <= Number(observed.created_at))
    : [];
  let status: "ready" | "behind" | "missing_journal" | "drifted" | "ahead";
  if (!relation?.relation) status = "missing_journal";
  else if (observed && Number(observed.created_at) > catalog.head.createdAt)
    status = "ahead";
  else if (unknown.length > 0 || blockedPending.length > 0) status = "drifted";
  else if (pending.length > 0) status = "behind";
  else status = "ready";
  return {
    contractVersion,
    status,
    compatible: status === "ready",
    target: await readPlatformDatabaseIdentity(client, target),
    source: {
      catalogDigest: catalog.digest,
      head: catalog.head,
    },
    observed: observed
      ? { createdAt: Number(observed.created_at), hash: observed.hash }
      : null,
    appliedCount: applied.length,
    pending,
    blockedPending,
    unknown: unknown.map((row) => ({
      createdAt: Number(row.created_at),
      hash: row.hash,
    })),
  };
};

const outputPath = (candidate: string | undefined, fallback: string) =>
  path.resolve(repoRoot, candidate ?? path.join(operationsRoot, fallback));

const runBackup = async ({
  client,
  databaseUrl,
  inspection,
  output,
}: {
  client: ReturnType<typeof postgres>;
  databaseUrl: string;
  inspection: Inspection;
  output?: string;
}): Promise<CompletePlatformBackupEvidence> => {
  mkdirSync(operationsRoot, { recursive: true, mode: 0o700 });
  chmodSync(operationsRoot, 0o700);
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const dumpPath = outputPath(
    output,
    `platform-${inspection.target.fingerprint.slice(0, 12)}-${timestamp}.dump`,
  );
  mkdirSync(path.dirname(dumpPath), { recursive: true });
  if (existsSync(dumpPath) || existsSync(`${dumpPath}.json`)) {
    throw new Error(
      "Backup output already exists; choose a new artifact path.",
    );
  }
  const recoverySnapshot = await createPlatformDatabaseDump({
    client,
    databaseUrl,
    dumpPath,
    schemaHead: inspection.observed,
  });
  chmodSync(dumpPath, 0o600);
  const evidence = {
    contractVersion: platformBackupContractVersion,
    createdAt: new Date().toISOString(),
    targetFingerprint: inspection.target.fingerprint,
    sourceDatabase: inspection.target,
    schemaHead: inspection.observed,
    recoverySnapshot,
    artifact: {
      path: path.relative(repoRoot, dumpPath),
      sha256: await sha256File(dumpPath),
      sizeBytes: statSync(dumpPath).size,
      format: "postgres-custom" as const,
    },
  };
  const manifestPath = `${dumpPath}.json`;
  writeFileSync(manifestPath, `${canonicalJson(evidence)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    ...evidence,
    manifestPath: path.relative(repoRoot, manifestPath),
    manifestSha256: await sha256File(manifestPath),
  };
};

const readPlan = (filePath: string) => {
  const absolutePath = path.resolve(repoRoot, filePath);
  const candidate = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !("digest" in candidate) ||
    typeof candidate.digest !== "string" ||
    !("command" in candidate) ||
    candidate.command !== "platform.database.migration"
  ) {
    throw new Error("Migration plan document has an unsupported shape.");
  }
  const plan = candidate as MigrationPlan;
  const { digest, ...unsigned } = plan;
  const calculated = digestCanonicalJson(unsigned);
  if (digest !== calculated)
    throw new Error("Migration plan digest is invalid.");
  return { plan, absolutePath, digest: calculated };
};

const validateBackup = async (backup: CompletePlatformBackupEvidence) => {
  const manifestPath = path.resolve(repoRoot, backup.manifestPath);
  const artifactPath = path.resolve(repoRoot, backup.artifact.path);
  if (!existsSync(manifestPath) || !existsSync(artifactPath)) {
    throw new Error("Migration backup evidence is missing.");
  }
  if ((await sha256File(manifestPath)) !== backup.manifestSha256) {
    throw new Error("Migration backup manifest digest changed.");
  }
  if ((await sha256File(artifactPath)) !== backup.artifact.sha256) {
    throw new Error("Migration backup artifact digest changed.");
  }
};

const verifyChecks = async (
  client: ReturnType<typeof postgres>,
  checks: string[],
) => {
  const results = [];
  for (const check of [...new Set(checks)]) {
    const [kind, identity] = check.split(":", 2);
    let passed = false;
    if (kind === "table" || kind === "index") {
      const [row] = await client<{ relation: string | null }[]>`
        select to_regclass(${`public.${identity}`})::text as relation
      `;
      passed = Boolean(row?.relation);
    } else if (kind === "constraint") {
      const [tableName, constraintName] = identity.split(".", 2);
      const [row] = await client<{ exists: boolean }[]>`
        select exists(
          select 1 from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
          where n.nspname = 'public'
            and t.relname = ${tableName}
            and c.conname = ${constraintName}
        ) as exists
      `;
      passed = row?.exists === true;
    }
    results.push({ check, passed });
  }
  return results;
};

const writePlan = async ({
  catalog,
  client,
  databaseUrl,
  operation,
  inspection,
}: {
  catalog: Catalog;
  client: ReturnType<typeof postgres>;
  databaseUrl: string;
  operation: Operation;
  inspection: Inspection;
}) => {
  if (inspection.status === "ready") {
    return { contractVersion, status: "no_changes", inspection };
  }
  if (inspection.status !== "behind") {
    throw new Error(`Cannot plan from database state ${inspection.status}.`);
  }
  const authority = operation.authority ?? "local";
  assertPlatformMigrationPlanAuthority({
    authority,
    databaseTarget: inspection.target.target,
    providerCredentialsAvailable:
      railwayDeploymentAuthorityCredentialsAvailable(),
  });
  const source = sourceIdentity();
  if (authority === "production" && !source.clean) {
    throw new Error(
      "Production migration plans require a clean source commit.",
    );
  }
  if (
    authority === "production" &&
    inspection.pending.some(
      (entry) => entry.mode === "legacy" || entry.mode === "exclusive",
    )
  ) {
    throw new Error(
      "Production cannot apply legacy or exclusive migrations; redesign the migration into online or operational-lane phases.",
    );
  }
  const affectedLanes = [
    ...new Set(inspection.pending.flatMap((entry) => entry.affectedLanes)),
  ] as OperationalLane[];
  const laneControls = await Promise.all(
    affectedLanes.map((lane) => getOperationalLaneControl({ lane })),
  );
  const backup = await runBackup({
    client,
    databaseUrl,
    inspection,
  });
  const unsigned = {
    contractVersion,
    command: "platform.database.migration" as const,
    createdAt: new Date().toISOString(),
    authority,
    source: {
      commit: source.commit,
      catalogDigest: catalog.digest,
      head: catalog.head,
    },
    target: inspection.target,
    before: {
      status: inspection.status,
      observed: inspection.observed,
      appliedCount: inspection.appliedCount,
    },
    pending: inspection.pending,
    drain: { affectedLanes, laneControls },
    verificationChecks: inspection.pending.flatMap(
      (entry) => entry.verificationChecks,
    ),
    backup,
  };
  const digest = digestCanonicalJson(unsigned);
  const plan: MigrationPlan = { ...unsigned, digest };
  const planPath = outputPath(
    operation.output,
    `plan-${source.commit.slice(0, 12)}-${digest.slice(0, 12)}.json`,
  );
  mkdirSync(path.dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${canonicalJson(plan)}\n`, { flag: "wx" });
  return {
    contractVersion,
    status: "planned",
    planPath: path.relative(repoRoot, planPath),
    planDigest: digest,
    plan,
  };
};

const assertPlanMatches = async ({
  plan,
  expectedDigest,
  inspection,
  catalog,
  operation,
}: {
  plan: MigrationPlan;
  expectedDigest: string;
  inspection: Inspection;
  catalog: Catalog;
  operation: Operation;
}) => {
  if (operation.planDigest !== expectedDigest) {
    throw new Error("--plan-digest must exactly match the plan document.");
  }
  if (operation.authority !== plan.authority) {
    throw new Error("--authority must exactly match the migration plan.");
  }
  if (plan.source.catalogDigest !== catalog.digest) {
    throw new Error("Migration catalog changed after the plan was created.");
  }
  const currentSource = sourceIdentity();
  const provenance = inspectPlatformMigrationDeploymentProvenance({
    repoRoot,
    sourceCommit: plan.source.commit,
    deployedCommit: currentSource.commit,
  });
  if (!provenance.sourceIsAncestor || !provenance.treesMatch) {
    throw new Error(
      "Current source does not contain the planned commit with an identical tree.",
    );
  }
  if (inspection.target.fingerprint !== plan.target.fingerprint) {
    throw new Error("Database target fingerprint does not match the plan.");
  }
  await validateBackup(plan.backup);
};

const pauseLanes = async ({
  plan,
  actor,
  reason,
  idempotencyKey,
}: {
  plan: MigrationPlan;
  actor: string;
  reason: string;
  idempotencyKey: string;
}) => {
  const paused: Array<{
    previous: OperationalLaneControlSnapshot;
    current: OperationalLaneControlSnapshot;
  }> = [];
  for (const previous of plan.drain
    .laneControls as OperationalLaneControlSnapshot[]) {
    if (previous.mode === "paused") {
      const observed = await getOperationalLaneControl({ lane: previous.lane });
      if (
        observed.revision !== previous.revision ||
        observed.mode !== previous.mode ||
        observed.retryAfterSeconds !== previous.retryAfterSeconds
      ) {
        throw new Error(
          `Lane ${previous.lane} changed after planning; inspect and create a new plan.`,
        );
      }
      paused.push({ previous, current: observed });
      continue;
    }
    const current = await setOperationalLaneControl({
      input: {
        lane: previous.lane,
        mode: "paused",
        reason: `Schema migration ${plan.digest}: ${reason}`,
        retryAfterSeconds: 60,
        expectedRevision: previous.revision,
        actor,
        idempotencyKey: `${idempotencyKey}:pause:${previous.lane}`,
      },
    });
    paused.push({ previous, current });
  }
  return paused;
};

const waitForLaneDrain = async (
  lanes: OperationalLane[],
  timeoutSeconds: number,
) => {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (true) {
    const rows = lanes.length
      ? await db
          .select({ id: operationalJobs.id, lane: operationalJobs.lane })
          .from(operationalJobs)
          .where(
            and(
              inArray(operationalJobs.lane, lanes),
              inArray(operationalJobs.status, ["running", "cancel_requested"]),
              drizzleSql`${operationalJobs.leaseExpiresAt} > now()`,
              drizzleSql`${operationalJobs.deadlineAt} > now()`,
            ),
          )
      : [];
    if (rows.length === 0)
      return { drainedAt: new Date().toISOString(), jobs: [] };
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out draining ${rows.length} active operational job(s): ${rows.map((row) => row.id).join(", ")}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
};

const migrationRunExists = async (client: ReturnType<typeof postgres>) => {
  const [row] = await client<{ relation: string | null }[]>`
    select to_regclass('public.platform_schema_migration_runs')::text as relation
  `;
  return Boolean(row?.relation);
};

const recordRun = async ({
  plan,
  actor,
  reason,
  idempotencyKey,
  drainEvidence,
}: {
  plan: MigrationPlan;
  actor: string;
  reason: string;
  idempotencyKey: string;
  drainEvidence: Record<string, unknown>;
}) => {
  return beginPlatformSchemaMigrationRun({
    input: {
      id: randomUUID(),
      planDigest: plan.digest,
      idempotencyKey,
      targetFingerprint: plan.target.fingerprint,
      sourceCommit: plan.source.commit,
      sourceHeadTag: plan.source.head.tag,
      sourceHeadCreatedAt: plan.source.head.createdAt,
      sourceHeadHash: plan.source.head.hash,
      actor,
      reason,
      plan,
      backupEvidence: plan.backup,
      drainEvidence,
    },
  });
};

const applyPlanWithLockHeld = async ({
  operation,
  client,
  catalog,
  inspection,
}: {
  operation: Operation;
  client: ReturnType<typeof postgres>;
  catalog: Catalog;
  inspection: Inspection;
}) => {
  if (!operation.apply) throw new Error("Migration apply requires --apply.");
  const actor = requireText(operation.actor, "Actor");
  const reason = requireText(operation.reason, "Reason");
  const idempotencyKey = requireText(
    operation.idempotencyKey,
    "Idempotency key",
  );
  const { plan, digest } = readPlan(requireText(operation.plan, "Plan path"));
  assertPlatformMigrationPlanAuthority({
    authority: plan.authority,
    databaseTarget: plan.target.target,
    providerCredentialsAvailable:
      railwayDeploymentAuthorityCredentialsAvailable(),
  });
  const existing = await getPlatformSchemaMigrationRun({
    planDigest: digest,
  }).catch(() => null);
  await assertPlanMatches({
    plan,
    expectedDigest: digest,
    inspection,
    catalog,
    operation,
  });
  if (existing && existing.idempotencyKey !== idempotencyKey) {
    throw new Error(
      "Migration plan already belongs to a different idempotency key.",
    );
  }
  const atPlannedHead =
    canonicalJson(inspection.observed) === canonicalJson(plan.before.observed);
  const atAppliedHead = inspection.compatible;
  if (!atPlannedHead && !atAppliedHead) {
    throw new Error("Database schema changed after the plan was created.");
  }
  if (
    atPlannedHead &&
    (inspection.status !== plan.before.status ||
      inspection.unknown.length > 0 ||
      inspection.appliedCount !== plan.before.appliedCount)
  ) {
    throw new Error(
      "Database migration history changed after the plan was created.",
    );
  }
  if (existing?.status === "applied" || existing?.status === "verified") {
    if (!atAppliedHead) {
      throw new Error(
        "Recorded migration run no longer matches the database schema head.",
      );
    }
    const checks = await verifyChecks(client, plan.verificationChecks);
    if (checks.some((check) => !check.passed)) {
      throw new Error(
        "Recorded migration run no longer passes database verification.",
      );
    }
    return {
      contractVersion,
      status: existing.status,
      replayed: true,
      run: existing,
      inspection,
      checks,
    };
  }
  if (existing && atAppliedHead) {
    const checks = await verifyChecks(client, plan.verificationChecks);
    if (checks.some((check) => !check.passed)) {
      throw new Error(
        "Applied migration replay failed database verification; affected lanes remain paused.",
      );
    }
    const run = await markPlatformSchemaMigrationApplied({
      planDigest: digest,
      appliedAt: existing.appliedAt ?? new Date(),
    });
    return {
      contractVersion,
      status: "applied",
      replayed: true,
      run,
      inspection,
      checks,
      next: "Deploy the reviewed source tree, then verify its exact production revision.",
    };
  }
  const paused = await pauseLanes({ plan, actor, reason, idempotencyKey });
  const drained = await waitForLaneDrain(
    plan.drain.affectedLanes,
    operation.drainTimeoutSeconds ?? 300,
  );
  const drainEvidence = { paused, ...drained };
  if (!existing && atAppliedHead) {
    await recordRun({ plan, actor, reason, idempotencyKey, drainEvidence });
    const checks = await verifyChecks(client, plan.verificationChecks);
    if (checks.some((check) => !check.passed)) {
      throw new Error(
        "Recovered migration application failed database verification; affected lanes remain paused.",
      );
    }
    const run = await markPlatformSchemaMigrationApplied({
      planDigest: digest,
    });
    return {
      contractVersion,
      status: "applied",
      replayed: true,
      recovered: true,
      run,
      inspection,
      checks,
      next: "Deploy the reviewed source tree, then verify its exact production revision.",
    };
  }
  const tableExisted = await migrationRunExists(client);
  if (tableExisted) {
    const run = await recordRun({
      plan,
      actor,
      reason,
      idempotencyKey,
      drainEvidence,
    });
    if (run.status === "apply_failed") {
      await restartFailedPlatformSchemaMigrationRun({ planDigest: digest });
    }
  }
  let after: Inspection;
  let checks: Array<{ check: string; passed: boolean }>;
  try {
    await migrate(drizzle(client), { migrationsFolder: migrationsRoot });
    if (!tableExisted) {
      await recordRun({ plan, actor, reason, idempotencyKey, drainEvidence });
    }
    after = await inspectDatabase({
      client,
      catalog,
      target: operation.target,
    });
    checks = await verifyChecks(client, plan.verificationChecks);
    if (!after.compatible || checks.some((check) => !check.passed)) {
      const verification = {
        failedAt: new Date().toISOString(),
        phase: "post_apply_database_verification",
        inspection: after,
        checks,
      };
      await markPlatformSchemaMigrationVerificationFailed({
        planDigest: digest,
        verification,
      });
      throw new Error(
        "Post-migration database verification failed; affected lanes remain paused.",
      );
    }
  } catch (error) {
    const tableAvailable = await migrationRunExists(client).catch(() => false);
    if (tableAvailable) {
      const current = await getPlatformSchemaMigrationRun({
        planDigest: digest,
      });
      if (current?.status === "applying") {
        await markPlatformSchemaMigrationApplyFailed({
          planDigest: digest,
          verification: {
            failedAt: new Date().toISOString(),
            phase: "migration_apply",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    throw error;
  }
  const run = await markPlatformSchemaMigrationApplied({
    planDigest: digest,
  });
  return {
    contractVersion,
    status: "applied",
    replayed: false,
    run,
    inspection: after,
    checks,
    next: "Deploy the reviewed source tree, then verify its exact production revision.",
  };
};

const applyPlan = async ({
  operation,
  client,
  catalog,
}: {
  operation: Operation;
  client: ReturnType<typeof postgres>;
  catalog: Catalog;
}) => {
  const releaseLock = await acquirePlatformSchemaMigrationLock();
  try {
    const inspection = await inspectDatabase({
      client,
      catalog,
      target: operation.target,
    });
    return await applyPlanWithLockHeld({
      operation,
      client,
      catalog,
      inspection,
    });
  } finally {
    await releaseLock();
  }
};

const restoreLanes = async ({
  plan,
  run,
  actor,
}: {
  plan: MigrationPlan;
  run: MigrationRun;
  actor: string;
}) => {
  const evidence = run.drainEvidence as {
    paused: Array<{
      previous: OperationalLaneControlSnapshot;
      current: OperationalLaneControlSnapshot;
    }>;
  };
  const restored = [];
  for (const item of evidence.paused) {
    if (item.previous.mode === "paused") continue;
    restored.push(
      await setOperationalLaneControl({
        input: {
          lane: item.previous.lane,
          mode: item.previous.mode,
          reason: `Schema migration ${plan.digest} verified`,
          retryAfterSeconds: item.previous.retryAfterSeconds,
          expectedRevision: item.current.revision,
          actor,
          idempotencyKey: `${run.idempotencyKey}:restore:${item.previous.lane}`,
        },
      }),
    );
  }
  return restored;
};

const verifyPlanWithLockHeld = async ({
  operation,
  client,
  catalog,
  inspection,
}: {
  operation: Operation;
  client: ReturnType<typeof postgres>;
  catalog: Catalog;
  inspection: Inspection;
}) => {
  const actor = requireText(operation.actor, "Actor");
  const reason = requireText(operation.reason, "Reason");
  const { plan, digest } = readPlan(requireText(operation.plan, "Plan path"));
  if (operation.planDigest !== digest) {
    throw new Error("--plan-digest must exactly match the plan document.");
  }
  if (operation.authority !== plan.authority) {
    throw new Error("--authority must exactly match the migration plan.");
  }
  if (plan.source.catalogDigest !== catalog.digest) {
    throw new Error("Migration catalog changed after the plan was created.");
  }
  if (inspection.target.fingerprint !== plan.target.fingerprint) {
    throw new Error("Database target fingerprint does not match the plan.");
  }
  const run = await getPlatformSchemaMigrationRun({ planDigest: digest });
  if (
    !run ||
    !["applied", "verification_failed", "verified"].includes(run.status)
  ) {
    throw new Error("No applied migration run exists for this plan.");
  }
  if (run.status === "verified") {
    return { contractVersion, status: "verified", replayed: true, run };
  }
  const checks = await verifyChecks(client, plan.verificationChecks);
  const platformUrl = operation.platformUrl
    ? parsePlatformOrigin(operation.platformUrl)
    : null;
  const deploymentId = operation.deploymentId?.trim() ?? null;
  let deployment: Record<string, unknown> | null = null;
  if (Boolean(platformUrl) !== Boolean(deploymentId)) {
    throw new Error(
      "--platform-url and --deployment-id must be provided together.",
    );
  }
  if (plan.authority === "production" && !platformUrl) {
    throw new Error(
      "Production verification requires --platform-url and --deployment-id.",
    );
  }
  let providerAuthority: Awaited<
    ReturnType<typeof resolveRailwayMigrationDeploymentAuthority>
  > | null = null;
  let provenance: ReturnType<
    typeof inspectPlatformMigrationDeploymentProvenance
  > | null = null;
  let provenanceError: string | null = null;
  if (deploymentId) {
    providerAuthority = await resolveRailwayMigrationDeploymentAuthority({
      databaseTarget: plan.target.target,
      deploymentId,
    });
    if (providerAuthority.status === "verified" && providerAuthority.revision) {
      try {
        provenance = inspectPlatformMigrationDeploymentProvenance({
          repoRoot,
          sourceCommit: plan.source.commit,
          deployedCommit: providerAuthority.revision,
        });
      } catch (error) {
        provenanceError =
          error instanceof Error ? error.message : String(error);
      }
    }
    checks.push({
      check: "deployment:provider-current-exact-revision",
      passed: providerAuthority.status === "verified",
    });
    checks.push({
      check: "deployment:reviewed-source-tree",
      passed:
        provenance !== null &&
        provenance.sourceIsAncestor &&
        provenance.treesMatch,
    });
  }
  if (platformUrl) {
    try {
      const response = await fetch(`${platformUrl}/api/readiness`);
      deployment = (await response.json()) as Record<string, unknown>;
      if (response.status !== 200 && response.status !== 503) {
        throw new Error(
          `Platform readiness returned unsupported HTTP ${response.status}.`,
        );
      }
      const readiness = parseRemoteReleaseOriginReadiness(
        deployment,
        response.status,
      );
      if (plan.authority === "production") {
        checks.push({
          check: "deployment:production-origin-authority",
          passed: matchesPlatformMigrationProductionOrigin({
            platformOrigin: platformUrl,
            requestPolicy: readiness.requestPolicy,
          }),
        });
      }
      checks.push({
        check: "deployment:application-identity",
        passed:
          response.ok &&
          readiness.readiness.ok &&
          matchesPlatformMigrationApplicationDeploymentAuthority({
            applicationDeployment: readiness.deployment,
            providerAuthority,
          }),
      });
    } catch (error) {
      deployment = {
        attempted: true,
        reachable: false,
        error: error instanceof Error ? error.message : String(error),
      };
      if (plan.authority === "production") {
        checks.push({
          check: "deployment:production-origin-authority",
          passed: false,
        });
      }
      checks.push({
        check: "deployment:application-identity",
        passed: false,
      });
    }
  }
  const passed = inspection.compatible && checks.every((check) => check.passed);
  const verification = {
    verifiedAt: new Date().toISOString(),
    actor,
    reason,
    inspection,
    checks,
    deployment,
    providerAuthority,
    provenance,
    provenanceError,
  };
  if (!passed) {
    await markPlatformSchemaMigrationVerificationFailed({
      planDigest: digest,
      verification,
      appliedAt: run.appliedAt ?? new Date(),
    });
    throw new Error(
      "Migration verification failed; affected lanes remain paused.",
    );
  }
  let restored;
  try {
    restored = await restoreLanes({ plan, run, actor });
  } catch (error) {
    const failedVerification = {
      ...verification,
      restoration: {
        passed: false,
        message: error instanceof Error ? error.message : String(error),
      },
    };
    await markPlatformSchemaMigrationVerificationFailed({
      planDigest: digest,
      verification: failedVerification,
      appliedAt: run.appliedAt ?? new Date(),
    });
    throw new Error(
      "Migration verification passed but lane restoration conflicted; inspect controls and retry verification.",
    );
  }
  const verified = await markPlatformSchemaMigrationVerified({
    planDigest: digest,
    verification: { ...verification, restored },
  });
  return {
    contractVersion,
    status: "verified",
    replayed: false,
    run: verified,
  };
};

const verifyPlan = async ({
  operation,
  client,
  catalog,
}: {
  operation: Operation;
  client: ReturnType<typeof postgres>;
  catalog: Catalog;
}) => {
  const releaseLock = await acquirePlatformSchemaMigrationLock();
  try {
    const inspection = await inspectDatabase({
      client,
      catalog,
      target: operation.target,
    });
    return await verifyPlanWithLockHeld({
      operation,
      client,
      catalog,
      inspection,
    });
  } finally {
    await releaseLock();
  }
};

const print = (result: Record<string, unknown>, json: boolean) => {
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Platform database migration: ${result.status}`);
    if (result.planPath) console.log(`Plan: ${result.planPath}`);
    if (result.planDigest) console.log(`Digest: ${result.planDigest}`);
    if (result.next) console.log(String(result.next));
  }
};

const main = async () => {
  const operation = JSON.parse(process.argv[2] ?? "{}") as Operation;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  if (!operation.target || !operation.command)
    throw new Error("Invalid operation.");
  if (
    operation.authority !== undefined &&
    operation.authority !== "local" &&
    operation.authority !== "production"
  ) {
    throw new Error("Authority must be local or production.");
  }
  if (
    operation.drainTimeoutSeconds !== undefined &&
    (!Number.isSafeInteger(operation.drainTimeoutSeconds) ||
      operation.drainTimeoutSeconds <= 0)
  ) {
    throw new Error("Drain timeout must be a positive integer.");
  }
  if (operation.target.kind === "railway" && !operation.target.environmentId) {
    throw new Error("Railway target identity is incomplete.");
  }
  const catalog = readPlatformMigrationCatalog({ migrationsRoot }) as Catalog;
  for (const entry of catalog.entries) {
    for (const lane of entry.affectedLanes) {
      if (!(operationalLaneValues as readonly string[]).includes(lane)) {
        throw new Error(
          `Migration ${entry.tag} names unknown operational lane ${lane}.`,
        );
      }
    }
  }
  const client = postgres(process.env.DATABASE_URL, {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    let result: Record<string, unknown>;
    if (operation.command === "inspect") {
      result = await inspectDatabase({
        client,
        catalog,
        target: operation.target,
      });
    } else if (operation.command === "backup") {
      const inspection = await inspectDatabase({
        client,
        catalog,
        target: operation.target,
      });
      result = await runBackup({
        client,
        databaseUrl: process.env.DATABASE_URL,
        inspection,
        output: operation.output,
      });
      result.status = "created";
    } else if (operation.command === "plan") {
      const inspection = await inspectDatabase({
        client,
        catalog,
        target: operation.target,
      });
      result = await writePlan({
        catalog,
        client,
        databaseUrl: process.env.DATABASE_URL,
        operation,
        inspection,
      });
    } else if (operation.command === "apply") {
      result = await applyPlan({ operation, client, catalog });
    } else {
      result = await verifyPlan({ operation, client, catalog });
    }
    print(result, Boolean(operation.json));
  } finally {
    await Promise.all([client.end(), platformDatabaseClient.end()]);
  }
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const operation = JSON.parse(process.argv[2] ?? "{}") as Partial<Operation>;
  if (operation.json) {
    console.log(
      JSON.stringify(
        { contractVersion, status: "failed", error: { message } },
        null,
        2,
      ),
    );
  } else {
    console.error(message);
  }
  process.exitCode = 1;
});
