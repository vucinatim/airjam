import { db } from "@/db";
import {
  realtimeAdmissionInstances,
  realtimeControllerAdmissionLeases,
  realtimeRoomAdmissionLeases,
} from "@/db/schema";
import {
  REALTIME_ADMISSION_POLICY,
  realtimeAdmissionInstanceIsLive,
} from "@air-jam/database-contract";
import {
  and,
  count,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

type RealtimeAdmissionDatabase = typeof db;

const readCount = (rows: Array<{ value: number }>): number =>
  rows[0]?.value ?? 0;

const readDatabaseClock = async (
  database: Pick<RealtimeAdmissionDatabase, "execute">,
): Promise<Date> => {
  const rows = await database.execute(
    sql<{
      observedAt: Date | string;
    }>`select transaction_timestamp() as "observedAt"`,
  );
  const value = rows[0]?.observedAt;
  const observedAt =
    value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(observedAt.getTime())) {
    throw new Error("PostgreSQL did not return the realtime inspection clock");
  }
  return observedAt;
};

export const inspectRealtimeAdmission = async ({
  database = db,
}: {
  database?: RealtimeAdmissionDatabase;
} = {}) =>
  database.transaction(
    async (transaction) => {
      const observedAt = await readDatabaseClock(transaction);
      const activeInstance = realtimeAdmissionInstanceIsLive(
        realtimeAdmissionInstances.expiresAt,
        observedAt,
      );
      const acceptingInstance = and(
        activeInstance,
        isNull(realtimeAdmissionInstances.drainingAt),
      );
      const activeController = or(
        isNull(realtimeControllerAdmissionLeases.resumeExpiresAt),
        gt(realtimeControllerAdmissionLeases.resumeExpiresAt, observedAt),
      );
      const [
        liveInstances,
        acceptingInstances,
        drainingInstances,
        expiredInstances,
        activeRooms,
        activeControllers,
        disconnectedControllers,
        instances,
      ] = await Promise.all([
        transaction
          .select({ value: count() })
          .from(realtimeAdmissionInstances)
          .where(activeInstance),
        transaction
          .select({ value: count() })
          .from(realtimeAdmissionInstances)
          .where(acceptingInstance),
        transaction
          .select({ value: count() })
          .from(realtimeAdmissionInstances)
          .where(
            and(
              activeInstance,
              isNotNull(realtimeAdmissionInstances.drainingAt),
            ),
          ),
        transaction
          .select({ value: count() })
          .from(realtimeAdmissionInstances)
          .where(lte(realtimeAdmissionInstances.expiresAt, observedAt)),
        transaction
          .select({ value: count() })
          .from(realtimeRoomAdmissionLeases)
          .innerJoin(
            realtimeAdmissionInstances,
            and(
              eq(
                realtimeRoomAdmissionLeases.instanceId,
                realtimeAdmissionInstances.instanceId,
              ),
              realtimeAdmissionInstanceIsLive(
                realtimeAdmissionInstances.expiresAt,
                observedAt,
              ),
            ),
          ),
        transaction
          .select({ value: count() })
          .from(realtimeControllerAdmissionLeases)
          .innerJoin(
            realtimeAdmissionInstances,
            and(
              eq(
                realtimeControllerAdmissionLeases.instanceId,
                realtimeAdmissionInstances.instanceId,
              ),
              realtimeAdmissionInstanceIsLive(
                realtimeAdmissionInstances.expiresAt,
                observedAt,
              ),
            ),
          )
          .where(activeController),
        transaction
          .select({ value: count() })
          .from(realtimeControllerAdmissionLeases)
          .innerJoin(
            realtimeAdmissionInstances,
            and(
              eq(
                realtimeControllerAdmissionLeases.instanceId,
                realtimeAdmissionInstances.instanceId,
              ),
              realtimeAdmissionInstanceIsLive(
                realtimeAdmissionInstances.expiresAt,
                observedAt,
              ),
            ),
          )
          .where(
            and(
              isNotNull(realtimeControllerAdmissionLeases.resumeExpiresAt),
              gt(realtimeControllerAdmissionLeases.resumeExpiresAt, observedAt),
            ),
          ),
        transaction
          .select({
            instanceId: realtimeAdmissionInstances.instanceId,
            startedAt: realtimeAdmissionInstances.startedAt,
            heartbeatAt: realtimeAdmissionInstances.heartbeatAt,
            expiresAt: realtimeAdmissionInstances.expiresAt,
            drainingAt: realtimeAdmissionInstances.drainingAt,
          })
          .from(realtimeAdmissionInstances)
          .where(activeInstance)
          .orderBy(realtimeAdmissionInstances.startedAt),
      ]);

      const rooms = readCount(activeRooms);
      const controllers = readCount(activeControllers);
      const accepting = readCount(acceptingInstances);
      return {
        contractVersion: REALTIME_ADMISSION_POLICY.contractVersion,
        observedAt: observedAt.toISOString(),
        authority: "postgresql" as const,
        acceptanceAuthority: {
          acceptingInstances: accepting,
          invariant:
            accepting <= 1 ? ("satisfied" as const) : ("violated" as const),
        },
        instances: {
          live: readCount(liveInstances),
          draining: readCount(drainingInstances),
          expired: readCount(expiredInstances),
          items: instances.map((instance) => ({
            instanceId: instance.instanceId,
            state: instance.drainingAt
              ? ("draining" as const)
              : ("active" as const),
            startedAt: instance.startedAt.toISOString(),
            heartbeatAt: instance.heartbeatAt.toISOString(),
            expiresAt: instance.expiresAt.toISOString(),
            drainingAt: instance.drainingAt?.toISOString() ?? null,
          })),
        },
        rooms: {
          active: rooms,
          sustainedTarget: REALTIME_ADMISSION_POLICY.sustainedRooms,
          burstCeiling: REALTIME_ADMISSION_POLICY.burstRooms,
          burstRemaining: Math.max(
            REALTIME_ADMISSION_POLICY.burstRooms - rooms,
            0,
          ),
        },
        controllers: {
          active: controllers,
          disconnectedResumable: readCount(disconnectedControllers),
          sustainedTarget: REALTIME_ADMISSION_POLICY.sustainedControllers,
          burstCeiling: REALTIME_ADMISSION_POLICY.burstControllers,
          burstRemaining: Math.max(
            REALTIME_ADMISSION_POLICY.burstControllers - controllers,
            0,
          ),
        },
        policy: REALTIME_ADMISSION_POLICY,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
