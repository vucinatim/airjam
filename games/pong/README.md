# Air Jam Game Template - Pong

A starter template for building multiplayer games with Air Jam. This template includes a simple Pong game that demonstrates the core Air Jam features.

## AI-Native Workflow

This template ships with a local project operating pack for humans and coding agents.

Start here:

1. `AGENTS.md` for the repo contract
2. `plan.md` for the active work ledger
3. `suggestions.md` for durable follow-ups
4. `docs/docs-index.md` for the local docs pack
5. `skills/index.md` for task-specific workflow modules

Use local files first.

Use the hosted docs site when you need broader or newer canonical Air Jam docs.

If you want to refresh the scaffold-managed docs and skills later, use:

```bash
pnpm exec airjam ai-pack status --dir .
pnpm exec airjam ai-pack diff --dir .
pnpm exec airjam ai-pack update --dir .
```

`ai-pack:update` replaces canonical AI-pack-managed files. It is intentionally not a merge tool.

## Getting Started

### Installation

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Configure environment variables (optional - defaults work for local dev):

   ```bash
   cp .env.example .env.local
   ```

   Then edit `.env.local` with your settings if needed.

## Local Development

### Default (Recommended)

```bash
pnpm run dev
```

This starts both the local Air Jam server (`http://localhost:4000`) and the game (`http://localhost:5173`) in one command.
It also auto-detects your LAN IP and sets `VITE_AIR_JAM_PUBLIC_HOST` so QR links are phone-friendly by default.
For this mode, leave `VITE_AIR_JAM_SERVER_URL` blank so controllers connect back through the game origin and Vite websocket proxy.

### Unified Dev Logs

Air Jam writes the canonical local debug stream to:

```text
.airjam/logs/dev-latest.ndjson
```

Use:

```bash
pnpm exec air-jam-server logs
pnpm exec air-jam-server logs --follow
pnpm exec air-jam-server logs --trace=host_abc123
pnpm exec air-jam-server logs --view=signal
```

Important:

- this file resets when the Air Jam server process restarts
- host, controller, and server events should converge into the same stream on the normal dev path
- direct file reads are also valid if you want raw NDJSON

### Use Official Air Jam Backend (No Local Server)

If you prefer to use the official Air Jam server instead of running locally:

1. Get your app ID from the [Air Jam Platform](https://airjam.io)
2. Set in `.env.local`:
   ```bash
   VITE_AIR_JAM_SERVER_URL=https://api.airjam.io
   VITE_AIR_JAM_APP_ID=your-app-id-here
   ```
3. Start web-only mode:
   ```bash
   pnpm run dev -- --web-only
   ```

### Optional HTTPS (Gyroscope/Camera APIs)

Most local development works on plain HTTP. Use this only when you need secure browser APIs (gyroscope, motion sensors, some camera APIs).

One-time setup per project:

1. Install `mkcert` once on your machine.
2. Initialize secure mode:
   ```bash
   pnpm run secure:init
   ```
   This writes `.airjam/secure-dev.json`, generates `.airjam/certs/`, and updates `.env.local`.

Daily secure dev:

```bash
pnpm run dev -- --secure
```

What `dev -- --secure` does:

- starts local Air Jam server on `http://localhost:4000`
- starts Vite on trusted local HTTPS
- serves your host/controller over the detected LAN HTTPS origin
- keeps the backend on local HTTP behind the Vite proxy

Optional tunnel fallback:

```bash
pnpm run secure:init -- --mode=tunnel --hostname my-game-dev.example.com --tunnel my-game-dev
pnpm run dev -- --secure --secure-mode=tunnel
```

## Playing the Game

1. Open the game URL in your browser (host view)
2. Scan the QR code with your phone to open the controller / open the controller view in your browser
3. Use the controller to play Pong!

### Lobby Flow (Template Defaults)

- Game opens in a lobby state.
- Host shows a dedicated lobby screen (QR + team readiness, no debug control bar).
- Controllers pick a team (`SOLARIS` / `NEBULON`).
- Controllers set `Points to Win` (`3`, `5`, `7`, `11`).
- Optional: set per-team bot counts from the controller lobby.
- Teams can mix humans and bots in any combination up to two slots per side.
- Press `Start Match` to begin.
- During a running match, use `Pause` / `Resume` and `Lobby` from controller.
- Match transitions to an `ended` state automatically when one team reaches target points.
- Ended state provides `Play Again` and `Back to Lobby` from controller.

### Feedback Pattern (Canonical)

- Host feedback is centralized in `src/host/hooks/use-pong-feedback.ts`.
- Paddle collisions trigger:
  - controller-only `hit` sound (targeted to the player who touched the ball)
  - controller-only haptic pulse (`light`) for that same player
- Score events trigger:
  - host-only sound (`score`)
- Match start/end trigger host-only start/win cues.
- Match end also broadcasts a controller `TOAST` message with winner + final score.
- Sound manifest is defined in `src/game/shared/sounds.ts` and files live in `public/sounds`.

## Project Structure

```
src/
  ├── app.tsx                     # Main app component with routing
  ├── airjam.config.ts            # Catalog metadata plus runtime/game config
  ├── host/
  │   ├── index.tsx               # Host surface shell
  │   ├── components/             # Lobby, overlay, ended, score host UI
  │   └── hooks/                  # Host-owned feedback and side effects
  ├── controller/
  │   ├── index.tsx               # Controller surface shell
  │   ├── components/             # Header, lobby, playing controls, ended panel
  │   ├── hooks/                  # Controller connection guard/use-case hooks
  │   └── constants.ts            # Controller-only presentation constants
  ├── game/
  │   ├── contracts/
  │   │   ├── input.ts            # Input schema/types
  │   │   ├── sounds.ts           # Shared sound manifest
  │   │   └── controller-signals.ts # Host/controller signal payload mapping
  │   ├── domain/
  │   │   ├── team.ts             # Team ids, labels, colors
  │   │   ├── team-slots.ts       # Team occupancy and bot-slot rules
  │   │   ├── teams-snapshot.ts   # Shared team projection used by both surfaces
  │   │   └── match-readiness.ts  # Lobby readiness/domain rules
  │   ├── stores/
  │   │   ├── pong-store-types.ts # Shared replicated state shapes
  │   │   ├── pong-store-state.ts # Thin state entrypoint + shared defaults
  │   │   ├── pong-store-lobby.ts # Lobby-phase reducers and team setup rules
  │   │   ├── pong-store-match.ts # Playing/ended reducers and scoring rules
  │   │   └── pong-store.ts       # Air Jam store wiring and actions
  │   ├── engine/
  │   │   ├── simulation.ts       # Runtime orchestration loop
  │   │   ├── runtime-state.ts    # Hot runtime values outside React state
  │   │   ├── ball.ts             # Ball movement and scoring helpers
  │   │   ├── render.ts           # Canvas draw layer
  │   │   ├── debug.ts            # Isolated render debug toggles
  │   │   ├── collision.ts        # Focused collision helpers
  │   │   └── paddles.ts          # Paddle movement helpers
  │   ├── prefabs/
  │   │   └── arena/
  │   │       ├── prefab.ts       # Metadata and registry-facing prefab contract
  │   │       ├── schema.ts       # Defaults and serializable config rules
  │   │       ├── paint.ts        # Runtime render helper used by the prefab contract
  │   │       └── preview.ts      # Future catalog/preview descriptor
  │   ├── ui/
  │   │   ├── team-name.tsx       # Shared game-facing team presentation
  │   │   ├── match-score-display.tsx # Shared game-facing score rendering
  │   │   └── team-slot-tile.tsx  # Shared team-slot surface used by host and controller
  └── main.tsx                    # Entry point
tests/
  └── game/
      ├── adapters/               # Host/controller integration payload tests
      ├── domain/                 # Pure rule tests
      ├── engine/                 # Runtime helper tests
      └── stores/                 # Pure transition tests
```

## Runtime Pattern (Canonical)

- `airjam.config.ts` is the single source for catalog metadata plus runtime/provider config.
- `airjam.Host` wraps `HostView` from `src/host/index.tsx` and owns input schema + behavior defaults.
- `airjam.Controller` wraps `ControllerView` from `src/controller/index.tsx`.
- Controller input is published on a fixed 16ms cadence using `useInputWriter` in `src/controller/index.tsx`.
- Host input is consumed with `host.getInput(playerId)` in the game loop.

## Starter Module Map

When extending this template, inspect these modules before adding new code:

- `src/host/index.tsx` for the host surface boundary and overlay composition
- `src/controller/index.tsx` for controller flow, action publishing, and input cadence
- `src/game/stores/pong-store.ts` for Air Jam store wiring and action ownership
- `src/game/stores/pong-store-state.ts` for the thin state entrypoint and initial defaults
- `src/game/stores/pong-store-lobby.ts` for lobby-phase transitions and team setup rules
- `src/game/stores/pong-store-match.ts` for match lifecycle and scoring reducers
- `src/game/contracts/input.ts` for the controller input schema and behavior contract
- `src/game/contracts/sounds.ts` for the shared sound manifest
- `src/game/contracts/controller-signals.ts` for host-to-controller signal payloads and transport-facing mapping
- `src/game/domain/team-slots.ts` for the canonical mixed human/bot slot model used by both surfaces
- `src/game/domain/teams-snapshot.ts` for the shared team projection used by host and controller UI
- `src/game/ui/team-name.tsx` and `src/game/ui/match-score-display.tsx` for shared game-facing UI primitives used by both host and controller surfaces
- `src/game/ui/team-slot-tile.tsx` for the shared team-slot presentation used by both host and controller lobbies
- `src/game/engine/simulation.ts` for the main runtime orchestration loop
- `src/game/engine/runtime-state.ts` for per-frame mutable runtime values that do not belong in React state
- `src/game/prefabs/arena/prefab.ts` for metadata and registry-facing prefab shape
- `src/game/prefabs/arena/schema.ts` for defaults and config validation
- `src/game/prefabs/arena/paint.ts` for the prefab-owned render helper
- `src/game/scene-population/` when a game needs runtime spawn or pooling layers that should not be treated as prefab definitions

Use these as the default boundaries instead of introducing new mixed files.

## Testing Pattern (Canonical)

Start by testing the pure modules before adding render or transport-heavy tests:

- `tests/game/adapters/` for host/controller payload and transport-facing adapter contracts
- `tests/game/domain/` for pure gameplay rules
- `tests/game/stores/` for store transitions that should work without React or networking
- `tests/game/engine/` for focused runtime helpers
- `tests/game/ui/` for render-safe shared game UI modules that do not depend on host/controller shells

Run:

```bash
pnpm test
```

Use higher-level host/controller tests only after the pure boundary is already covered.

## Canonical Usage Rules

- Keep game lifecycle in the networked store (`lobby`, `playing`, `ended`), not in transport state.
- Treat `runtimeState` (`paused` / `playing`) as runtime pause only.
- Host owns authority for simulation, scoring, and state transitions; controllers send input + actions.
- Keep host shell code in `src/host/`, controller shell code in `src/controller/`, and gameplay logic in `src/game/`.
- Keep feedback centralized in host feedback modules (`use-pong-feedback`): no scattered side-effects.
- Let the Air Jam runtime boundary provide platform-settings context for game surfaces; mount `PlatformSettingsRuntime persistence="local"` only in the platform shell when you need a persisted owner runtime.
- Mount `AudioRuntime` once per host/controller surface, then use `useAudio()` only below that boundary.
- Target controller feedback explicitly when needed (e.g., hitter-only hit cue) and keep broad cues host-local by default.
- Keep reusable authored content in `src/game/prefabs/` once it is meant to be scanned, configured, or reused.
- Keep debug-only toggles and diagnostics isolated in focused game modules instead of mixing them into host/controller views.
- Keep shared game-facing UI in `src/game/ui/`; do not add a separate top-level `src/ui/` folder for Pong-specific components.

## What SDK Handles For You

- Remote controller sound playback: use `AudioRuntime` instead of manual `server:playSound` socket subscriptions or leaf-level audio ownership.
- Controller toast signaling: use `useControllerToasts()` to consume host `sendSignal("TOAST", ...)`.
- Presence-aware action context: every store action receives `ctx.connectedPlayerIds` (no custom presence sync action needed).
- Host pause/play: keep match lifecycle in the game store and use explicit runtime pause/resume commands only for pause UI.

## Environment Variables

See `.env.example` for all available environment variables. Key variables:

- `VITE_AIR_JAM_SERVER_URL` - Optional backend override. Leave blank for default local dev; set it for official/prod backends.
- `VITE_AIR_JAM_APP_ID` - Public app ID (optional for local dev, required for production)
- `AIR_JAM_SECURE_MODE` - Secure dev mode selected by `secure:init` (`local` by default, `tunnel` only when opted in)
- `AIR_JAM_SECURE_PUBLIC_HOST` - Optional HTTPS host used only for tunnel fallback
- `CLOUDFLARE_TUNNEL_NAME` - Optional Cloudflare tunnel name used only by `--secure --secure-mode=tunnel`

## Troubleshooting

### Server not connecting locally

1. Ensure `pnpm run dev` is running.
2. Verify server health at `http://localhost:4000/health`.
3. Remove or correct `VITE_AIR_JAM_SERVER_URL` overrides in `.env.local`. `http://localhost:4000` is wrong for phone controllers because it resolves on the phone, not your laptop.

### App ID errors in deployed environments

1. Ensure `VITE_AIR_JAM_APP_ID` is set in your hosting provider.
2. Ensure `VITE_AIR_JAM_SERVER_URL` points to your production Air Jam backend.
3. Re-copy/rotate your App ID from the Air Jam platform if needed.

### Controller join URL / QR issues

1. Confirm the room code on host and phone matches.
2. If testing on a phone outside localhost, set `VITE_AIR_JAM_PUBLIC_HOST` or use `pnpm run dev -- --secure`.
3. Ensure SPA rewrites are enabled so `/controller?room=XXXX` resolves to your app (`vercel.json` is included).

## Production Deployment

### Deploying to Vercel

1. Set environment variables in Vercel:
   - `VITE_AIR_JAM_SERVER_URL` - Your official Air Jam server URL
   - `VITE_AIR_JAM_APP_ID` - Your app ID from the Air Jam platform

2. Deploy:
   ```bash
   vercel
   ```

The game will connect to the official Air Jam server - no local server needed!
`vercel.json` is included in this template so `/controller?room=XXXX` and other SPA routes resolve correctly.

### Building A Hosted Arcade Release Artifact

The public Arcade hosting lane uses an uploaded hosted release artifact instead of a raw deployed URL.

From your project root:

```bash
pnpm exec airjam release bundle --dir .
```

That command:

1. runs your `build` script
2. bundles the contents of `dist/`
3. injects the hosted release manifest at `.airjam/release-manifest.json`
4. writes the uploadable zip to `.airjam/releases/<version>/`

The template ships that as a script over `airjam release bundle --dir .`, so you do not need a global install.

The hosted artifact contract is fixed:

- host entry at `/`
- controller entry at `/controller`

If you want custom routes or a marketing site at `/`, keep using self-hosted mode. The dashboard-uploaded hosted lane is intentionally stricter.

### Publishing Through The Dashboard

1. Open your game's **Arcade Releases** page in the Air Jam Dashboard.
2. Upload the zip created by `pnpm exec airjam release bundle --dir .`.
3. Make the validated release live.
4. Upload managed thumbnail, cover, and preview media in the Dashboard.
5. Set Arcade visibility to listed.

Use your self-hosted deployment URL only for private preview, staging, or custom route setups. Use the hosted artifact lane for the public Arcade.

### Optional: Stronger Signed Host Bootstrap

If you want stricter ownership guarantees without giving up static hosting, keep the game static and add one small backend or edge route that returns a signed host grant.

Frontend env:

```bash
VITE_AIR_JAM_HOST_GRANT_ENDPOINT=/api/airjam/host-grant
```

Server env:

```bash
AIR_JAM_HOST_GRANT_SECRET=your_signing_secret
```

Minimal endpoint shape:

```ts
import { createHostGrant } from "@air-jam/sdk/protocol";

export async function POST(request: Request) {
  const { appId } = await request.json();
  const { gameId, creatorId } = await loadTrustedAppIdentity(appId);
  const abuseSessionId = await loadTrustedAbuseSessionId(request);
  const now = Math.floor(Date.now() / 1000);

  const hostGrant = await createHostGrant({
    secret: process.env.AIR_JAM_HOST_GRANT_SECRET!,
    claims: {
      jti: crypto.randomUUID(),
      aud: "airjam:realtime",
      appId,
      gameId,
      creatorId,
      iat: now,
      exp: now + 60,
      scopes: ["host:bootstrap"],
      origins: ["https://your-game.example"],
      sessionKind: "game",
      intent: "create_room",
      abuseSessionId,
    },
  });

  return Response.json({ hostGrant });
}
```

The SDK fetches that grant automatically before `host:bootstrap`. Your host/controller game code does not change.
`loadTrustedAppIdentity` must be a server-side lookup; never trust game or creator identity supplied by the browser.
`loadTrustedAbuseSessionId` must return a stable server-issued UUID from an authenticated session or signed anonymous cookie, never a browser-supplied value.

### Building for Production

```bash
pnpm run build
```

The built files will be in the `dist/` directory.

## Learn More

- [Air Jam Documentation](https://airjam.io/docs)
- [Platform](https://airjam.io)
- [Examples](https://github.com/vucinatim/air-jam/tree/main/apps)

## License

MIT
