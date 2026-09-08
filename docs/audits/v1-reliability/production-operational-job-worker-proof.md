# Production Operational Job Worker Proof

Last updated: 2026-09-08
Status: Gate `G3-02` durable release-execution slice reviewed, merged, and running in production; observation and rollback proof remain under `G3-08`

## Outcome

Hosted release processing no longer runs inside a creator's HTTP request.
Finalizing one exact immutable generation now admits and enqueues a versioned
artifact-processing job, returns the release in `checking`, and leaves all
expensive work to a separately deployable worker.

The worker executes one explicit three-stage graph:

```text
artifact processing -> browser validation -> image moderation -> ready
```

Every stage is scoped to the same release generation. PostgreSQL owns job,
attempt, lease, retry, cancellation, and terminal authority; R2 owns only
attempt-scoped side effects and promoted immutable release objects.

## Runtime Contract

The platform runtime and operational worker are separate entrypoints built from the
same platform package:

1. `run-platform.mjs` serves Next.js and applies preview migrations
2. `run-operational-job-worker.mjs` claims and executes durable operational jobs

The operational worker:

1. claims with the existing PostgreSQL `SKIP LOCKED` authority
2. dispatches only a versioned, strictly parsed payload for the claimed kind
3. creates a durable attempt before external work starts
4. heartbeats and completes through the exact worker, lease token, attempt ID,
   and generation fence
5. retries only explicitly retryable failures within the source-owned policy
6. enqueues the next stage only after the current stage commits successfully
7. stops claiming during drain and waits a bounded time for work and maintenance

`/health` proves process liveness. `/ready` returns `200` only after a database
authority operation succeeds and drops to `503` after authority failure.
`POST /drain` requires `AIRJAM_PLATFORM_WORKER_CONTROL_TOKEN`; `SIGTERM` and
`SIGINT` use the same drain lifecycle.

## Attempt And Storage Safety

Migration `0029_release_job_attempts.sql` introduces immutable attempt identity
and generation-native jobs. Each attempt has its own output root. A failed,
canceled, or lease-expired attempt cannot overwrite a later attempt, and only a
currently leased attempt for the current generation can commit release-visible
state.

Superseding an upload generation atomically cancels queued jobs or requests
cancellation of running jobs before the old generation becomes abandoned. The
worker also rechecks generation identity at executor and commit boundaries.

Terminal attempt outputs are discoverable and removable through the same
operator domain. Cleanup deletes the attempt prefix before transactionally
recording `outputCleanedAt` and an `output_cleaned` job event. Storage is loaded
only when cleanup has a real candidate, so an idle worker can establish database
readiness without unnecessary R2 coupling.

## Creator And Agent Contract

The dashboard, tRPC route, machine API, SDK, CLI, and MCP all call the same
enqueueing application service. The old synchronous finalizer and moderation
service were removed.

The machine finalize response contains the exact release, generation, and
redacted processing job. `airjam release submit` returns after durable
submission by default. `--wait` follows the exact generation to a terminal
state, while `--publish` implies the same wait and publishes only after the
generation is ready. A timeout does not cancel or lose the job; inspection can
resume later.

Canonical operator discovery is:

```bash
pnpm --silent run repo -- platform operations jobs --help
pnpm --silent run repo -- platform operations jobs status --json
pnpm --silent run repo -- platform operations jobs inspect --job <job-id> --json
pnpm --silent run repo -- platform operations jobs cleanup-orphans --help
pnpm --silent run repo -- platform operations jobs worker-once --help
```

The one-cycle command is an intentional agent and recovery surface. It uses the
same dispatcher and database authority as the long-running service; it is not a
second execution implementation.

## Deployment Contract

`apps/platform/railway.worker.json` defines the worker start command and
liveness check. The standalone build bundles application dependencies and
copies the official `playwright-core` package beside the worker because its
optional runtime imports must remain intact.

Scheduled lifecycle cleanup uses one stable system actor with a time-bucketed
idempotency key. Rolling deployment overlap therefore replays the same command
instead of treating the new replica's unique worker identity as a conflicting
request.

The hermetic deploy check copies no `.env*` files except `.env.example`, passes
only a small non-secret process environment, performs a frozen install and
platform build, verifies both runtime entries and the packaged Playwright
dependency, then starts each entry against a closed database. This prevents a
build proof from uploading source maps or contacting configured providers.

The fourth Railway process is now deployed in production. Deployment
`a667f069-1609-4586-80ab-4befae6de106` runs merge revision
`e6f03c1fd0f97d5f591ab99f6d2d98042da7e28b`; `/ready` reports `accepting`,
fresh required budget evidence, no degraded required authorities, and a
complete `6/6` production synthetic batch with zero failures or skips.

## Validation

Local proof covers:

1. fresh migration through `0029`
2. a valid legacy upgrade with deterministic attempt backfill
3. a fail-closed legacy upgrade whose transaction leaves no partial schema
4. concurrent finalization, queue, claim, lease, retry, cancellation, replay,
   supersession, and redacted inspection behavior
5. retryable failure with isolated output roots, successful later retry, and
   terminal orphan cleanup
6. the real artifact archive through artifact, browser, and disabled-moderation
   stages to `ready`
7. worker configuration, authority-gated readiness, authenticated drain, and
   bounded shutdown
8. CLI discovery, preview-first cleanup and worker cycles, and secret redaction
9. SDK/CLI/MCP submission semantics, including wait-before-publish
10. platform typecheck, lint, tests, production build, and hermetic standalone
    runtime loading

The PostgreSQL-backed platform suite passed `60` files and `282` tests. The
repo contract suite passed `78` tests. The focused devtools release suite and
CLI suite also pass. All databases used by these proofs are isolated local
fixtures and contain no production data.

## Remaining Gate Work

This slice closes the release-executor migration and initial production
activation, but not Gate `G3-02` or the separate `G3-08` observation gate.
The remaining proof requires:

1. measured queue-full, burst, overload, and dependency-degradation drills
2. a retained production observation window covering cost, retry, drain, and
   rollback behavior
