# Primary Agent Run Audit

Last updated: 2026-09-09

Status: Gate `G2-03` completion proof retained; Gates `G2-04` and `G2-05` remain

## Question

Can a new Codex process, with no Air Jam repository access or maintainer
credentials, discover the candidate packages, create a polished game, operate
its complete lifecycle through machine contracts, repair a controlled fault,
and submit a hidden release to isolated staging?

For the Codex primary lane, the answer is now a certified yes. Run
`g2-03-20260909-a22` completed the exact scenario with a controller-owned
terminal `passed` result. The full sanitized transcript and decisive machine
evidence are retained in
[`evidence/g2-03-20260909-a22`](./evidence/g2-03-20260909-a22/). This closes
the primary-client claim only: Claude Desktop remains independently owned by
`G2-04`, and the final post-client replay remains owned by `G2-05`.

## Safety And Isolation Boundary

Every valid attempt uses:

1. an empty temporary workspace outside the Air Jam monorepo
2. a run-scoped Verdaccio registry containing the exact five candidate
   packages, with fallback to old public Air Jam packages disabled
3. a new ephemeral Codex process with ambient credentials removed
4. a controller-run Codex sandbox preflight that proves repository reads are
   denied, workspace writes are allowed, undeclared network access is denied,
   and the run-scoped registry is reachable before the agent starts
5. writes limited to the workspace and run-owned evidence, state, temporary,
   cache, npm-cache, and pnpm-store roots
6. network access limited through Codex's managed proxy to loopback and the
   exact isolated Railway staging hostname
7. production publication and public Arcade visibility requested as forbidden;
   actual release state must be independently inspected before it can count as
   proof
8. a redacted, reconciled evidence mirror under
   `.airjam/golden-path-runs/<run-id>/evidence`

Attempts `a4` through `a9` targeted the then-active isolated Railway PR
environment at `air-jam-platform-air-jam-pr-52.up.railway.app`. Production was
not changed by any run. On the 2026-08-29 replay preflight, that hostname still
returned the platform health response while the provider API reported zero
ephemeral environments. The hostname is therefore no longer admissible staging
identity and no new primary run was started against it.

The controller now accepts Railway project and environment identities instead
of a URL. It resolves the environment, platform deployment, distinct public
domain, environment-variable identity, distinct Postgres instance, distinct
release-storage bucket and credentials, distinct release-pipeline tokens,
non-reused production-sensitive values, and health response through
provider-owned state; rejects the primary/base environment; and retains the
non-secret provider attestation without passing Railway credentials to the
external agent.

Pull request `#61` subsequently caused Railway to create a fresh ephemeral
environment with a distinct Postgres instance. Safe provider comparisons found
that the environment cloned the production R2 bucket, R2 credentials,
platform-worker tokens, and other production-sensitive values. The controller
therefore still cannot admit it, and no external agent was started. The
repo-loaded Railway credential also cannot read the bot-created environment;
the provider's account-scoped CLI identity can inspect it without exposing
secret values.

Run `a22` targeted provider-attested ephemeral environment
`814fa07a-ed20-48c0-ba1a-b8a0524c516e` at
`https://games-staging.air-jam.app`. It used a distinct PostgreSQL service
instance and public database target, the staging-only
`air-jam-preview-releases` bucket with a temporary object-read-write
credential, rotated release-pipeline secrets, a distinct public origin, and a
run-scoped creator identity. Production publication was disabled and the
resulting release remained hidden and unpublished. The controller revoked the
identity and removed all run-owned processes and temporary credentials.

## Independent Review Correction

Claude's stacked-PR review found that the first retained-proof implementation
still crossed three trust boundaries incorrectly:

1. agent-authored command text could satisfy post-repair quality criteria
2. an MCP close event could count without proving that the tool call succeeded
3. hidden-release state and sandbox isolation were recorded as facts without
   controller-owned observations

