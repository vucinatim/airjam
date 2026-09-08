# Operational Reliability Contract

Last updated: 2026-09-04
Status: canonical implemented contract

Related sources:

1. [Operational Events And Incidents Contract](./operational-events-and-incidents-contract.md)
2. [Production Control Contract](./production-control-contract.md)
3. [Production Observability Baseline](../strategy/production-observability-baseline.md)
4. [`@air-jam/operations-contract`](../../packages/operations-contract/index.mjs)
5. [Operational reliability policy](../../apps/platform/src/server/operations/operational-reliability-policy.ts)
6. [Operational synthetic scheduler](../../apps/platform/src/server/operations/operational-synthetic-scheduler.ts)

## Purpose

This contract defines the implemented Air Jam reliability loop from a domain
failure or synthetic observation through durable storage, SLO evaluation,
internal alert state, and safe agent operation.

It owns:

1. structured and secret-safe operational failures
2. transactional event enqueue and durable delivery
3. source-owned launch-critical synthetic checks and SLOs
4. durable alert opening and recovery
5. truthful operational-worker readiness
6. preview-first, audited repair through the repository CLI
7. the trust boundary for reports from untrusted hosted runtimes

The narrow GitHub issue projection consumes this contract through its own
adapter boundary. Broader incident correlation, notification adapters, and
runbook execution remain later options and must not replace event, delivery,
SLO, or alert authority.

## Canonical Machine Surface

Agents and maintainers use one discoverable repo-owned surface:

```bash
pnpm run repo -- platform operations reliability --help
pnpm --silent run repo -- platform operations reliability catalog --json
pnpm --silent run repo -- platform operations reliability status --json
pnpm --silent run repo -- platform operations reliability events status --json
pnpm --silent run repo -- platform operations reliability events list --json
pnpm --silent run repo -- platform operations reliability synthetics list --json
pnpm --silent run repo -- platform operations reliability alerts list --json
pnpm --silent run repo -- platform operations reliability issues status --json
```

Mutating commands are previews unless `--apply` is explicit:

```bash
pnpm --silent run repo -- platform operations reliability events deliver-once --json
pnpm --silent run repo -- platform operations reliability events deliver-once --apply --json
pnpm --silent run repo -- platform operations reliability events repair-expired --json
pnpm --silent run repo -- platform operations reliability events repair-expired --apply --json
pnpm --silent run repo -- platform operations reliability synthetics run-due --json
pnpm --silent run repo -- platform operations reliability synthetics run-due --apply --json
```

Dead-letter requeue additionally requires the exact event, actor, reason, and
idempotency key. The command records an immutable command row and emits a
separate audit event:

```bash
pnpm --silent run repo -- platform operations reliability events \
  requeue-dead-letter \
  --event <event-id> \
  --actor <operator-or-agent-id> \
  --reason <bounded-reason> \
  --idempotency-key <stable-key> \
  --json
```

Railway environment selection uses the same internal secret-resolution pattern
as the existing platform operator commands. Database credentials are never
printed in JSON output.

## Durable Event Delivery

Producers commit the versioned operational envelope to
`operational_event_outbox`. A worker claims one eligible row under a PostgreSQL
row lock and receives a unique lease token.

Canonical states are:

```text
pending -> delivering -> delivered
   ^           |
   |           +-> pending       (retryable failure with budget)
   |           +-> dead_letter   (terminal or exhausted failure)
   +--------------- requeue      (explicit audited command)
```

Rules:

1. the event ID is the idempotency identity
2. reusing an event ID with a different envelope fails closed
3. claims use `FOR UPDATE SKIP LOCKED`
4. completion and failure require the exact worker, lease token, state, and
   unexpired database-authority time
5. retry delay is bounded exponential backoff
6. delivery writes the exact envelope to the append-only event store before
   marking the outbox row delivered
7. an existing event-store ID with different content fails closed
8. expired leases return to pending or dead-letter according to their retained
   attempt budget
9. requeue starts a fresh bounded attempt budget but retains the previous
   attempt evidence in its audit command

The delivery worker does not call GitHub, email, Slack, or another vendor.
Those are downstream adapters over durable Air Jam state.

## Structured Failure Boundary

Operational failures contain only:

1. contract version
2. stable code
3. failure class
4. bounded summary owned by the producer
5. retryability
6. optional recursively bounded, defensively filtered structured details

Unknown exception messages and stacks are not retained. Secret-shaped keys,
including authorization, cookie, token, password, credential, exact `key`, and
secret fields, are removed recursively. Compound credential names such as
`apiKey`, `signing_key`, `private-key`, compact `accesstoken`, and plural
`apiKeys` are recognized conservatively; unrelated words such as `monkey` or
`keyboardLayout` remain available as useful evidence. The explicitly public
diagnostic field `targetKey` is retained; other standalone or compound `key`
fields fail closed. Logs for publisher failures contain only a stable source
failure code and exception class.

