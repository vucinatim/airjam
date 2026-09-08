# Railway Deployment Guide

Last updated: 2026-09-04
Status: active guide

Related docs:

1. [Deployment Topology](../strategy/deployment-topology.md)
2. [Production Observability Baseline](../strategy/production-observability-baseline.md)
3. [Post-v1 Topology Roadmap](../strategy/post-v1-topology-roadmap.md)

## Purpose

This guide explains the deploy model that now matters:

1. Railway hosts the platform, realtime server, browser worker, and operational-job
   worker
2. Railway native PR environments own preview lifecycle
3. the repo only owns config clarity, inspection, and validation

Do not treat Air Jam deploys as a split Vercel plus Railway system anymore.

## Canonical Services

The production Railway project should contain four deployable services:

1. `air-jam-platform`
2. `air-jam-server`
3. `air-jam-release-browser-worker`
4. `air-jam-platform-worker`

The platform and realtime Dockerfiles use the repository's Node 22 runtime
floor. The operational worker must remain attached to
`/apps/platform/railway.worker.json` so its build, bundled entrypoint,
readiness boundary, and watched paths are source-owned rather than duplicated
in Railway service settings.

Persistent infrastructure remains external:

1. PostgreSQL on Railway
2. release/media object storage in R2
3. a dedicated cookieless domain for untrusted hosted release content

## Canonical Preview Model

Previews are Railway-native.

That means:

1. PR environments are enabled at the project level
2. focused PR environments are disabled unless Railway proves they are reliable enough
3. each PR environment contains the same service set as production, including its own ephemeral Postgres
4. the repo does not mint custom `full-pr-*` aliases or own preview teardown

### Behavior on PR open

1. Railway clones every service into an ephemeral environment named `air-jam-pr-<number>`.
2. The ephemeral Postgres boots empty. The platform container applies the
   committed Drizzle migrations before starting Next.js, but only when
   `RAILWAY_ENVIRONMENT_NAME != "production"`.
3. Both the platform and realtime server must define `DATABASE_URL` as the
   Railway service reference `${{Postgres.DATABASE_URL}}`. Never store it as a
   literal: a PR environment generates new Postgres credentials, and a copied
   production connection string will fail authentication.
4. `resolvePlatformDeploymentConfig` detects `RAILWAY_ENVIRONMENT_NAME != "production"` and forces `githubAuthEnabled = false`. Avoids the GitHub OAuth wildcard-callback problem and keeps preview auth simple.
5. The realtime server derives preview policy from the canonical deployment
   environment resolver. Railway identity takes precedence over explicit local
   overrides, so production cannot self-identify as preview. The server
   requires the preview database for lane and capacity authority, while marking
   production provider-budget evidence as `not_applicable`; preview workers do
   not need production usage credentials to make realtime ready.
6. `.github/workflows/preview-comment.yml` polls Railway, resolves the platform service domain in the new environment, and posts a sticky preview-URL comment on the PR.

The workflow needs a single repo secret: `RAILWAY_PROJECT_TOKEN` (a Railway project-scoped token).

### Production schema management

Production schema is migration-managed through the canonical repo lifecycle.
The committed Drizzle journal remains the source of truth, but agents must use
`platform database migration inspect|plan|apply|verify`; raw `drizzle-kit`
invocation and manually extracted production credentials are not supported
operator paths. The preview-only container migration path still does not run
when `RAILWAY_ENVIRONMENT_NAME=production`.

See the [production database migration contract](../contracts/production-database-migration-contract.md)
for migration modes, immutable plans, lane drain behavior, failure semantics,
and the exact merge/apply/deploy/verify sequence.

## Repo Commands

The repo now exposes Railway inspection, not a custom preview control plane.

Use:

```bash
pnpm run repo -- railway whoami
pnpm run repo -- railway doctor
pnpm run repo -- railway doctor --json
pnpm run repo -- platform release-origin inspect
pnpm --silent run repo -- platform release-origin inspect --json
pnpm --silent run repo -- platform release-origin inspect --platform-url https://airjam.io --json
pnpm --silent run repo -- platform release-origin attest --platform-url https://airjam.io --release-url https://<release-domain>/releases/g/<game-id>/r/<release-id>/generations/<generation-id> --railway-project <project-id> --json
pnpm --silent run repo -- platform database migration inspect --railway-environment <environment-id> --railway-project <project-id> --json
```

`railway doctor` should answer:

1. which project we are inspecting
2. whether PR environments are enabled
3. which environment is primary
4. which ephemeral environments are currently open
5. whether platform, server, browser worker, and operational-job worker all have
   healthy deploy identity

