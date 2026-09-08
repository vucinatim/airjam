# Deployment Topology

Last updated: 2026-09-04
Status: canonical target topology; operational worker rollout pending

Related docs:

1. [Railway Deployment Guide](../guides/railway-deployment-guide.md)
2. [Production Observability Baseline](./production-observability-baseline.md)
3. [Post-v1 Topology Roadmap](./post-v1-topology-roadmap.md)
4. [Hosted Release Domain Cutover Plan](../plans/hosted-release-domain-cutover-plan.md)

This document defines the production topology that now matters.

## Goal

Production should be explicit and boring.

That means:

1. one provider owns deploy lifecycle for the first-party product surface
2. each service has one clear responsibility
3. build and start commands are explicit
4. required environment variables are explicit
5. cross-service dependencies are explicit
6. previews use the provider's native lifecycle unless there is a proven reason not to

## Canonical Topology

Air Jam production should be split into five surfaces:

1. `Railway` for the platform app
2. `Railway` for the realtime/API server
3. `Railway` for the release screenshot and moderation worker
4. `Railway` for the durable platform operational worker
5. `R2` for hosted release artifacts and managed media

That split matches the actual workload boundaries:

1. the platform app is a public Next.js web surface
2. the realtime server is a long-lived websocket and room-lifecycle process
3. screenshot capture and moderation require a stateful browser runtime and should not be coupled to the realtime server
4. durable release orchestration requires a drainable database-backed process,
   not a creator request or the browser service
5. release artifacts and media should stay externalized

## Service Ownership

### 1. Platform App

Provider: `Railway`
Repo ownership: `apps/platform`

Responsibilities:

1. landing page
2. Arcade
3. dashboard
4. auth flows
5. hosted release submission, durable enqueue, inspection, and publish control
6. managed media routes

Should not own:

1. long-lived realtime socket handling
2. screenshot browser runtime
3. direct release artifact storage

Public origins:

1. `https://airjam.io`
2. `https://www.airjam.io`
3. `https://games.air-jam.app` for untrusted creator-content execution, not
   product navigation

Important env ownership:

1. `NEXT_PUBLIC_AIR_JAM_SERVER_URL`
2. `NEXT_PUBLIC_AIR_JAM_PUBLIC_HOST`
3. `BETTER_AUTH_URL`
4. `BETTER_AUTH_SECRET`
5. GitHub auth credentials
6. release storage env
7. release moderation env

### 2. Realtime/API Server

Provider: `Railway`  
Repo ownership: `packages/server`

Responsibilities:

1. websocket and session lifecycle
2. room creation and bootstrap
3. host and controller traffic
4. authoritative multiplayer coordination
5. server-side auth validation for multiplayer access

Should not own:

1. platform page rendering
2. screenshot capture
3. release moderation browser processes
4. managed media presentation

Public origin:

1. `https://api.airjam.io`

Config-as-code path:

1. `/packages/server/railway.json`

### 3. Release Screenshot / Moderation Worker

Provider: `Railway`  
Repo ownership: `packages/release-browser-worker`

Responsibilities:

1. open hosted release URLs in a real browser
2. capture release screenshots during finalize and publish
3. support image moderation evaluation

Should not own:

1. websocket gameplay runtime
2. platform page rendering
3. release artifact persistence

Worker access is an explicit auth boundary:

1. health and discovery can remain narrow unauthenticated routes
2. proxied HTTP and WebSocket browser access should require a bearer token
3. the platform should provide that token through `AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN`

Config-as-code path:

1. `/packages/release-browser-worker/railway.json`

### 4. Platform Release-Job Worker

Provider: `Railway`
Repo ownership: `apps/platform`

Responsibilities:

1. claim PostgreSQL-authoritative release and lifecycle jobs
2. execute versioned generation-scoped release and resource-scoped cleanup work
3. heartbeat, retry, cancel, repair, clean terminal attempt outputs, and
   schedule retention-eligible resources
4. expose liveness, authority-backed readiness, and authenticated drain

Should not own:

1. public page or API serving
2. realtime room/session authority
3. a separate queue or release state machine

Config-as-code path:

1. `/apps/platform/railway.worker.json`

The worker uses the same release application services and PostgreSQL authority
as the platform, while remaining a separately scalable and drainable process.

### 5. Storage

Provider: `R2`

Responsibilities:

1. hosted release bundles
2. release assets
3. managed media for thumbnail, cover, and preview video

Storage should remain dumb infrastructure. Presentation and access policy stay in the platform app.

## Canonical Preview Model

Previews should be Railway-native.

That means:

1. Railway PR environments are enabled at the project level
2. focused PR environments stay off unless Railway proves they are reliable enough
3. preview environments use the same service set as production
4. the repo does not own custom `full-pr-*` aliases or a separate preview lifecycle

## Current Production State

The intended live shape is now also the deployment shape:

1. Railway hosts the platform app
2. Railway hosts the realtime server and Postgres
3. Railway hosts the release browser worker
4. production schema is independently verified at migration head `0036`
   through the canonical migration lifecycle
5. the repo defines the operational worker, but its production service rollout
   remains pending the documented activation, drain, rollback, and cost proof
6. R2 stores release and media objects

The remaining operational work is the explicit operational-worker rollout and
steady-state validation, not another topology redesign.

## Clean Production Contract

The intended production contract is:

1. Railway owns the first-party app services
2. R2 owns only release and media object storage
3. no production capability should depend on provider-specific fallbacks such as `VERCEL_URL`
4. the repo owns inspection and validation, not a second deploy control plane

## Environment Ownership Matrix

### Platform App Env

