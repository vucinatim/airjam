# Production Control Contract

Last updated: 2026-09-08
Status: canonical 1.0 contract

Related docs:

1. [../plans/v1-release-roadmap-plan.md](../plans/v1-release-roadmap-plan.md)
2. [../audits/v1-reliability/production-capacity-cost-and-recovery-audit.md](../audits/v1-reliability/production-capacity-cost-and-recovery-audit.md)
3. [../architecture/platform-control-plane-architecture.md](../architecture/platform-control-plane-architecture.md)
4. [../architecture/analytics-architecture.md](../architecture/analytics-architecture.md)
5. [../audits/v1-reliability/production-realtime-admission-proof.md](../audits/v1-reliability/production-realtime-admission-proof.md)

## Purpose

This contract defines the one production-control model that bounds Air Jam's
hosted cost and work before the 1.0 launch.

It covers:

1. expensive-lane admission and kill switches
2. shadow-first free-cloud quota decisions
3. budget-state response
4. bounded durable jobs
5. lifecycle cleanup
6. machine inspection and safe operator mutation

It does not introduce payments, subscriptions, or a second product tier.

## Authority

The hosted control plane owns production policy. PostgreSQL owns lightweight
global admission leases and concurrency counts. The realtime server owns live
room correctness and gameplay hot state. Workers own bounded execution, never
creator-visible product state.

All human, HTTP, CLI, MCP, realtime, and worker adapters must call the same
domain decisions. A transport-local rate limiter may remain as an abuse or
load-shedding layer, but it cannot be the authoritative creator, game, queue,
or budget allowance.

Authoritative usage comes from:

1. platform lifecycle records for accounts, games, releases, and media
2. shared realtime admission leases for live room and controller concurrency
3. the runtime usage ledger for completed room/controller activity and room-hours
4. durable job records for queued and executing work
5. object metadata plus platform records for managed storage
6. provider usage snapshots for infrastructure cost

Approximate product telemetry is never quota or billing authority.

## Control Layers

Admission evaluates these layers in order:

1. hard safety invariants such as payload and archive limits
2. explicit lane state
3. current budget state
4. creator, game, IP-abuse, and global quotas
5. queue and concurrency capacity

Earlier denials cannot be bypassed by later layers.

### Lane Modes

Every controlled lane has one persisted mode:

1. `normal`: derive quota enforcement from budget state
2. `restricted`: enforce configured allowances even when the budget would keep
   them in shadow mode
3. `paused`: reject new work while preserving already-safe reads and in-flight
   work according to the lane's drain contract

Missing rows mean `normal`. A missing database or unreadable control state must
fail closed for cost-creating platform work. Realtime gameplay may use a bounded
last-known-good control snapshot so a brief control-plane failure does not evict
active rooms or turn the platform into the realtime hot path.

The canonical lanes are:

1. `game_creation`
2. `game_listing`
3. `release_submission`
4. `artifact_ingestion`
5. `release_processing`
6. `browser_validation`
7. `moderation`
8. `media_ingestion`
9. `product_telemetry`
10. `realtime_room_admission`
11. `realtime_controller_admission`
12. `preview_capacity`
13. `lifecycle_cleanup`

Published release reads, public docs, login, usage inspection, export, and
self-host/BYOC guidance remain available through budget degradation whenever
their dependencies are healthy. A security incident may separately revoke a
specific unsafe artifact or serving surface.

### Budget States

Provider usage snapshots determine one of:

1. `normal`
2. `warning`
3. `protection`
4. `near_ceiling`
5. `ceiling`

The roadmap owns the monetary thresholds and launch-cycle distinction. The
control domain stores measured provider evidence and derives the state; callers
do not submit an arbitrary state label.

Budget behavior is:

1. `normal`: quotas are shadow-only except hard safety and abuse bounds
2. `warning`: keep legitimate work open, record the incident signal, and
   forecast the ceiling
3. `protection`: enforce expensive-lane quotas and stop nonessential preview
   growth
4. `near_ceiling`: pause new browser validation and optional processing intake
5. `ceiling`: reject new cost-creating hosted work while allowing active rooms
   to finish when safe