It also found that the only `G2-03` artifact reference pointed into ignored
`.airjam` state. That location is useful operator memory but is not durable
repository evidence another reviewer can retrieve. `G2-03` was therefore
reopened on 2026-08-29. The hardened controller now reruns all four quality
gates before fault injection and after repair, rejects failed MCP closes,
preflights the installed Codex sandbox, and refuses to pass until the platform
release is independently verified as ready, hidden, and non-production. Run
`a22` now supplies that passing replay and durable redacted artifact.

## Passing Replay

Run `g2-03-20260909-a22` started at `2026-09-09T04:02:24.489Z` and ended at
`2026-09-09T04:24:05.360Z`. A fresh `codex-cli 0.153.4` process had an empty
workspace, no Air Jam repository read access, no maintainer or provider
credentials, and no undeclared network access. It independently discovered
the five `0.9.3` candidate packages and then:

1. scaffolded and implemented the two-player Signal Relay game
2. passed typecheck, lint, tests, and build before the controlled fault
3. opened semantic sessions and exercised controller-owned readiness and start
4. observed the deterministic `WIN_SCORE:3->2` mutation through a failing test
   and live runtime state, then restored the rule
5. restarted the controller-owned browser broker when the old browser retained
   stale code instead of editing installed tooling or widening its sandbox
6. replayed wrong-answer lockout, rejected duplicate input, one-point scoring,
   no victory at two points, victory at three points, and complete play-again
   reset through a fresh two-controller match
7. captured and inspected lobby, playing, and winner host/controller visuals
8. reran the complete four-gate evaluation after repair
9. built, validated, and submitted the release bundle to isolated staging
10. produced ready hidden release
    `cfc41e51-efa2-4c28-9259-8d0988b275d9`; artifact validation, screenshot
    capture, and the configured image-moderation lane all passed
11. closed every session, stopped the broker and dev stack, proved zero
    remaining listeners, and revoked the run-scoped platform session

The independent verifier reported `passed` with no failures or unevaluated
criteria. The manifest indexes 149 artifacts; the durable transcript contains
144 structured events. The manifest in the durable evidence directory is the
canonical digest inventory for the transcript and all 149 source artifacts.

## Attempt Ledger

