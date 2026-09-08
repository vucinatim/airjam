# Production Realtime Admission Proof

Last updated: 2026-09-08
Status: Gate `G3-02` realtime-admission slice implemented and locally proven; reviewed merge, production rollout, and load proof pending

## Outcome

Air Jam's realtime capacity is no longer modeled as the contents of one server
process. The working branch gives PostgreSQL lightweight authority over active
realtime instances, rooms, and controllers while the realtime process remains
the authority for gameplay state and latency-sensitive execution.

This split is intentional:

1. PostgreSQL answers whether new work may enter the hosted system
2. the realtime process owns game state, actions, replication, and room
   correctness after admission
3. the platform reads the same leases for quota and operator inspection
4. no gameplay event or hot state is routed through the platform or database

The player interaction model is unchanged. Hosts still create ordinary room
codes and controllers still join them directly. There is no new account,
permission, confirmation, or capacity UI in the normal path. A capacity denial
uses the existing room and controller error responses with a stable retry delay
when one is meaningful.

## Capacity Policy

One source-owned, versioned policy defines the initial launch envelope:

| Scope             | Sustained target | Burst ceiling | Normal mode                                 | Restricted mode                    |
| ----------------- | ---------------: | ------------: | ------------------------------------------- | ---------------------------------- |
| Rooms             |              100 |           300 | Admit through the burst ceiling             | Admit through the sustained target |
| Controllers       |            1,600 |         4,800 | Admit through the burst ceiling             | Admit through the sustained target |
| Rooms per creator |               50 |            50 | Observe without constraining legitimate use | Enforce at 50                      |
| Rooms per game    |               50 |            50 | Observe without constraining legitimate use | Enforce at 50                      |

This preserves the free-product decision to prefer modest excess cost over
prematurely rejecting users. The sustained values are operational targets, not
ordinary-user limits. The larger ceilings are hard shared safety boundaries.
Creator and game room allowances become hard only when the room-admission lane
is deliberately `restricted`; they remain shadow policy in `normal` mode.

Both realtime admission lanes retain the canonical `normal`, `restricted`, and
`paused` controls. Pausing rejects only new admission. It does not evict an
existing room or invalidate a legitimate controller resume.

## Durable Authority And Lifecycle

The admission rollout is split across two production-valid migrations instead
of combining an application-writer change with a `NOT NULL` contract:

1. `0038_app_id_creator_expand.sql` adds nullable app-credential creator
   identity, backfills existing rows, and adds the canonical game/creator
   ownership foreign key while both the old and new platform writers can run
2. after the platform writer that always records creator identity is deployed
   and the old replica is gone, `0039_realtime_admission_contract.sql` performs
   a second overlap backfill, validates a named non-null check, makes the column
   `NOT NULL`, and introduces the three admission authorities

Those three authorities are:

1. a short-lived lease and heartbeat for each realtime instance
2. one lease for each active room, bound to its instance and carrying optional
   app, game, and creator identity plus the room's controller capacity
3. one lease for each active or resumable controller, bound to its room and
   instance

Admission is serialized under one PostgreSQL transaction lock. The limit check
and lease insertion therefore form one decision even when multiple realtime
processes race at the exact boundary. Room codes are globally unique across
live instances, and an expired instance cannot reserve a code forever.

The instance heartbeats every 10 seconds and its lease expires after 30
seconds. Foreign-key cascades release its rooms and controllers after an
orderly stop. Registration and heartbeat authority reclaim expired instances
under the same global admission lock, so a crashed instance is first excluded
from capacity accounting and then removed with its orphaned leases.
Room teardown releases the room and its controllers. Controller leave releases
its lease; a temporary disconnect retains only the bounded resume reservation
and a successful resume clears that reservation.

App credentials now project their canonical creator identity into the shared
database contract. That lets the realtime server enforce creator and game
policy without reaching through the platform's private schema or inventing a
second identity lookup.

## Failure And Drain Behavior

The failure policy protects active play and cost at the same time:

1. a missing, expired, or unreachable PostgreSQL authority fails closed for a
   new hosted room or controller
2. an existing controller may resume through a paused lane or draining instance,
   but PostgreSQL must still confirm the exact lease; an authority outage fails
   the resume closed rather than risking duplicate controller ownership
3. a draining instance stops accepting new rooms and controllers while existing
   leased work can finish
4. a paused lane rejects new work with its persisted operator reason and retry
   delay
5. reaching a global or per-room boundary rejects only that prospective join;
   the local room map is not mutated first
6. local development without PostgreSQL uses an explicit local authority;
   hosted production or preview without PostgreSQL uses an explicit unavailable
   authority and cannot silently pretend shared usage is zero
7. a candidate proves fresh database and budget authority before it drains an
   incumbent; if the activated candidate disappears, the incumbent recovers
   admission once no live successor remains

