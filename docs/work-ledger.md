# Air Jam Work Ledger

Last updated: 2026-09-08
Status: historical memory

This file is the append-only historical memory for the repo.

Use it for:

1. milestone closures
2. major validations
3. notable decisions
4. durable execution history

For the current snapshot, use [current-state.md](./current-state.md).

The pre-reset overloaded ledger has been preserved at:

1. [archive/2026-05-08-work-ledger-pre-os-reset.md](./archive/2026-05-08-work-ledger-pre-os-reset.md)

## 2026-09-08 - Retention Went Live And Realtime Admission Reached Local Proof

- merged reviewed PR `#102` and deployed exact main revision
  `5a30c1a415f64dcc901dcb42b26a6e1df429eb8c`, making the complete superseded-
  unpublished release lifecycle live in production through verified migration
  `0037`
- moved 180-day inactivity, durable seven-day creator warning, safe generation
  export, retention renewal, and PostgreSQL-enforced cleanup eligibility from a
  rollout claim to a production fact; activation of the separate operational
  worker remains owned by `G3-08`
- implemented the next `G3-02` slice on its working branch: PostgreSQL-backed
  realtime instance, room, and controller admission leases while keeping
  latency-sensitive gameplay state inside the realtime process
- kept the room-code and controller-join UX unchanged and ratified generous
  normal-mode burst ceilings of 300 rooms and 4,800 controllers over sustained
  targets of 100 and 1,600; creator/game room allowances of 50 remain shadow
  policy unless the room lane is deliberately restricted
- added stable machine inspection through
  `platform operations realtime status`, fail-closed new-work behavior,
  resumable existing-controller handling, graceful drain state, crash expiry,
  and creator/game identity at the shared app-credential boundary
- exercised the focused lifecycle, exact room-ceiling race, stale-instance,
  identity, socket-boundary, quota, fresh-migration, and CLI paths against an
  isolated local PostgreSQL authority
- retained an honest delivery boundary in the
  [production realtime admission proof](./audits/v1-reliability/production-realtime-admission-proof.md):
  the admission implementation is not merged or live; final boundary coverage,
  full gates, protected review, guarded migration, exact deployment, and load/
  dependency/recovery proof remain open
- replaced the unsafe one-step ownership/admission migration with a real
  expand/writer/contract sequence: `0038` adds nullable app creator identity
  and backfills existing rows, the adjacent platform deployment always writes
  that identity, and `0039` performs a second overlap backfill, validates the
  named non-null constraint, and adds realtime admission authority
- proved both an exact rolling upgrade from production migration `0037` with
  old and new writers overlapping and a fresh PostgreSQL 14 catalog through
  `0040`, which the canonical inspector classified as `ready`
- recorded the independent integration findings instead of accepting the first
  green batch: critical PostgreSQL suites now belong to protected CI, Railway
  evidence collection no longer holds database authority across provider I/O,
  repeated system registration preserves the original room, game-scoped grants
  cannot register a system host, and hosted master-key authentication is gone
- implemented and documented the local
  [host grant authority proof](./audits/v1-security/host-grant-authority-proof.md):
  non-forgeable anonymous launch identity, exact-origin v3 grants, one-winner
  PostgreSQL consumption, explicit audience/session/intent claims, and server-
  issued room resume capabilities close the `AJ-SEC-003` design without adding
  user-visible permission or join flows; coordinated migration `0040` rollout
  and hostile-path production proof remain open
- passed the complete post-edit local batch with the protected PostgreSQL lane:
  canonical guards, typechecks, lint, repo contracts, 194 server tests, 281 SDK
  tests, and 453 platform tests; the run also found and removed an ambient
  hosted-release configuration dependency from a PostgreSQL test before the
  batch was accepted as evidence
- completed the one pre-push Canonicalizer session with a `ready` verdict after
  consolidating operational-authority readers, realtime live-instance policy,
  and local-master-key eligibility into their canonical shared owners; the
  complete PostgreSQL-enabled batch passed again after those review fixes

## 2026-09-04 - Production Recovery Was Automated And Live-Proven

- closed `G3-03` with one agent-first repo CLI for provider backup inspection
  and scheduling, immutable isolated restore, exact deployment rollback, and
  durable job replay; no operational capability depends on a human-only UI
- configured and read back exact daily, weekly, and monthly Railway volume
  backup policy, then captured a fresh checksummed PostgreSQL 17 snapshot
- restored the snapshot into a disposable Railway PostgreSQL 18 environment,
  verified migration head and all 40 relation counts, exercised exact job
  cancellation and replay lineage, and removed every run-owned provider and
  local resource
- used protected PRs `#92`, `#93`, and `#94`, one GitHub-native Opus review per
  PR, required CI/Railway previews, and final `ready` Canonicalizer verdicts for
  the substantial batches
- let the first production calls fail closed and improve the contract: one
  GraphQL schema mismatch was rejected before mutation; later successful
  provider rollbacks exposed that Railway rollback instances omit runtime Git
  SHA while retaining the new deployment ID and provider revision
- made accepted or ambiguous production mutations preserve structured evidence,
  prevented unrelated concurrent deployments from being misattributed, and
  bound public readiness to the exact newly created rollback deployment ID
- completed a final verified backward rollback in 10,526 ms and exact forward
  recovery in 8,248 ms, leaving production on reviewed revision
  `8bf765f45e217281daa30bb1a471066d097969e7`; retained the full chain in the
  [production recovery proof](./audits/v1-reliability/production-recovery-proof.md)

## 2026-09-04 - Production Schema Changes Gained One Guarded Lifecycle

- replaced the standalone backup command and manual production Drizzle recipe
  with one repo CLI spanning exact-target inspection, fingerprinted backup,
  immutable planning, guarded application, and independent verification
- kept the committed Drizzle journal authoritative while requiring every new
  migration to carry hashed online, operational-lane, or exclusive policy and
  explicit database-object verification checks
- generated an exact source schema head for runtime use; platform readiness and
  every operational-worker scheduling surface now fail closed when the live
  database is missing, behind, ahead, drifted, or unavailable
- added durable migration runs binding plan digest, idempotency, source commit,
  target fingerprint, backup, actor intent, lane drain, failure, and
  verification evidence
- made operational-lane migrations preserve current controls, pause and drain
  only affected writers, retain paused state on failure, and restore through
  revision-fenced canonical production controls only after exact-deployment
  readiness succeeds
- proved the full 37-migration fresh path plus isolated inspect, real backup,
  immutable plan, apply, object verification, final verification, idempotent
  replay, and deliberate deployed-readiness failure on PostgreSQL 17; retained
  reviewed merge and production rollout as explicit closure work for `G3-06`
- merged reviewed PR `#89`, used its own repo CLI to create a fingerprint-bound
  production backup and immutable plan, applied migration `0036`, and verified
  exact Railway deployment `1ca7a865-2ab5-417e-8221-574c0071736d` at merge
  commit `5a280c43337f4dc5f00069457ee3a89b8c7cffc0`; durable run
  `572a389a-e93e-4ecc-9887-75a69e69424c` finished `verified`

## 2026-09-04 - One Alert Now Owns One Durable GitHub Issue

- closed `G4-03` with a narrow projection instead of adding a generic incident
  workflow, hosted reasoning service, or automatic remediation framework
- kept `operational_alerts` authoritative while using GitHub only for durable
  notice, coordination, assignment, comments, and history
- gave each repository/alert key one leased PostgreSQL projection with exact
  revision fencing, bounded retry, dead-letter inspection, expired-lease
  repair, and audited idempotent requeue
- implemented create, update, recovery close, and recurrence reopen against one
  issue identity; uncertain creates reconcile through a hidden marker instead
  of duplicating issues
- preserved agent and maintainer text outside a strictly owned managed block
  containing alert, source-event, SLO-evaluation, failed/passed verification,
  and canonical CLI inspection pointers
- isolated a repository-installed issue-only GitHub App identity to the
  operational worker and kept secrets out of documents, status, and previews
- exposed alert and issue-projection inspection plus safe maintenance through
  the canonical repo CLI and wired the PostgreSQL regression proof into CI
- retained production activation under `G3-08`; shipping the capability does
  not silently provision a continuously running production actor

## 2026-09-04 - Reliability Foundation Was Hardened Before Continuous Execution

- closed `G4-07` without adding a generic incident engine, remediation DSL, or
  parallel correlation model
- replaced substring-only secret filtering with lexical, recursive handling of
  compound API, signing, private, encryption, access, auth, and session key
  names while retaining unrelated diagnostic fields
- made normalized structured failure identity authoritative for both realtime
  event kind and retained failure code
- changed retained synthetic chronology to use PostgreSQL authority time while
  preserving monotonic execution duration
- serialized each SLO stream before assigning chronology and added an explicit
  stale-evaluation fence; historical runs remain durable but cannot regress
  breach/recovery streaks or alert revisions
- isolated every due synthetic catalog item and added a stable batch result
  with per-check outcomes and exact due/completed/failed/stale/not-due counts
- moved the idempotency fence ahead of external synthetic effects, so multiple
  worker replicas cannot duplicate a real room or protocol story
- kept worker health truthful when an isolated batch partially fails and made
  failed and stale-fenced outcomes inspectable through worker status
- extracted scheduler orchestration from the execution/persistence service so
  cadence, isolation, and batch reporting have one focused module
- moved the PostgreSQL regression suites into the ordinary GitHub test lane so
  concurrency and database-time invariants remain continuously enforced
