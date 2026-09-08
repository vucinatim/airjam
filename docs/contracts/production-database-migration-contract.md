# Production Database Migration Contract

Last updated: 2026-09-08
Status: canonical contract

## Purpose

This contract defines the only supported lifecycle for changing Air Jam's
production PostgreSQL schema. It is designed for unattended agents without
turning migrations into an autonomous black box.

The operator decides intent. The repository supplies immutable plans, exact
target identity, backups, concurrency controls, durable evidence, and
independent verification.

## Authority

The committed Drizzle journal and SQL files under `apps/platform/drizzle` are
the sole schema source of truth. The generated
`platform-schema-head.generated.ts` binds runtime readiness and worker claims to
the exact journal head.

There is no second migration registry, hand-written production SQL path, or
automatic production migration at application startup.

Only loopback database hosts are classified as local. A direct non-loopback
`DATABASE_URL` is deliberately unclassified and receives the same explicit
production-authority gates as a production or unclassified Railway target.

## Migration Policy

Every migration after journal index `35` declares its operating mode inside the
SQL file. These comments are part of the migration hash.

```sql
-- airjam:migration-mode=online
-- airjam:verify=table:example
```

Supported modes:

1. `online`: safe while the previous and next application revisions overlap.
2. `operational_lanes`: requires one `airjam:affected-lanes` directive. Apply
   pauses only those canonical production-control lanes and waits for their
   active leases to finish.
3. `exclusive`: cannot be applied to production. It must be redesigned into
   online expand/migrate/contract phases.

Every new migration declares at least one independent `table`, `index`, or
`constraint` verification check. Historical migrations are recognized but
cannot be introduced as pending work on a production plan.

Policy-governed journal entries must also have a timestamp newer than the
entry immediately before them. Inspection distinguishes migrations that are
merely pending from a historical gap that Drizzle can no longer apply; a gap
is drift, so planning fails before backup, lane control, or schema mutation.

## Canonical Lifecycle

The repo CLI is the only normal operator surface:

```bash
pnpm run repo -- platform database migration --help
```

The lifecycle is:

1. `inspect` compares an explicit database target with the exact source
   catalog. Unknown hashes, a missing journal, and source-behind state fail
   closed.
2. `plan` creates a PostgreSQL custom-format backup and manifest, captures the
   database fingerprint and current journal head, snapshots affected lane
   revisions, and writes an immutable digest-addressed plan.
3. `apply` requires the plan path, digest, authority, actor, reason,
   idempotency key, and `--apply`. It rechecks every binding, pauses only the
   declared lanes, drains active jobs, applies Drizzle migrations, and verifies
   the journal and declared database objects. It does not reopen lanes.
4. the reviewed source tree is deployed, either as the source commit itself or
   as a GitHub merge commit that contains the source commit without changing
   its tree.
5. `verify` independently checks the database again and, for production, calls
   the deployed `/api/readiness` endpoint, requires an explicit exact deployed
   Git revision, proves that revision contains the reviewed source commit with
   an identical Git tree, and requires production to report that exact
   revision. Only then does it restore lanes that the migration paused.

Apply and verify share one PostgreSQL advisory lifecycle lock. This prevents
concurrent operators from applying the same catalog or restoring the same lane
snapshot twice.

The plan and backup are local operational artifacts under
`.airjam/operations/database-migrations` by default. They may contain database
names and provider resource IDs, but never database URLs or credentials.

## Runtime Safety

`/api/health` remains process liveness. `/api/readiness` includes the generated
schema-head comparison and returns `503` when the database is missing, behind,
ahead, drifted, or unavailable.

The operational worker checks the same schema authority before every claim and
periodically while running. An incompatible schema leaves the process alive and
observable but blocks all new job, maintenance, event-delivery, synthetic, and
issue-projection work.

Job claims recheck schema authority immediately before every claim. Other worker
loops use the shared compatibility snapshot, refreshed every
`AIRJAM_PLATFORM_WORKER_REPAIR_MS` (30 seconds by default). That bounded overlap
is safe only because production accepts adjacent-version-compatible `online`
migrations and refuses `exclusive` migrations; it is not permission to weaken
the online compatibility rule.

Application changes paired with an `online` migration must remain compatible
with both adjacent schema versions during rollout. Changes that cannot satisfy
that rule must use explicit production-control lanes and phased migrations.

## Failure and Retry Contract

Migration runs are durable and unique by plan digest and idempotency key.

1. retries with the same plan and key replay safely
2. reuse of either identity for different intent is rejected
3. apply failures are recorded as `apply_failed`
4. post-apply or deployed-revision failures are recorded as
   `verification_failed`
5. affected lanes stay paused on every failure after drain begins
6. verification may be retried after the external condition is repaired
7. lane restoration uses expected revisions; concurrent operator changes fail
   closed instead of being overwritten

The migration record binds source commit and head, target fingerprint, full
plan, backup evidence, drain evidence, actor, reason, and verification result.

## Backup Boundary

`platform database backup` is also available independently. A successful
backup returns the artifact path, SHA-256, size, target fingerprint, source
schema head, and manifest digest. Producing a backup does not prove restore;
isolated restore and recovery rehearsal belong to Gate `G3-03`.

Backup artifacts are hashed as streams so database size does not become an
operator-memory ceiling. Connection credentials are supplied to `pg_dump` or
its version-matched Docker fallback through libpq environment variables, never
process arguments.

Recovery-capable backup manifests, isolated restore planning, and independent
data verification are defined by the
[production recovery contract](./production-recovery-contract.md).

## Production Sequence

Production plans are created from the clean, fully reviewed PR head. The merge
commit may have a different commit identity, but its tree must remain identical
to the reviewed source and the source commit must be its ancestor. Because
`main` is the production branch, agents should keep the merge-to-apply interval
short:

1. inspect and create the production plan from the final green, reviewed PR
   head against the explicit Railway environment
2. merge that exact head without introducing tree changes
3. apply the plan while the new deployment is progressing
4. wait for the merge revision to become current and ready
5. verify with `--deployed-revision <merge-commit>` and allow the lifecycle to
   restore affected lanes

Do not invoke raw `drizzle-kit migrate`, extract a production URL into a shell,
or restore lanes manually during the normal path.
