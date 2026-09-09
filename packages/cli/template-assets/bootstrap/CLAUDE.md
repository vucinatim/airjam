# Claude Workflow Notes

Use the same Air Jam development path as every other agent.

## Local Launch

Start local development with:

```bash
pnpm run dev
```

Open the host at `http://localhost:5173`.

Do not use raw `vite` for normal Air Jam work. It skips the local Air Jam server.

Do not create or prefer a separate preview-specific package script.

Claude Code Desktop preview is already configured through `.claude/launch.json`. Use that preview configuration when opening the embedded preview. It runs:

```bash
pnpm run dev -- --preview-managed
```

This keeps Vite as the foreground process for Claude Preview while Air Jam manages the local server in the background. Humans and normal terminal workflows should still use `pnpm run dev`.

Use these recovery commands before debugging gameplay code when local runtime state looks stale:

```bash
pnpm exec airjam status
pnpm exec airjam reset local
pnpm exec air-jam-server logs --view=signal
```

After editing host-only runtime refs, physics loops, or `useHostActionListener` side effects, hard refresh the host or run `pnpm exec airjam reset local` if actions appear duplicated or rendered state no longer matches replicated state.

## Preview Controllers

Use visible preview controllers in the same host preview screen for UI smoke proof:

1. click buttons with real browser clicks
2. drag controls with real browser drag/release gestures
3. verify that the controller visually connects and can trigger at least one visible action

When you need multiple local players, add multiple preview controllers from the host preview workspace instead of opening unrelated OS browser tabs unless the user explicitly asks for that.

Do not synthesize pointer events into controller iframes from parent-page eval. That path is brittle around iframe boundaries, pointer capture, and React event timing.

## Gameplay Proof

Use the game-owned agent contract for reliable gameplay assertions:

1. `airjam.open_game_session`
2. `airjam.read_game_session`
3. `airjam.invoke_game_session_action`
4. `airjam.capture_game_session_visuals`
5. `airjam.close_game_session`

Use semantic actions for gameplay mechanics, physics outcomes, scoring, reset, and state assertions. Preview controllers are for visible UI smoke proof, not the primary automation lane.

## Game Authoring Rule

Multiplayer games should be controllable from controllers. If a game has a start, ready, reset, or similar primary flow, expose it through controller UI and semantic agent actions. The host screen should not be the only place where play begins.
