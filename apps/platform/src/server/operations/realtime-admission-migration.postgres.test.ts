import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.AIR_JAM_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const platformRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const migrationsRoot = path.join(platformRoot, "drizzle");

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
};

const createMigrationCatalogThrough0037 = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "airjam-0037-catalog-"));
  const metaRoot = path.join(root, "meta");
  mkdirSync(metaRoot);
  const journal = JSON.parse(
    readFileSync(path.join(migrationsRoot, "meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.filter((entry) => entry.idx <= 37);
  writeFileSync(
    path.join(metaRoot, "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    copyFileSync(
      path.join(migrationsRoot, `${entry.tag}.sql`),
      path.join(root, `${entry.tag}.sql`),
    );
  }
  return root;
};

const readPostgresErrorCode = async (
  operation: () => Promise<unknown>,
): Promise<string | null> => {
  try {
    await operation();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? null;
  }
};

describeWithPostgres("realtime admission migrations 0038-0039 upgrade", () => {
  it("keeps the expand/writer overlap safe before enforcing ownership and adding admission authority", async () => {
    const sourceUrl = new URL(databaseUrl!);
    const adminUrl = new URL(sourceUrl);
    adminUrl.pathname = "/postgres";
    const databaseName = `airjam_0038_${crypto.randomUUID().replaceAll("-", "")}`;
    const quotedDatabaseName = `"${databaseName}"`;
    const targetUrl = new URL(sourceUrl);
    targetUrl.pathname = `/${databaseName}`;
    const catalogRoot = createMigrationCatalogThrough0037();
    const admin = postgres(adminUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    let target: ReturnType<typeof postgres> | null = null;

    try {
      await admin.unsafe(`create database ${quotedDatabaseName}`);
      target = postgres(targetUrl.toString(), {
        max: 1,
        onnotice: () => undefined,
      });
      await migrate(drizzle(target), { migrationsFolder: catalogRoot });

      await target`
          insert into users (id, name, email, email_verified, created_at, updated_at)
          values
            ('migration-user-a', 'Owner A', 'migration-a@example.invalid', true, now(), now()),
            ('migration-user-b', 'Owner B', 'migration-b@example.invalid', true, now(), now())
        `;
      await target`
          insert into games (id, user_id, name, config, created_at, updated_at)
          values
            ('migration-game-a', 'migration-user-a', 'Game A', '{}'::jsonb, now(), now()),
            ('migration-game-b', 'migration-user-b', 'Game B', '{}'::jsonb, now(), now())
        `;
      await target`
          insert into app_ids (id, game_id, key, is_active, created_at)
          values
            ('migration-app-a', 'migration-game-a', 'migration-key-a', true, now()),
            ('migration-app-b', 'migration-game-b', 'migration-key-b', false, now())
        `;

      const migration0038 = readFileSync(
        path.join(migrationsRoot, "0038_app_id_creator_expand.sql"),
        "utf8",
      );
      await target.begin(async (transaction) => {
        for (const statement of migration0038.split(
          "--> statement-breakpoint",
        )) {
          const sql = statement.trim();
          if (sql) await transaction.unsafe(sql);
        }
      });

      const identities = await target<
        Array<{
          id: string;
          game_id: string;
          creator_id: string | null;
          user_id: string;
          is_active: boolean;
        }>
      >`
          select a.id, a.game_id, a.creator_id, g.user_id, a.is_active
          from app_ids a
          join games g on g.id = a.game_id
          order by a.id
        `;
      expect(identities).toEqual([
        {
          id: "migration-app-a",
          game_id: "migration-game-a",
          creator_id: "migration-user-a",
          user_id: "migration-user-a",
          is_active: true,
        },
        {
          id: "migration-app-b",
          game_id: "migration-game-b",
          creator_id: "migration-user-b",
          user_id: "migration-user-b",
          is_active: false,
        },
      ]);

      const [creatorColumn] = await target<
        Array<{ is_nullable: "YES" | "NO" }>
      >`
          select is_nullable
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'app_ids'
            and column_name = 'creator_id'
        `;
      expect(creatorColumn?.is_nullable).toBe("YES");

      const [ownershipConstraint] = await target<Array<{ definition: string }>>`
          select pg_get_constraintdef(c.oid) as definition
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
          where n.nspname = 'public'
            and t.relname = 'app_ids'
            and c.conname = 'app_ids_game_creator_fk'
        `;
      expect(ownershipConstraint?.definition).toBe(
        "FOREIGN KEY (game_id, creator_id) REFERENCES games(id, user_id)",
      );

      // A still-running 0037 writer can omit creator_id during the expand
      // deployment. A 0038 writer can populate it immediately. The contract
      // migration must reconcile both rows before enforcing NOT NULL.
      await target`
          insert into games (id, user_id, name, config, created_at, updated_at)
          values
            ('migration-game-overlap-old', 'migration-user-a', 'Overlap Old', '{}'::jsonb, now(), now()),
            ('migration-game-overlap-new', 'migration-user-b', 'Overlap New', '{}'::jsonb, now(), now())
        `;
      await target`
          insert into app_ids (id, game_id, key, is_active, created_at)
          values ('migration-app-overlap-old', 'migration-game-overlap-old', 'migration-key-overlap-old', true, now())
        `;
      await target`
          insert into app_ids (id, game_id, creator_id, key, is_active, created_at)
          values ('migration-app-overlap-new', 'migration-game-overlap-new', 'migration-user-b', 'migration-key-overlap-new', true, now())
        `;

      expect(
        await readPostgresErrorCode(
          () =>
            target!`
              update app_ids
              set creator_id = 'migration-user-b'
              where id = 'migration-app-a'
            `,
        ),
      ).toBe("23503");

      const migration0039 = readFileSync(
        path.join(migrationsRoot, "0039_realtime_admission_contract.sql"),
        "utf8",
      );
      await target.begin(async (transaction) => {
        for (const statement of migration0039.split(
          "--> statement-breakpoint",
        )) {
          const sql = statement.trim();
          if (sql) await transaction.unsafe(sql);
        }
      });

      const finalIdentities = await target<
        Array<{
          id: string;
          creator_id: string;
          user_id: string;
        }>
      >`
          select a.id, a.creator_id, g.user_id
          from app_ids a
          join games g on g.id = a.game_id
          order by a.id
        `;
      expect(finalIdentities).toEqual([
        {
          id: "migration-app-a",
          creator_id: "migration-user-a",
          user_id: "migration-user-a",
        },
        {
          id: "migration-app-b",
          creator_id: "migration-user-b",
          user_id: "migration-user-b",
        },
        {
          id: "migration-app-overlap-new",
          creator_id: "migration-user-b",
          user_id: "migration-user-b",
        },
        {
          id: "migration-app-overlap-old",
          creator_id: "migration-user-a",
          user_id: "migration-user-a",
        },
      ]);

      const [finalCreatorColumn] = await target<
        Array<{ is_nullable: "YES" | "NO" }>
      >`
          select is_nullable
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'app_ids'
            and column_name = 'creator_id'
        `;
      expect(finalCreatorColumn?.is_nullable).toBe("NO");

      const [notNullCheck] = await target<
        Array<{ validated: boolean; definition: string }>
      >`
          select c.convalidated as validated, pg_get_constraintdef(c.oid) as definition
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
          where n.nspname = 'public'
            and t.relname = 'app_ids'
            and c.conname = 'app_ids_creator_id_not_null_check'
        `;
      expect(notNullCheck).toEqual({
        validated: true,
        definition: "CHECK ((creator_id IS NOT NULL))",
      });

      const admissionTables = await target<Array<{ table_name: string }>>`
          select table_name
          from information_schema.tables
          where table_schema = 'public'
            and table_name in (
              'realtime_admission_instances',
              'realtime_room_admission_leases',
              'realtime_controller_admission_leases'
            )
          order by table_name
        `;
      expect(admissionTables.map(({ table_name }) => table_name)).toEqual([
        "realtime_admission_instances",
        "realtime_controller_admission_leases",
        "realtime_room_admission_leases",
      ]);

      expect(
        await readPostgresErrorCode(
          () =>
            target!`
              update app_ids
              set creator_id = null
              where game_id = 'migration-game-a'
            `,
        ),
      ).toBe("23502");
    } finally {
      await target?.end();
      await admin.unsafe(
        `drop database if exists ${quotedDatabaseName} with (force)`,
      );
      await admin.end();
      rmSync(catalogRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
