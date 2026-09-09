# `@air-jam/mcp-server`

The official Air Jam MCP server exposes the same project, development,
evaluation, semantic game-session, and hosted-release services as the Air Jam
CLI.

## Discover and connect

```bash
pnpm exec airjam mcp doctor --dir . --json
pnpm exec airjam mcp config --profile portable --dir .
pnpm exec airjam-mcp
```

The portable project declaration is `.mcp.json`. Codex and Claude Desktop can
also use their explicit profiles through `airjam mcp config`.

## Complete evaluation

Call `airjam.evaluate` before sharing a game and again after any repair. It
runs typecheck, lint, tests, and the production build, returning one stable
`air-jam-complete-evaluation/v1` result. Use `airjam.run_quality_gate` when you
only need to narrow a failure.

For reliable gameplay assertions, use `airjam.open_game_session`,
`airjam.read_game_session`, `airjam.invoke_game_session_action`, and
`airjam.close_game_session`. Use `airjam.capture_game_session_visuals` to
capture the owning room's canonical host and controller views when the client
cannot launch its own browser. Browser interaction remains visual proof rather
than the primary automation lane.
