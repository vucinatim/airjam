# Current State

Last updated: 2026-09-04
Status: current snapshot

This is the canonical quick-read status surface for the Air Jam repo.

Use this file for:

1. current focus
2. what is structurally done
3. what is still open
4. the small set of plans that govern current work
5. immediate next steps

Do not use this file as a running work log.

Update it only at:

1. phase closures
2. meaningful reprioritizations
3. repo operating system changes that affect how the repo should be read

For historical progress, use [work-ledger.md](./work-ledger.md).

## Current Focus

Air Jam is now governed by the
[1.0 release roadmap](./plans/v1-release-roadmap-plan.md).

The focus has moved from a narrow final-proof-and-publish pass to a deliberate
1.0 re-baseline shaped by six months of progress in general-purpose coding
agents, MCP, CLI operability, and Air Jam's own harness.

The current priorities are:

1. execute the ratified public 1.0 contract: one `Air Jam` product, a complete
   agent-operable development harness, and no separate mandatory hosted editor
2. audit and canonicalize the codebase before public API stability is promised
3. prove the complete lifecycle through an external agent from a clean
   environment
4. harden production capacity, recovery, security, sensory feedback, alerting,
   and agent diagnosis before inviting launch traffic
5. finish package, documentation, demo, article, and distribution work against
   one exact release candidate
6. launch with a free creation harness and useful hobby cloud inside an explicit
   cost envelope, rather than tying sustainability to signup count
