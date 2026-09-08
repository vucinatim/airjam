# syntax=docker/dockerfile:1.7
#
# Two-stage build for the Air Jam realtime server.
#
# - `deps` installs the pnpm workspace using only package.json + lockfile
#   so the install layer stays cached across deploys unless deps change.
# - `runtime` overlays source, builds the server, and stays as the final
#   image. The workspace install is preserved so the `pnpm --filter ...
#   start` CMD keeps working unchanged.

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
# Even though this is the server image, `pnpm install --frozen-lockfile`
# resolves the whole workspace from the lockfile and scandir's the
# file: target, so the loader directory must exist on disk before
# install runs. Tiny (~12K) — copy the whole dir.
COPY apps/platform/loader ./apps/platform/loader

# Keep the dependency layer provider-neutral. Railway cache mounts require a
# service identity, while the manifest-only layer is already safely cacheable.
RUN pnpm install --frozen-lockfile

# ============================================================================
# Stage 2: runtime — build the server and run it
# ============================================================================
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable

# Reuse the installed workspace from the deps stage. node_modules and
# pnpm's workspace symlinks (node_modules/@air-jam/sdk → packages/sdk,
# etc.) all come along.
COPY --from=deps /app /app

# Overlay source. Anything below this line invalidates the build cache
# but leaves the install layer untouched.
COPY tsconfig.base.json ./
COPY scripts   ./scripts
COPY packages  ./packages

# `--filter @air-jam/server...` (trailing ellipsis) builds the server
# together with its workspace deps — SDK in particular, which tsup keeps
# external and needs its dist/ on disk at runtime.
RUN pnpm --filter @air-jam/server... build

CMD ["pnpm", "--filter", "@air-jam/server", "start"]
