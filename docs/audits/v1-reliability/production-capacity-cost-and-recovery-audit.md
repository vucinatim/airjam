# Production Capacity, Cost, And Recovery Audit

Last updated: 2026-08-29
Status: Gate `G3-01` measured baseline

This audit records the production facts and architectural gaps that govern Air
Jam's 1.0 reliability work. The readiness manifest owns execution status. This
document owns the evidence, interpretation, and resulting system direction.

## Executive Verdict

Air Jam's current production baseline is healthy and inexpensive. It is not yet
safe to invite an unpredictable launch spike.

The distinction matters:

1. the current Railway topology cost `$7.99` in the last complete billing cycle
   and is projecting approximately `$8.43` for the current cycle
2. current storage, database, memory, and connection usage are all small
3. the sampled seven-day HTTP traffic contained no `5xx` response
4. the system already has useful local limits, health endpoints, provider
   inspection, product telemetry, and explicit release payload ceilings
5. the remaining launch risk is unbounded or unrecoverable work during a spike,
   not an already-expensive steady state

The 1.0 launch blockers exposed by this audit are:

1. expensive release work is synchronous and has no durable queue, global
   concurrency owner, pause/resume control, or safe replay contract
2. public release assets and media still traverse the dynamic platform and its
   database instead of an isolated cached delivery plane
3. realtime rooms and rate limits are process-local, with no global admission
   ceiling, graceful production drain, or multi-replica room ownership model
4. Postgres has no recurring backup schedule and no measured isolated restore
5. Railway's compute usage limit applies to the shared workspace, not just Air
   Jam, so it cannot implement Air Jam's ratified `$100` ordinary and `$150`
   launch-month envelopes safely by itself
6. archived releases, failed release artifacts, and an abandoned media upload
   demonstrate that storage lifecycle cleanup is not yet an enforced product
   contract
7. deployment health checks exist, but continuous synthetic monitoring,
   incident correlation, alerts, and timed rollback proof remain unverified

No production resource, variable, backup, deployment, or lifecycle record was
changed during this audit.

## Scope And Evidence Method

The audit distinguishes three kinds of evidence:

1. **live production facts** measured through provider and application read
   surfaces on `2026-08-29`
2. **candidate source facts** read from the current repository head, which is
   newer than every live production deployment
3. **ratified targets** already owned by the 1.0 roadmap

The canonical machine reads were:

```bash
pnpm --silent run repo -- railway doctor --json
pnpm --silent run repo -- platform telemetry health --json
pnpm --silent run repo -- platform telemetry overview --days 30 --json
pnpm --silent run repo -- platform telemetry overview --days 90 --json
```

Provider metrics, deployment history, usage, volume, backup, log, and database
reads were bounded and read-only. R2 and Postgres required narrow diagnostic
queries because the repo CLI does not yet expose capacity or lifecycle
aggregates for those resources. That missing machine surface is itself a Gate 3
operability gap; those diagnostics are evidence, not a new operating path.

The live services run older commits than the cumulative 1.0 integration
candidate:

| Service                | Live commit                                | Last successful deployment |
| ---------------------- | ------------------------------------------ | -------------------------- |
| Platform               | `24cd182e0150d6121a334ba0eced82414d18e677` | 2026-08-26                 |
| Realtime server        | `5d1a83d9586325196c343e601b9113372957c21e` | 2026-07-29                 |
| Release browser worker | `ecab13744a58f8a32b68f4767df007e15ed263da` | 2026-07-24                 |

Source conclusions in this audit therefore describe the candidate contract,
not proof that an unmerged change is already running in production.

## Production Topology

The Railway project has one persistent `production` environment and no retained
ephemeral environment at inspection time.

| Plane                 | Railway service                  | Production shape              | Public health surface       |
| --------------------- | -------------------------------- | ----------------------------- | --------------------------- |
| Product and API       | `air-jam-platform`               | 1 replica, EU West, always on | `/api/health`               |
| Realtime              | `air-jam-server`                 | 1 replica, EU West, always on | `/ready`                    |
| Release checks        | `air-jam-release-browser-worker` | 1 replica, EU West, always on | `/health`                   |
| Persistence           | Postgres                         | 1 managed database and volume | provider-managed            |
| Release/media objects | Cloudflare R2                    | external bucket               | no repo-owned capacity read |

Observed Railway facts:

1. all application services reported successful current deployments
2. all three application services have deployment health-check paths
3. every service has one replica, no custom CPU or memory cap, no configured
   application sleep, and no explicit overlap or draining policy
4. the project is on a Hobby workspace shared with unrelated projects
5. Railway currently reports no workspace compute usage limit
6. Railway PR deploys are enabled; a PR environment can clone the complete
   topology and its variables unless isolation is enforced separately