No automated operation may increase a threshold, allowance, replica limit, or
provider plan.

Budget cycles and evidence are append-only. The current policy stores monetary
values as integer micro-USD, retains raw provider measurements and the rate
card used to derive them, and selects only the newest snapshot per provider
scope when aggregating spend. Evidence older than six hours is explicitly
`stale`; missing and stale authority return no current state while preserving a
separately labeled last-known state. They are never silently treated as
`normal`.

The platform operational worker is the single continuous collector. It runs an
immediate startup refresh and a 15-minute schedule. A project-scoped PostgreSQL
advisory lock serializes overlapping worker replicas; the lock holder re-reads
persisted evidence and skips the provider call when the exact Railway project
scope is not due. Collection uses the same platform-owned Railway adapter as
the CLI and persists through `recordOperationalBudgetEvidence`; there is no
parallel table, queue, cron service, or in-memory authority.

Production collection requires a sealed, environment-scoped
`RAILWAY_PROJECT_TOKEN`. Before usage reads, the adapter queries Railway's
project-token identity and requires an exact match with both
`RAILWAY_PROJECT_ID` and `RAILWAY_ENVIRONMENT_ID`. It never falls back to an
account token. Local and preview workers default to explicit collection-disabled
status and cannot claim production budget authority.

Realtime admission makes that boundary explicit. Production requires fresh
provider-backed budget evidence. A deployment-derived preview marks the
production budget requirement as `not_applicable`; it still requires its own
PostgreSQL lane, instance, room, controller, and hard-capacity authority. This
keeps previews usable without copying production usage credentials or
fabricating provider evidence, while `/health` and `/ready` expose the effective
requirement for agent inspection.

The ordinary threshold sequence is `$25`, `$50`, `$75`, `$90`, and `$100`.
The one-cycle 1.0 launch sequence is `$50`, `$75`, `$100`, `$135`, and `$150`.
The launch profile is inactive until the exact provider cycle start is approved
as a reviewed source change. It cannot be activated through an environment
variable or operator command.

## Admission Result

Every decision returns a stable machine-readable result containing:

1. contract version and decision ID
2. lane
3. whether the persisted control authority was available
4. current lane mode and revision, or `null` when authority was unavailable
5. `allowed`, `shadow_denied`, or `denied` outcome
6. reason code
7. current usage and limit when relevant
8. unit and accounting window when relevant
9. reset time or retry delay when known
10. queue position when work was accepted into a queue
11. self-host/BYOC guidance for an enforced hosted boundary

Canonical denial reasons are:

1. `lane_paused`
2. `budget_protection`
3. `quota_exceeded`
4. `queue_full`
5. `concurrency_exceeded`
6. `capacity_exceeded`
7. `rate_limited`
8. `control_unavailable`

HTTP adapters use `429` for caller allowance/rate boundaries and `503` for
global, budget, paused-lane, or unavailable-capacity boundaries. They include
`Retry-After` when the decision supplies a delay. CLI and MCP preserve the same
reason and details instead of reducing the result to an unstructured message.

## Quota Rules

The exact initial allowances remain owned by the 1.0 roadmap. This domain must
implement them without creating a parallel policy table in documentation.

Rules:

1. hard archive and payload safety limits are always enforced
2. legitimate-user allowances are shadow-only below the budget protection
   threshold unless a lane is explicitly `restricted`
3. abuse controls may enforce independently of the budget state
4. every mutation consumes allowance through the semantic application service,
   not through one transport adapter
5. a failed or canceled reservation is released promptly
6. retrying the same idempotent attempt does not consume another allowance
7. no partial upload is accepted after an admission denial
8. active gameplay is the last lane degraded

The quota catalog is a reviewed source contract rather than operator input.
Callers provide the semantic scope and requested integer amount; they cannot
provide the limit, usage, budget state, or desired outcome. Managed-storage
usage counts compressed and extracted release artifacts plus media source
assets while those objects remain retained. Rolling room time comes from
authoritative runtime game segments clipped to the accounting window.

