# Production Lifecycle Cleanup Proof

Last updated: 2026-09-08
Status: Gate `G3-02` full storage-retention lifecycle reviewed, merged, and scheduled in production; observation and rollback proof remain

## Outcome

Air Jam now treats storage retention as a durable product lifecycle rather than
an ad hoc object-store deletion. PostgreSQL discovers eligible resources,
records one globally idempotent scheduling command, and creates resource-scoped
`lifecycle_cleanup` jobs for the independently deployed platform operational
worker.

The implemented retention classes are:

1. failed or abandoned release generations after 24 hours
2. stale uploads, failed media, and archived unassigned media after 24 hours
3. superseded unpublished release generations after 180 days of inactivity and
   at least seven days of creator-visible warning

Media retention begins when the asset fails or is archived. A never-finalized
upload uses its creation time. The database records and constrains that
inactivity clock so an old asset archived today does not become immediately
eligible merely because its upload is old.

Superseded unpublished generations move through one explicit lifecycle:
`active`, `warned`, `reclaimable`, `deleting`, and `tombstoned`. A ready release
becomes inactive when it is archived without ever being published, or when a
newer validated release supersedes it. Existing builds begin their 180-day
clock conservatively when first observed after rollout rather than being
backdated from upload time. A late warning always grants a fresh seven days.
Published generations are outside this lifecycle and are never automatically
reclaimed. If a release stops being superseded before cleanup starts, the
planner clears its retention clock so the creator-facing state returns to
`active` instead of showing a stale warning.

Creators can export any generation whose cleanup has not started. The
application service locks the exact generation, verifies ownership, renews a
warned generation's inactivity window, verifies that the source archive still
exists, and returns a short-lived signed download target without exposing an
object key. Dashboard, authenticated API, typed machine API, CLI, and MCP all
use that same service. The machine commands are:

```bash
airjam release inspect --release <release-id>
airjam release export --release <release-id> --generation <generation-id> \
  --out <archive.zip>
```

The MCP equivalent is `airjam.release_export`. Local export reserves the target
without overwrite before downloading, streams the archive with a running size
check, and removes any partial file if transfer or verification fails. Making a
warned release live also clears its retention clock transactionally.

## Safety Contract

Cleanup revalidates and locks the resource before touching storage. It refuses
candidate or promoted release generations, assigned media, active media, and
resources whose retention deadline has not elapsed. The currently live release
is therefore outside the eligible state space rather than protected by a
caller convention. Superseded cleanup additionally requires persisted
inactivity, warning, and eligibility timestamps. The executor rechecks all
three, the promoted-generation relationship, never-published state, and the
full warning window while holding the generation lock. Publishing and
exporting use the same lock order, and cleanup takes the release write lock up
front rather than upgrading a shared lock, so creator action and cleanup cannot
race into deletion or create a lock-upgrade deadlock.

The bounded retention planner selects only rows with a transition currently
due: a new inactivity clock, a due warning, or stale state to clear. Already
clocked rows waiting for their 180-day deadline do not occupy the scan window,
so a large retained backlog cannot starve newer generations indefinitely.

The first attempt inventories the exact bounded object set below the canonical
resource root and persists the keys, sizes, and ETags on the durable attempt.
Retries reuse that first manifest instead of listing again. This guarantees
that an object appearing after the original cleanup decision cannot be swept
into a later retry. Object deletion is idempotent, so a crash or partial object
store failure can delete the same manifest again before PostgreSQL atomically
records both the storage tombstone and terminal job result.

Managed-storage quotas exclude only resources with a committed
`storageDeletedAt` tombstone. A failed or partially completed cleanup therefore
cannot make retained storage disappear from quota accounting.

## Durable And Automatic Operation

Operational jobs now identify their canonical resource independently of
release scope. Versioned resource kinds are `release_generation` and
`game_media_asset`; release metadata remains present only for release-scoped
work. Active-job uniqueness prevents two cleanup jobs from owning the same
resource, and replay is fenced to the original resource identity.