Platform-only env should include at least:

1. `NEXT_PUBLIC_AIR_JAM_SERVER_URL`
2. `NEXT_PUBLIC_AIR_JAM_PUBLIC_HOST`
3. `BETTER_AUTH_URL`
4. `BETTER_AUTH_SECRET`
5. `GITHUB_CLIENT_ID`
6. `GITHUB_CLIENT_SECRET`
7. `DATABASE_URL`
8. `AIR_JAM_MASTER_KEY`
9. `AIRJAM_RELEASES_R2_BUCKET`
10. `AIRJAM_RELEASES_R2_ACCOUNT_ID` or `AIRJAM_RELEASES_R2_ENDPOINT`
11. `AIRJAM_RELEASES_R2_ACCESS_KEY_ID`
12. `AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY`
13. `AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN`
14. `AIR_JAM_SYSTEM_APP_ID`
15. `AIR_JAM_HOST_GRANT_SECRET`

The web process should not claim or execute release jobs.

### Realtime Server Env

Server-only env should include at least:

1. `DATABASE_URL`
2. `AIR_JAM_MASTER_KEY`
3. `AIR_JAM_AUTH_MODE`
4. `AIR_JAM_ALLOWED_ORIGINS`
5. `AIR_JAM_HOST_GRANT_SECRET`

`AIR_JAM_ALLOWED_ORIGINS` accepts comma-separated exact origins, a leading
subdomain wildcard such as `https://*.vercel.app`, or `*`. Prefer the narrowest
policy that covers the deployment topology. A leading wildcard matches exactly
one DNS label and never matches the apex, nested subdomains, another protocol,
or a lookalike suffix.

The realtime server should not need the platform's release-storage or moderation env.

### Browser Worker Env

Worker-specific env should be limited to whatever the browser service needs to run safely, such as:

1. browser process settings
2. optional access token or shared secret for callers
3. any worker-level observability config

The worker should not need database or multiplayer env unless a later design explicitly makes that necessary.

### Platform Operational Worker Env

The operational worker owns:

1. `DATABASE_URL`
2. the release-storage variables required by artifact work and cleanup
3. `AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN`, shared with the platform's private
   generation-serving route
4. `AIRJAM_RELEASES_BROWSER_WS_ENDPOINT`
5. `AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN` when the browser worker requires it
6. `OPENAI_API_KEY` only when moderation mode enables it
7. `AIRJAM_PLATFORM_WORKER_CONTROL_TOKEN`
8. `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, and a sealed,
   environment-scoped `RAILWAY_PROJECT_TOKEN` for budget evidence; never an
   account token
9. optional `AIRJAM_PLATFORM_WORKER_*` scheduling and drain bounds, including
   the 15-minute budget-refresh cadence
10. the explicit `AIRJAM_SYNTHETIC_*` targets required by the enabled synthetic
   catalog
11. `AIRJAM_GITHUB_ISSUES_APP_ID`,
    `AIRJAM_GITHUB_ISSUES_INSTALLATION_ID`,
    `AIRJAM_GITHUB_ISSUES_PRIVATE_KEY`, and
    `AIRJAM_GITHUB_ISSUES_REPOSITORY` for the repository-installed,
    issue-only GitHub App used by Gate `G4-03`

It should not receive Better Auth, the multiplayer master key, maintainer
personal GitHub tokens, broad repository credentials, or creator-facing OAuth
credentials. Synthetic public origins are inert check targets rather than
application authority and remain explicitly configured. PR and local workers
leave budget refresh explicitly disabled unless they are intentionally given a
separate, exactly attested project/environment token; they never inherit the
production token.

## Recommended Hardening Path

### Phase 1. Freeze The Contract

Document and audit the current live shape:

1. service list
2. public URLs
3. repo ownership
4. build/start commands
5. env ownership
6. dependency edges

This document is the first step of that freeze.

### Phase 2. Make Railway Services Deterministic

For the platform:

1. keep `apps/platform` as the only platform service root
2. build with standalone Next output and one explicit start command
3. avoid provider-specific host fallbacks in production

For the realtime server:

1. keep one service for the realtime and API process
2. build from repo root with explicit workspace commands
3. keep env ownership narrow and server-specific
4. keep `main` autodeploy only after the service contract is pinned clearly

### Phase 3. Extract Browser Moderation Into A Real Subsystem

Stand up a dedicated browser runtime and wire:

1. `AIRJAM_RELEASES_BROWSER_WS_ENDPOINT`
2. `AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN`
3. moderation-specific env

This is the key step that turns hosted release publishing into a reliable production lane.

### Phase 4. Add Operational Guardrails

Add one lightweight smoke procedure that verifies:

1. platform app is reachable
2. realtime API health is reachable
3. Arcade connects
4. controller join works
5. hosted release finalize/publish works

Also add a cheap way to answer:

1. what platform build is live
2. what server build is live
3. what browser worker build is live

Production identity should be queryable, not guessed from symptoms.

## Immediate Next Steps

The next practical hardening steps are:

1. complete `airjam.io` and `www.airjam.io` Railway domain cutover
2. verify production routes on the Railway-hosted platform surface
3. keep `railway doctor` as the single deploy inspection front door
4. re-test hosted release publish with a fresh release
5. remove remaining stale docs and operational notes that still describe the old split-provider preview model

## Non-Goals

This cleanup does not require:

1. reintroducing a repo-owned preview up or down lifecycle
2. minting custom preview aliases
3. splitting Arcade out of the platform yet
4. extracting the API and auth services during the deployment reset

Those are separate decisions and should not be mixed into the Railway consolidation block.