`platform release-origin inspect` assesses local configuration by default.
Pass the deployed platform origin through `--platform-url` to inspect its public
`/api/readiness` contract authoritatively without loading or printing provider
credentials. Production must report `ready` before hosted release delivery is
considered healthy.

The inspector returns a valid Railway platform readiness document even when its
HTTP status is `503`, preserving `readiness.ok: false`, the effective platform
request-host policy, and the exact disabled or invalid boundary reason for
agents. It rejects an inspected URL that is not the deployment's reported
canonical platform origin. A valid `503` proves that hosted release delivery is
not product-ready; it does not make a terminal-successful live platform process
unhealthy. Railway's deployment healthcheck remains `/api/health`, which reports
process liveness independently of product and release-domain readiness.

After the dedicated domain is routed, use `platform release-origin attest`
against one exact live release-generation root. The command is safe for unattended agents:
it performs bounded DNS-pinned HTTP/TLS checks and does not launch a browser or
execute release code. It independently rejects a shared cookie site and probes
the actual Better Auth anonymous-session response in addition to protected API
CORS. Preserve its JSON alongside the exact deployment being approved.
`productionEvidenceEligible: true` requires public HTTPS, a complete
and stable deployment-reported identity, every routing, response, cookie, and
protected-endpoint CORS check to pass, and a bounded Railway query that matches
the exact expected project, production environment, current platform-service
deployment, and both public domains. Supply `--railway-project <project-id>` or
`RAILWAY_PROJECT_ID` and one of `RAILWAY_PROJECT_TOKEN`, `RAILWAY_API_TOKEN`, or
`RAILWAY_TOKEN`. Without either identity or provider authority, passing
transport evidence remains diagnostic. The provider does not independently
authenticate the readiness revision. This is one input to Gate 5 closure, not a
substitute for the controlled hostile-browser and normal-game proofs.

## Production Contract

Production should stay boring:

1. the platform serves `airjam.io`
2. the server serves `api.airjam.io`
3. `AIRJAM_RELEASES_PUBLIC_ORIGIN` is
   `https://games.air-jam.app`, a dedicated cookieless site that is not
   `airjam.io` or any `*.airjam.io` sibling
4. the browser worker is not public product UI and should expose only the narrow routes it needs
5. the operational-job worker exposes only liveness, readiness, and authenticated
   drain; it owns durable processing, not public API traffic
6. the platform should consume the public server URL explicitly rather than guessing from provider-specific env

## Production Rollout Validation

Before treating a production rollout as the exact merged revision and a live
process, verify:

1. `pnpm --silent run repo -- railway doctor --project <project-id> --json`
   reports the expected project, production environment, affected services, and
   deployment IDs
2. until Gate `G5-02` lands the repo-owned exact-commit verifier, bind each
   affected service to the exact merged commit and provider deployment with:

   ```bash
   gh api repos/vucinatim/air-jam/commits/<merged-commit>/status
   npx -y @vucinatim/agentic-devtools railway get-deployment --deployment-id <deployment-id>
   ```

   Select the affected service's GitHub deployment status, require
   `state: success`, and retain the deployment ID from its `target_url`. Require
   the provider response to report the same `id` and literal `status: SUCCESS`.
   This is an explicitly interim provider read, not a second long-term
   deployment authority.

3. when the platform is affected, `/`, `/arcade`, and `/docs` return `200`
4. when the platform is affected, `/api/health` returns `200` as
   process-liveness proof and reports the exact deployment ID and merged
   revision
5. when the platform is affected, `/api/auth/get-session` returns `200` and
   `/api/airjam/host-grant` works same-origin
6. when the server is affected, `/health` returns `200`
7. when the browser worker is affected, `/health` returns `200`
8. when the operational-job worker is affected, `/health` returns `200` and
   `/ready` returns `200` only after PostgreSQL authority is available
9. when operational reliability changes, the repo-CLI reliability status shows
   no dead-letter events and every configured launch-critical synthetic has a
   retained recent run
10. classify every unchanged service as unaffected and confirm that its
    preceding successful deployment remains live

## Hosted Release Product-Readiness Validation

The production domain provisioning and rollback order is governed by the
[hosted release domain cutover plan](../plans/hosted-release-domain-cutover-plan.md).

Before treating hosted release delivery as product-ready, verify:

1. platform `/api/readiness` returns `200` with `ok: true`, the expected
   canonical platform origin, `isRailwayPreviewEnvironment: false`, and
   deployment identity matching the exact revision under approval