| Attempt              | Terminal classification       | Furthest trustworthy stage | Material finding                                                                                                                                                                                                                                                                                                                        | Retained proof                                                                                                                                                                  |
| -------------------- | ----------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `g2-03-20260828-a1`  | invalid harness attempt       | preflight                  | The first controller combined obsolete/incompatible Codex sandbox and approval flags. The agent never started.                                                                                                                                                                                                                          | Partial controller bundle under `.airjam/golden-path-runs/g2-03-20260828-a1/evidence`; its empty indexes are not success evidence.                                              |
| `g2-03-20260828-a2`  | invalid isolation             | create                     | The temporary project lived below the monorepo, so pnpm correctly inherited the ancestor workspace. That violated the clean-room contract.                                                                                                                                                                                              | Partial transcript and workspace under `.airjam/golden-path-runs/g2-03-20260828-a2`.                                                                                            |
| `g2-03-20260828-a3`  | failed environment attempt    | build/evaluate             | The agent independently built Signal Relay and passed typecheck, lint, focused tests, and build. `pnpm run dev` then failed because the default Codex workspace profile denied local TCP binding. A user interruption also proved that evidence retained only in the temporary root was not durable.                                    | Operator-observed only; the interrupted temporary evidence did not survive and is not admissible completion proof.                                                              |
| `g2-03-20260829-a4`  | failed environment attempt    | create                     | The hardened profile worked, but the sanitized `PATH` selected an FNM/Corepack shim. Its empty run cache tried to resolve pnpm from the external npm registry, which the network allowlist correctly denied. Concurrent recovery installs also showed that generated guidance needs an explicit one-install-at-a-time rule.             | Partial transcript under `.airjam/golden-path-runs/g2-03-20260829-a4/evidence`.                                                                                                 |
| `g2-03-20260829-a5`  | blocked environment attempt   | build                      | The agent created and implemented Signal Relay, repaired its own contract mistakes, passed all four quality gates, and started the managed dev stack. Semantic-session open failed because the managed profile denied the `tsx` Unix socket.                                                                                            | Complete controller result, transcript, runtime log, manifest, and verifier report under `.airjam/golden-path-runs/g2-03-20260829-a5/evidence`.                                 |
| `g2-03-20260829-a6`  | failed product/client attempt | control                    | With run-scoped Unix sockets allowed, the built helper was still launched through the `tsx` CLI. Its IPC listener collided with the managed profile (`EADDRINUSE`). The agent retried through supported broker controls, preserved both failures, refused to edit installed package internals, and stopped without an unproven release. | Complete normalized transcript, manifest, project state, and verifier report under `.airjam/golden-path-runs/g2-03-20260829-a6/evidence`.                                       |
| `g2-03-20260829-a7`  | blocked environment attempt   | control                    | The helper fix advanced session startup into the actual Playwright browser. Bundled Chromium and system Chrome were both denied macOS Mach-port registration inside the managed Codex process profile. The new prompt produced all six meaningful evidence indexes and preserved the blocker correctly.                                 | Twenty-seven indexed files, including complete stage indexes and failure classification, under `.airjam/golden-path-runs/g2-03-20260829-a7/evidence`.                           |
| `g2-03-20260829-a8`  | blocked client attempt        | create                     | The first package-manager pin read `create-airjam`'s own packed `package.json`; npm strips that field while packing, so the initializer rejected the otherwise valid candidate before creating a project. The attempt also exposed that early blockers need exact failure keys and valid empty downstream indexes.                      | Eighteen files under `.airjam/golden-path-runs/g2-03-20260829-a8/evidence`; the original verifier report is retained as failure evidence.                                       |
| `g2-03-20260829-a9`  | blocked environment attempt   | control                    | The shipped template manifest fixed creation and the agent independently produced the complete game, passed typecheck, lint, five domain tests, and build, and started managed dev. Semantic-session open then reproduced the bundled/system Chromium Mach-port denial. The corrected verifier preserved the terminal blocker.          | Twenty-five manifest-indexed artifacts plus the verifier report under `.airjam/golden-path-runs/g2-03-20260829-a9/evidence`.                                                    |
| `g2-03-20260909-a11` | blocked product attempt       | inspect                    | Extensionless TypeScript agent-contract imports did not resolve under the supported Node runtime.                                                                                                                                                                                                                                       | Complete classified blocker retained locally.                                                                                                                                   |
| `g2-03-20260909-a12` | failed harness attempt        | pre-fault                  | The controller could not establish the prerequisites for fault injection and independent post-run verification.                                                                                                                                                                                                                         | Failure manifest retained locally.                                                                                                                                              |
| `g2-03-20260909-a13` | blocked product attempt       | evaluate                   | The public CLI/MCP surface did not yet expose one discoverable complete evaluation operation.                                                                                                                                                                                                                                           | Complete classified blocker retained locally.                                                                                                                                   |
| `g2-03-20260909-a14` | blocked environment attempt   | control                    | Browser launch still crossed the managed macOS Mach-port boundary.                                                                                                                                                                                                                                                                      | Complete classified blocker retained locally.                                                                                                                                   |
| `g2-03-20260909-a15` | blocked environment attempt   | visual                     | Semantic multiplayer passed, but no supported CLI visual-capture lane could survive the managed browser boundary.                                                                                                                                                                                                                       | Complete classified blocker retained locally.                                                                                                                                   |
| `g2-03-20260909-a16` | blocked environment attempt   | install                    | The isolated candidate registry was not warmed with one transitive dependency required during installation.                                                                                                                                                                                                                             | Complete classified blocker retained locally.                                                                                                                                   |
| `g2-03-20260909-a18` | blocked environment attempt   | repair verification        | Source repair passed evaluation, but the stale browser could not be replaced through the still-sandboxed launcher.                                                                                                                                                                                                                      | Complete classified blocker retained locally.                                                                                                                                   |
| `g2-03-20260909-a19` | blocked environment attempt   | release upload             | The hidden game and validated bundle existed, but the agent proxy rejected the presigned R2 upload tunnel.                                                                                                                                                                                                                              | 153 indexed artifacts and a classified blocker retained locally.                                                                                                                |
| `g2-03-20260909-a20` | failed product attempt        | staging verification       | Upload reached R2, but the presigned request hoisted original-filename metadata into the URL, so R2 stored no required metadata and the generation failed `invalid_upload_facts`.                                                                                                                                                       | 143 indexed artifacts and independently inspected staging/R2 facts retained locally.                                                                                            |
| `g2-03-20260909-a22` | passed                        | complete release lifecycle | The agent completed discovery, implementation, initial evaluation, semantic control, deterministic fault diagnosis and repair, fresh-runtime replay, visual inspection, final evaluation, hidden staging submission, independent release verification, and cleanup.                                                                     | Durable sanitized transcript, manifest, verifier, isolation, quality, session, visual, and release evidence in [`evidence/g2-03-20260909-a22`](./evidence/g2-03-20260909-a22/). |