One realtime replica is currently an architectural constraint, not simply a
cost choice. The 1.0 candidate moves admission and lease authority into
PostgreSQL, but gameplay and room placement remain process-local. Registration
allows one accepting instance and drains the incumbent during a replacement;
that makes deploy handoff safe without pretending multi-replica room routing
exists. Increasing replicas before introducing explicit room placement would
therefore create incorrect behavior rather than safe capacity. All realtime
capacity numbers in this audit are the tested envelope for one accepting
replica.

## Cost Baseline

### Railway

| Window                          | Measured project usage | Interpretation                       |
| ------------------------------- | ---------------------: | ------------------------------------ |
| 2026-07-03 through 2026-08-03   |              `$7.9882` | last complete cycle                  |
| 2026-08-03 through 2026-08-29   |              `$7.1444` | current partial cycle                |
| Current cycle linear projection |                `$8.43` | directional, not a provider forecast |

Last complete cycle by service:

| Service                |      Cost |
| ---------------------- | --------: |
| Platform               | `$3.7860` |
| Release browser worker | `$2.3670` |
| Realtime server        | `$1.2822` |
| Postgres               | `$0.4878` |
| Deleted volume         | `$0.0652` |

The worker is the second-largest steady cost despite very low publish volume.
That does not justify deleting it: browser checks are part of the release trust
boundary. It does justify moving browser work behind an idle-capable, bounded
job contract once the durable release lane exists.

The complete Railway workspace was at `$30.99` during the current cycle. A
Railway usage hard limit would protect the whole workspace by shutting down all
workloads after the workspace crosses the limit. Because Air Jam shares that
workspace, this control is too broad to be the product's primary budget guard.
Air Jam needs app-level accounting and lane switches; a provider cap can remain
the last-resort ceiling or Air Jam can later move to a dedicated workspace if
that isolation becomes worth the additional operational boundary.

### R2

The production release/media bucket contained:

| Object class            | Objects |    Stored bytes |
| ----------------------- | ------: | --------------: |
| Release zip artifacts   |      33 |     271,634,465 |
| Extracted release sites |     576 |     312,885,457 |
| Release screenshots     |      24 |       3,004,278 |
| Managed media           |      16 |      43,960,199 |
| Other                   |       5 |              25 |
| **Total**               | **654** | **631,484,424** |

There were no incomplete multipart uploads. Current storage is approximately
`0.631 GB`, below Cloudflare R2's current account-wide `10 GB-month` Standard
storage free tier. That makes present storage cost negligible if other buckets
do not consume the allowance; it does not make object growth safe or free
forever.

The production runtime credential was denied access to inspect the bucket
lifecycle configuration. This audit therefore does not claim that no provider
lifecycle rule exists. It does prove that Air Jam cannot inspect it through the
canonical operator surface and that retained archived/failed objects have no
effective application-owned cleanup contract.

## Usage And Traffic Context

The first-party product telemetry introduced on 2026-08-26 reported for the
last 30 days:

| Signal                    |         Count |
| ------------------------- | ------------: |
| Page views                |            56 |
| Anonymous sessions        |            39 |
| Meaningful public intents |            15 |
| Agent resource requests   |             9 |
| Runtime sessions          |           202 |
| Game sessions             |            35 |
| Eligible playtime         | 2,067 seconds |

For the last 90 days, authoritative lifecycle/runtime facts reported one new
account, three games, three releases, two publications, 325 runtime sessions,
71 game sessions, and 4,373 seconds of eligible playtime. The database contains
three accounts, twelve games, and thirty-six releases across its complete
history. Product telemetry is intentionally approximate and must not be used as
identity or billing truth.

The most recent seven-day provider-log sample showed:

1. the platform query reached its `5,000`-entry cap and contained no `5xx`
   response; sampled response duration was `24 ms` at p50 and `57 ms` at p95
2. the realtime service returned all `1,562` available entries and no `5xx`;
   `275` were Socket.IO paths
3. platform sampled transfer was approximately `902 MB`, materially larger
   than ingress, and most requests were neither release nor API paths
4. `404` scanner/bot traffic dominated the non-success responses on both
   public services

This is a health and cost baseline, not a capacity test. Seven-day current
resource summaries were small—roughly `380 MB` platform, `206 MB` browser
worker, `123 MB` realtime, and `53 MB` Postgres memory with negligible observed
CPU—but quiet-production utilization cannot prove the roadmap's sustained or
burst envelope.

## Database And Lifecycle Baseline

| Measure                                |                          Observed value |
| -------------------------------------- | --------------------------------------: |
| Railway volume                         |         225.65 MB of 5,000 MB (`4.51%`) |
| PostgreSQL database                    |          14,530,227 bytes (`13.86 MiB`) |
| Configured Postgres connection ceiling |                                     500 |
| Connections at inspection              |                       6 total, 1 active |
| Estimated application pool ceiling     | about 20 across two one-replica clients |
| Recurring backup schedules             |                                       0 |
| Unexpired manual backups               |                                       2 |