2. release-origin attestation returns `status: passed`,
   `evidenceKind: production-deployment`, and
   `productionEvidenceEligible: true`

Before terminating or replacing the operational-job worker, call its authenticated
`POST /drain` endpoint and wait for bounded completion. Queue state remains in
PostgreSQL across deploys; a process restart must never be treated as job loss.

Configure these reliability values on the operational worker:

1. `AIRJAM_SYNTHETIC_HOSTED_RELEASE_URL` pointing to one exact immutable live
   generation
2. `AIRJAM_SYNTHETIC_WORKER_ORIGIN` pointing to the operational worker's public
   health origin
3. `AIRJAM_SYNTHETIC_BROWSER_WORKER_ORIGIN` pointing to the browser worker
4. `AIRJAM_SYNTHETIC_APP_ID` when the platform app identity is not appropriate

Do not set `AIRJAM_OPERATIONAL_ENVIRONMENT` on Railway. The provider-owned
`RAILWAY_ENVIRONMENT_NAME` is authoritative, so production resolves to
production while every PR environment resolves to preview even when Railway
clones service variables. In PR environments, operational synthetics use the
environment-scoped `RAILWAY_SERVICE_AIR_JAM_PLATFORM_URL`,
`RAILWAY_SERVICE_AIR_JAM_SERVER_URL`,
`RAILWAY_SERVICE_AIR_JAM_PLATFORM_WORKER_URL`, and
`RAILWAY_SERVICE_AIR_JAM_RELEASE_BROWSER_WORKER_URL` targets instead of the
production-oriented explicit origins above.

The same worker is the sole continuous Railway budget-evidence collector.
Configure `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, and an
environment-scoped `RAILWAY_PROJECT_TOKEN` as a sealed Railway variable. Do not
provide an account token fallback, and do not expose this token to PR preview
services. Production enables collection automatically, runs once at startup,
then every 15 minutes with database-coordinated due skipping. Railway must use
the worker's `/ready` endpoint: it remains unavailable for missing or stale
persisted evidence, while a transient provider failure does not disrupt
readiness when retained evidence is still fresh.

Roll this authority out in dependency order:

1. verify the existing operational-budget migrations are applied; this feature
   adds no table or migration
2. set the exact project/environment ids and sealed project token on the
   production operational-worker service
3. deploy the worker and wait for its immediate refresh to make `/ready` return
   `200`
4. verify `platform operations budget status --json` reports `fresh`
5. only then deploy or scale realtime admission that consumes this persisted
   evidence

Rolling worker overlap is safe: PostgreSQL serializes refresh ownership and the
second worker re-reads before contacting Railway. During rollback, keep at least
one budget-refresh-capable worker authoritative; do not replace it with an old
worker that can only retain evidence until it becomes stale.

Configure the narrow GitHub issue bridge only on that worker, using a
repository-installed App with repository metadata read and Issues read/write:

1. `AIRJAM_GITHUB_ISSUES_APP_ID`
2. `AIRJAM_GITHUB_ISSUES_INSTALLATION_ID`
3. `AIRJAM_GITHUB_ISSUES_PRIVATE_KEY`
4. `AIRJAM_GITHUB_ISSUES_REPOSITORY=vucinatim/air-jam`
5. optional `AIRJAM_PLATFORM_WORKER_ISSUE_PROJECTION_MS` (default `5000`)

Do not copy these values to platform web, realtime, browser-worker, or PR
preview services. Use the issue-only App identity rather than a maintainer
token.

Configure `AIRJAM_OPERATIONAL_ENVIRONMENT=production` and
`AIR_JAM_RUNTIME_ERROR_REPORT_RATE_LIMIT_MAX` on the realtime server. Hosted
runtime crash reports are bounded, room-authorized evidence; they are never
authoritative repair instructions.

Use the repo-owned machine surface for inspection and safe maintenance:

```bash
pnpm --silent run repo -- platform operations reliability catalog --json
pnpm --silent run repo -- platform operations reliability status \
  --railway-environment <environment-id> \
  --railway-project <project-id> \
  --json
pnpm --silent run repo -- platform operations reliability issues --help
```

For PR environments, verify the same shape against the ephemeral Railway domains.

## What Not To Reintroduce

Do not rebuild the old split-provider preview system casually.

Avoid:

1. repo-owned preview up/down workflows
2. custom full-stack preview aliases
3. Vercel-specific fallback identity logic
4. provider-guessing bootstrap rules

If deploy complexity grows again, prefer making the Railway contract more explicit rather than adding a second orchestration layer.
