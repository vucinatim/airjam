import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeDatabaseSchema, type ServerDatabase } from "../src/db";
import type { ServerLogger } from "../src/logging/logger";
import { AuthService } from "../src/services/auth-service";

const databaseUrl = process.env.AIR_JAM_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("host bootstrap PostgreSQL identity", () => {
  const client = postgres(databaseUrl!, { max: 2 });
  const database = drizzle(client, {
    schema: runtimeDatabaseSchema,
  }) as ServerDatabase;
  const suffix = crypto.randomUUID();
  const creatorId = `auth-creator-${suffix}`;
  const gameId = `auth-game-${suffix}`;
  const appKey = `aj_app_${suffix.replaceAll("-", "")}`;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ServerLogger;

  beforeAll(async () => {
    await client`
      insert into users (id, name, email, email_verified, created_at, updated_at)
      values (
        ${creatorId}, 'Realtime identity test', ${`${creatorId}@example.invalid`},
        true, now(), now()
      )
    `;
    await client`
      insert into games (id, user_id, name, config, created_at, updated_at)
      values (${gameId}, ${creatorId}, 'Realtime identity game', '{}'::jsonb, now(), now())
    `;
    await client`
      insert into app_ids (id, game_id, creator_id, key, is_active, created_at)
      values (${`auth-app-id-${suffix}`}, ${gameId}, ${creatorId}, ${appKey}, true, now())
    `;
  });

  afterAll(async () => {
    await client`delete from app_ids where key = ${appKey}`;
    await client`delete from games where id = ${gameId}`;
    await client`delete from users where id = ${creatorId}`;
    await client.end();
  });

  it("binds an app credential to its canonical game and creator", async () => {
    const auth = new AuthService({
      db: database,
      logger,
      env: {
        authMode: "required",
        databaseUrl,
        nodeEnv: "test",
      },
    });

    await expect(auth.verifyHostBootstrap({ appId: appKey })).resolves.toEqual(
      expect.objectContaining({
        isVerified: true,
        appId: appKey,
        gameId,
        creatorId,
        verifiedVia: "appId",
      }),
    );
  });
});