- proved the boundary with `18/18` operations-contract tests, `5/5`
  PostgreSQL reliability invariants, `3/3` PostgreSQL realtime-publisher tests,
  the `4/4` CLI contract suite, `10/10` focused platform tests, and the full
  batch gate

## 2026-09-04 - Agent Autonomy Was Reframed Around Capability, Not Ceremony

- recorded the maintainer decision to constrain production effects rather than
  agent reasoning: local agents receive rich sensors, shared evidence, and
  focused Railway, GitHub, Air Jam, and local actions
- defined the intended loop-and-swarm ecosystem: Railway and runtime state stay
  provider/application truth, GitHub issues and pull requests provide durable
  coordination, readiness owns release claims, and agents choose diagnosis and
  implementation paths
- narrowed the Gate 4 launch bar to trustworthy synthetics, alerts, agent
  diagnosis, and one deduplicated GitHub issue path
- removed the generic incident lifecycle, runbook persistence engine, and
  automatic-remediation allowlist from mandatory 1.0 scope; retained them as
  post-1.0 options earned by real incidents
- explicitly ruled out a dedicated swarm scheduler until observed coordination
  needs justify it
- preserved strong effect boundaries for destructive, privileged, costly, and
  public operations without forcing low-risk reads or reversible work through a
  uniform state machine

## 2026-09-04 - Public Install And Durable Reliability Landed In Production

- merged the six-cell public install proof in PR `#74` and the durable
  operational reliability loop in PR `#75` after protected CI, Railway previews,
  Canonicalizer, and one final GitHub-native Claude Opus review were clear
- deployed exact main revision
  `c6a8a14a228adef6c367f99d94d26d514f1ae4b5` successfully across the platform,
  realtime server, and release browser worker
- applied production migration `0034` after verifying the prior migration head,
  then confirmed all six new operational reliability tables and the new journal
  head without exposing database credentials
- verified platform health/readiness, realtime and browser-worker health, clean
  provider logs, and live browser behavior for branding, direct `/arcade`
  navigation, and card-hover presentation
- proved the repo-owned reliability CLI can inspect its six synthetics and four
  SLOs against production while reporting no fabricated run or alert state
- deliberately left the separately deployable operational worker unprovisioned:
  continuous synthetics and alert evaluation wait for the Gate `G3-02`
  activation preflight, drain/rollback proof, required configuration, and actual
  cost observation