A producer normalizes an untrusted failure code once. The resulting stable code
is used for both the event kind and the structured failure. Raw and normalized
identities cannot diverge inside one retained event.

Realtime app-identity verification and runtime-usage persistence use this
shared producer. Their raw database errors and submitted app credentials never
enter the outbox.

## Hosted Runtime Reports

Game and controller JavaScript is untrusted. A render crash can therefore be
useful evidence without becoming infrastructure authority.

The SDK error boundary sends only:

1. contract version and random report ID
2. room ID and runtime role
3. stable crash code
4. bounded error class name
5. an eight-character local digest
6. client occurrence time

It never sends the raw message, stack, component stack, URL, app credential,
nickname, or controller input.

The realtime server:

1. validates the exact strict payload
2. rate-limits both the connecting client and room scope
3. accepts host reports only from a host authorized for that room
4. accepts controller reports only from a controller authorized for that room
5. derives runtime session, controller, and game identity from server-owned
   room state
6. persists the report through the shared outbox with authority
   `runtime_reported`

`runtime_reported` evidence may contribute to diagnosis and correlation. It
must not independently trigger an authoritative repair or assert an internal
cause.

## Launch-Critical Synthetics

The source-owned catalog contains six checks:

| Check                      | User story proved                                                             |
| -------------------------- | ----------------------------------------------------------------------------- |
| `landing-docs`             | Public landing and documentation render                                       |
| `arcade-hosted-release`    | Arcade discovery and immutable hosted release HTML                            |
| `platform-realtime-health` | Platform and realtime public health                                           |
| `room-controller`          | Real room creation and controller join protocol                               |
| `semantic-gameplay`        | Replicated state plus one semantic controller action                          |
| `release-dependencies`     | Platform release boundaries, operational worker, and browser worker readiness |

HTTP checks use bounded timeouts and response assertions. Semantic checks use
the public Socket.IO protocol rather than calling internal domain methods. All
targets are explicit. A missing target records a structured error; it does not
silently skip the check.

Runs retain one observation per declared step. Status is derived exactly:

1. any observation in `error` makes the run `error`
2. otherwise any `failed` observation makes the run `failed`
3. otherwise the run is `passed`

Execution duration is measured with a monotonic process clock. At persistence,
the transaction anchors `completedAt`, `startedAt`, event time, and evidence time
to PostgreSQL `clock_timestamp()`. The submitted process wall clock is
provisional and never becomes retained chronology.

The idempotency fence is acquired before a check performs network or realtime
side effects. The bounded check executes while its PostgreSQL transaction-level
advisory lock is held; another worker with the same idempotency key waits, reads
the retained replay, and does not repeat the external story. This deliberately
uses the existing transaction authority instead of adding a second lease table
or singleton-worker assumption.

The due-run scheduler isolates every catalog item. A lookup, execution, or
persistence failure for one check becomes a secret-safe per-check failure and
does not prevent later checks from running. Its JSON result reports genuinely
due, completed, failed, stale-ignored, and not-due counts plus one explicit
outcome per check; a lookup failure is not guessed to be due. A resolved batch
with failures leaves the worker's synthetic authority degraded. A fenced stale
evaluation remains a successful retained run but is counted, logged, and
exposed in worker status; isolation never turns a partial or fenced result into
invisible success.

## SLO And Alert Policy

The source-owned catalog contains four SLOs:

| SLO                                | Objective |     Window | Minimum samples |
| ---------------------------------- | --------: | ---------: | --------------: |
| `public-web-availability`          |    99.00% |     1 hour |               2 |
| `control-plane-availability`       |    99.50% | 30 minutes |               2 |
| `multiplayer-session-availability` |    99.00% |     1 hour |               2 |
| `release-dependency-availability`  |    99.00% |     1 hour |               2 |

Each evaluation stores its exact observation window, counts, ratio, objective,
status, and alert streaks. The database transaction takes a per-SLO advisory
lock before assigning database-authority chronology, then uses an alert row lock
and revision fence. Concurrent workers therefore cannot open duplicate alerts,
lose an update, or assign chronology in a different order from evaluation.

Historical evidence may legitimately arrive after newer evidence. The run and
its operational event remain durable, but an evaluation older than the latest
retained SLO evaluation is explicitly returned as `stale_ignored`. It cannot
alter streaks, alert status, recovery time, or alert revision. The disposition
is returned by the same CLI result and surfaced by scheduler and worker batch
state; no parallel correlation schema is needed.