The platform operational worker schedules eligible cleanup on a bounded
interval, executes the same durable claim/lease/retry lifecycle as release
processing, and includes cleanup scheduling in its readiness and drain state.
The default schedule interval is 15 minutes and can be configured with
`AIRJAM_PLATFORM_WORKER_LIFECYCLE_CLEANUP_MS`.

Canonical agent discovery and operation are:

```bash
pnpm --silent run repo -- platform operations lifecycle cleanup --help
pnpm --silent run repo -- platform operations lifecycle cleanup \
  --actor <actor> --reason <reason> --idempotency-key <key> --json
pnpm --silent run repo -- platform operations lifecycle cleanup \
  --actor <actor> --reason <reason> --idempotency-key <key> --apply --json
pnpm --silent run repo -- platform operations jobs list \
  --kind lifecycle_cleanup --resource-kind <kind> --resource <id> --json
```

Preview calculates exact object and byte totals but redacts storage roots,
object keys, and object-store metadata. Apply enqueues work; it does not perform
destructive storage IO in the operator process. Repeating an identical batch
idempotency key returns the original jobs and reports that replay explicitly.

## Migration Contract

Migrations `0030` through `0033`:

1. generalize jobs and attempts from mandatory release scope to canonical
   resource scope
2. allow one idempotent cleanup command to create a bounded batch of jobs
3. fence replay lineage to the original resource
4. add cleanup tombstones and the media inactivity clock with legacy backfill

A fresh database was migrated through `0033`. A separate database was migrated
through `0029`, seeded with a legacy release job and archived media asset, then
upgraded through `0033`. The job retained its generation identity as
`resourceKind=release_generation`, and the media inactivity clock was
backfilled from its last legacy transition timestamp.

Migration `0037_superseded_release_retention.sql` adds the inactivity, warning,
and eligibility clocks to immutable generations, extends the cleanup index,
and enforces the lifecycle in PostgreSQL. The constraint permits retention
state only on ready generations, requires the 180-day inactivity window and
seven-day warning window, and permits cleanup tombstones for a ready generation
only when its retention eligibility exists. The migration declares the exact
operational lanes it affects and the constraint/index checks required by the
canonical migration lifecycle.

## Validation

The PostgreSQL contract suite proves:

1. exact candidate object counts and bytes for both resource classes
2. batch idempotency and resource-scoped job creation
3. terminal tombstones and quota exclusion only after committed deletion
4. retry after a simulated partial object-store failure
5. reuse of the first persisted manifest across attempts
6. survival of an object created after the first cleanup decision
7. release replay, generation, media-assignment, and worker authority invariants
8. a superseded unpublished release receives one durable warning and no early
   cleanup job
9. the warned release becomes eligible only after both retention clocks pass
10. the cleanup worker archives and tombstones exactly that generation
11. an unauthorized creator cannot export another creator's generation
12. an authorized export renews retention and clears warning eligibility
13. publishing a warned generation clears every retention timestamp
14. already-clocked rows cannot starve work beyond the bounded scan window
15. historical archived releases start at first observation rather than being
    backdated
16. a release that stops being superseded has stale retention state cleared
17. streamed CLI export refuses an existing target before transfer and removes
    partial output after integrity failure

The full migration catalog through `0037` applies successfully to a fresh,
isolated native PostgreSQL 14 database. The focused real-PostgreSQL retention
and publish suite passes `9` cases. The devtools release suite passes `10`
focused cases, with the wider platform release, configuration, machine
projection, SDK, and MCP coverage owned by the complete batch gate. Workspace
typecheck, lint, canonical guards, and repository contract
tests pass. The complete `check:batch` gate passes locally under the supported
Node `22.22.0` runtime, including all CLI, MCP, server, SDK, and platform unit
and integration suites that do not require an external PostgreSQL target. The
separate real-PostgreSQL suite above covers the database-authoritative retention
and publish transitions.

## Remaining Gate Work

This does not close `G3-02`. Realtime global admission and the production
worker are now reviewed, merged, deployed, and initially healthy. The worker's
lifecycle-cleanup authority reported ready on deployment
`a667f069-1609-4586-80ab-4befae6de106`. Deliberate overload drills plus a
retained observation window covering cleanup, retry, drain, cost, and rollback
remain mandatory closure evidence.
