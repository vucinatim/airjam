# Air Jam Docs Index

Last updated: 2026-09-04
Status: current navigation

This is the canonical navigation entry for the Air Jam repository.

## Read First

Use this order for fast orientation:

1. [../README.md](../README.md)
2. [current-state.md](./current-state.md)
3. [working-agreements.md](./working-agreements.md)
4. [documentation-taxonomy.md](./documentation-taxonomy.md)
5. the relevant active plan
6. [work-ledger.md](./work-ledger.md) only if historical context is needed

Default agent loop:

1. orient from the read-first path
2. open only the relevant active plan
3. implement and validate
4. update history or current-state only if the operating rules require it

## Active Now

The 1.0 release roadmap is the governing product track:

1. [plans/v1-release-roadmap-plan.md](./plans/v1-release-roadmap-plan.md)

The machine-backed subordinate execution plan owns dependency-aware work
packages, evidence, the batched checkpoint model, and the canonical architecture
for the remaining 1.0 reliability, recovery, agent-operated alerting, security,
and release work:

1. [plans/v1-release-execution-plan.md](./plans/v1-release-execution-plan.md)

The cross-environment strategy for smart local agents operating through Air
Jam, GitHub, and Railway is:

1. [strategy/agent-operating-ecosystem-strategy.md](./strategy/agent-operating-ecosystem-strategy.md)

The active Gate 5 production boundary cutover is governed by:

1. [plans/hosted-release-domain-cutover-plan.md](./plans/hosted-release-domain-cutover-plan.md)

Agents inspect the live execution state through:

```bash
pnpm --silent run repo -- readiness status --json
pnpm --silent run repo -- readiness next --json
```

The evidence-backed architecture and simplicity baseline for Gate 1 is:

1. [audits/v1-canonicalization/v1-canonicalization-audit.md](./audits/v1-canonicalization/v1-canonicalization-audit.md)
2. [audits/v1-canonicalization/codebase-assessment.md](./audits/v1-canonicalization/codebase-assessment.md)
3. [audits/v1-canonicalization/canonicalization-execution-set.md](./audits/v1-canonicalization/canonicalization-execution-set.md)
4. [audits/v1-canonicalization/public-surface-source-audit.md](./audits/v1-canonicalization/public-surface-source-audit.md)
5. [audits/v1-canonicalization/gate-1-removal-approval-packet.md](./audits/v1-canonicalization/gate-1-removal-approval-packet.md)

The assessment preserves the architectural judgment. The execution set owns
the deletion-first bundles and Git measurement contract. The readiness manifest
remains the execution-state authority.

The canonical Gate 2 external-agent proof is defined by:

1. [contracts/external-agent-golden-path-contract.md](./contracts/external-agent-golden-path-contract.md)
2. [audits/v1-golden-path/public-bootstrap-audit.md](./audits/v1-golden-path/public-bootstrap-audit.md)
3. [audits/v1-golden-path/primary-agent-run-audit.md](./audits/v1-golden-path/primary-agent-run-audit.md)
4. the machine-readable scenario and prompt exposed through
   `pnpm --silent run repo -- golden-path spec --json`

The Gate 6 public package graph, supported Node/OS matrix, budgets, and
machine-executable clean-install contract are defined by:

1. [contracts/public-package-support-contract.md](./contracts/public-package-support-contract.md)
2. [contracts/public-package-release-trust-contract.md](./contracts/public-package-release-trust-contract.md)
3. [audits/v1-public-release/public-install-matrix-audit.md](./audits/v1-public-release/public-install-matrix-audit.md)
4. `pnpm --silent run repo -- release install-matrix spec --json`

The ranked Gate 5 public, privileged, artifact, runtime, agent, provider,
privacy, and supply-chain security baseline is:

1. [audits/v1-security/threat-model-audit.md](./audits/v1-security/threat-model-audit.md)
2. [audits/v1-security/supply-chain-release-trust-proof.md](./audits/v1-security/supply-chain-release-trust-proof.md)

The audit owns evidence and decisions. `G5-02` and `G5-03` in the readiness
manifest own implementation and proof; the document is not a parallel backlog.

The Gate 4 authority boundary and future vocabulary for operational evidence,
alerts, incidents, and runbooks is defined by:

1. [contracts/operational-events-and-incidents-contract.md](./contracts/operational-events-and-incidents-contract.md)
2. [contracts/operational-reliability-contract.md](./contracts/operational-reliability-contract.md)
3. [contracts/operational-alert-issue-projection-contract.md](./contracts/operational-alert-issue-projection-contract.md)
4. [audits/v1-operations/operational-contract-proof.md](./audits/v1-operations/operational-contract-proof.md)
5. [audits/v1-operations/operational-reliability-proof.md](./audits/v1-operations/operational-reliability-proof.md)
6. [audits/v1-operations/operational-alert-issue-projection-proof.md](./audits/v1-operations/operational-alert-issue-projection-proof.md)
7. [audits/v1-operations/production-rollout-incident-audit.md](./audits/v1-operations/production-rollout-incident-audit.md)
8. the machine-readable catalogs, JSON Schemas, validators, and reliability
   operations exposed through
   `pnpm --silent run repo -- platform operations contract --help` and
   `pnpm --silent run repo -- platform operations reliability --help`

The measured Gate 3 production baseline is:

