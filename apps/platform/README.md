# Air Jam Platform

Next.js app for:

1. docs and developer onboarding
2. dashboard and game/app ID management
3. Arcade host and persistent controller runtime

## Local Development

Run the platform from the repo root:

```bash
pnpm run repo -- workspace service platform
```

Platform default URL:

- [http://localhost:3000](http://localhost:3000)

Related local services:

1. `pnpm run repo -- workspace service server` for the realtime server
2. `pnpm arcade:dev --game=air-capture` for the live Arcade reference-game path
3. `pnpm arcade:dev --game=pong` for the live Arcade Pong template path

## Local Arcade Dev Catalog

When the platform runs in development, the Arcade browser can also show repo-local
reference games without pretending they are public hosted releases.

Current behavior:

1. the local Arcade catalog is dev-only
2. by default it exposes `Air Capture` at `http://127.0.0.1:5173`
3. local entries are labeled `Local Dev` in the Arcade grid
4. public Arcade release rules stay unchanged: real public listing still requires a live hosted release

Optional env for local Arcade entries:

1. `NEXT_PUBLIC_AIR_JAM_LOCAL_REFERENCE_DEFAULT=air-capture|pong`
2. `NEXT_PUBLIC_AIR_JAM_LOCAL_REFERENCE_AIR_CAPTURE_URL=http://127.0.0.1:5173`
3. `NEXT_PUBLIC_AIR_JAM_LOCAL_REFERENCE_PONG_URL=http://127.0.0.1:4173`
4. `NEXT_PUBLIC_AIR_JAM_LOCAL_REFERENCE_PONG_CONTROLLER_URL=http://192.168.0.33:4173/controller`

Use a separate `*_CONTROLLER_URL` when the desktop Arcade should embed the
host surface from `localhost`, but controller phones need the LAN-reachable
controller URL.

## Sentry Error Monitoring (Optional)

The platform supports a minimal Sentry integration for production error monitoring.

Set these in `.env.local` or your hosted environment:

1. `NEXT_PUBLIC_SENTRY_DSN=<project-dsn>`
2. `SENTRY_AUTH_TOKEN=<auth-token-for-source-map-upload>`

If `NEXT_PUBLIC_SENTRY_DSN` is unset, Sentry stays disabled.

The default slot exists because both the local Pong template and `air-capture`
use port `5173` by default, so only the reference game you are actively running
should auto-appear without an explicit override.

## Notes

1. Controller chrome in Arcade embedded-game mode follows host-driven session orientation, not just the arcade surface launch hint. The live shell/runtime rules are covered by [arcade-surface-contract.md](../../docs/contracts/arcade-surface-contract.md) and [composition-shell-contract.md](../../docs/contracts/composition-shell-contract.md).
2. Product architecture and strategy live in [framework-paradigm.md](../../docs/framework-paradigm.md), [platform-control-plane-architecture.md](../../docs/architecture/platform-control-plane-architecture.md), and [deployment-and-monetization-strategy.md](../../docs/strategy/deployment-and-monetization-strategy.md).

## Public Docs And AI Pack Surface

The platform also owns the public docs delivery surface and the hosted AI-pack
delivery surface.

Important public routes:

1. `/docs`
2. `/docs-manifest`
3. `/docs-search-index`
4. `/llms.txt`
5. `/ai-pack/manifest.json`

Reference docs:

1. [platform-docs-surface-architecture.md](../../docs/architecture/platform-docs-surface-architecture.md)
2. [documentation-and-ai-pack-architecture.md](../../docs/architecture/documentation-and-ai-pack-architecture.md)
3. [ai-pack-manifest-contract.md](../../docs/contracts/ai-pack-manifest-contract.md)
4. [ai-pack-workflow-guide.md](../../docs/guides/ai-pack-workflow-guide.md)

## First-Party Product Telemetry

The platform owns a small first-party telemetry plane for approximate public
discovery and product-intent evidence. It does not load an external analytics
script and requires no analytics-provider environment variables.

The browser records canonical page transitions and typed intent actions through
the same-origin `/api/telemetry` route. A server-owned request boundary records
agent-facing resource reach. Collection failures never block navigation, copy
actions, external links, Arcade entry, or public resource responses.

Telemetry is privacy-bounded:

1. anonymous session identity exists only in browser memory
2. no cookies, browser storage, or fingerprinting are used
3. raw IP addresses, full user agents, full URLs, query strings, and raw
   referrers are not persisted
4. production, preview, development, and test traffic stay separable

The internal report at `/dashboard/ops/telemetry` presents product telemetry
beside separately labeled platform lifecycle and runtime usage facts. Product
telemetry is not a source of gameplay, quota, billing, or creator-reward truth.

Apply the platform database migrations before collecting telemetry through the
repo-owned lifecycle documented below. The canonical telemetry surface is
discoverable through:

```bash
pnpm run repo -- platform telemetry --help
```

It exposes stable JSON reads and the full maintenance lifecycle:

```bash
pnpm --silent run repo -- platform telemetry overview --days 30 --environment production --json
pnpm --silent run repo -- platform telemetry health --json
pnpm --silent run repo -- platform telemetry rebuild --json
pnpm --silent run repo -- platform telemetry rebuild --apply --json
pnpm --silent run repo -- platform telemetry retain --json
pnpm --silent run repo -- platform telemetry retain --apply --json
```

`overview` returns the same authority-separated report used by the ops UI.
`health` inspects storage, projection, and retention state. Rebuild and retention
are read-only previews unless `--apply` is explicit. All commands use
`DATABASE_URL` from the environment or `apps/platform/.env.local`; they do not
embed or print database credentials.

Agents can operate an explicit hosted environment without manually extracting
its database secret:

```bash
pnpm --silent run repo -- platform telemetry health \
  --railway-environment <environment-id> \
  --railway-project <project-id> \
  --json
```

`--railway-project` may be omitted when `RAILWAY_PROJECT_ID` is configured. The
repo command resolves the environment PostgreSQL connection internally and
passes it only to the telemetry subprocess.

Reference docs:

1. [product-telemetry-architecture.md](../../docs/architecture/product-telemetry-architecture.md)
2. [product-telemetry-contract.md](../../docs/contracts/product-telemetry-contract.md)

## Hosted Releases Setup

The public Arcade hosted-release and managed-media lanes now share the same storage infrastructure.

Infrastructure requirements:

1. Postgres migrations applied
2. one Cloudflare R2 bucket for release artifacts and game media assets
3. screenshot moderation runtime with browser access
4. optional OpenAI image moderation when you want automated image-policy enforcement
5. a dedicated cookieless public origin for creator-controlled release assets
6. one separately deployed platform operational-job worker

The database migrations under [drizzle](./drizzle) are operated through one
agent-safe lifecycle:

```bash
pnpm run repo -- platform database migration --help
pnpm --silent run repo -- platform database migration inspect --json
```

For production, pass the exact Railway project and environment to every step.
Planning creates a fingerprint-bound backup; apply requires explicit authority,
intent, idempotency, and `--apply`; verify independently checks the deployed
revision before restoring any drained operational lanes. Do not run
`drizzle-kit migrate` directly against production. See the
[production database migration contract](../../docs/contracts/production-database-migration-contract.md).

Environment variables for the hosted release lane are documented in [`.env.example`](./.env.example).

Minimum additional env needed for the hosted release lane:

1. `AIRJAM_RELEASES_PUBLIC_ORIGIN`
2. `AIRJAM_RELEASES_R2_BUCKET`
3. `AIRJAM_RELEASES_R2_ACCOUNT_ID` or `AIRJAM_RELEASES_R2_ENDPOINT`
4. `AIRJAM_RELEASES_R2_ACCESS_KEY_ID`
5. `AIRJAM_RELEASES_R2_SECRET_ACCESS_KEY`

`AIRJAM_RELEASES_PUBLIC_ORIGIN` must be an absolute origin on a separate
cookie site from the authenticated platform. Air Jam production uses
`https://games.air-jam.app` for the platform at `https://airjam.io`. It must not
be the platform origin or a sibling such as `games.airjam.io`. Hosted release
delivery stays disabled when this boundary is missing or invalid; there is no
same-origin fallback.

Inspect the effective boundary through the canonical agent-safe command:

```bash
pnpm run repo -- platform release-origin inspect
pnpm --silent run repo -- platform release-origin inspect --json
pnpm --silent run repo -- platform release-origin inspect --platform-url https://airjam.io --json
pnpm --silent run repo -- platform release-origin attest --platform-url https://airjam.io --release-url https://<release-domain>/releases/g/<game-id>/r/<release-id>/generations/<generation-id> --railway-project <project-id> --json
```

`inspect` reports configuration and health. `attest` collects bounded deployed
transport evidence for one exact canonical live generation-specific host root and its controller
document. It pins DNS before requesting, rejects private/reserved destinations,
independently rejects a shared cookie site, and checks TLS, routing, HTML policy,
cookie absence, Better Auth session isolation, protected API CORS, and stable
deployment identity. It never executes creator JavaScript on the maintainer
machine. A loopback run is always diagnostic; only a passing HTTPS Railway
production run with an exact expected project and provider authentication can
set `productionEvidenceEligible: true`. Set `RAILWAY_PROJECT_TOKEN`,
`RAILWAY_API_TOKEN`, or `RAILWAY_TOKEN`; `RAILWAY_PROJECT_ID` may replace the
flag. Provider verification independently binds the expected project,
production environment, current platform-service deployment, and both public
domains. The readiness revision remains deployment-reported rather than
provider-authenticated. Eligibility means the deployment evidence is
admissible, not that the complete security finding is closed by this command.

Without `--platform-url`, the command assesses environment variables visible to
the local platform process. With `--platform-url`, it reads the deployed
platform's public `/api/readiness` boundary through a bounded request. Both JSON
forms are stable and versioned and contain no credentials.

Remote inspection contract v2 returns valid platform readiness documents from
both `200` (ready) and `503` (unready), including `readiness.httpStatus`,
`readiness.ok`, the effective platform request-host policy, and the deployed
release boundary assessment. The inspector requires the reported canonical
platform origin to equal `--platform-url`. A valid unready contract is inspection
evidence, so the command returns it successfully; malformed contracts,
unsupported HTTP statuses, and transport failures still exit nonzero with a
machine-readable error. `/api/health` is the intentionally narrower process
liveness contract used by deployment infrastructure.

Optional env for screenshot moderation:

1. `AIRJAM_RELEASES_INTERNAL_ACCESS_TOKEN`
2. `AIRJAM_RELEASES_BROWSER_WS_ENDPOINT` plus `AIRJAM_RELEASES_BROWSER_ACCESS_TOKEN`, or `AIRJAM_RELEASES_BROWSER_EXECUTABLE_PATH`; the Railway worker endpoint uses the stable shape `wss://<worker-domain>/ws`
3. `AIRJAM_RELEASES_IMAGE_MODERATION_MODE=openai|disabled`
4. `OPENAI_API_KEY` when `AIRJAM_RELEASES_IMAGE_MODERATION_MODE=openai`

The long-running operational executor starts with:

```bash
pnpm --filter platform worker
```

Production uses the bundled `worker:start` entry and
[`railway.worker.json`](./railway.worker.json). Configure a strong
`AIRJAM_PLATFORM_WORKER_CONTROL_TOKEN`; `/health` is liveness, `/ready` proves
recent PostgreSQL authority, and authenticated `POST /drain` stops new claims
before deploy termination.

Production also requires `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, and a
sealed, environment-scoped `RAILWAY_PROJECT_TOKEN` on this worker only. The
worker exactly attests the token's project/environment identity, refreshes
Railway budget evidence immediately and every 15 minutes, and coordinates
overlapping replicas with PostgreSQL. Missing or stale persisted evidence keeps
`/ready` unavailable. A failed provider attempt remains visible without
degrading readiness while retained evidence is still fresh. Local and preview
workers default `AIRJAM_PLATFORM_WORKER_BUDGET_REFRESH_MODE` to disabled.

The same worker schedules retention-eligible release-generation and managed
media cleanup. `AIRJAM_PLATFORM_WORKER_LIFECYCLE_CLEANUP_MS` controls the
schedule interval and defaults to 15 minutes. It also applies the canonical
product-telemetry retention policy immediately on startup and every 15 minutes
by default. `AIRJAM_PLATFORM_WORKER_TELEMETRY_RETENTION_MS` may change only the
schedule cadence; the retention durations remain owned by the product-telemetry
domain contract. Both schedules are independent readiness authorities, so a
failure degrades `/ready` and stays visible to operators.

Preview and enqueue lifecycle cleanup via:

```bash
pnpm --silent run repo -- platform operations lifecycle cleanup --help
```

Agents and maintainers inspect and safely operate the same authority through:

```bash
pnpm --silent run repo -- platform operations jobs --help
```

The worker also owns durable operational-event delivery and launch-critical
synthetics. Its event-delivery and synthetic schedules default to one second
and thirty seconds respectively. Production should explicitly configure one
immutable hosted release plus the operational and browser worker origins:

```bash
AIRJAM_SYNTHETIC_HOSTED_RELEASE_URL=https://<release-origin>/releases/g/<game>/r/<release>/generations/<generation>/
AIRJAM_SYNTHETIC_WORKER_ORIGIN=https://<operational-worker-origin>
AIRJAM_SYNTHETIC_BROWSER_WORKER_ORIGIN=https://<browser-worker-origin>
AIRJAM_SYNTHETIC_APP_ID=<synthetic-app-id>
```

The same worker owns the narrow alert-to-GitHub issue projection. Configure a
repository-installed GitHub App with Issues read/write and repository metadata
read; do not use a maintainer token:

```bash
AIRJAM_GITHUB_ISSUES_APP_ID=<app-id>
AIRJAM_GITHUB_ISSUES_INSTALLATION_ID=<installation-id>
AIRJAM_GITHUB_ISSUES_PRIVATE_KEY=<pem-private-key>
AIRJAM_GITHUB_ISSUES_REPOSITORY=vucinatim/air-jam
AIRJAM_PLATFORM_WORKER_ISSUE_PROJECTION_MS=5000
```

Inspect or safely advance the complete machine lifecycle through:

```bash
pnpm --silent run repo -- platform operations reliability alerts --help
pnpm --silent run repo -- platform operations reliability issues --help
```

Inspect the exact six-check, four-SLO policy and the retained state through:

```bash
pnpm run repo -- platform operations reliability --help
pnpm --silent run repo -- platform operations reliability catalog --json
pnpm --silent run repo -- platform operations reliability status --json
```

All repair and synthetic execution commands are previews unless `--apply` is
explicit. The canonical state, trust, redaction, and dead-letter contract is in
[operational-reliability-contract.md](../../docs/contracts/operational-reliability-contract.md).

If screenshot moderation is not configured, its durable job fails closed. The
release remains failed until the runtime is available and an operator replays
the terminal job, which keeps platform policy aligned with server-side checks.

If screenshot moderation is configured but `AIRJAM_RELEASES_IMAGE_MODERATION_MODE=disabled`, the platform still captures the canonical screenshot and records an `image_moderation` warning check, but the release can become `ready`. That mode is intended for local or other non-production environments where you want deterministic release QA without making OpenAI moderation a hard requirement.

## Managed Media

Public game visuals now live in the dedicated `Media` page inside the dashboard.

That page manages:

1. thumbnail image
2. cover image
3. preview video

These assets are uploaded to Air Jam-managed R2 storage and served back through stable platform URLs under `/media/g/{gameId}/{kind}`.

The old raw external media URL fields have been removed from the game model.
