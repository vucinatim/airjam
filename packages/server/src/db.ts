import { createRuntimeDatabaseSchema } from "@air-jam/database-contract";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const runtimeDatabaseSchema = createRuntimeDatabaseSchema();

export const {
  appIds,
  operationalBudgetCycles,
  operationalBudgetEvidence,
  operationalLaneControls,
  operationalEventOutbox,
  operationalEvents,
  realtimeAdmissionInstances,
  realtimeControllerAdmissionLeases,
  realtimeRoomAdmissionLeases,
  runtimeUsageSessions,
  runtimeUsageEvents,
  runtimeUsageControllerSegments,
  runtimeUsageGameSegments,
  runtimeUsageEligibleSegments,
  runtimeUsageGameSessionMetrics,
  runtimeUsageDailyGameMetrics,
} = runtimeDatabaseSchema;

export type ServerDatabase =
  | PostgresJsDatabase<Record<string, never>>
  | PostgresJsDatabase<typeof runtimeDatabaseSchema>;

export interface OwnedServerDatabase {
  database: ServerDatabase;
  close: () => Promise<void>;
}

export const createOwnedServerDatabase = (
  databaseUrl: string | undefined,
): OwnedServerDatabase | null => {
  if (!databaseUrl) {
    return null;
  }

  const client = postgres(databaseUrl);
  let closePromise: Promise<void> | null = null;
  return {
    database: drizzle(client, { schema: runtimeDatabaseSchema }),
    close: () => (closePromise ??= client.end()),
  };
};

export const createServerDatabase = (
  databaseUrl: string | undefined,
): ServerDatabase | null => {
  return createOwnedServerDatabase(databaseUrl)?.database ?? null;
};