Alerts open only after the declared consecutive breach threshold and recover
only after the declared consecutive recovery threshold. Alert recovery retains
the original opening time, exact recovery time, latest evaluation, and
optimistic revision.

This alert state is internal Air Jam truth. The narrow GitHub projection is
defined separately in the
[operational alert issue projection contract](./operational-alert-issue-projection-contract.md)
and never becomes alert authority.

## Worker Readiness

The operational worker tracks these authorities independently:

1. durable jobs
2. maintenance/repair
3. lifecycle cleanup
4. event delivery
5. synthetics
6. persisted operational-budget evidence

`/ready` requires recent successful database-backed job and event-delivery
authority, telemetry-retention authority, and, whenever budget refresh is
enabled, fresh persisted budget evidence. Production cannot disable budget
refresh. Missing or older-than-six-hours evidence makes the worker unready. A
provider collection failure remains visible in refresh status and logs, but
does not make the worker unready while the previously persisted evidence is
still fresh. Auxiliary failures remain visible as degraded authorities. A
successful loop can never erase another subsystem's failure.

`/health` remains process liveness. Authenticated `POST /drain` stops new work
and waits for bounded in-flight completion, including a provider budget
refresh, before deployment termination. Railway deploy health uses `/ready` so
a new production worker cannot become authoritative without fresh evidence.

## Configuration

Operational worker cadence:

1. `AIRJAM_PLATFORM_WORKER_EVENT_DELIVERY_MS` defaults to `1000`
2. `AIRJAM_PLATFORM_WORKER_SYNTHETIC_MS` defaults to `30000`
3. `AIRJAM_PLATFORM_WORKER_ISSUE_PROJECTION_MS` defaults to `5000`
4. `AIRJAM_PLATFORM_WORKER_BUDGET_REFRESH_MS` defaults to `900000` (15 minutes)
   and must remain shorter than the six-hour evidence staleness boundary
5. `AIRJAM_PLATFORM_WORKER_BUDGET_REFRESH_MODE` defaults to `enabled` in
   production and `disabled` elsewhere; production rejects `disabled`
6. existing poll, repair, cleanup, concurrency, drain, and control-token values
   retain their current meanings

Enabled budget refresh requires `RAILWAY_PROJECT_ID`,
`RAILWAY_ENVIRONMENT_ID`, and a sealed, environment-scoped
`RAILWAY_PROJECT_TOKEN`. The worker attests the token through Railway's
`projectToken` query and requires exact project/environment identity before
collecting usage. Account tokens and ambiguous token fallbacks are not part of
this authority.

Synthetic targets:

1. `AIRJAM_SYNTHETIC_HOSTED_RELEASE_URL` selects one immutable live release
2. `AIRJAM_SYNTHETIC_WORKER_ORIGIN` selects the operational worker origin
3. `AIRJAM_SYNTHETIC_BROWSER_WORKER_ORIGIN` selects the browser worker origin
4. `AIRJAM_SYNTHETIC_APP_ID` selects the synthetic host app identity when the
   platform identity is not suitable

In Railway PR environments, Railway's environment-scoped sibling URLs are the
target authority: `RAILWAY_SERVICE_AIR_JAM_PLATFORM_URL`,
`RAILWAY_SERVICE_AIR_JAM_SERVER_URL`,
`RAILWAY_SERVICE_AIR_JAM_PLATFORM_WORKER_URL`, and
`RAILWAY_SERVICE_AIR_JAM_RELEASE_BROWSER_WORKER_URL`. They take precedence over
production-oriented explicit origins so a cloned preview cannot probe the
wrong environment.

Runtime-reporting environment configuration:

1. Railway's `RAILWAY_ENVIRONMENT_NAME` is authoritative when present:
   `production` maps to production and every other Railway environment maps to
   preview
2. outside Railway, `AIRJAM_OPERATIONAL_ENVIRONMENT` explicitly labels retained
   events
3. `AIR_JAM_RUNTIME_ERROR_REPORT_RATE_LIMIT_MAX` defaults to `30` per existing
   server rate-limit window

Production must configure every required synthetic target. Unconfigured
targets are operational failures by design.

## Current Boundary

Implemented here:

1. durable outbox and event store
2. structured platform, worker, realtime-server, and hosted-runtime producers
3. retry, dead-letter, repair, and audited requeue
4. six synthetics and four SLOs
5. durable alert opening and recovery
6. truthful worker readiness
7. complete CLI inspection and safe maintenance lifecycle
8. narrow, leased, deduplicated GitHub issue projection

Not owned by this contract:

1. external notification routing beyond the implemented narrow issue projection
2. a generic incident lifecycle
3. governed runbook execution
4. autonomous code-changing repair

If real operations later justify those systems, they consume the records
defined here and preserve every authority distinction above. Their schemas do
not make their implementation mandatory.