7. keep development fast through the canonical
   [check layers](./working-agreements.md#development-check-layers), then use the
   [review and merge rules](./working-agreements.md#review-stacks-and-integration)
   and
   [production-delivery rules](./working-agreements.md#production-delivery-and-public-launch)

## What Is Structurally Done

These are now baseline truths, not open architecture debates:

1. the framework, platform, realtime server, and browser-worker split is established
2. the dashboard and hosted release model are real:
   1. game records
   2. release records
   3. release artifacts
   4. managed media
   5. public hosted release serving
3. the hosted release machine lane is real:
   1. CLI auth
   2. CLI release submit / inspect / publish
   3. MCP release submit / inspect / publish
4. the Railway-first deploy model is real:
   1. the platform now deploys on Railway alongside the realtime server and browser worker
   2. Railway native PR environments are the canonical preview model
   3. the repo now owns deploy inspection instead of a second preview control plane
5. the release architecture and public product direction are already substantially defined in:
   1. [vision.md](./vision.md)
   2. [discoverability-vision.md](./discoverability-vision.md)
   3. [framework-paradigm.md](./framework-paradigm.md)
   4. [strategy/public-arcade-release-strategy.md](./strategy/public-arcade-release-strategy.md)
6. the full implemented surface is now easier to recover through:
   1. [capability-inventory.md](./capability-inventory.md) for current capability breadth
   2. [documentation-taxonomy.md](./documentation-taxonomy.md) for the live docs category map
   3. explicit reference docs for:
      1. the platform control plane
      2. the platform docs surface
      3. the hosted release pipeline
      4. platform identity and auth
      5. documentation and AI-pack delivery
      6. runtime topology and inspection
      7. semantic agent sessions
      8. game metadata and media presentation
      9. local, hosted-release, and agent development loops
7. Last Band Standing now has a much stronger quiz-content baseline:
   1. one canonical row per song with inline category ownership
   2. one canonical quiz category and a curated 1-through-5 difficulty for
      every song
   3. same-quiz-category answer pools with four unique visible labels and no
      permissive fallback
   4. Unicode-safe canonical normalization
   5. deterministic catalog validation and randomized option-generation tests
   6. 206 canonical songs across ten independently playable categories
   7. 59 Slovenian songs and 26 Balkan songs
   8. explicit deterministic clip timing on every catalog entry
   9. complete two-, six-, and ten-player ten-round semantic match proofs
   10. a clean host answer reveal, controller-owned all-player between-round
       rankings, and scrollable ten-player final standings
8. the Android Auto road-trip implementation is structurally in place:
   1. Arcade owns an exact typed `?qr=open` launch contract
   2. Arcade and Last Band Standing respond to short-wide dimensions and safe
      areas without Android/user-agent branches
   3. Last Band Standing has a compact ten-player gameplay strip
   4. the private wrapper uses the URL contract instead of DOM button matching
   5. the wrapper is rebuilt on Android for Cars App Library 1.7.0 with focused
      host-navigation tests and zero Android lint errors
9. the road-trip platform-foundation goal is complete locally:
   1. the public preview-controller launcher is contextual and disappears
      during phone-connected gameplay
   2. semantic Arcade sessions resolve epoch-scoped embedded stores through
      authoritative `arcade.surface` state
   3. local bootstrap and 16-player Arcade capacity are re-proven
   4. the top-center controller menu consumes the real phone safe-area inset
   5. the Android wrapper carries the canonical installed Air Jam icon
10. first-party product telemetry is now part of the platform baseline:
    1. one closed, versioned event contract covers canonical page views and
       meaningful public intent
    2. same-origin browser ingestion is bounded, rate-limited, idempotent, and
       non-blocking to product UX
    3. agent-facing resources record server-observed reach without changing
       their public response contracts
    4. append-only raw evidence projects deterministically into daily event and
       ephemeral-session metrics
    5. the ops-only report keeps product telemetry, platform lifecycle facts,
       and authoritative runtime activity visibly separate
    6. anonymous identity is memory-only and the system does not fingerprint or
       persist raw IP addresses, full user agents, full URLs, query strings, or
       raw referrers
    7. the dormant external website-analytics integration and its environment
       and CSP contract are fully removed
    8. the full operator lifecycle is available through the repo CLI with
       stable JSON reads, health inspection, and explicit preview/apply
       maintenance commands backed by the same domain services as the ops UI
11. Gate 1 tooling and public-contract convergence is complete:
    1. `create-airjam` is one-shot bootstrap only
    2. installed project lifecycle has one owner in `@air-jam/cli`
    3. the server binary owns only signal-server start and unified logs
    4. CLI and MCP operate the same semantic sessions and typed services
    5. managed framework references cannot overwrite project-owned instructions
       or skills
    6. all six scaffold games pass semantic store/action conformance
    7. a packed clean-room project proves CLI discovery, MCP protocol startup,
       semantic session control, typecheck, tests, and production build
12. Gate 1 platform application authority convergence is complete:
    1. release and managed-media lifecycle bypasses are removed
    2. human and machine adapters share actor-aware application services
    3. PostgreSQL enforces one live release and valid active media assignments
    4. platform and realtime server compile against one shared physical-table
       contract while platform alone owns migrations
    5. Arcade lifecycle events are planned by one stateless orchestrator without
       replacing replicated surface state or the local capability reducer
13. Gate 1 clean-checkout crystallization is complete:
    1. all published CLI entrypoints bootstrap correctly without ignored build
       output or populated-worktree hoisting
    2. generated-artifact validation derives and compares output from authored
       sources instead of trusting ignored hosted files
    3. the full release, browser, scaffold, and strict realtime matrix passes
       from the exact canonicalization head
    4. authored production source, tests, and guidance are `6,050` lines net
       smaller than the exact pre-canonicalization baseline
14. Gate 2 now has one canonical external-agent proof contract:
    1. a repo-validated JSON manifest fixes the clients, isolation boundary,
       ten ordered lifecycle stages, hidden-staging publication policy, and
       machine evidence paths
    2. Codex owns the complete create-through-release proof; Claude Desktop
       owns a separate independent install, discovery, and semantic-session
       proof
    3. a deterministic three-to-two win-score mutation exercises the bounded
       inspect-diagnose-repair loop without claiming general self-healing
    4. `pnpm --silent run repo -- golden-path spec|validate --json` makes the
       scenario discoverable and rejects malformed or production-unsafe specs
    5. the exact candidate package graph now passes an isolated-registry
       bootstrap proof with no local dependency specs or private repository
       paths
    6. the generated project discovers the canonical CLI, all `27` MCP tools,
       project-scoped Codex configuration, managed dev lifecycle, typecheck,
       lint, tests, and production build
    7. the MCP server reports its shipped package version rather than a
       hard-coded version
    8. the standalone MCP tool set now has one canonical machine-readable
       contract shared by server registration and clean-room verification
    9. `create-airjam` packs to `87,164,321` bytes because it embeds all six
       scaffold archives; Gate 6 now enforces that value beneath a 100 MiB
       package ceiling and proves cold scaffold installation below ten minutes
       on every supported cell
    10. the retained Codex primary run independently built the full Signal Relay
        game, passed all four quality gates, and reached semantic-session control
        before both supported Chromium paths hit the same macOS Mach-port denial
    11. independent review reopened `G2-03`: the retained local run remains
        useful diagnostic evidence, but its ignored artifact path was not
        independently retrievable and the controller could trust agent-authored
        verification claims
    12. the corrected controller now owns isolation probes, quality gates,
        cleanup, and release-verification authority; `G2-03` requires a new
        durable replay before completion, `G2-04` owns independent Claude
        Desktop proof, and `G2-05` owns browser/staging closure
    13. the integration review further made staging isolation environment-wide
        and fail-closed, made evidence retention rollback-safe and extension
        independent, and bounded external-agent plus cleanup process lifetimes
15. Gate 4 now has one agent-operable operational authority contract:
    1. product telemetry, authoritative lifecycle/runtime facts, and durable
       incidents remain separate evidence planes
    2. deterministic fingerprints bind incident identity to exact normalized
       failure scope
    3. runbook preview/apply binds exact descriptor, parameters, context,
       expiry, actions, and blast radius through SHA-256 digests
    4. approval, bounded automation, verification, rollback, and terminal
       evidence rules fail closed
    5. all fourteen schema families are inspectable as Draft 7 JSON Schema and
       runtime-validatable through the canonical repo CLI
16. Gate 4 now also has one durable reliability loop:
    1. authoritative producers persist events through a transactional outbox
       and immutable event store instead of relying on process memory
    2. bounded leases, retries, dead-letter state, audited requeue, and expired-
       lease repair make delivery safe to operate through the repo CLI
    3. six launch-critical synthetic stories continuously feed four explicit
       SLO evaluations and durable alert state
    4. platform, server, and hosted-runtime failure producers emit structured,
       redacted evidence with server-owned authority and identity
    5. worker and platform readiness report their true release dependencies
       while process liveness remains an independent deployment signal
17. Gate `G5-01` now has one ranked threat model:
    1. public, privileged, artifact, runtime, agent, provider, privacy, and
       supply-chain boundaries were independently reviewed and centrally
       deduplicated
    2. the audit identified one critical launch blocker—creator executable
       releases falling back to the authenticated platform origin—which the
       first `G5-02` slice has since removed
    3. thirteen high-priority threat groups now have exact ownership, canonical
       end states, and hostile proof requirements
    4. production browser-worker credentials are present, so the worker finding
       is a fail-open architecture and egress gap rather than an unsupported
       claim of current anonymous exposure
    5. implementation remains in `G5-02` and `G5-03`, with one final batched
       human residual-risk review in `G5-04`
18. the first `G5-02` implementation slice is now merged and production-valid:
    1. hosted game code has no authenticated-platform-origin fallback
    2. production requires an explicit cross-site release origin outside Better
       Auth trust, and build/runtime platform identity drift fails readiness
       while liveness remains process-only
    3. incoming `Host` authority, not Next's server-derived request URL, owns
       platform-versus-release routing; release, platform, and unknown hosts
       fail into explicit lanes
    4. host and controller frames share one sandbox and Permissions Policy
       contract
    5. the repo CLI can inspect local or deployed `ready`, `disabled`, and
       `invalid` state as stable JSON
    6. unit, real-Next-server Host routing, and hostile-browser proofs cover the
       local contract
    7. a second repo-CLI surface can attest an exact deployed host/controller
       pair without executing creator code: it pins DNS, bounds requests and
       TLS, independently checks cookie-site separation, redirects, exact
       response policy, Better Auth and protected-endpoint CORS isolation,
       stable deployment identity, and the exact Railway project/current
       service deployment/both-domain binding
    8. only provider-authenticated public-HTTPS runs can become production
       evidence; loopback, missing project identity, and missing provider
       authority stay explicitly diagnostic
    9. the selected dedicated production domain, `games.air-jam.app`, is now
       provisioned, deployed, and attested end to end; the separate observation,
       rollback-proof, and legacy-host work remains governed by
       `docs/plans/hosted-release-domain-cutover-plan.md`
    10. corrective PR `#76` passed exact-head Canonicalizer and Claude Opus
        review, CI, standalone-artifact proof, Railway previews, and an exact
        production rollout: platform deployment
        `8dbde4b3-3059-4bfd-8ba6-93deccbde995` reached terminal `SUCCESS`, and
        live liveness reported merged revision
        `e122a52c1da49ef409364c93fb675df56a4e639d`
19. the production hosted-release cutover is complete and evidence-backed:
    1. all six public catalog games use `https://games.air-jam.app` while public
       links, rooms, controllers, QR codes, and reconnect remain on `airjam.io`
    2. production schema drift from migration `0020` to `0033` was recovered
       after an isolated PostgreSQL 17 restore rehearsal, exact write drain,
       and fresh checksummed backup
    3. merged revision `ebf63d8a0d5587f27ba59adf48213fb71f20340b`
       is live on terminal-success Railway deployment
       `e65c8e41-3f72-4078-9ce0-443695d296a2`
    4. the browser smoke matrix passes `7/7` and the canonical production
       attestation passes `20/20` with verified Railway identity and
       `productionEvidenceEligible: true`
    5. the exact outcome, provider identifiers, recovery facts, and remaining
       scope are retained in the
       [hosted-release cutover evidence](./audits/v1-security/hosted-release-domain-cutover-evidence.md)
20. the production recovery surface is complete and live-proven:
    1. Railway recurring backups have exact daily, weekly, and monthly policy
       with provider read-back
    2. a fresh PostgreSQL 17 snapshot restored into a disposable Railway
       PostgreSQL 18 environment with exact schema-head and all-table-count
       verification; the environment and local proxy were removed afterward
    3. durable job replay preserves exact lineage, actor intent, correlation,
       resource scope, and one audited replay event, while ineligible replay
       fails with a structured escalation bundle
    4. deployment recovery is preview-first and fences exact project,
       environment, service, current deployment, target revision or image,
       provider result, exact public deployment identity, actor, and reason;
       Railway rollback instances report no runtime revision, so the provider
       record remains revision authority
    5. the final production backward rollback verified in 10,526 ms and forward
       recovery verified in 8,248 ms; production was left on the newest reviewed
       revision
    6. the complete measurements, safe discovery failures, provider IDs, and
       evidence digests live in the
       [production recovery proof](./audits/v1-reliability/production-recovery-proof.md)

## What Is Still Open

The roadmap now organizes the remaining work into explicit evidence gates:

1. external-agent golden-path proof
2. remaining launch-scale reliability, backpressure, cost, and overload proof
3. production activation and observation of the implemented operational
   sensors and deduplicated GitHub issue bridge
4. security, abuse, privacy, and supply-chain trust
5. final public documentation, demo, article, npm prerelease, and promotion
   proof
6. one immutable release rehearsal and final go/no-go decision

## Active Now

The 1.0 release roadmap is the governing product plan:

1. [plans/v1-release-roadmap-plan.md](./plans/v1-release-roadmap-plan.md)

The subordinate execution plan and machine manifest own dependency-aware daily
work state without becoming a second product authority:

1. [plans/v1-release-execution-plan.md](./plans/v1-release-execution-plan.md)

The foundation integration through PR `#61`, the production-health recovery in
PR `#76`, the public install matrix in PR `#74`, and the durable reliability
loop in PR `#75` are merged. The latest schema-bearing production rollout was
main revision `5a280c43337f4dc5f00069457ee3a89b8c7cffc0`: the platform reached
terminal `SUCCESS` as Railway deployment
`1ca7a865-2ab5-417e-8221-574c0071736d`, and schema migration `0036` was
independently verified against that exact revision. Production schema remains
at exact head `0036`; current deployment identity comes from the live
`/api/readiness` machine contract rather than a commit copied into this
deploy-triggering document. The realtime server and browser worker remain
successful on their latest watched-path-relevant revisions. Live browser smoke
covers the landing page, direct Arcade navigation, branding, and game-card
hover behavior. The separately defined operational worker is not provisioned
in production yet, so continuous synthetics, SLO evaluation, and alert
generation are implemented but intentionally inactive.
Production code is delivered incrementally; stable package promotion, public
release visibility, final docs, the launch article, and distribution are
coordinated only after one exact candidate passes rehearsal.

Canonical agent reads are:

```bash
pnpm --silent run repo -- readiness status --json
pnpm --silent run repo -- readiness next --json
```

The discoverability plan is a subordinate launch checklist and cannot redefine
the 1.0 contract:

1. [plans/discoverability-and-launch-promotion-plan.md](./plans/discoverability-and-launch-promotion-plan.md)

## Recent Closures

Gate 0 is closed with the product name, development-harness contract, supported
client profiles, free-cloud allowances, cost ceilings, capacity target, and
autonomy ceiling ratified on `2026-08-28`.

Gate 1 bundles `R1` through `R5` are closed. They removed duplicate topology,
obsolete visual/control paths, copied project CLI implementations, unsafe
guidance ownership, accidental public runtime exports, platform lifecycle
bypasses, duplicate physical-table declarations, unenforced release/media
invariants, and Arcade callback-ref lifecycle synchronization. The exact
clean-checkout release matrix passes at `da835f6`, and authored source, tests,
and guidance are `6,050` lines net smaller than the Gate 1 baseline.

Gate `G2-01` is closed with the
[external-agent golden-path contract](./contracts/external-agent-golden-path-contract.md),
its exact Signal Relay prompt, versioned evidence format, and repository-owned
validator. Current Anthropic guidance makes Desktop Extensions the preferred
Claude Desktop packaging path, so the older raw JSON setup remains explicitly
uncertified until the independent `G2-04` proof settles and canonicalizes it.

Gate `G2-02` is independently re-closed after review found that the first
bootstrap run proved package versions and registry configuration without
positively binding installed bytes to that run's packed candidates. The proof
now compares SHA-512 integrity across the tarballs, registry metadata, and
generated lockfile; requires all lifecycle scripts and all `27` MCP tools; uses
bounded command, protocol, registry, and workspace-lock waits; and passes a
fresh managed-dev plus typecheck, lint, test, and build run. That replay also
fixed standalone topology so a configured Vite port is advertised consistently
to hosts, controllers, sockets, and readiness tooling.

Gate `G6-01` is closed by the
[public install matrix audit](./audits/v1-public-release/public-install-matrix-audit.md).
The exact five-package candidate graph passed clean `npx` creation, CLI and all
27 MCP tool discovery, managed development, and generated-project typecheck,
lint, tests, and build on Linux, macOS, and Windows across Node.js 22 and 24.
All six cells stayed inside explicit package, install-time, cell-time, and
archive-extraction budgets. The proof used a fallback-free candidate registry
and empty cache, so neither an old npm package nor the monorepo could satisfy
it; npm and production were not changed.

Gate `G2-03` is now explicitly blocked on isolated staging credentials and
controller-readable provider identity. Its completion requires a new
controller-owned Signal Relay replay whose durable artifacts, isolation checks,
quality gates, cleanup, and release verification do not depend on agent-authored
success claims. The old PR-52 hostname is no longer admissible staging proof because it
still served platform health after Railway reported no corresponding ephemeral
environment. The runner now requires provider-owned Railway project and
environment identity and proves separation from production before agent
startup. Pull request `#61` produced an ephemeral environment with a distinct
Postgres instance, but Railway cloned the production R2 bucket, storage
credentials, release-pipeline tokens, and other sensitive values, while the
provider API can now attest those service-by-service facts without exposing the
values. It is therefore not admissible isolated staging. Correcting those
boundaries remains explicit work rather than an automatic side effect of the
proof harness.

Gate `G2-02` is closed at `511ee85` with the
[public bootstrap audit](./audits/v1-golden-path/public-bootstrap-audit.md).
The exact five-package candidate graph was built, packed, published to a fresh
loopback registry with Air Jam upstream fallback disabled, installed from a
clean scaffold, exercised through CLI and raw MCP, and removed after all
generated-project quality gates passed. No npm package or production system was
changed.

Gate `G5-01` is closed by the
[ranked security threat model](./audits/v1-security/threat-model-audit.md). Its
highest-priority result is that creator-controlled executable game bytes must
move to a dedicated cookieless origin with strict iframe and browser policies
before 1.0. The audit deliberately leaves implementation open in `G5-02` and
`G5-03`; it does not treat documenting a threat as fixing it.
Gate `G4-01` is closed with the
[operational events and incidents contract](./contracts/operational-events-and-incidents-contract.md)
and its [proof](./audits/v1-operations/operational-contract-proof.md). The
private runtime package, TypeScript declarations, JSON Schema export, and repo
CLI now share one versioned model for events, correlation, incident state,
runbook descriptors, immutable previews, invocations, and action audit records.
Gates `G4-02` and `G4-07` are closed by the production-valid reliability layer
and its foundation hardening through the
[operational reliability contract](./contracts/operational-reliability-contract.md)
and its [proof](./audits/v1-operations/operational-reliability-proof.md): durable
event delivery, structured platform/server/runtime failures, six synthetics,
four SLOs, durable alerts, truthful worker readiness, and one agent-operable CLI
surface. Retained failure details now use an adversarial recursive redaction
vocabulary, event and failure identities share one normalized code, synthetic
chronology is database-owned, each scheduled check is isolated and reported,
and older SLO evaluations cannot regress newer alert state. Scheduling is a
separate orchestration module rather than another responsibility in the
persistence service. Production schema migration `0036` is applied and
verified, but the operational worker service is deliberately not deployed
until its activation preflight, drain, synthetic configuration, rollback, and
cost-observation path is ready.
Gate `G4-03` is closed by the
[operational alert issue projection contract](./contracts/operational-alert-issue-projection-contract.md)
and its
[proof](./audits/v1-operations/operational-alert-issue-projection-proof.md).
Each alert key now owns one leased, bounded, deduplicated GitHub issue
projection with create, update, recovery close, recurrence reopen, marker-based
reconciliation, preserved discussion, inspectable dead letters, and a complete
preview-first repo CLI lifecycle. The issue-only GitHub App identity belongs
only on the operational worker.
Operational evidence retention is owned by `G3-07`; it and the remaining
activation dependencies gate separately claimable `G3-08` activation.
This does not claim that continuous evaluations or GitHub issue delivery are
active in production. A generic incident lifecycle and governed
automatic-remediation engine are intentionally not 1.0 requirements: smart
local agents should use the shared evidence and focused Air Jam, Railway,
GitHub, and local tools instead.

Gate `G3-01` is closed with the
[production capacity, cost, and recovery audit](./audits/v1-reliability/production-capacity-cost-and-recovery-audit.md).
Production currently costs about `$8` per Railway cycle, uses little database
and object-storage capacity, and showed no `5xx` in the sampled seven-day
traffic. At the time it was captured, the audit identified synchronous release
work, dynamic release delivery, process-local realtime authority, no recurring
database backup, no app-specific spend brake, incomplete lifecycle cleanup,
and no continuously proven alert/rollback path. Recurring backup and exact
rollback have since been closed by `G3-03`; the remaining gaps retain their
current owners. No production state was changed by the original audit.

Gate `G3-02` is active. Its first production-valid slice establishes the
[production control contract](./contracts/production-control-contract.md),
persistent and audited lane modes, typed fail-closed admission decisions, and
preview-first CLI operation. Release submission, artifact ingestion, release
processing, browser validation, moderation, media ingestion, and telemetry now
share that application-service authority. Its second slice adds the
[production budget evidence proof](./audits/v1-reliability/production-budget-evidence-proof.md):
Railway project usage now flows through immutable evidence, reviewed thresholds,
derived state, freshness reporting, idempotent replay, and the canonical repo
CLI. Its third slice adds the
[production shadow quota proof](./audits/v1-reliability/production-shadow-quota-proof.md):
the ratified allowances now live in one versioned source catalog, lifecycle and
runtime records produce creator/game usage, and the canonical CLI explains
shadow versus enforced decisions. Durable jobs, application-service wiring,
cleanup, realtime admission, and overload proof remain part of the same
unfinished gate. Its fourth slice adds the
[production durable job authority proof](./audits/v1-reliability/production-durable-job-authority-proof.md):
PostgreSQL now owns bounded queues, fair transactional claims, fenced leases,
heartbeats, absolute deadlines, retries, cancellation, replay lineage, repair,
global immutable command replay, and append-only job events. Claims honor the
persisted lane mode, release checks cannot cross release scope, and the repo CLI
uses redacted operator projections rather than lease-bearing worker records.
The fifth slice adds the
[production immutable release generations proof](./audits/v1-reliability/production-immutable-release-generations-proof.md):
every upload now has immutable generation identity, first-observed object
facts, create-only source and output keys, explicit candidate/promoted pointers,
generation-scoped checks, and fail-closed legacy migration. Public serving,
publishing, quotas, dashboard, machine API, SDK, CLI, and MCP now agree on that
generation model. Its sixth slice adds the
[production operational job worker proof](./audits/v1-reliability/production-operational-job-worker-proof.md):
finalize now enqueues a strict generation-scoped three-stage job graph, a
separate drainable worker owns execution, attempts isolate retry outputs, and
dashboard, API, SDK, CLI, and MCP share enqueue, inspect, wait, and publish
semantics. The old synchronous finalizer is gone. Its seventh slice adds the
[production lifecycle cleanup proof](./audits/v1-reliability/production-lifecycle-cleanup-proof.md):
the operational worker now schedules and executes exact, resource-scoped
cleanup for terminal release generations and inactive unassigned media. The
first object manifest survives partial deletion and retries, database
tombstones control quota accounting, and the canonical CLI provides redacted
preview/apply plus resource-filtered inspection. Superseded unpublished
generations now also have a PostgreSQL-enforced 180-day lifecycle with a
durable seven-day warning, creator export through dashboard/API/CLI/MCP, and
retention renewal when exported or published. Realtime admission, overload
proof, and explicit production rollout remain part of the unfinished gate.

The previous narrow v1 closeout plan was superseded by the 1.0 roadmap and is
preserved in the
[2026-08-26 pre-roadmap snapshot](./archive/2026-08-26-v1-release-plan-pre-roadmap.md).

The first-party telemetry implementation, Android Auto road-trip release,
preview system closeout, Railway API control-surface replacement, and repo
operating system reset are closed.

The telemetry implementation plan is preserved in the
[2026-08-26 telemetry archive](./archive/2026-08-26-first-party-product-telemetry-plan.md).
Other closed plans are archived according to the repository documentation
taxonomy.

They should no longer compete with launch execution.

## Planned Next

Execute the roadmap in dependency order:

1. keep the ratified Gate 0 contract frozen
2. keep the now-closed Gate 1 boundaries stable
3. parallelize independent golden-path,
   reliability, operations, security, and public-surface work
4. retain evidence for every gate and integrate through one central validation
   pass
5. keep [strategy/post-v1-topology-roadmap.md](./strategy/post-v1-topology-roadmap.md)
   non-current unless a measured release risk requires part of it

## Immediate Next Steps

The canonical architecture and delivery order now lives in
[the remaining-1.0 section of the execution plan](./plans/v1-release-execution-plan.md#remaining-10-architecture).
In short:

1. keep the now-complete canonical production migration lifecycle and schema
   compatibility boundary stable; `G3-06` is merged, applied, and independently
   verified against the exact Railway production deployment
2. finish invisible realtime admission in `G3-02`, then provision and observe
   the operational worker and the now-implemented storage retention lifecycle
   safely; migrate the four Railway application services and PostgreSQL to one
   reviewed `.railway/railway.ts` project graph before treating deployment
   configuration as release-ready
3. provision an isolated ephemeral Railway/R2 rehearsal profile and unblock the
   Codex plus Claude Desktop golden-path proofs
4. keep the completed recovery contract stable and finish supply-chain trust as
   an independent lane
5. run overload, recovery, and security closure drills through the existing
   focused agent-operable controls
6. finish docs/demo/story against shipped evidence, then cut and rehearse one
   immutable 1.0 candidate
7. agents continue to claim, complete, or block work only through the canonical
   readiness manifest

## Current Caveats

1. the repo has enough implemented infrastructure that the main risk is now
   committing to stale assumptions or freezing accidental complexity
2. the production baseline, target capacity envelope, and recovery path are now
   measured and explicit, but deliberate overload and continuous alert/issue
   proof have not yet been demonstrated
3. product telemetry anonymous-session and actor-class counts are approximate
   discovery measures, not durable people or identity proof
4. self-healing should emerge from smart agents running against strong sensors,
   shared evidence, and focused tools; a generic runbook or code-changing
   automation engine is post-1.0 and must be justified by real incidents
5. monetization mechanics are intentionally deferred until activation or
   requested value is real, but cost metering, quotas, queues, spend alerts,
   degradation, and kill switches are launch requirements

## Canonical Read Order

For a fast orientation pass:

1. [../README.md](../README.md)
2. [docs-index.md](./docs-index.md)
3. this file
4. [working-agreements.md](./working-agreements.md)
5. [documentation-taxonomy.md](./documentation-taxonomy.md)
6. the currently relevant active plan
7. [work-ledger.md](./work-ledger.md) only if historical context is needed