An unavailable durable-job or global-realtime authority is reported as
`control_unavailable`. Request-lifetime work and process-local room maps must
not masquerade as exact shared concurrency. The status surface may expose that
gap before the owning subsystem exists, but admission cannot treat it as zero.

## Durable Job Contract

Release processing and browser validation must converge on durable jobs rather
than request lifetime. The authority foundation below exists; adapter migration
remains an explicit part of this contract rather than an implied current fact.

Every caller-issued job mutation first has one globally idempotent durable
command. Enqueue, cancel, replay, and repair hash all caller-controlled
semantic inputs and persist an immutable result in the same transaction as the
effect. This includes zero-result repair, so reusing an old command key cannot
repair work that expired later.

Every job has:

1. stable job ID, kind, creator, game, and release identity
2. an immutable creating-command reference and canonical request hash
3. `queued`, `running`, `succeeded`, `failed`, or `canceled` status
4. bounded attempt count, next-attempt time, deadline, and lease expiry
5. persisted structured JSON progress and terminal result/error
6. created, started, finished, and updated timestamps
7. cancellation and operator pause semantics

The canonical kinds are `release_artifact_processing`,
`release_browser_validation`, `release_image_moderation`, and
`lifecycle_cleanup`. Each maps to its own semantic lane so budget, capacity,
and retry policy remain independently controllable. Jobs identify either a
`release_generation` or `game_media_asset` resource; release scope remains
required only for release-generation work. `cancel_requested` is a persisted
cooperative state between running and terminal cancellation.

Claiming is transactional and synchronized with persisted lane state. Normal
and restricted lanes may drain admitted work; paused lanes start none. A worker
owns a database-time lease capped by the absolute job deadline, heartbeats it,
and cannot stage, succeed, fail, or extend work at or after that deadline.
Retryable failure schedules a bounded retry; terminal failure remains
inspectable. Queue depth and per-creator/global concurrency are checked before
admission. One creator cannot occupy every worker slot.

The platform owns job orchestration and creator-visible release state. A narrow
processor owns archive/check execution. The browser worker remains isolated
and does not become the release-state authority.

The durable PostgreSQL authority and operator CLI are implemented. Immutable
release generations give source uploads, extracted sites, screenshots, and
trusted checks stable generation identity; create-only keys and explicit
candidate/promoted pointers fence stale finalizers from release-visible state.
Creator release paths enqueue a versioned three-stage graph for the separately
deployed operational worker. Terminal-generation and inactive-media cleanup
uses the same authority. The job table must not be presented as global realtime
concurrency authority before room and controller admission also use a shared
durable owner.

Contract version `1` governs lifecycle, fencing, and operator semantics only.
Each real executor must add a separate versioned, runtime-validated payload,
progress, result, and error contract for its job kind before product wiring;
arbitrary JSON must not become a permanently public executor API.

## Lifecycle Cleanup

Cleanup is an idempotent domain operation, not hidden SQL or storage cron.

It covers:

1. failed uploads and temporary extraction data after 24 hours
2. expired job leases and terminal-job retention
3. superseded unpublished artifacts after the ratified warning and retention
   windows
4. archived managed media that is no longer assigned
5. product telemetry retention through its existing canonical policy
6. disposable preview environments through their provider-owned identity

The currently live release is never automatically deleted. Material cleanup is
previewable, reports exact candidates and bytes, requires the ratified warning
state when applicable, and records an append-only result. The first deletion
manifest is persisted and reused across retries so later objects cannot enter
an earlier cleanup decision. R2 deletion and database state changes must be
retry-safe if either side fails partway through.

## Mutation Safety And Audit

Every control mutation records:

1. a caller-provided idempotency key
2. actor identity
3. expected prior revision
4. before and after values
5. reason
6. timestamp

Stale revisions fail rather than overwrite another operator. Replaying the same
idempotency key returns the original result only when the requested mutation is
identical; conflicting reuse fails.

Control mutations are explicit preview/apply operations. Destructive cleanup,
production restore, maintenance mode for core play, budget increases, and limit
increases retain the approval boundaries in the roadmap.

## Agent-Operable Surface

