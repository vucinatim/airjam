# Agent MCP

Use the Air Jam MCP for Air Jam-native workflows before falling back to ad hoc shell commands.

If you only want the shortest correct mental model first, read `docs/airjam/agent-gold-path.md` before this file.

## What It Is

The project-local Air Jam MCP is the intended agent-facing path for:

1. project inspection
2. game inspection
3. canonical log reads
4. dev process lifecycle and status
5. runtime topology inspection
6. live game-session reads and semantic action invocation
7. quality-gate execution

The goal is to keep agents on explicit Air Jam contracts instead of forcing them to rediscover repo commands.

## Default Workflow

Start here:

1. `pnpm exec airjam mcp doctor --dir .`
2. the project already ships a committed `.mcp.json`
3. `pnpm exec airjam mcp init --dir . --force` only when you want to repair or regenerate that config
4. use the `mcp` script or `pnpm exec airjam-mcp` in your MCP-capable client

## Usage Rule

Use the Air Jam MCP first for:

1. `inspect_project`
2. `list_games`
3. `inspect_game`
4. `read_logs`
5. `start_dev`
6. `status`
7. `topology`
8. `open_game_session`
9. `send_game_session_input`
10. `read_game_session`
11. `invoke_game_session_action`
12. `capture_game_session_visuals`
13. `close_game_session`
14. `run_quality_gate`

Use direct shell commands only when:

1. the MCP does not expose the required operation
2. you are doing one-off repo maintenance work outside Air Jam devtools boundaries

## Browser Tooling Rule

When local UI verification matters:

1. use the current agent or client's built-in browser or in-app browser tooling first when available
2. prefer visible host/controller browser sessions over hidden automation when you need to verify what a player actually sees
3. pair that browser workflow with Air Jam MCP for logs, topology, snapshots, host staging actions, and quality gates
4. use secondary browser MCPs such as Chrome DevTools only when the first-party browser tooling is unavailable or when you need lower-level DOM, network, or performance diagnostics
5. if Claude Code Desktop preview launches the app, use the committed `.claude/launch.json`
6. if another browser/preview tool wants a launch command, use `pnpm run dev`
7. do not use raw `vite` for normal Air Jam development because it skips the local Air Jam backend
8. use normal `pnpm run dev -- --secure` when HTTPS is required
9. use visible preview controllers for controller UI smoke proof with real browser click/drag/release gestures
10. do not synthesize pointer events into controller iframes from parent-page eval; use semantic game actions when reliable gameplay proof matters
11. when the agent cannot own a browser process, use `airjam.capture_game_session_visuals` on the room-owning session to capture canonical host and controller screenshots through Air Jam's project-scoped runtime owner

## Debugging Rule

For runtime or multiplayer issues:

1. start with `airjam.read_logs`
2. use `view=signal` first
3. narrow with `trace`, `room`, `controller`, `runtime`, `process`, or `source`
4. only add ad hoc logs after the canonical log stream is insufficient
5. prefer `airjam.topology` over manually reconstructing local endpoints
6. when you need to drive and inspect a live game, use `airjam.open_game_session`, `airjam.send_game_session_input`, `airjam.read_game_session`, `airjam.invoke_game_session_action`, `airjam.capture_game_session_visuals`, and `airjam.close_game_session`
7. use the unified session action metadata from `airjam.open_game_session` and `airjam.read_game_session` before guessing payload shapes
8. session action ids are lane-prefixed on purpose: `player:<actionId>` for semantic player-lane actions and `host:<actionId>` for semantic host-lane staging actions
9. when a compatible local Air Jam dev session is already running, the official harness/session tools should attach to that live stack instead of trying to start a duplicate dev server
10. read the returned action `outcome` together with `acknowledgementObservation` and `snapshotAfterStatus`: a missing host acknowledgement is not the same thing as semantic rejection if the post-action snapshot shows committed state change
11. if an isolated harness or runtime ownership tool times out, check Air Jam status/log/reset tooling before treating it as gameplay bug
12. after editing host-only runtime refs, physics loops, or `useHostActionListener` side effects, hard refresh the host or run `pnpm exec airjam reset local` if actions appear duplicated or rendered state no longer matches replicated state

## Semantic Staging Rule

`src/game/contracts/agent.ts` is the primary agent-facing contract.

When you own the game code and the existing host staging surface is too thin:

1. add a small game-owned semantic action instead of automating the visible browser UI whenever the intent is really part of the game contract
2. prefer explicit verbs like `returnToLobby`, `startRound`, `setScore`, or `finishMatch`
3. include action descriptions and payload descriptions so future agents can discover the contract without source diving
4. for schema-backed semantic action payloads, prefer `agentActionInput.zod(...)` over ad hoc custom parsers when Zod already expresses the shape cleanly
5. if the verb is a host-owned staging/reset action rather than a player verb, publish it with `agentAction.host(...)` so it becomes a canonical `host:*` session action instead of a bridge action
6. `resultDescription` should describe the expected semantic effect for agents and humans; it is not automatic runtime result data
7. if a semantic action must return actual runtime result data, the underlying store action should return `acceptAirJamAction(result)` and callers should read that result from the acknowledgement or session action response

## Semantic Game Rule

If the scaffolded template includes `src/game/contracts/agent.ts`, treat `src/airjam.config.ts` as the canonical agent manifest and the template-owned contract file as the portable implementation it wires through `agent`.

That contract is template-owned. Do not create a second generated agent surface on top of it, and do not rely on devtools guessing its filesystem path when the config already declares it.

Use:

1. `airjam.open_game_session`
2. `airjam.send_game_session_input`
3. `airjam.read_game_session`
4. `airjam.invoke_game_session_action`
5. `airjam.capture_game_session_visuals`
6. `airjam.close_game_session`

If a clean-slate project does not ship those files yet but the game is growing beyond a trivial single-screen flow:

1. add `src/game/contracts/agent.ts` early
2. wire it through `src/airjam.config.ts` `agent`
3. publish a small semantic action set for the important game verbs instead of leaving them implicit in visible UI only

## Quality Rule

Before finishing meaningful work:

1. run the smallest matching `airjam.run_quality_gate`
2. prefer focused checks first
3. broaden to the heavier project checks only when the change warrants it
4. for host/controller UI or gameplay presentation changes, verify the visible browser preview before sign-off

## Notes

The MCP config is project-local and scaffolded by default.

Do not mutate global client configuration unless you explicitly mean to.