The realtime `/health` projection remains a process-liveness response and
includes only bounded admission authority, accepting-work, drain, heartbeat,
pending-reconciliation, terminal-loss, and `hasError` state. It deliberately
does not expose raw error messages, instance identity, or policy internals.
`/ready` is the traffic-readiness boundary and returns `503` when hosted
admission authority is unavailable or the instance is draining.

The 1.0 deployment contract remains exactly one realtime replica. PostgreSQL
provides shared admission and lease authority, but gameplay and room placement
remain process-local. Instance registration therefore permits only one
accepting replica and drains an incumbent during replacement; it is a safe
deployment handoff, not a multi-replica room-routing design. The configured and
tested capacity envelope is consequently a one-replica envelope until a future
room-placement authority is designed and proven.

## Agent-Operable Inspection

The canonical read path is:

```bash
pnpm --silent run repo -- platform operations realtime status --json
```

It reports:

1. live, draining, and expired realtime instance counts plus lease chronology
2. active rooms against sustained target and burst ceiling
3. active and disconnected-resumable controllers against the same envelope
4. remaining burst capacity
5. the exact versioned policy used by admission

The projection excludes lease tokens, credentials, and raw gameplay state.
Lane mutation continues through the existing optimistic, audited
`platform operations lane set` lifecycle; realtime inspection does not create a
second control plane.

## Local Validation

The branch has been exercised against an isolated native PostgreSQL database.
Current focused evidence covers:

1. room admission, per-room controller capacity, disconnect, resume, drain,
   stop, and cascading release
2. two concurrent room admissions at 299 active rooms, where exactly one
   reaches the 300-room burst ceiling and the other is denied
3. an expired instance being excluded from capacity and its stale room code
   being reclaimed
4. canonical app-credential resolution to both game and creator identity
5. active-only host-grant lookup, with an inactive or absent app credential
   receiving no signed grant
6. socket-boundary denial before local room or controller mutation, while
   preserving the existing user-facing error contract
7. platform quota reads deriving concurrent room usage from live admission
   leases rather than a process-local approximation
8. fresh application of the migration catalog through migration `0040`, with
   the canonical migration inspector reporting the exact source and database
   head as `ready`
9. an exact rolling `0037` to `0038` to `0039` upgrade containing existing
   active and inactive app/game rows plus writes from both deployment versions:
   nullable expand, two-phase creator backfill, validated `NOT NULL`, the
   composite game/creator ownership foreign key, and PostgreSQL rejection of
   invalid ownership pairs
10. exact global-controller boundaries, creator/game shadow versus restricted
    enforcement, budget protection and ceiling states, missing/stale evidence,
    and resume behavior during pause, drain, and dependency loss
11. deterministic socket races where room teardown, controller leave, resume
    expiry, or disconnect wins while admission is pending, including immediate
    local authority revocation before a slow durable release completes
12. machine-readable CLI inspection of an empty local authority with the exact
    policy and zero fabricated activity
13. rollout handoff preflight that leaves a healthy incumbent accepting when a
    candidate lacks fresh authority, plus incumbent recovery after an activated
    candidate disappears
14. heartbeat-owned reclamation of expired instance rows and their cascaded room
    and controller leases

Signed host-grant and host-resume authority is security evidence owned by the
[host grant authority proof](../v1-security/host-grant-authority-proof.md), not
by this capacity proof.

The post-edit complete local batch passed on 2026-09-08 with the protected
PostgreSQL lane enabled: canonical guards, typechecks, lint, repo contracts,
194 server tests, 281 SDK tests, and 453 platform tests all passed. The batch
also exposed and removed one ambient hosted-release configuration dependency
from the PostgreSQL release-generation test, so the protected lane is
hermetic. Canonicalizer then returned `ready` after the shared operational-
authority readers, live-instance predicate, and local-master-key eligibility
were reduced to one owner and the complete batch passed again. This is complete
local delivery evidence, not a production claim: protected PR CI,
GitHub-native final review, and production validation still have to pass.

## Remaining Gate And Rollout Proof

This document does not close `G3-02` and does not claim that migrations `0038`
and `0039` or this admission service are live. Closure still requires:

1. reviewed, green protected PRs for each production-valid rollout slice
2. guarded production backup, immutable plans, application, and verification
   for the `0038` expand and platform-writer rollout, followed only after old-
   replica removal by the `0039` contract/admission migration
3. exact platform and realtime deployment plus health, schema, and log
   validation at each compatibility boundary
4. measured sustained, burst, exact-ceiling, soak, graceful-drain, database-
   failure, and recovery drills
5. observed interaction with budget state and the continuously deployed
   operational worker

Until those steps exist as retained evidence, production continues to run the
previous reviewed behavior at main revision
`5a30c1a415f64dcc901dcb42b26a6e1df429eb8c`.