The two observed backups were temporary pre-security-patch snapshots with
expiry dates, not a recurring recovery policy. No isolated restore has been
performed and timed for the 1.0 candidate.

Release persistence shows lifecycle debt rather than immediate volume pressure:

| Status   | Releases | Artifacts |  Zip bytes | Extracted bytes |
| -------- | -------: | --------: | ---------: | --------------: |
| Live     |        7 |         7 | 98,092,272 |     107,947,625 |
| Archived |       17 |        15 | 85,060,904 |     103,319,779 |
| Failed   |       12 |        12 | 88,481,289 |     101,618,053 |

Archived and failed records retain most of their artifacts. One managed-media
row has remained in `uploading` state since 2026-03-30. Archiving currently
changes product state without owning corresponding object reclamation.

## Expensive-Lane Inventory

| Lane                       | Existing bounds and strengths                                                                        | Missing launch control                                                                                                 | Owning work               |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Realtime rooms/controllers | max 16 controllers per ordinary room; bounded per-IP host/register/join rates; inactive room cleanup | global room/controller admission ceiling, shared rate authority, graceful drain, safe overload response, measured soak | `G3-02`, `G3-04`          |
| Dynamic web/API            | payload-specific limits; selected mutation rate limits; health endpoint                              | cross-transport quota domain, public request shedding, cached static plane, continuous synthetic proof                 | `G3-02`, `G4`, `G5`       |
| Release ingestion          | 100 MB zip, 250 MB extracted, 5,000 files, 25 MB per file                                            | per-creator allowance, bounded queue, idempotent job state, concurrency, pause/resume/replay                           | `G3-02`, `G3-03`          |
| Browser checks             | separate worker, token in production, browser check contract                                         | health that proves Chromium readiness, fail-closed worker auth, idle economics, queue ownership                        | `G3-02`, `G4`, `G5`       |
| Moderation                 | explicit mode and timeout; currently disabled in production                                          | optional-dependency degradation and asynchronous job ownership before enablement                                       | `G3-02`, `G3-04`          |
| Postgres                   | ample current capacity and provider volume                                                           | explicit per-service pool ceiling, recurring backups, isolated restore, migration/rollback drill                       | `G3-02`, `G3-03`, `G3-04` |
| R2 artifacts/media         | explicit object classes and upload limits                                                            | operator inventory, creator/game accounting, retention/cleanup, isolated preview credentials, recovery proof           | `G3-02`, `G3-03`          |
| Telemetry                  | bounded ingestion, deterministic projection, CLI health/rebuild/retain                               | scheduled retention, capacity alarms, operational event separation                                                     | `G3-02`, `G4`             |
| Deploys/previews           | provider-owned environments, health checks, deploy history                                           | isolated preview secrets/storage, expiry proof, continuous monitors, timed rollback                                    | `G3-03`, `G4`, `G7`       |

## Ratified Target Gaps

The roadmap already fixes the 1.0 capacity target. This audit does not change
it.

| Measure               |        Sustained target |         Burst target | Current proof                                 |
| --------------------- | ----------------------: | -------------------: | --------------------------------------------- |
| Concurrent rooms      |                     100 |   300 for 15 minutes | no load proof; process-local owner            |
| Controllers           |                   1,600 | 4,800 for 15 minutes | room-local max exists; no global bound        |
| Dynamic API           |                 100 RPS |              300 RPS | no load proof or global shedding              |
| Cached public traffic |                 500 RPS |            1,500 RPS | release delivery is still dynamic             |
| Browser jobs          | 2 concurrent, queue 100 |   reject above queue | no durable queue                              |
| Upload jobs           |  4 concurrent, queue 50 |   reject above queue | no durable queue                              |
| Database connections  |                      40 |          warn at 80% | neither explicit app pool nor alert is proven |

The ratified free-cloud allowances—50 games per creator, 20 listed games, 2 GB
per creator, 500 MB per game, submission and job limits, room-hour allowance,
and per-creator/game room ceilings—are product policy only until `G3-02`
implements one shared counter and decision authority.

## Findings And Decisions

### `REL-001`: Cost protection must be lane-aware

Air Jam is far below its ordinary cost ceiling today, but the provider's
workspace-wide shutdown control is both too broad and too late. `G3-02` must
own creator/game allowances, queue depth, job concurrency, storage accounting,
and one explicit operator switch per expensive lane. Provider budget alerts and
a final workspace ceiling complement those controls; they do not replace them.

### `REL-002`: Release work needs durable job authority