## What The Agent Proved

Across the retained runs, an external agent with no monorepo source context was
able to:

1. find the candidate packages through registry and package metadata
2. discover the correct `airjam` CLI, MCP server, generated docs, and generated
   skills
3. recover the intended architecture: pure domain rules, host-authoritative
   replicated transitions, explicit untrusted controller actions, thin UI
   compositions, and one semantic agent contract
4. implement a polished two-to-four-player Signal Relay game from the minimal
   scaffold
5. diagnose type-level and contract-level mistakes from public SDK types rather
   than private examples
6. pass typecheck, lint, focused domain tests, and production build
7. start and inspect the real managed local dev stack through `pnpm run dev`
8. initialize and inspect the public MCP protocol
9. use status, unified logs, broker status/stop, and session commands as one
   coherent machine operating surface
10. stop safely when the supported contract could not prove a required stage
11. diagnose and repair a deterministic behavior regression using tests, live
    authoritative state, and a fresh runtime
12. inspect host and controller visuals through the same machine lifecycle
13. submit and independently verify a ready hidden release in isolated staging
14. clean every run-owned local process and revoke its platform identity

This is strong evidence for the central product theory: the generated harness,
not a mandatory hosted Studio, can carry an agent from an empty directory to a
substantial game. The remaining failures are concentrated in lifecycle edges,
not in the game framework's basic ability to support agent-authored products.

## Defects Closed During G2-03

### Harness And Isolation

1. replaced invalid Codex automation flags with the current custom permission
   profile contract
2. moved the clean workspace outside the monorepo and attested that boundary
3. denied child reads of the Air Jam repository while retaining only declared
   run-owned writes
4. enabled loopback TCP binding and only the run-owned Unix-socket root
5. put the pinned host pnpm binary ahead of user-level Corepack shims
6. isolated `TMPDIR`, Air Jam state, Corepack, XDG, npm, and pnpm caches
7. mirrored transcripts and evidence during execution instead of only at exit
8. made durable controller-state writes atomic
9. delayed the declared fault until all four initial quality gates are rerun by
   the controller and one successfully closed semantic session is observed;
   the controller reruns the same four gates after repair
10. exposed every agent-owned evidence index and its minimum schema in the
    primary prompt; placeholder success records are explicitly forbidden
11. made the independent verifier distinguish `invalid`, `blocked`, `failed`,
    and `passed`; preserve the first structurally valid blocker; and report
    downstream criteria as not evaluated instead of failed
12. replaced assertion-only sandbox evidence with deterministic deny/allow
    probes against the installed Codex CLI
13. made retained evidence snapshots prune stale files, replace the retained
    bundle atomically with rollback, redact every valid UTF-8 artifact before
    mirroring, and reject binary evidence that cannot be safely inspected

### Product And Scaffold

