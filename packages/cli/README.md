# `@air-jam/cli`

The canonical project and operator CLI for Air Jam.

`create-airjam` only creates a project. The generated project then depends on
this package for its complete ongoing lifecycle: development, inspection,
semantic game control, AI-pack maintenance, MCP setup, hosted game records,
and releases.

## Discover the contract

```bash
pnpm exec airjam --help
pnpm exec airjam session --help
pnpm exec airjam mcp --help
pnpm exec airjam release --help
```

## Machine-first local lifecycle

These commands return stable JSON documents and are safe for terminal agents
to compose:

```bash
pnpm exec airjam status --dir .
pnpm exec airjam evaluate --dir .
pnpm exec airjam dev start --dir .
pnpm exec airjam session open --dir .
pnpm exec airjam session read <session-id> --dir .
pnpm exec airjam session invoke <session-id> <action-id> --payload '{}'
pnpm exec airjam session close <session-id> --dir .
pnpm exec airjam dev stop --dir .
pnpm exec airjam reset local --dir .
```

`airjam evaluate` is the canonical complete evaluation contract. It runs
typecheck, lint, tests, and the production build, then returns every gate in one
stable `air-jam-complete-evaluation/v1` JSON document. The MCP equivalent is
`airjam.evaluate`; use individual quality gates only to narrow a failure.

A semantic session starts or reuses the canonical Air Jam dev process, opens a
real controller/runtime connection, exposes the game's published semantic
actions and authoritative snapshot, and releases processes it created when the
last session closes. The project-local broker is authenticated, loopback-only,
and can be inspected or stopped explicitly:

```bash
pnpm exec airjam session broker status --dir .
pnpm exec airjam session broker stop --dir .
```

## Agent clients

The Air Jam MCP exposes the same underlying project, development, semantic
session, quality, and release services to Codex, Claude, and other MCP clients.

```bash
pnpm exec airjam mcp doctor --dir . --json
pnpm exec airjam mcp init --dir .
pnpm exec airjam mcp config --profile portable --dir .
pnpm exec airjam mcp config --profile codex --dir .
pnpm exec airjam mcp config --profile claude-desktop --dir .
```

The portable declaration is `.mcp.json`. Codex and Claude Desktop use their
own client registration formats; `mcp doctor` reports declarations and actual
client registrations separately.

## Framework guidance ownership

The CLI owns the canonical managed framework pack under `docs/airjam/`.
Project instructions (`AGENTS.md`, `CLAUDE.md`, and `skills/`) are copied only
during bootstrap and belong to the project afterward.

```bash
pnpm exec airjam ai-pack status --dir . --json
pnpm exec airjam ai-pack diff --dir . --json
pnpm exec airjam ai-pack update --dir . --json
```

AI-pack updates replace managed framework guidance only. They never overwrite
project-owned agent instructions or skills.

## Programmatic assets

Scaffolding code can resolve the two explicit asset roots and portable MCP
declaration through `@air-jam/cli/scaffold`. Vite projects use
`@air-jam/cli/vite-config`.