- recorded the remaining implementation architecture directly in the canonical
  [1.0 release execution plan](./plans/v1-release-execution-plan.md#remaining-10-architecture)
  rather than creating another progress tracker

## 2026-09-01 - Creator Releases Moved To A Dedicated Production Origin

- provisioned `games.air-jam.app` additively on the exact production Railway
  platform service while preserving Namecheap email forwarding and every
  unrelated DNS record
- kept the public product experience on `airjam.io`; the new origin is an
  implementation boundary for creator-controlled host and controller documents,
  not a new player-facing navigation or room-code model
- recovered a pre-existing production migration drift from journal `0020` to
  `0033` by creating a rehearsal dump, proving the journal against its isolated
  PostgreSQL 17 restore, then taking a distinct fresh pre-mutation dump after an
  exact write drain
- recorded the real maintenance consequence: an `airjam.io` health probe timed
  out with HTTP `000` after the deployment stop, and the replacement process
  reported ready at `13:41:50Z`; exact outage duration and affected requests
  were not continuously measured
- retained both production dumps under `.airjam/backups/production/` with mode
  `0600` and recorded their exact SHA-256 values in the
  [cutover evidence](./audits/v1-security/hosted-release-domain-cutover-evidence.md)
- merged decision/runbook PR `#79` after its blocking review was corrected and
  confirmed inline on the final green head; merged runtime correction PR `#80`
  after green GitHub checks, green Railway previews, and a final
  `CLEAR TO MERGE` GitHub-native Claude Opus 5 review
- observed exact production deployment
  `e65c8e41-3f72-4078-9ce0-443695d296a2` at terminal `SUCCESS`, serving merged
  revision `ebf63d8a0d5587f27ba59adf48213fb71f20340b`
- proved all six public catalog games use the dedicated origin, the browser
  smoke matrix passes `7/7`, and the canonical provider-authenticated
  attestation passes `20/20` with `productionEvidenceEligible: true`
- kept `G5-02` and `G3-02` open for their broader security, rollback,
  migration-automation, admission, and overload responsibilities

## 2026-09-01 - Trusted CI Entered Critical-Path Optimization

- measured the protected CI baseline at `9m30s` on the final PR revision and
  `11m34s` on the identical merge tree
- found that the confidence stages were serialized even though type safety,
  tests, builds, hermetic deployment proof, and performance validation do not
  share one required artifact
- moved those contracts into isolated parallel lanes behind the unchanged
  required `checks` result and made superseded PR revisions cancellable
- removed the duplicate post-merge exhaustive run because strict branch
  protection already requires an up-to-date green PR merge candidate
- replaced the 90-second warning-only PR benchmark with a 15-second strict
  performance smoke while retaining the full 90-second strict release profile
- removed the canonical guard's external ripgrep installation dependency so CI
  setup is self-contained and faster
- the first parallel run exposed that one CLI test only passed when an earlier
  typecheck happened to leave a generated platform manifest behind; the test
  now creates and removes its own isolated generated fixture
- validated the six-lane graph on successive green PR heads in `3m44s` and
  `3m56s`, with all lanes starting within one second; the exact evidence head's
  `3m48s` test lane was the critical path, making the run `58.6%` faster than
  the protected PR baseline and `66.0%` faster than the duplicate post-merge
  baseline while preserving the same confidence areas

## 2026-08-31 - Development And Review Gates Were Re-Layered

- superseded the same-day exact-head two-local-review policy after it proved too
  slow and duplicated Opus-class judgment without improving the product
- established `check:instant` with a warm `<=1s` target and `check:changed` with
  a warm `<=5s` target as the normal development loop
- moved full typecheck, lint, canonical guards, and tests into the substantial
  pre-push batch gate; exhaustive builds, deployment proof, and perf remain CI
  responsibilities
- limited Canonicalizer to one local session before pushing a substantial
  multi-file, new-system, architectural, or roughly `1,000+` line batch
- moved the only final Opus review to one open, green, merge-ready GitHub pull
  request so findings and line comments remain beside the code
- removed automatic review reruns and local review fixtures from the ordinary
  merge path

## 2026-08-31 - Review, Merge, And Production Delivery Became Canonical

- made the working agreements the sole normative owner for reviewed delivery
- clarified that the maintainer owns product direction, paradigm, scope, taste,
  polish, material risk acceptance, and launch judgment rather than routine code
  review
- assigned implementation assurance to one exact-range Canonicalizer pass and
  one explicit `claude-opus-5` pass for every individual pull request, including
  each stack slice
- made any base or head change invalidate both reviews and required their exact
  SHAs, sessions, resolved models, verdicts, and findings to be attached to the
  pull request
- retained CI and affected provider previews as the mechanically enforced
  GitHub gates; review evidence remains instruction-governed for 1.0
- recorded the maintainer's explicit decision to remove the routine human
  approval requirement while retaining required CI for administrators,
  conversation resolution, and force-push and branch-deletion protections
- required exact affected-service production deployment success plus live
  health, readiness, and revision evidence before calling a rollout complete
- initially considered protected automated review attestation, then dropped it
  from the 1.0 path when the same-day layered-review decision removed the
  duplicate local review model

## 2026-08-31 - Production Platform Recovery Was Verified

- merged corrective PR `#76` only after exact-head Canonicalizer and explicit
  Claude Opus review, GitHub CI, standalone-artifact proof, and every affected
  Railway preview reached a passing terminal state
- observed production platform deployment
  `8dbde4b3-3059-4bfd-8ba6-93deccbde995` reach terminal `SUCCESS`
- proved live `/api/health` reports the exact deployment and merged revision
  `e122a52c1da49ef409364c93fb675df56a4e639d`
- confirmed `/api/readiness` now preserves the explicit disabled
  hosted-release boundary without making Railway process liveness fail
- retained hosted-release domain provisioning and repo-native exact-deployment
  automation as open `G5-02` work rather than conflating them with recovery

## 2026-08-31 - Failed Platform Rollout Entered Controlled Recovery

- confirmed that the platform deployment following PR `#73` reached terminal
  `FAILED` while Railway kept the previous successful revision serving users
- identified two independent deployment blockers: Railway's exact healthcheck
  host was rejected by production host policy, and release-domain readiness was
  incorrectly coupled to process liveness
- found that the build/runtime release-origin guard had only source-level proof;
  its dynamic environment lookup did not provide trustworthy standalone bundle
  attestation
- separated `/api/health` liveness from `/api/readiness`, constrained the
  provider-independent liveness exception to one exact path, and moved
  release-origin inspection and attestation to the readiness contract
- extended the hermetic deploy check to boot the actual standalone production
  artifact and prove both matching-origin readiness and deliberate
  build/runtime drift rejection
- recorded the timeline, evidence, root causes, and remaining production
  closure in the
  [production rollout incident audit](./audits/v1-operations/production-rollout-incident-audit.md)
- opened exact-head Canonicalizer and Claude Opus review; their results remain
  pull-request evidence rather than self-certified historical proof
- kept recovery open until exact-head agent review, merge, terminal Railway
  `SUCCESS`, and live deployment-identity verification are complete

## 2026-08-30 - Public Installation Became A Six-Cell Release Contract

- completed the exact candidate-package proof across Linux, macOS, and Windows
  on both Node.js 22 and 24 without publishing to npm or mutating production
- built and packed the coordinated five-package graph, published it to one
  fallback-free run-scoped registry per cell, and forced `npx` through an empty
  cache so public or workspace packages could not create a false pass
- proved exact lockfile integrity, version discovery, all 26 MCP tools, managed
  development start/status/stop, and generated-project typecheck, lint, tests,
  and production build in all six cells
- established explicit package, graph, scaffold-install, complete-cell, and
  archive-extraction budgets; the graph measured 89,546,135 bytes, the slowest
  scaffold install took 147,076 ms, and the slowest cell took 308,915 ms
- made scaffold archives reproducible and read-only to build, and made
  extraction transactional and bounded against path, entry-count, size, and
  compression-ratio attacks
- removed real cross-platform defects in package-manager launching, managed
  process supervision, Node.js 24 MCP execution, Windows path identity and
  temporary roots, portable tool-version collection, and controller identity
- independently downloaded and re-aggregated all six evidence documents; the
  result matched workflow run `33312857389` for exact PR merge
  `19eb8e41f5bf9a06100d3c5af975a59d1837bd62`
- closed `G6-01` with the
  [public install matrix audit](./audits/v1-public-release/public-install-matrix-audit.md),
  while retaining public npm rehearsal, provenance, promotion, docs, demo, and
  launch-story work in later Gate 6 and Gate 7 items

## 2026-08-30 - Gate 4 Gained A Durable Reliability Loop

- implemented one transactional operational outbox and immutable event store
  with bounded leases, retry scheduling, dead-letter state, expired-lease
  repair, stable idempotency, and audited operator requeue
- extended the shared operations contract from seven to thirteen discoverable
  schemas for structured failures, synthetics, SLO evaluations, and alerts
- added redacted structured-failure producers across the platform request
  boundary, server auth/runtime paths, and hosted SDK runtime boundary; hosted
  clients contribute non-authoritative evidence while room, role, game, and
  session identity remain server-owned
- implemented six launch-critical synthetic journeys feeding four explicit SLO
  policies and durable opening, continuation, and recovery alert state
- integrated reliability draining, synthetics, SLO evaluation, and alert work
  into the operational worker with per-subsystem readiness and health checks
  for release storage, moderation, and hosted-runtime availability
- exposed status, inspection, delivery, synthetic, SLO, alert, and safe requeue
  operations through the canonical repo CLI with stable JSON output
- proved the storage lifecycle and all six synthetic stories against real local
  PostgreSQL in addition to focused SDK, server, platform, and CLI suites
- retained the next boundary honestly: incident correlation, notification and
  GitHub issue adapters, governed remediation, and deployed failure drills
  remain later Gate 4 work

## 2026-08-30 - Hosted Release Isolation Became Safely Attestable

- added one repo-owned `platform release-origin attest` lifecycle that produces
  stable JSON for an exact deployed host/controller release pair without
  executing creator JavaScript on the maintainer machine
- rejected the initial local-browser attestation design during hostile review;
  arbitrary deployed browser execution remains owned by the future hardened
  browser-worker boundary rather than an unsandboxed operator process
- converged remote inspect and attest onto one DNS-resolved, address-policy
  checked, DNS-pinned, TLS-server-name-preserving, logically bounded transport
- made attestation independently prove conservative cookie-site separation,
  exact host/controller redirects and response policy, cookie absence, the real
  Better Auth anonymous-session boundary, representative protected API CORS and
  preflight denial, and stable deployment-reported identity
- centralized release response and cookie-site policies so runtime validation
  and deployed evidence cannot silently define different security boundaries
- separated transport candidates from production eligibility; Railway must
  independently match an explicit expected project, production environment,
  current successful platform-service deployment, and both public domains
- bounded Railway GraphQL and TLS requests and covered never-resolving provider
  calls, private/reserved/mixed address families, IPv6 loopback diagnostics,
  shared cookie sites, malformed contracts, policy drift, and provider mismatch
- retained the known DNS limitation honestly: Node's OS `getaddrinfo` cannot be
  cancelled after the logical five-second race, though no request proceeds and
  the command promise no longer waits for that resolver result
- kept `G5-02` open: the dedicated production release domain still has to be
  provisioned and attested, and controlled hostile-browser plus normal-game
  proof must remain green against the approved candidate

## 2026-08-30 - Hosted Releases Gained A Fail-Closed Origin Boundary

- implemented the first `G5-02` security slice as a stacked, production-valid
  change while keeping the readiness item open for deployment proof
- removed the authenticated platform origin fallback and the two superseded
  release-origin variables; `AIRJAM_RELEASES_PUBLIC_ORIGIN` is now the one
  canonical contract
- made production require an explicit cross-site HTTPS origin outside the
  platform cookie site and every exact or wildcard Better Auth trusted origin
- separated platform and untrusted-release response policy, centralized the
  host/controller iframe sandbox, and blocked top-navigation and popup escape
- added one repo-owned, secret-free operator surface for local and deployed
  inspection: `pnpm run repo -- platform release-origin inspect`
- corrected adversarial-review findings before integration:
  - request routing now derives authority from the incoming `Host`, not Next's
    server-derived request URL
  - unknown production hosts fail closed
  - platform-to-release redirects are temporary and non-cacheable
  - build/runtime platform-origin drift makes health fail
  - the exact `/releases` boundary is covered
  - valid deployed `503` health documents remain machine-inspectable
- proved the local boundary with unit suites, a real Next server receiving
  explicit Host headers, and a hostile browser fixture that cannot reach
  platform storage, cookies, parent DOM, authenticated API responses, or top
  navigation while the normal Pong bridge still works
- retained the external closure honestly: the dedicated provider domain,
  actual hosted-route proof, and deployed cookie/CORS/header attestation remain
  required before `G5-02` can be completed

## 2026-08-30 - Gate 5 Received A Ranked Security Threat Model

- completed three independent read-only audits across public/artifact,
  privileged/agent/provider, and supply-chain/privacy surfaces, then
  deduplicated them into one canonical register
- confirmed one critical launch blocker in source and production configuration:
  creator-controlled hosted game code falls back to the authenticated platform
  origin and is not effectively sandboxed from platform authority
- ranked thirteen high-priority and three defense-in-depth threat groups with
  exact evidence, current controls, canonical end states, readiness ownership,
  and adversarial proof requirements
- used the repo-owned Railway surface to attest current production service and
  non-secret variable-name state without printing credential values; worker
  tokens are present, while a dedicated hosted-release origin is not
- preserved verified strengths including strict ZIP validation, scoped release
  inspection tokens, database-backed ops roles, local machine-token file
  protection, telemetry minimization, and package provenance foundations
- mapped every accepted finding onto existing `G5-02`, `G5-03`, and cross-gate
  work instead of creating a duplicate Markdown task tracker
- selected dedicated cookieless untrusted-content origin isolation and a
  hostile-release browser proof as the first Gate 5 implementation slice

## 2026-08-30 - Gate 4 Operational Authority Contract Closed

- defined one versioned runtime contract that keeps approximate product
  telemetry, authoritative lifecycle/runtime evidence, and correlated incident
  state in separate authority planes
- added strict schemas and TypeScript declarations for operational events,
  correlation, evidence, incidents, runbook descriptors, immutable previews,
  invocations, and action audit records
- made incident fingerprints deterministic and self-verifying so a record
  cannot claim an identity inconsistent with its normalized failure scope
- bound runbook apply to the exact descriptor, parameters, preview digest,
  incident context, expiry window, ordered actions, and declared resource and
  cost blast radius
- made approval, bounded-automation actor authority, terminal evidence,
  rollback identity, chronology, retry ceilings, and state transitions fail
  closed
- exposed the complete catalog, Draft 7 JSON Schemas, and redacted runtime
  validation through the canonical repo CLI
- retained the implementation boundary honestly: durable producers, outbox,
  incident persistence/correlation, notifications, GitHub issue delivery, and
  runbook execution remain later Gate 4 slices

## 2026-08-30 - Product Storage Gained A Durable Lifecycle

- generalized operational jobs from mandatory release scope to canonical
  release-generation or game-media resource identity
- added exact preview and idempotent batch scheduling for failed or abandoned
  generations, stale uploads, failed media, and archived unassigned media
- made the platform operational worker schedule and execute cleanup through the
  same bounded claim, lease, retry, drain, and readiness authority as release
  work
- persisted the first exact object manifest and reused it across retries, so a
  partial deletion can resume without sweeping objects created after the
  original decision
- fenced live, candidate, promoted, assigned, and newly inactive resources out
  of cleanup under database locks
- added a database-enforced media inactivity clock with legacy backfill so the
  24-hour window begins at failure or archive rather than original upload
- added storage tombstones and excluded only committed deletions from managed
  storage quota accounting
- exposed redacted cleanup preview/apply and resource-filtered job inspection
  through the canonical repo CLI
- renamed the separately deployable process and runtime entry from release-job
  worker to operational-job worker after it gained lifecycle responsibility
- proved fresh migration, seeded legacy upgrade, partial-delete retry, late-
  object preservation, media integrity, release replay, and quota behavior
- kept `G3-02` active for warned long-term unpublished-artifact retention,
  realtime admission, overload proof, and explicit production rollout

## 2026-08-30 - Hosted Release Processing Left The Request Lifecycle

- replaced synchronous upload finalization with one generation-scoped durable
  graph for artifact processing, browser validation, and image moderation
- added strict versioned executor payloads, immutable attempt identity,
  attempt-scoped output roots, lease-aware completion, and exact-generation
  fences around every external side effect
- added the separately deployable platform operational worker with database-gated
  readiness, liveness, authenticated drain, signal handling, bounded
  concurrency, expired-work repair, and terminal-output cleanup
- made superseding generations cancel or request cancellation of their active
  jobs atomically before abandonment
- converged dashboard, API, SDK, CLI, and MCP on enqueue-and-inspect semantics;
  submission returns its job, explicit wait follows the exact generation, and
  publish waits for readiness
- exposed cleanup and one-cycle execution through the canonical preview-first
  repo CLI so agents can inspect, recover, and operate the same worker domain
- made the standalone deployment proof secret-free and verified that the
  packaged worker loads with its official Playwright runtime dependency
- proved fresh and legacy migrations, crash/retry isolation, the full three-
  stage pipeline, worker drain/readiness, redaction, platform tests, repo
  contracts, build, and hermetic runtime loading
- kept `G3-02` active for broader lifecycle cleanup, realtime admission, load
  and overload proof, and the explicit production migration/worker rollout

## 2026-08-30 - Hosted Releases Gained Immutable Generations

- replaced the one-row mutable release artifact model with release-local,
  monotonic generations and explicit candidate/promoted pointers
- gave source ZIPs, extracted sites, and screenshots unique create-only object
  identities; finalization records first-observed facts and conditionally reads
  the exact observed ETag
- fenced stale and superseded generations from processing, promotion, failure,
  moderation completion, publishing, and public serving
- attached every trusted release check to its exact generation and enforced
  same-release provenance through composite PostgreSQL foreign keys
- converged dashboard, operations, public serving, quotas, application services,
  machine API, SDK, CLI, and MCP on the generation-native contract while
  removing the old artifact table and release-wide finalize endpoint
- made migration preflight abort on incomplete ordinary legacy evidence before
  mutation, while explicitly archiving and hiding only the canonical fake
  preview placeholder
- proved fresh migrations through `0028`, a valid legacy upgrade, preview and
  interrupted-state conversion, and transactionally unchanged abort behavior
  for an incompatible live legacy artifact
- ran the same compatibility predicate read-only against production: all 33
  real artifacts are admissible, the sole incomplete artifact is the canonical
  preview placeholder, and no publicly eligible release lacks metadata
- made public paths generation-specific, counted every retained generation
  toward storage quota, and removed private object keys and raw check payloads
  from machine projections
- exposed granular upload/finalize recovery across CLI and MCP and repaired the
  source-mode helper launcher used by agent-contract and visual tooling
- kept request-driven execution explicit until versioned executor contracts,
  job-attempt identity, lease-aware completion, and the separate worker process
  replace it end to end

## 2026-08-30 - Durable Release Work Gained PostgreSQL Authority

- added separate artifact-processing, browser-validation, and image-moderation
  job kinds with source-owned queue, concurrency, lease, deadline, attempt, and
  retry bounds
- added creator/game/release scope integrity, one-active-resource exclusion,
  append-only revisioned events, fenced claims and heartbeats, bounded retry,
  cooperative cancellation, replay lineage, and expired-lease recovery
- replaced scattered event/job idempotency with one global immutable command
  ledger, including stable replay for empty repair batches and cross-kind races
- made PostgreSQL time authoritative for production leases, capped leases at
  absolute deadlines, synchronized claims with persisted lane pause, and
  separated redacted operator projections from lease-bearing worker records
- enforced same-release check provenance and deterministic cascade semantics
  in PostgreSQL rather than trusting application joins
- exposed policy, queue status, list, inspect, cancel, replay, and repair through
  the canonical preview-first repo CLI
- proved all migrations through `0026`, twenty-three focused policy/PostgreSQL tests,
  and five CLI contracts on a fresh native cluster, including a real
  database-backed secret-redaction proof
- kept release adapters off the queue until immutable upload generations and
  attempt-scoped outputs make R2 side effects safe under crash/replay
- kept concurrent-job quota authority unavailable until legacy synchronous work
  is fully removed rather than falsely counting only the new table

## 2026-08-29 - Free-Cloud Quotas Became Authoritative And Observable

- encoded every ratified creator/game allowance in one versioned source
  catalog, including semantic `game_creation` and `game_listing` lanes
- derived games, listing, retained storage, release submissions, browser
  validations, and room time from lifecycle/runtime authority rather than
  approximate product telemetry or caller-submitted counters
- made missing durable-job and global-realtime concurrency owners explicitly
  unavailable instead of reporting process-local state as exact
- added one evaluator that combines lane mode, fresh budget evidence, scope
  usage, and requested amount into `allowed`, `shadow_denied`, or `denied`
- exposed creator/game status and prospective admission checks through the
  canonical repo CLI without limit, usage, state, or outcome overrides
- used a fresh PostgreSQL cluster to catch and fix timestamp-typing and scope-
  aggregation defects, then passed the full migration and authority proof
- kept enforcement unwired while observations accumulate; durable queues,
  adapter wiring, cleanup, realtime admission, and overload proof remain

## 2026-08-29 - Provider Spend Became Immutable, Derived, And Agent-Operable

- added project-scoped Railway usage evidence with raw measurements, exact
  rate-card identity, actual and projected micro-USD totals, provider scope,
  collector, reason, freshness, and immutable idempotent replay
- encoded the ratified ordinary and launch threshold ladders in reviewed source;
  callers cannot submit budget state, raise a threshold, or activate launch
  headroom through runtime configuration
- exposed budget status and preview/apply sync through the canonical repo CLI,
  including safe remote-database targeting and stable JSON
- proved the complete migration, concurrent ingestion, conflicting replay,
  provider read, preview, apply, status, and command-level retry lifecycle on a
  fresh isolated PostgreSQL cluster without mutating production
- measured `$7.203280` actual and `$8.610859` projected current-cycle Railway
  usage, both in the ordinary `normal` state
- kept `G3-02` active for shadow/enforced quotas, durable queues, lifecycle
  cleanup, realtime admission, and overload proof

## 2026-08-29 - Production Lane Controls Became Persistent And Agent-Operable

- defined one canonical production-control contract for lane state, budget
  response, quotas, durable jobs, lifecycle cleanup, and machine operation
- added persistent lane controls plus append-only mutation events with actor,
  reason, before/after state, optimistic revision, and idempotent replay
- exposed the control lifecycle through the canonical repo CLI with stable JSON,
  Railway-environment targeting, read-only preview by default, and explicit apply
- routed release submission, artifact and media ingestion, release processing,
  browser validation, moderation, and telemetry through one application-service
  admission authority shared by human and machine transports
- made paused and unavailable control decisions fail closed with typed `503`
  details and retry guidance instead of transport-specific arbitrary errors
- proved the migration, concurrent revision safety, idempotent event replay, and
  real CLI mutation against an isolated temporary PostgreSQL instance
- kept `G3-02` explicitly active: budget evidence, shadow/enforced quotas,
  durable jobs, cleanup, realtime admission, and overload drills remain required

## 2026-08-29 - Production Cost And Recovery Became Measured

- inventoried the live Railway topology, deployments, usage, memory, traffic,
  database, volume, backups, rollback eligibility, and provider controls
  without changing production
- measured the last complete Railway cycle at `$7.99` and the current cycle at
  an approximately `$8.43` linear projection, separating today's affordable
  steady state from launch-spike risk
- measured `0.631 GB` across 654 R2 objects and showed that archived and failed
  releases retain most of their artifacts while one media upload has remained
  incomplete since March
- confirmed that Postgres has ample current headroom but no recurring backup
  schedule or isolated restore proof, and that Railway's compute cap protects
  the shared workspace rather than Air Jam alone
- mapped every expensive lane to its existing bounds, missing launch control,
  and owning Gate 3 or Gate 4 work item
- kept realtime single-replica scaling honest, selected durable bounded release
  jobs plus isolated cached artifact delivery as the production-valid path, and
  rejected permanent always-on staging until repeated rehearsals justify it
- closed `G3-01` as a measured baseline only; quotas, queues, cleanup, lane
  switches, backups, restore, rollback, replay, and load proof remain explicit
  implementation work

## 2026-08-29 - Readiness Evidence Became Immutable And CI-Portable

- traced the post-review CI failure to repository-history evidence that passed
  in a full local clone but could not resolve in GitHub's default shallow
  checkout
- kept existence validation fail-closed rather than weakening the evidence
  contract to syntax-only acceptance
- migrated git evidence to full immutable commit SHAs, made abbreviated refs
  invalid, and gave the CI validation lane complete repository history
- added regression coverage for both immutable ref enforcement and the CI
  checkout requirement
- passed the complete local `pnpm check:ci` pipeline, including generated
  sources, type checks, lint, canonical guard, package tests, builds, and the
  multiplayer performance sanity run

## 2026-08-29 - Integration Review Hardened The Proof Boundaries

- accepted the second independent review of cumulative pull request `#61` and
  corrected the findings at their owning contracts instead of treating them as
  isolated test edits
- made the Docker workspace guard discover every Dockerfile and prove that each
  required manifest copy occurs in the exact stage, before the frozen install
- replaced platform-only secret checks with an environment-wide Railway proof:
  every application service must have a distinct provider instance, every
  service's rendered variables are compared, and equal production values fail
  closed unless explicitly classified as harmless metadata or process tuning
- tied the release-browser endpoint to the staging worker, preserved the
  runtime's endpoint-dependent token semantics, and stopped emitting origin
  evidence until the separate domain comparison actually succeeds
- made retained evidence replacement rollback-safe, sanitized every UTF-8
  artifact regardless of extension, and rejected binary evidence instead of
  mirroring it without redaction
- consolidated child-process teardown and the standalone MCP tool contract,
  bounded final cleanup and the primary Codex wall clock, and made missing
  isolated-toolchain binaries fail with direct errors
- added CLI and MCP package suites to the root CI contract, repaired the
  canonical generated-content workflow command, validated template package
  versions and typed artifact evidence, and aligned flexible scaffold lint
  ownership with bootstrap validation
- retained `G2-03` as blocked: stronger proof changes what the controller can
  safely certify; it does not make the current production-derived preview
  credentials admissible

## 2026-08-29 - Cumulative Integration Entered Provider Preview

- opened pull request `#61` as the single corrected integration target for
  review slices `#52` through `#60`; merging the component stack bottom-up is
  no longer the delivery path
- kept integration separate from stable package promotion, public release
  visibility, final launch material, and HN distribution
- let the existing Railway PR-deploy policy create a disposable environment
  instead of provisioning permanent staging
- used provider build logs to find that the platform Docker dependency stage
  omitted the new `@air-jam/database-contract` workspace manifest, allowing a
  populated local install to mask missing `drizzle-orm` dependencies
- corrected both production Docker dependency stages and added a repo contract
  that derives every pnpm workspace manifest and rejects future omissions
- safely compared provider variables without printing or retaining their values:
  the PR environment has distinct Postgres but reused the production R2 bucket,
  R2 credentials, release-pipeline tokens, and other sensitive values
- hardened the golden-path admission contract to reject reused
  production-capable credentials even when a future environment uses a
  different bucket name
- retained the remaining staging constraint explicitly: the controller still
  needs an identity that can attest the bot-created environment plus genuinely
  isolated storage and credentials before it may start the external agent

## 2026-08-29 - Golden-Path Staging Authority Became Provider-Owned

- stopped the next `G2-03` replay before external-agent startup because the old
  PR-52 hostname returned platform health while Railway reported no remaining
  ephemeral environment
- removed URL-only staging trust from `golden-path run-primary`
- made the canonical CLI require Railway project and environment identities,
  reject the primary/base environment, resolve the canonical platform service
  and a domain distinct from production, verify environment identity plus
  distinct Postgres and release-storage resources, require a successful
  deployment and health response, and retain that non-secret provider
  attestation
- kept Railway credentials in the controller boundary; the isolated Codex child
  receives only the verified staging URL
- left environment provisioning separate and explicit so the proof harness
  cannot silently create recurring infrastructure cost

## 2026-08-29 - Independent Review Re-Proved Public Bootstrap Provenance

- reopened `G2-02` after review showed the original registry proof checked
  versions and configured registry state but did not positively bind installed
  bytes to the exact tarballs packed by that run
- added SHA-512 provenance checks across packed artifacts, run-scoped registry
  metadata, direct generated-project resolutions, and pnpm lockfile integrity
- required all generated lifecycle scripts, all `24` standalone MCP tools, and
  the lint gate instead of filtering/reporting partial capability
- replaced duplicate unsafe MCP stream readers with one bounded shared probe
  that rejects malformed output without leaking its child process
- bounded bootstrap commands and workspace-build locks and made managed-dev
  cleanup eligible before parsing command output
- discovered and fixed a public topology defect where Vite honored a custom
  `VITE_PORT` but `airjam topology` still advertised `5173`
- passed the full strengthened clean-registry bootstrap with managed
  start/status/stop plus generated-project typecheck, lint, tests, and build

## 2026-08-29 - Independent Review Reopened G2-03 And Fixed The Merge Model

- accepted the independent review finding that the original primary-run
  verifier could trust agent-authored proof and retained its only detailed run
  bundle in an ignored local path
- reopened `G2-03` instead of preserving a completion claim that another
  reviewer could not reproduce
- hardened controller-owned isolation, quality, cleanup, release-verification,
  packaged-helper, machine-session, and readiness contracts on the cumulative
  branch
- passed the complete local CI gate on the corrected head and retained the
  review correction in the canonical primary-run audit
- established that pull requests `#52` through `#60` remain focused review
  slices but will close through one corrected cumulative integration pull
  request because the fixes cross the original stack boundaries
- separated incremental production delivery from the coordinated 1.0 launch:
  code and hidden/prerelease surfaces are exercised before launch, while stable
  package promotion, public visibility, final docs, the article, and
  distribution remain one exact-candidate event
- recorded the remaining policy checkpoint: automated issue comments are not
  formal GitHub approvals, and the solo-repository approval rule must be
  satisfied legitimately or changed explicitly rather than silently bypassed

## 2026-08-29 - Gate 2 Retained The Primary External-Agent Run

- ran nine clean-room controller attempts and retained every material failure
  instead of converting partial execution into a success claim
- proved that a credential-free Codex process can discover the public packages,
  canonical CLI, generated guidance, SDK contracts, MCP, semantic sessions, and
  release surface from an empty directory with repository reads denied
- independently built a polished, host-authoritative Signal Relay game with a
  pure domain core, stable semantic actions, presentation-only host/controller
  surfaces, and the exact `WIN_SCORE = 3` contract
- passed typecheck, lint, five focused domain tests, and production build in the
  final retained attempt, then started and safely stopped managed local dev
- fixed the clean-room defects exposed along the way: controller permissions,
  workspace/caches, durable evidence mirroring, helper launch transport,
  canonical scaffold lint and pnpm metadata, single-writer install guidance,
  disclosed evidence schemas, and classified-blocker verification
- independently verified `g2-03-20260829-a9` as `blocked` at the one remaining
  local boundary: macOS denied Mach-port registration to both bundled Chromium
  and system Chrome inside the managed Codex permission profile
- retained twenty-five manifest-indexed artifacts plus the verifier report,
  removed the run-scoped registry and credentials, and preserved the workspace
  for inspection
- handed the canonical browser-runtime/broker solution, run-scoped staging
  identity, and exact passing replay to `G2-05`; no staging or production
  release was submitted

## 2026-08-28 - Gate 2 Proved The Exact Candidate Bootstrap Outside The Monorepo

- built and packed the canonical five-package public release graph, then
  published the exact tarballs to an authenticated run-scoped loopback registry
- disabled upstream fallback for all Air Jam packages so a missing candidate
  package fails instead of resolving an old public release
- scaffolded and installed a clean minimal project with no `workspace:`,
  `link:`, `file:`, or private monorepo path resolution
- discovered the installed project CLI, root development lifecycle, semantic
  session and release commands, portable MCP declaration, and project-scoped
  Codex profile
- initialized the packaged MCP server over raw STDIO, verified all `24` tools,
  and exercised managed dev start, status, and stop
- passed the generated project's typecheck, tests, and production build, then
  removed the run-owned workspace, registry, credentials, and processes
- fixed MCP identity drift by deriving the announced server version from its
  shipped package manifest and added client-level regression coverage
- aligned the local candidate set with the public release graph so
  `@air-jam/cli` cannot silently disappear from clean-room proofs
- kept the registry harness compatible with the repository's Node 20 CI floor
- measured `create-airjam` at `87,264,734` packed bytes; this is functional but
  material launch friction, and Gate 6 retains the explicit package-size and
  cold-install decision
- passed `33` repository contract tests, the full workspace typecheck, the
  MCP server's `8` tests, lint with one pre-existing ignored vendored warning,
  and the complete isolated-registry proof at implementation commit `511ee85`
- published no npm package and changed no production infrastructure

## 2026-08-28 - Gate 2 Received A Replayable External-Agent Proof Contract

- fixed one machine-readable Signal Relay scenario across ten ordered stages:
  preflight, create, discover, build, control, inspect, repair, evaluate,
  release, and verify
- separated the supported-client claim into Codex's complete lifecycle proof
  and Claude Desktop's independent local MCP installation, discovery, and
  semantic-session proof
- defined a strict clean room: registry packages only, no monorepo/private
  paths or docs, run-scoped identities/configuration, and no maintainer-authored
  product edits after the agent starts
- added one deterministic `WIN_SCORE` mutation so inspect-diagnose-repair is
  repeatable without turning the release claim into an unbounded self-healing
  promise
- required a normalized, digest-indexed evidence bundle with commands,
  sessions, logs, quality, visuals, release facts, retained failures, redaction,
  cleanup disposition, and independent verification
- structurally disabled production publishing and required isolated hidden
  staging for the release stage
- aligned client assumptions with current official vendor guidance: Codex's
  project-scoped STDIO MCP configuration is supported, while Claude Desktop's
  preferred Desktop Extension path still needs independent Air Jam proof
- exposed the contract through `pnpm run repo -- golden-path spec|validate`
  with stable JSON and tests that reject unsafe publication or stage drift
- passed canonical guard, full typecheck, lint with one pre-existing ignored
  vendored warning, and all `32` repository contract tests
- published nothing and changed no production infrastructure; Gates `G2-02`
  through `G2-05` retain responsibility for actually passing the scenario

## 2026-08-28 - Gate 1 Closed From An Exact Clean Checkout

- closed canonicalization bundle `R5` at
  `da835f650d929c5873bf55e8e5db2e8df5c74f81`
- found and removed five populated-worktree assumptions: ignored CLI build
  output, runtime-heavy help discovery, ignored hosted generated artifacts,
  undeclared hoisted contract-runner dependencies, and a browser smoke path
  that could not honor the canonical executable override
- made all three independently published CLI wrappers execute packaged output
  when installed and bootstrap only their owning package when run from a clean
  source checkout
- proved the complete clean-checkout matrix: frozen install, generated
  determinism, canonical guard, lint, `29` repo contracts, hermetic platform
  deployment, all typechecks/tests/builds, strict realtime performance, `17`
  server smoke tests, `4` real-browser scenarios, and all six packed scaffolds
- measured strict realtime at `20,553` events sent and received, `0%` loss,
  `227.10` events/second, and `2.04 ms` p95 latency
- measured the exact Gate 1 authored delta at `+10,872 / -16,922` (`-6,050`
  net) across production source, tests/guards, and docs/guidance
- reported `6,170` generated Drizzle snapshot lines and six binary scaffold
  archives separately; generated churn is why the raw numeric repository diff
  is slightly positive despite the authored reduction
- recovered from local disk exhaustion by removing only ignored build/test
  output in the disposable proof checkout, then passed browser and scaffold
  gates against the same commit
- published no packages and changed no production infrastructure

## 2026-08-28 - Gate 1 R4 Established Platform Application Authority

- completed the six-commit implementation range `f7eff9d..fb59754`
- removed generic release/media status writers and placed creator UI, ops UI,
  and machine HTTP over shared actor-aware application services
- made PostgreSQL authoritative for one-live-release and active-ready-media
  invariants, including explicit concurrent and invalid-write integration proof
- extracted `@air-jam/database-contract` so platform and realtime server compile
  against one physical runtime-usage schema while platform remains the only
  migration owner
- replaced Arcade launch/close callback-ref synchronization with one stateless
  semantic event/effect orchestrator without adding another state model
- covered room reset, launch/ack/failure, restore, history back, explicit exit,
  and server child close with deterministic scenarios
- verified the visible local lifecycle through the canonical `pnpm run dev`
  path: deep-link launch, embedded game render, Back-to-browser server close,
  and browser-card relaunch all converged
- passed platform typecheck/lint, `211` platform tests, `28` repo contracts, and
  `3` explicitly configured real-PostgreSQL invariant tests
- measured the non-generated implementation at `+2,131 / -1,469` production
  and operational lines, with `+777 / -1` test/contract lines
- left no R4-scoped debt; R5 now owns final clean-checkout crystallization

## 2026-08-28 - Gate 1 R3 Made The Public Harness Actually Agent-Operable

- completed bundle `R3` at
  `bf7d0630097638deec919f01f5bbc4e3e50a627d`
- followed with clean-checkout corrections `4980af1` and `59d5657` so the
  CLI-owned AI-pack manifest is committed and `pnpm run dev` remains the
  executable default agent/human development front door
- turned `create-airjam` back into a one-shot bootstrap package and created one
  installed `@air-jam/cli` owner for ongoing project lifecycle
- removed all project lifecycle commands and copied runtime implementations
  from `@air-jam/server`; its binary now owns server start and unified logs only
- added persistent JSON semantic sessions to the CLI over the same typed
  devtools services used by MCP, including safe broker inspection and shutdown
- separated portable MCP declaration from Codex and Claude Desktop profiles
  without mutating global client configuration implicitly
- moved managed framework references into `docs/airjam/` and made generated
  root instructions and local skills project-owned after scaffolding
- narrowed the SDK root to the intended framework API and isolated raw platform
  composition under the explicit `@air-jam/sdk/arcade/runtime` leaf
- added real semantic conformance for all six scaffoldable games
- proved the packed public boundary from an isolated Pong scaffold: dependency
  install, CLI and MCP discovery, raw MCP initialize/tool listing, semantic
  session open/read/close, typecheck, `22` tests, and production build
- found and fixed two failures that workspace-only checks had hidden:
  - the published MCP ESM bundle had inlined a CommonJS ZIP dependency that
    crashed on `require("fs")`
  - one parallel repo test rebuilt and cleaned shared SDK output while another
    test imported it
- closed with frozen install, generated freshness, all focused package tests,
  `134` server tests (`2` skipped), `260` SDK tests, `202` platform tests, full
  workspace build, and performance sanity
- recorded an implementation shape of `-980` net production/operational source
  lines, `+352` net test/guard lines, and `+24` net documentation/guidance lines;
  six generated scaffold archives remain outside line-count claims
- removed `2.6 GB` of old reproducible local tarball-set cache after the disk
  filled during the production build; no source, database, or user-authored
  content was removed
- published nothing and changed no production infrastructure

## 2026-08-28 - Gate 1 Canonicalization Removed Two Duplicate System Families

- established exact baseline `18ca38957c19c7ee5d9e39aac2bb91f0393a8902`
  so cleanup claims exclude earlier roadmap, telemetry, story, and audit work
- completed bundle `R1` at `958e071829dc9794484ded4f8cdc9f98b3af6217`:
  removed the duplicate runtime-topology package, dormant SDK control and
  observability seams, empty Studio placeholder, and bot-lab workspace coupling
- completed bundle `R2` at `408fdbf45c123dc60e4721e137f7fa43e955fb60`:
  removed the production visual command bus, browser action bridge, unreachable
  MCP visual definitions, speculative capability manifest, and pre-1.0 runtime
  compatibility paths
- made semantic game sessions the only state/action automation model, runtime
  inspection the source of mounted-runtime facts, and browser scenario capture
  visual proof only
- recorded a combined bundle shape of `+687 / -8,199` lines across production
  source, tests, and docs, with exact category evidence retained in the
  [canonicalization execution set](./audits/v1-canonicalization/canonicalization-execution-set.md)
- preserved the user's local bot-lab files and performed no package publish or
  production deployment

## 2026-08-28 - Gate 0 Ratified The Air Jam 1.0 Product And Operating Contract

- ratified `Air Jam` as the one public product name and retired `Air Jam
Studio` as a primary 1.0 name
- defined the shipped capability as the free agent-operable development
  harness, with terminal and MCP profiles as the portable client contract
- selected Codex for the complete external-agent lifecycle proof and Claude
  Desktop for the independent desktop MCP proof
- kept 1.0 completely free without payments, checkout, credit cards, player
  paywalls, or expiring trials
- set generous shadow-first hobby allowances and made active gameplay the last
  lane degraded under pressure
- bounded variable infrastructure at `$100` in an ordinary month and `$150` in
  the 1.0/HN launch billing cycle against a measured Railway baseline of about
  `$8` per month
- selected a `100`-room sustained launch target with a required three-times
  burst proof before it becomes a public support claim
- allowed only bounded, reversible, verified stateless/provider recovery for
  1.0; production code promotion and budget increases remain approval-gated
- recorded the maintainer approval as canonical `G0-03` decision evidence and
  aligned the live vision, framework, operations, hosting, and release
  references with the ratified terminology

## 2026-08-26 - The 1.0 Roadmap Became A Machine-Operable Execution Program

- added the subordinate
  [1.0 release execution plan](./plans/v1-release-execution-plan.md) without
  weakening the release roadmap as the product and gate authority
- created one versioned machine execution manifest with 42 dependency-aware
  work packages across all eight gates and a `285-520` agent-hour planning
  envelope
- concentrated maintainer judgment into six batched checkpoints instead of
  making normal implementation repeatedly wait for informal validation
- kept production publication behind explicit approval items while allowing
  local, preview, staging, audit, test, and evidence work to continue
  autonomously
- added the canonical `pnpm run repo -- readiness` surface for stable JSON
  status, ready-work selection, inspection, validation, and preview/apply status
  transitions
- required ownership for active work, typed blockers, retained evidence for
  completion, explicit decision evidence for human checkpoints, and terminal
  evidence for production work
- made ready state dependency-derived so a blocked external or human item does
  not stop independent lanes
- aligned `AGENTS.md`, working agreements, documentation taxonomy, monorepo OS,
  docs navigation, current state, roadmap, and README with the new operating
  contract

## 2026-08-26 - The Free Product Economics Were Bounded Without Paywalling Creation

- ratified that the framework and complete agent-operable development harness remain
  free, with creators normally bringing their own model client, compute, or
  cloud account
- preserved self-hosting and bring-your-own-cloud as first-class escape hatches
  so adoption does not automatically become an Air Jam infrastructure liability
- defined the official free cloud as genuinely useful for ordinary hobby use
  while bounded by an explicit monthly learning budget, quotas, queues, spend
  alerts, safe degradation, and kill switches
- rejected an arbitrary signup count such as 1,000 as the monetization trigger;
  future paid experiments instead follow measured activation, retention,
  provider cost, repeated play, real limit pressure, and user requests for
  professional value
- established the emotional contract that normal hobby use should feel
  generous and an active social session should never be interrupted by a
  surprise paywall
- prioritized eventual revenue from event capacity, agencies and support,
  managed-cloud convenience, teams/private/analytics, and only later a proven
  premium Arcade catalog or marketplace
- prohibited maintainer-funded creator payout liabilities; any reward pool must
  be capped and funded by realized revenue or sponsors before playtime can
  allocate it
- retired speculative fixed price points until actual unit economics and demand
  are measured
- recorded the full durable policy in the
  [deployment and monetization strategy](./strategy/deployment-and-monetization-strategy.md)
  and made the remaining numeric decisions part of Gate 0 in the
  [1.0 release roadmap](./plans/v1-release-roadmap-plan.md)

## 2026-08-26 - The 1.0 Release Track Was Re-Baselined Around The External-Agent Harness

- replaced the narrow final-proof-and-publish v1 plan with the
  [Air Jam 1.0 release roadmap](./plans/v1-release-roadmap-plan.md)
- preserved the superseded plan as the
  [pre-roadmap snapshot](./archive/2026-08-26-v1-release-plan-pre-roadmap.md)
- recorded the clarified development-harness thesis:
  - Air Jam owns the complete creation, runtime, inspection, evaluation, and
    release harness
  - Codex, Claude Desktop, T3 Code, terminal agents, and future clients connect
    through public CLI, MCP, and typed contracts
  - the hosted UI is an optional control room, not a mandatory authoring model
- defined a public 1.0 promise centered on a clean-machine external agent
  completing the full create/run/control/inspect/fix/evaluate/publish lifecycle
- expanded the release bar into evidence-backed gates for:
  - product and architecture re-baselining
  - codebase and contract canonicalization
  - external-agent golden-path proof
  - launch-scale reliability and recovery
  - event-driven incident automation and bounded remediation
  - security, abuse, privacy, and supply-chain trust
  - public packages, docs, demo, article, rehearsal, and launch
- explicitly separated approximate product telemetry, authoritative
  lifecycle/runtime events, and operational incidents so future autonomy does
  not use discovery analytics as a correctness authority
- kept full code-changing self-healing, a mandatory hosted AI editor, universal
  agent integration, and speculative million-user topology outside the 1.0
  blocking scope

## 2026-08-26 - First-Party Product Telemetry Replaced The Dormant Analytics Path

- replaced the unused external website-analytics adapter with one small,
  platform-owned telemetry plane shaped around Air Jam's discovery questions
- landed a closed, versioned event contract for canonical page views, quick
  start, scaffold copy, Arcade entry, GitHub/npm intent, and server-observed
  agent-resource reach
- kept anonymous session identity ephemeral and memory-only, with no cookies,
  browser storage, fingerprinting, raw IP persistence, full user-agent storage,
  full URLs, query strings, raw referrers, or arbitrary metadata
- added hardened same-origin ingestion, trusted-proxy-aware transient
  throttling, append-only evidence, idempotent transactional projection,
  deterministic rebuild, and explicit 90-day raw/session-contribution
  retention
- added an ops-only 7/30/90-day report that visibly separates approximate
  product telemetry from authoritative platform lifecycle and runtime usage
  facts
- exposed the full telemetry operator lifecycle through the canonical repo CLI:
  authority-separated overview, storage/retention health, deterministic rebuild,
  and retention, with stable JSON and explicit preview/apply mutation semantics
- made agent-first operability a durable repo rule: UI-only operator features
  are incomplete, and future machine surfaces must share domain services with
  their human presentations
- removed the obsolete script component, browser adapter, environment contract,
  layout mount, and CSP allowance instead of keeping two analytics models
- closed with a fresh PostgreSQL migration/ingest/replay/dedupe/rebuild proof,
  202 passing platform tests, 11 passing repo CLI contract tests, clean
  typecheck/lint/build gates, and local browser
  proof across landing, Arcade, agent resources, auth protection, and the ops
  report

## 2026-08-26 - First Organic AI-Mediated Discovery Signal Recorded

- preserved the quantified timeline, production-usage evidence, public traffic
  signals, measurement caveats, and release-story interpretation in the
  [organic discovery retrospective](./archive/2026-08-26-organic-discovery-retrospective.md)
- recorded that Air Jam had been publicly playable for 101 days when an
  external developer reported that Claude had recommended it for an
  independently formed "open-source Jackbox" idea
- treated the message as organic positioning and agent-discoverability evidence,
  not as product-market fit or established user adoption
- confirmed that the formal v1 release remained incomplete despite the public
  prerelease, `airjam.io` Arcade, `0.9.2` packages, and May launch content
- identified a real observability gap: production had authoritative runtime
  usage analytics but no active website-traffic authority because the optional
  external analytics path was never configured
- recorded the preferred follow-up direction as first-party, typed product
  telemetry that remains separate from runtime accounting and fully replaces
  the inactive external path when implemented

## Historical Baseline Before The Reset

Before the 2026-05-08 repo operating system reset, the repo already had these major milestones behind it:

1. the framework, platform, realtime server, and browser-worker topology were already in place
2. the hosted release dashboard lane and managed media lane were already implemented
3. the hosted release CLI and MCP flows were already proven locally end to end
4. the on-demand full-stack preview lane had already been validated live against Vercel and Railway
5. the Railway CLI dependency for hosted preview orchestration had already been replaced by a direct Railway API control surface
6. the launch set and late prerelease hardening work were already largely complete

For the detailed pre-reset execution story, use the archived ledger snapshot above.

## 2026-07-24 - Android Auto Platform Foundation Closed

- completed Goal 1 of the active
  [Android Auto road-trip plan](./archive/2026-07-24-android-auto-road-trip-plan.md)
- kept public on-screen controllers as a zero-setup demo while making their
  launcher contextual:
  - full discovery in an empty Arcade
  - compact fallback when appropriate
  - hidden during phone-connected gameplay
- made semantic agent sessions resolve Arcade's authoritative active surface and
  epoch-scoped embedded store domain without changing portable game contracts
- re-proved local app-ID bootstrap and explicit 16-player Arcade room capacity
- measured the connected Galaxy S24 fullscreen safe area and kept the
  controller menu tear top-center below its camera cutout
- installed and visually confirmed the canonical Air Jam Android launcher icon
- closed the phase with:
  - SDK typecheck/build and 270 tests
  - devtools typecheck/build and 50 tests
  - Platform typecheck/lint/build and 162 tests
  - Android unit/lint/debug/release gates
- recorded the newly found missing root `pnpm run dev` contract as GitHub issue
  #40 instead of expanding the road-trip scope
- left all implementation local and unpublished pending explicit user approval

## 2026-05-08 - Railway Consolidation Simplified The Deploy Model

- finished the Block 1 deployment reset in practice:
  - the platform now runs on Railway alongside the realtime server and release browser worker
  - Railway native PR environments are now the canonical preview model
  - the repo no longer treats Vercel plus Railway plus a custom preview control plane as one deploy system
- removed the repo-owned full-stack preview control plane from the active surface:
  - deleted the preview workflows
  - deleted the repo preview command and preview helper modules
  - deleted the preview-specific runtime contract tests
- replaced the old preview-oriented inspection story with a simpler Railway-first one:
  - kept the direct Railway API client
  - added `pnpm run repo -- railway doctor` as the canonical deploy inspection front door
- removed stale Vercel-specific runtime assumptions from the deployable platform surface:
  - removed `VERCEL_URL` fallback identity logic
  - removed Vercel Speed Insights integration
  - removed the leftover full-stack preview host guard
- rewrote the live deployment docs around one simpler truth:
  - Railway is now the deploy and preview provider for the first-party app surfaces
  - the repo should own validation and config clarity, not a second preview lifecycle

## 2026-05-08 - Repo Operating System Reset Closed

- closed the repo operating-system reset by separating:
  - the current snapshot into [current-state.md](./current-state.md)
  - stable rules into [working-agreements.md](./working-agreements.md)
  - navigation into [docs-index.md](./docs-index.md)
  - docs category and naming rules into [documentation-taxonomy.md](./documentation-taxonomy.md)
  - history into this ledger
- tightened the doc surface further after the reset:
  - renamed the capability reference to [capability-inventory.md](./capability-inventory.md)
  - normalized the environment contract doc into [contracts/environment-contracts.md](./contracts/environment-contracts.md)
  - replaced the overly broad `systems/` live surface with explicit `docs/architecture/`, `docs/contracts/`, and `docs/guides/` categories
  - kept `docs/strategy/` and `docs/content/` as explicit live categories without leaving folder-level README files scattered across the tree
  - moved architecture, contracts, and guides into their own semantically correct directories instead of forcing them all into `systems/`
  - moved future or exploratory system docs out of the live reference surface
  - reduced `content/` to real article drafts instead of draft-plus-plan-plus-outline sprawl
  - moved the dated [Project Review (2026-04-15)](./archive/2026-04-15-project-review.md) out of the live strategy surface
  - removed duplicate file-list sprawl from [docs-index.md](./docs-index.md) so it points at canonical folder entrypoints instead of trying to re-list every live doc
  - normalized live status labels so stable references stop pretending to be active execution tracks
  - compacted the settings-ownership work into the archived [2026-05-03-landing-arcade-controller-polish-plan.md](./archive/2026-05-03-landing-arcade-controller-polish-plan.md) and archived the separate settings plan
  - archived the now-superseded prerelease agent dev-loop hardening plan after its durable rules were absorbed into the repo operating surfaces
  - collapsed the remaining live plan surface down to the release plan now
    preserved as the
    [2026-08-26 pre-roadmap snapshot](./archive/2026-08-26-v1-release-plan-pre-roadmap.md)
  - archived the subordinate prerelease, polish, packaging, and future-architecture plans so they stop competing with the final v1 closeout path
- preserved the old overloaded ledger as [archive/2026-05-08-work-ledger-pre-os-reset.md](./archive/2026-05-08-work-ledger-pre-os-reset.md) instead of deleting execution memory
- centralized plan-role and category rules in [documentation-taxonomy.md](./documentation-taxonomy.md) so they stop living only in chat memory
- slimmed [monorepo-operating-system.md](./monorepo-operating-system.md) so it now matches the actual repo memory model instead of the older ledger-centric doctrine
- updated [AGENTS.md](../AGENTS.md) so the documentation discipline now reflects:
  - `docs/current-state.md` for the quick current snapshot
  - `docs/work-ledger.md` for history
  - `docs/working-agreements.md` for stable repo operating system rules
- audited the plan surface and archived the clearly completed tracks that should no longer compete with current execution:
  - [archive/2026-04-20-code-review-reference-cleanup-plan.md](./archive/2026-04-20-code-review-reference-cleanup-plan.md)
  - [archive/2026-04-27-game-structure-alignment-plan.md](./archive/2026-04-27-game-structure-alignment-plan.md)
  - [archive/2026-05-05-public-package-surface-rationalization-plan.md](./archive/2026-05-05-public-package-surface-rationalization-plan.md)
  - [archive/2026-05-08-hosted-release-cli-and-mcp-plan.md](./archive/2026-05-08-hosted-release-cli-and-mcp-plan.md)
  - [archive/2026-05-06-shared-preview-deployment-plan.md](./archive/2026-05-06-shared-preview-deployment-plan.md)
  - [archive/2026-05-07-railway-api-foundation-and-agentic-os-plan.md](./archive/2026-05-07-railway-api-foundation-and-agentic-os-plan.md)
  - [archive/2026-05-07-repo-operating-system-reset-plan.md](./archive/2026-05-07-repo-operating-system-reset-plan.md)
- the repo now has one cleaner read path:
  - `README.md`
  - `docs/docs-index.md`
  - `docs/current-state.md`
  - `docs/documentation-taxonomy.md`
  - relevant active plan
  - `docs/work-ledger.md` only for history

## 2026-05-08 - Capability Surface Explanation Tightened

- kept [capability-inventory.md](./capability-inventory.md) as the breadth map instead of turning it into a second strategy or architecture doc
- expanded the stable reference layer so the Air Jam ecosystem is easier to understand through focused explanatory docs rather than through one giant inventory:
  - architecture:
    - [architecture/platform-control-plane-architecture.md](./architecture/platform-control-plane-architecture.md)
    - [architecture/agent-tooling-architecture.md](./architecture/agent-tooling-architecture.md)
    - [architecture/hosted-release-pipeline-architecture.md](./architecture/hosted-release-pipeline-architecture.md)
    - [architecture/platform-identity-and-auth-architecture.md](./architecture/platform-identity-and-auth-architecture.md)
    - [architecture/documentation-and-ai-pack-architecture.md](./architecture/documentation-and-ai-pack-architecture.md)
  - contracts:
    - [contracts/runtime-topology-contract.md](./contracts/runtime-topology-contract.md)
    - [contracts/runtime-inspection-contract.md](./contracts/runtime-inspection-contract.md)
    - [contracts/agent-session-contract.md](./contracts/agent-session-contract.md)
    - [contracts/game-metadata-contract.md](./contracts/game-metadata-contract.md)
    - [contracts/media-presentation-contract.md](./contracts/media-presentation-contract.md)
  - guides:
    - [guides/local-development-guide.md](./guides/local-development-guide.md)
    - [guides/hosted-release-guide.md](./guides/hosted-release-guide.md)
    - [guides/agent-development-guide.md](./guides/agent-development-guide.md)
- the live docs surface now explains the same ecosystem through three complementary layers:
  - inventory for breadth
  - architecture and contracts for structure
  - guides for operational usage

## 2026-05-08 - Platform And AI-Pack Docs Audit Tightened

- audited the platform-facing docs and AI-pack-facing docs and found the main missing gap was not broad vision but concrete delivery-surface explanation
- added:
  - [architecture/platform-docs-surface-architecture.md](./architecture/platform-docs-surface-architecture.md)
  - [contracts/ai-pack-manifest-contract.md](./contracts/ai-pack-manifest-contract.md)
  - [guides/ai-pack-workflow-guide.md](./guides/ai-pack-workflow-guide.md)
- tightened [architecture/documentation-and-ai-pack-architecture.md](./architecture/documentation-and-ai-pack-architecture.md) so it now explains the hosted docs registry, machine endpoints, hosted AI-pack manifests, and local AI-pack workflow more explicitly
- updated [apps/platform/README.md](../apps/platform/README.md) so the platform app now points at the real public docs and AI-pack reference surfaces instead of leaving those contracts mostly implicit in code

## 2026-05-08 - Public Story Alignment Tightened

- aligned the release plan's public-surface closeout around one primary story:
  - Air Jam is an open AI-native framework for multiplayer games controlled by phones
- tightened the public docs intro and agent entrypoint so they now lead with the AI-native framework model instead of a more generic platform/framework phrasing
- tightened the framework launch article draft so it now foregrounds:
  - shared human-and-agent runtime contracts
  - AI-native development as the actual differentiator
  - the clearer split between self-hosting and hosted Arcade publishing
- lightly reinforced the same story in the origin-story article draft so the long-form content does not drift back toward a simpler but weaker "just a framework" explanation

## 2026-05-08 - Public Creator Attribution Added

- added a shared public creator-attribution registry and presentation layer for Arcade and landing cards
- public game cards now support real GitHub-linked avatar attribution stacks instead of only a flat creator label
- the current curated data is intentionally owned in one file so zerodays game attribution can be adjusted without touching multiple UI surfaces

## 2026-05-08 - Post-V1 Topology Roadmap Written

- wrote [strategy/post-v1-topology-roadmap.md](./strategy/post-v1-topology-roadmap.md) as the canonical post-v1 application-topology roadmap
- locked the intended sequencing instead of treating deployment simplification, Arcade isolation, and API/auth extraction as one blended future refactor:
  - Block 1: move the current platform stack fully onto Railway
  - Block 2: isolate Arcade into its own app boundary
  - Block 3: extract API and auth into a dedicated backend service
- explicitly kept this roadmap out of `docs/plans/` so the repo still has one active release plan while the future architecture direction remains visible and non-current
- recorded the current recommendation on service boundaries:
  - do not remove tRPC during the Railway migration
  - revisit tRPC only once a real separate API service exists
  - use `yu-gi-ai` as the stronger long-term reference for a split API/app/auth package shape, not as a signal to do all of that immediately

## 2026-05-08 - Full-Stack Preview System Verified From `main`

- ran a real hosted smoke test from `main` itself through a temporary PR
- verified that hosted preview create succeeded end to end:
  - Railway created `preview-pr-10`
  - the server came up
  - the browser worker came up
  - the full-stack alias responded at `full-pr-10.preview.airjam.io`
- verified that hosted destroy succeeded end to end:
  - the Railway environment was removed
  - the PR-specific preview alias was removed
  - provider state returned to `production` only
- fixed the final semantic gap so destroyed `full-pr-*` hosts no longer pretend to be live:
  - inactive full-stack preview hosts now return `404`
  - they include an explicit `x-airjam-preview-state: inactive` signal
- upgraded workflow actions to Node 24-capable versions so the preview system is not quietly heading toward a future GitHub Actions runtime deprecation problem

## 2026-05-07 - Railway Preview Control Surface Validated

- proved that Railway API tokens were valid at the public API layer even when Railway CLI auth and project-link flows rejected the same tokens
- replaced the preview lane's critical Railway transport with a direct API-backed control surface
- reran hosted preview automation and reduced the remaining blockers down to Vercel auth and workflow parsing issues instead of provider ambiguity
- confirmed that the correct long-term lesson was:
  - the preview architecture was sound
  - the Railway CLI was the unreliable layer
  - the clean fix was a native Railway control surface rather than more token or workflow guesswork

## 2026-05-07 - Preview Architecture Conclusion Locked

- validated that pure Railway-native PR environments were not clean enough for Air Jam because they:
  - duplicated database services and volumes
  - inherited unsealed production variables before repo-owned preview overrides could take control
  - did not solve the cross-provider orchestration problem by themselves
- validated that the empty-environment plus selected-service-sync idea was also not ready because Railway's available primitive created global copy-services instead of reusing the canonical project services
- locked the architectural conclusion:
  - the repo-owned ephemeral full-stack preview lane remains the canonical implementation until Railway exposes a cleaner supported primitive we can prove end to end

## 2026-07-24 - Android Auto Road Trip Goal 2 Closed

- completed Last Band Standing's correctness and results milestone:
  - every song now has one canonical quiz category and a curated difficulty
  - every four-option round stays inside that category with unique visible
    labels
  - the host reveal reports every player's result, time, round gain, and total
  - ten-player controller standings scroll while the lobby action remains
    pinned
  - lobby category selection is explicit on host and controller
- proved complete ten-round matches with two, six, and ten players
- passed the exact car reveal layouts at `800x480` and `1920x720`
- passed standings bottom-reachability at all four supported phone sizes
- opened Air Jam issue #42 for incorrect agent-contract inference when
  game-session tooling receives a game-local `cwd` without `gameId`
- moved the active road-trip plan to Goal 3: user-reviewed harder-song curation
  and focused visual polish

## 2026-07-24 - Android Auto Road Trip Release Closed

- completed and archived the
  [Android Auto road-trip plan](./archive/2026-07-24-android-auto-road-trip-plan.md)
- merged Air Jam PR #41 after the full release doctor, GitHub CI, and Railway
  preview checks passed
- deployed the platform, realtime server, and release browser worker
  successfully to Railway production
- repaired two release-time platform defects:
  - platform previews now use their own Postgres service reference
  - the release browser worker now exposes one stable authenticated `/ws`
    endpoint across deploys
- published Last Band Standing `0.2.1` as the live hosted release:
  - 206 canonical songs
  - unique same-category answer options
  - controller-owned between-round rankings
  - scrollable final standings
  - responsive Android Auto and phone layouts
  - chrome-free YouTube playback
  - successful artifact validation and canonical screenshot capture
- merged the Android wrapper PR and published signed GitHub Release `v1.0.2`
  with a checksum while retaining `v1.0.0` for rollback
- verified the production platform and realtime health endpoints, public Arcade
  listing, hosted release render, and authenticated browser-worker connection
- left only non-blocking human clip-start listening and tuning for later polish