Finalize currently reads and extracts the archive, uploads files, drives the
browser, captures evidence, and runs optional moderation in a request path.
The final architecture is a database-backed release job state machine with
bounded claiming, idempotent steps, retry classification, pause/resume, and
operator-safe replay. Browser execution remains a narrow isolated worker; the
platform owns orchestration and creator-visible state but does not perform the
heavy work synchronously.

### `REL-003`: Static delivery must leave the dynamic control plane

Creator-controlled release content currently shares the product origin and
public asset requests can traverse platform code, Postgres, and R2. This is
both a security boundary and the largest obvious launch-scaling problem. The
1.0 candidate needs an isolated release origin with direct cached object
delivery. This finding aligns with `CAN-100` and `CAN-101`; it does not create a
second tracker.

### `REL-004`: Realtime should stay single-replica until room ownership is real

Premature horizontal scaling would split in-memory room authority. The 1.0
path is to enforce the ratified global envelope, reject admission explicitly,
add graceful shutdown/drain, and prove one-replica capacity first. A shared
room-placement architecture is justified only if that measured envelope cannot
hold the launch target.

### `REL-005`: Recovery starts with recurring backups, then proof

Manual expiring snapshots are not a recovery contract. `G3-03` must configure
recurring backups, restore into an isolated environment, verify application
invariants, record recovery point and recovery time, and prove deployment
rollback/redeploy plus release-job replay. No automated destructive data repair
is authorized for 1.0.

### `REL-006`: Cleanup is product behavior

Archived releases, failed artifacts, abandoned uploads, telemetry retention,
and preview environments require explicit lifecycle states and idempotent
cleanup. Cleanup must be inspectable, previewable where material, safely
repeatable, and exposed through the repo CLI—not a collection of hidden cron
scripts or ad hoc SQL.

### `REL-007`: Deployment health is not continuous operations

Railway health checks gate deployments; they do not prove the product between
deploys. Gate 4 must add continuous synthetics, operational events, alert
routing, incident correlation, and verified closure. Optional Sentry and Better
Stack references in the repo are not treated as production evidence until the
provider/configuration path is attested by a machine read.

### `REL-008`: Capacity inspection needs canonical machine surfaces

The repo-native Railway and telemetry commands are strong foundations, but an
agent cannot yet retrieve Air Jam cost, resource peaks, database/storage
capacity, backup state, queue state, or lane status through one stable contract.
The implementation gates should extend repo-owned inspection alongside the
controls they add so future agents can diagnose and operate the product without
dashboard knowledge.

## Production-Valid Delivery Sequence

The findings produce this order:

1. `G3-02`: define one quota/job/lane-policy domain and its CLI inspection
   contract; add explicit global admission and connection-pool ceilings
2. separate hosted release delivery onto an isolated cached origin so launch
   traffic does not multiply platform, database, and storage work
3. move release processing onto the durable bounded job model, keeping browser
   execution isolated and all state transitions idempotent
4. implement creator/game accounting, lifecycle cleanup, degraded modes, spend
   signals, and safe lane switches through the same policy services
5. add realtime graceful drain and prove the one-replica envelope before
   considering shared room placement or more replicas
6. `G3-03`: configure backups and execute isolated restore, rollback, and job
   replay drills
7. `G3-04`: run sustained and three-times burst validation, dependency-failure
   drills, and deliberate overload proofs against the exact candidate

Each slice can deploy incrementally when it is production-valid. Stable package
promotion, public visibility, and the launch article remain coordinated around
one rehearsed candidate.

## Staging Decision

Do not add a permanently running full-copy staging environment yet.

At the current production shape it would add roughly another single-digit
monthly Railway cost before it proves equivalent value, while static cloned
variables can accidentally reuse production resources. The canonical path is:

1. disposable provider-owned candidate environments
2. isolated Postgres, R2 bucket/credentials, tokens, and external identities
3. automatic expiry and cleanup
4. idle or scale-to-zero worker/process choices only where their runtime
   contracts support them safely
5. a permanent staging environment only when recurring rehearsals show that its
   availability is worth the cost and secret-management boundary

This resolves the staging question without weakening `G2-03`: no external
agent or release proof may use a preview that shares production-capable
credentials.

## Provider References

1. [Railway pricing](https://docs.railway.com/pricing)
2. [Railway cost controls](https://docs.railway.com/pricing/cost-control)
3. [Railway volume backups](https://docs.railway.com/volumes/backups)
4. [Railway health checks](https://docs.railway.com/deployments/healthchecks)
5. [Railway deployment actions](https://docs.railway.com/deployments/deployment-actions)
6. [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)

## Closure Contract

`G3-01` may close when this audit is present, the readiness manifest references
it as typed evidence, and repository validation passes. Closure means the
baseline and gaps are known. It does not claim that any launch-scale control,
backup, restore, rollback, or load target has already been implemented or
proven.
