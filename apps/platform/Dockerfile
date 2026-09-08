# syntax=docker/dockerfile:1.7
#
# Three-stage build for the Air Jam platform Next.js app.
#
# Why three stages:
# - `deps` installs the pnpm workspace using only package.json + lockfile,
#   so the install layer stays cached across deploys unless deps change.
# - `builder` runs `next build` with the deps already installed.
# - `runtime` ships only the Next.js standalone output — no source, no
#   dev deps, no pnpm — for a small image and fast Railway cold start.
#
# BuildKit cache mounts persist the pnpm content-addressed store across
# builds even when the install layer is invalidated, so package downloads
# don't repeat from the registry.

ARG NODE_IMAGE=node:22-bookworm-slim

# ============================================================================
# Stage 1: deps — install workspace dependencies
# ============================================================================
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

RUN corepack enable

# Workspace manifests only. Any source-only change leaves this layer cached.
# scripts/repo/runtime/docker-workspace-manifest-contract.test.mjs requires
# this dependency-stage list to cover every pnpm workspace before install.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

COPY apps/platform/package.json                 ./apps/platform/
COPY packages/cli/package.json                  ./packages/cli/
COPY packages/database-contract/package.json    ./packages/database-contract/
COPY packages/operations-contract/package.json  ./packages/operations-contract/
COPY packages/sdk/package.json                  ./packages/sdk/
COPY packages/env/package.json                  ./packages/env/
COPY packages/server/package.json               ./packages/server/
COPY packages/harness/package.json              ./packages/harness/
COPY packages/devtools-core/package.json        ./packages/devtools-core/
COPY packages/create-airjam/package.json        ./packages/create-airjam/
COPY packages/mcp-server/package.json           ./packages/mcp-server/
COPY packages/release-browser-worker/package.json ./packages/release-browser-worker/
COPY games/air-capture/package.json             ./games/air-capture/
COPY games/code-review/package.json             ./games/code-review/
COPY games/minimal/package.json                 ./games/minimal/
COPY games/pong/package.json                    ./games/pong/
COPY games/the-office/package.json              ./games/the-office/
COPY games/last-band-standing/package.json      ./games/last-band-standing/

# apps/platform has a file: dep on ./loader (turbopack-mdx-loader).
# pnpm install scandir's the target at lockfile-resolve time, so the
# loader directory must exist on disk before install runs. It's tiny
# (~12K) — copy the whole dir, not just the package.json.
COPY apps/platform/loader ./apps/platform/loader

# Omit an explicit cache id so this Dockerfile remains portable across the
# platform and operational-worker services. Railway scopes the anonymous cache
# mount to the active build instead of rejecting another service's identity.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ============================================================================
# Stage 2: builder — compile the Next.js app
# ============================================================================
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

RUN corepack enable

# Public env vars baked into the Next.js client bundle at build time.
# Railway passes these as --build-arg; ARG → ENV exposes them to
# `pnpm --filter platform build` so next.config.ts can resolve the
# production topology instead of falling back to localhost.
ARG NEXT_PUBLIC_AIR_JAM_SERVER_URL
ARG NEXT_PUBLIC_AIR_JAM_PUBLIC_HOST
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_AIR_JAM_APP_ID
ARG NEXT_PUBLIC_AUTH_GITHUB_ENABLED
# RAILWAY_ENVIRONMENT_NAME flips preview behavior in
# resolvePlatformDeploymentConfig (auth off, public URL = railway domain).
ARG RAILWAY_ENVIRONMENT_NAME
ARG RAILWAY_PUBLIC_DOMAIN
ENV NEXT_PUBLIC_AIR_JAM_SERVER_URL=$NEXT_PUBLIC_AIR_JAM_SERVER_URL \
    NEXT_PUBLIC_AIR_JAM_PUBLIC_HOST=$NEXT_PUBLIC_AIR_JAM_PUBLIC_HOST \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_AIR_JAM_APP_ID=$NEXT_PUBLIC_AIR_JAM_APP_ID \
    NEXT_PUBLIC_AUTH_GITHUB_ENABLED=$NEXT_PUBLIC_AUTH_GITHUB_ENABLED \
    RAILWAY_ENVIRONMENT_NAME=$RAILWAY_ENVIRONMENT_NAME \
    RAILWAY_PUBLIC_DOMAIN=$RAILWAY_PUBLIC_DOMAIN

# Reuse the installed workspace from the deps stage. node_modules and
# pnpm's workspace symlinks (node_modules/@air-jam/sdk → packages/sdk,
# etc.) all come along.
COPY --from=deps /app /app

# Now overlay the source. Anything below this line invalidates the
# build cache but leaves the install layer untouched. The pnpm symlinks
# from the deps stage already point at these paths, so no re-install is
# needed once the source lands.
COPY tsconfig.base.json ./
COPY scripts   ./scripts
COPY apps      ./apps
COPY packages  ./packages
COPY content   ./content
COPY docs      ./docs

RUN pnpm --filter platform build \
 && cp -rT /app/apps/platform/.next/static /app/apps/platform/.next/standalone/apps/platform/.next/static \
 && cp -rT /app/apps/platform/public /app/apps/platform/.next/standalone/apps/platform/public

# ============================================================================
# Stage 3: runtime — minimal production image
# ============================================================================
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0

# Next.js standalone output bundles every traced application dependency
# into its own node_modules tree. The platform build also emits one bundled
# platform and operational-job worker entries into this tree so operational runtime
# dependencies do not depend on Next.js tracing separately copied scripts. The trace includes
# apps/platform/drizzle/ via `outputFileTracingIncludes` in next.config.ts.
COPY --from=builder /app/apps/platform/.next/standalone ./

CMD ["node", "/app/apps/platform/run-platform.mjs"]