The canonical repo surface is:

```bash
pnpm --silent run repo -- platform operations --help
```

Budget inspection and evidence collection are:

```bash
pnpm --silent run repo -- platform operations budget status --json
pnpm --silent run repo -- platform operations budget sync --help
```

`budget sync` reads Railway directly, previews by default, and requires actor,
reason, idempotency key, exact `--railway-project` and
`--railway-environment` targets, and explicit `--apply` before persistence. It
uses the same project-token-only, exactly attested adapter as the worker. A
retry of a completed logical collection returns the original evidence before
token resolution or another provider request. The CLI exposes no state,
threshold, or ceiling override.

Quota inspection and prospective decisions are:

```bash
pnpm --silent run repo -- platform operations quota status --help
pnpm --silent run repo -- platform operations quota check --help
```

The quota CLI reads lifecycle/runtime authority plus persisted lane and budget
state. It exposes no usage, limit, budget-state, or outcome override.

Durable job inspection and safe operation are:

```bash
pnpm --silent run repo -- platform operations jobs --help
```

Policy, queue status, listing, and inspection are read-only. Cancellation,
replay, and expired-lease repair are preview-first and require actor, reason,
caller idempotency, and explicit `--apply`; cancellation also requires the
current expected revision. Operator projections never expose worker lease
tokens, request hashes, or raw command, payload, progress, result, error, and
event-detail JSON. Lease-bearing records remain a separate worker authority.

Shared realtime capacity inspection is:

```bash
pnpm --silent run repo -- platform operations realtime status --json
```

It exposes live, draining, and expired instances; active room usage; active and
resumable controller usage; sustained targets; burst ceilings; and remaining
burst capacity. It never exposes lease tokens, credentials, or gameplay state. The
two realtime lane modes continue to use the canonical optimistic, audited lane
mutation lifecycle rather than a separate realtime control surface.

The complete lifecycle must expose stable JSON for:

1. overall status and policy inspection
2. lane inspection and safe mode changes
3. budget evidence and derived state
4. quota usage and decision explanation
5. job listing by kind or resource, pause/resume, cancellation, and replay
6. cleanup preview/apply
7. realtime instance, room, controller, drain, and capacity inspection

Reads never require dashboard interaction. Mutations require explicit apply,
idempotency, actor, reason, and optimistic revision where applicable. UI and
HTTP surfaces use the same application services as this command.

## Delivery Order

The production-valid implementation sequence is:

1. persistent lane controls, mutation audit, shared admission errors, and CLI
2. platform release/media/telemetry enforcement through application services
3. persistent budget evidence
4. shadow and enforced quota accounting
5. durable release and browser-validation jobs
6. lifecycle cleanup and storage reconciliation
7. realtime room/controller global admission plus graceful drain
8. load, overload, dependency-failure, and recovery proof

Steps 1 through 5 are implemented through the linked budget, quota,
durable-authority, immutable-generation, and operational-worker proofs. Step 6
now covers terminal job-attempt outputs, failed or abandoned release
generations, stale or inactive unassigned media, and the complete superseded-
unpublished warning/export/renewal/retention lifecycle through exact retry-
stable manifests. That lifecycle is live through PR `#102`, main revision
`5a30c1a415f64dcc901dcb42b26a6e1df429eb8c`, and migration `0037`. Step 7 is
implemented and locally exercised on its working branch, but its reviewed
merge, migration `0038`, and production rollout remain open. Step 8 remains
open in full.

Each step remains part of the final architecture. No step introduces a
temporary in-memory queue, transport-only quota, or dashboard-only control.

## Done Criteria

Gate `G3-02` is complete only when:

1. every listed lane has a real decision owner and operator control
2. ratified allowances are inspectable and enforced under the correct budget
   states
3. release/browser work is durably bounded, cancellable, and replay-safe
4. lifecycle cleanup is automatic, idempotent, and inspectable
5. limit, concurrency, queue-full, stale-revision, idempotency, and failure-mode
   tests pass
6. the canonical CLI covers inspection and every safe mutation lifecycle
7. no human or machine transport can bypass the application-service policy