1. built JavaScript helpers now run directly under Node; authored TypeScript
   helpers use Node's `--import` loader path instead of starting the `tsx` CLI
   IPC server
2. the same helper-launch contract now covers semantic control, agent-contract
   inspection, AI configuration inspection, and visual capture
3. generated projects now retain a canonical `lint` script
4. generated projects pin the repository's canonical pnpm version through a
   shipped template manifest that survives npm packing
5. scaffold smoke tests now require and execute the same lint gate that the
   external-agent contract requires
6. the isolated bootstrap now asserts the package-manager and lint contracts
   and executes typecheck, lint, tests, and build
7. generated agent guidance serializes scaffold/package-manager mutations so
   one installation owns the workspace at a time
8. early classified blockers can carry empty downstream indexes without being
   misreported as missing product work

## Independent Integration Review Closeout

The cumulative `#61` review found that several early hardening assertions were
narrower than their evidence names. The corrected controller now:

1. proves Docker manifest copies in the dependency stage before the frozen
   install, with Dockerfile discovery rather than a hand-maintained file list
2. compares rendered variables across every deployed Air Jam Railway service,
   requires distinct service instances, and fails closed on an equal production
   value unless its name is explicitly classified as safe configuration
3. requires a remote browser endpoint to resolve to the staging worker while
   preserving the runtime contract that its token is conditional on that
   endpoint
4. composes `publicOriginDistinct` only after the independent public-domain
   comparison succeeds
5. bounds the primary Codex process and final managed-dev cleanup, uses one
   process-tree shutdown primitive, and reports a missing Codex/toolchain binary
   directly
6. consumes one canonical MCP tool-name manifest instead of relying on a magic
   count and brings both the CLI and MCP package tests into root CI
7. validates artifact evidence as a Git commit, Git range, or durable
   repository file instead of accepting an opaque formatted string

Those corrections initially left the Railway preview inadmissible because it
still derived storage and credentials from production. The later isolated
staging lifecycle replaced every affected authority, proved the separation
through provider state and live denial probes, and supplied the admissible
environment used by passing run `a22`.

## Remaining Closure Work

The primary Codex lane no longer has a known product blocker. Gate `G2-04` must
now prove that Claude Desktop can independently discover the packaged surface
and bootstrap semantic sessions without private maintainer knowledge. Gate
`G2-05` then owns any client-specific corrections, a final exact replay against
the settled candidate path, and an honest classification of residual friction.

The `create-airjam` archive size is no longer an unowned concern: `G6-01`
measured it across the full Node/OS matrix and enforces the explicit 100 MiB
ceiling. Search spelling remains observable onboarding friction for Gate 6,
not a blocker to the now-proven primary lifecycle.

## Architectural Assessment

The strongest part of the product is contract convergence. Generated docs,
skills, CLI, MCP, replicated state, semantic actions, unified logs, and release
commands describe the same operating model. The external agents repeatedly
recovered the intended host-authoritative architecture without private source
access.

The former weakest part was lifecycle composition at clean-room boundaries.
The repeated failed attempts exposed and then closed package-manager,
process-ownership, helper-transport, browser, evidence, staging-identity,
storage-upload, and cleanup seams. The next uncertainty is portability: one
Codex lane is now proven, but the second supported client and final settled
candidate still need independent evidence.

The correct 1.0 response is not to add a second hosted Studio or a parallel
operator model. It is to finish the single CLI/MCP harness so creation,
inspection, evaluation, publication, evidence, and safe cleanup remain one
canonical lifecycle for humans and agents.

## Gate Boundary

`G2-03` owns the retained Codex primary run and its findings. `G2-04` separately
owns Claude Desktop packaging, discovery, and semantic-session proof. `G2-05`
owns the browser/staging lifecycle fixes and exact terminal passing replay.
Run `a22` satisfies `G2-03`'s primary-attempt and durable-evidence requirement.
It does not certify Claude Desktop, the complete Gate 2 scenario, or production
readiness, and no attempt in this audit authorizes public publication.