1. [audits/v1-reliability/production-capacity-cost-and-recovery-audit.md](./audits/v1-reliability/production-capacity-cost-and-recovery-audit.md)
2. [audits/v1-reliability/production-budget-evidence-proof.md](./audits/v1-reliability/production-budget-evidence-proof.md)
3. [audits/v1-reliability/production-shadow-quota-proof.md](./audits/v1-reliability/production-shadow-quota-proof.md)
4. [audits/v1-reliability/production-durable-job-authority-proof.md](./audits/v1-reliability/production-durable-job-authority-proof.md)
5. [audits/v1-reliability/production-immutable-release-generations-proof.md](./audits/v1-reliability/production-immutable-release-generations-proof.md)
6. [audits/v1-reliability/production-operational-job-worker-proof.md](./audits/v1-reliability/production-operational-job-worker-proof.md)
7. [audits/v1-reliability/production-lifecycle-cleanup-proof.md](./audits/v1-reliability/production-lifecycle-cleanup-proof.md)
8. [contracts/production-control-contract.md](./contracts/production-control-contract.md)
9. [contracts/production-database-migration-contract.md](./contracts/production-database-migration-contract.md)
10. [audits/v1-reliability/production-migration-lifecycle-proof.md](./audits/v1-reliability/production-migration-lifecycle-proof.md)
11. [contracts/production-recovery-contract.md](./contracts/production-recovery-contract.md)
12. [audits/v1-reliability/production-recovery-proof.md](./audits/v1-reliability/production-recovery-proof.md)

It distinguishes the current low-cost, low-usage production state from the
queues, quotas, recovery, static-delivery, and operational controls still
required before launch-scale traffic is invited. The production-control
contract fixes the shared admission, budget, job, cleanup, audit, and CLI model
that Gate 3 implements. The budget proof records the implemented provider-to-
policy-to-database lifecycle without implying that the remaining gate is done.
The shadow-quota proof records the source-owned allowance catalog,
authoritative creator/game usage, and agent-readable prospective decisions.
The durable-job proof records the bounded PostgreSQL queue, database-time lease
and deadline fencing, lane-synchronized claims, immutable command replay,
release-scoped provenance, redacted operator reads, retry, cancellation,
repair, and CLI authority. The immutable-generation proof records generation-
scoped source and output identity, candidate/promoted fencing, exact check
provenance, fail-closed legacy migration, and the shared human/machine contract
that made safe worker execution possible. The operational-job worker proof records
the completed adapter cutover, attempt-scoped executor graph, separately
deployable drainable process, cleanup and one-cycle CLI operations, and
enqueue/inspect/wait semantics without claiming that production rollout or the
rest of Gate `G3-02` is complete.

The lifecycle-cleanup proof records exact retry-safe deletion for temporary
artifacts and media plus the complete superseded-unpublished lifecycle: a
180-day inactivity clock, durable seven-day creator warning, safe export and
retention renewal through dashboard/API/CLI/MCP, and PostgreSQL-enforced
cleanup eligibility.

The detailed discoverability checklist remains a subordinate launch reference:

1. [plans/discoverability-and-launch-promotion-plan.md](./plans/discoverability-and-launch-promotion-plan.md)

The completed first-party telemetry work is preserved in the
[2026-08-26 telemetry archive](./archive/2026-08-26-first-party-product-telemetry-plan.md),
and the completed Android Auto work is preserved in the
[2026-07-24 road-trip archive](./archive/2026-07-24-android-auto-road-trip-plan.md).
Their durable improvements now feed into the v1 release proof rather than
competing as parallel product architectures.

## Planned Next

The roadmap gates define the product sequence and the readiness manifest derives
the currently executable queue. The next independent work is:

1. finish Gate `G3-02` realtime admission and overload proof, then roll out the
   complete storage-retention lifecycle and operational worker safely
2. close the remaining ranked Gate 5 security findings after the completed
   `games.air-jam.app` production cutover
3. project confirmed operational alert keys into maintained GitHub
   issues with linked evidence for local agents
4. run isolated backup/restore and rollback/replay proof
5. prove supply-chain provenance, privacy claims, and the emergency release
   procedure
6. post-v1 architecture work is intentionally non-current and now lives in:
   1. [strategy/post-v1-topology-roadmap.md](./strategy/post-v1-topology-roadmap.md)
7. do not treat future topology work as a second live execution plan while the
   [1.0 roadmap](./plans/v1-release-roadmap-plan.md) is still current

## Core Docs

1. [vision.md](./vision.md)
2. [discoverability-vision.md](./discoverability-vision.md)
3. [framework-paradigm.md](./framework-paradigm.md)
4. [capability-inventory.md](./capability-inventory.md)
5. [monorepo-operating-system.md](./monorepo-operating-system.md)

## Operating Surfaces

1. [current-state.md](./current-state.md)
2. [working-agreements.md](./working-agreements.md)
3. [documentation-taxonomy.md](./documentation-taxonomy.md)
4. [work-ledger.md](./work-ledger.md)
5. [suggestions.md](./suggestions.md)

## Reference Directories

1. `docs/plans/`
2. `docs/architecture/`
3. `docs/contracts/`
4. `docs/guides/`
5. `docs/strategy/`
6. `docs/content/`
7. `docs/audits/`
8. `docs/archive/`

Use the capability inventory for breadth and these directories for the cleaner
explanatory layer around the same implemented surface.

## Rule

Keep this file compact.
It should point to the right surfaces, not re-list every file in the repo.
