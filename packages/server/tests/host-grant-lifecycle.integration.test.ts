import {
  createHostGrant,
  ErrorCode,
  type HostBootstrapAck,
  type HostGrantClaims,
  type HostSessionKind,
} from "@air-jam/sdk/protocol";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeDatabaseSchema, type ServerDatabase } from "../src/db";
import type { ServerLogger } from "../src/logging/logger";
import { AuthService } from "../src/services/auth-service";
import { setupServerTestHarness } from "./helpers/server-test-harness";

const databaseUrl = process.env.AIR_JAM_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;

type HostRegistrationAck = {
  ok: boolean;
  roomId?: string;
  hostResumeCapability?: { token: string };
  code?: ErrorCode | string;
  message?: string;
};

describeWithPostgres("signed host-grant socket lifecycle", () => {
  const client = postgres(databaseUrl!, { max: 4 });
  const database = drizzle(client, {
    schema: runtimeDatabaseSchema,
  }) as ServerDatabase;
  const suffix = crypto.randomUUID();
  const creatorId = `grant-socket-creator-${suffix}`;
  const gameId = `grant-socket-game-${suffix}`;
  const appKey = `aj_app_${suffix.replaceAll("-", "")}`;
  const hostGrantSecret = `grant-socket-secret-${suffix}`;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ServerLogger;
  const authService = new AuthService({
    db: database,
    logger,
    env: {
      authMode: "required",
      databaseUrl,
      hostGrantSecret,
      nodeEnv: "test",
    },
  });
  const harness = setupServerTestHarness({ server: { authService } });

  beforeAll(async () => {
    await client`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values (
        ${creatorId}, 'Host grant socket test', ${`${creatorId}@example.invalid`},
        true, now(), now()
      )
    `;
    await client`
      insert into games (id, user_id, name, config, created_at, updated_at)
      values (${gameId}, ${creatorId}, 'Host grant socket game', '{}'::jsonb, now(), now())
    `;
    await client`
      insert into app_ids (id, game_id, creator_id, key, is_active, created_at)
      values (${`grant-socket-app-${suffix}`}, ${gameId}, ${creatorId}, ${appKey}, true, now())
    `;
  });

  afterAll(async () => {
    await client`delete from realtime_host_grant_consumptions where app_id = ${appKey}`;
    await client`delete from app_ids where key = ${appKey}`;
    await client`delete from games where id = ${gameId}`;
    await client`delete from users where id = ${creatorId}`;
    await client.end();
  });

  const issueSystemGrant = async (
    overrides: Partial<Omit<HostGrantClaims, "typ">> = {},
  ) => {
    const now = Math.floor(Date.now() / 1_000);
    return createHostGrant({
      secret: hostGrantSecret,
      claims: {
        jti: crypto.randomUUID(),
        aud: "airjam:realtime",
        appId: appKey,
        gameId,
        creatorId,
        iat: now,
        exp: now + 60,
        scopes: ["host:bootstrap"],
        origins: ["https://airjam.io"],
        sessionKind: "system",
        intent: "system_register",
        abuseSessionId: crypto.randomUUID(),
        ...overrides,
      },
    });
  };

  const bootstrapWithGrant = async (
    socket: Awaited<ReturnType<typeof harness.connectSocket>>,
    hostGrant: string,
    hostSessionKind: HostSessionKind = "system",
  ) =>
    harness.emitWithAck<HostBootstrapAck>(socket, "host:bootstrap", {
      hostGrant,
      hostSessionKind,
    });

  it("accepts one legitimate launch and rejects raw replay", async () => {
    const hostGrant = await issueSystemGrant();
    const first = await harness.connectSocket({ origin: "https://airjam.io" });
    await expect(bootstrapWithGrant(first, hostGrant)).resolves.toMatchObject({
      ok: true,
    });

    const replay = await harness.connectSocket({ origin: "https://airjam.io" });
    await expect(bootstrapWithGrant(replay, hostGrant)).resolves.toMatchObject({
      ok: false,
      code: ErrorCode.INVALID_APP_ID,
      message: "Unauthorized: Host grant was already consumed",
    });
  });

  it.each([
    ["missing", undefined],
    ["forged", "https://attacker.example"],
  ])(
    "rejects a %s socket origin without consuming the grant",
    async (_label, origin) => {
      const hostGrant = await issueSystemGrant();
      const rejected = await harness.connectSocket(
        origin === undefined ? undefined : { origin },
      );
      await expect(
        bootstrapWithGrant(rejected, hostGrant),
      ).resolves.toMatchObject({
        ok: false,
        code: ErrorCode.INVALID_APP_ID,
      });

      const legitimate = await harness.connectSocket({
        origin: "https://airjam.io",
      });
      await expect(
        bootstrapWithGrant(legitimate, hostGrant),
      ).resolves.toMatchObject({ ok: true });
    },
  );

  it("cannot use a fresh signed grant to hijack an active room", async () => {
    const owner = await harness.connectSocket({ origin: "https://airjam.io" });
    expect(
      await bootstrapWithGrant(owner, await issueSystemGrant()),
    ).toMatchObject({ ok: true });
    const created = await harness.emitWithAck<HostRegistrationAck>(
      owner,
      "host:createRoom",
      { maxPlayers: 4 },
    );
    expect(created).toMatchObject({ ok: true });

    const attacker = await harness.connectSocket({
      origin: "https://airjam.io",
    });
    expect(
      await bootstrapWithGrant(attacker, await issueSystemGrant()),
    ).toMatchObject({ ok: true });
    await expect(
      harness.emitWithAck<HostRegistrationAck>(
        attacker,
        "host:registerSystem",
        { roomId: created.roomId },
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: ErrorCode.UNAUTHORIZED,
    });
    expect(
      harness.getRoomManager().getRoom(created.roomId!)?.masterHostSocketId,
    ).toBe(owner.id);
  });

  it("rejects registerSystem after a game-scoped grant bootstrap", async () => {
    const gameHost = await harness.connectSocket({
      origin: "https://airjam.io",
    });
    const gameGrant = await issueSystemGrant({
      sessionKind: "game",
      intent: "create_room",
    });
    await expect(
      bootstrapWithGrant(gameHost, gameGrant, "game"),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      harness.emitWithAck<HostRegistrationAck>(
        gameHost,
        "host:registerSystem",
        { roomId: "SYS400" },
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: ErrorCode.UNAUTHORIZED,
      message: "Unauthorized: System host authority required",
    });
    expect(harness.getRoomManager().getRoom("SYS400")).toBeUndefined();
  });
});
