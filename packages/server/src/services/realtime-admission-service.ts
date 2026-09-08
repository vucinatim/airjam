import {
  decideOperationalAdmissionPolicy,
  readOperationalAuthoritySnapshot,
  REALTIME_ADMISSION_POLICY,
  realtimeAdmissionInstanceIsLive,
  type OperationalBudgetRequirement,
  type OperationalLane,
} from "@air-jam/database-contract";
import { and, count, eq, isNull, lte, ne, sql } from "drizzle-orm";
import {
  operationalBudgetCycles,
  operationalBudgetEvidence,
  operationalLaneControls,
  realtimeAdmissionInstances,
  realtimeControllerAdmissionLeases,
  realtimeRoomAdmissionLeases,
  type ServerDatabase,
} from "../db.js";
import type { ServerLogger } from "../logging/logger.js";

const ADMISSION_LOCK_KEY = 1_094_822_066;

export type RealtimeAdmissionDenialReason =
  | "authority_unavailable"
  | "instance_draining"
  | "lane_paused"
  | "budget_protection"
  | "global_capacity_exceeded"
  | "creator_quota_exceeded"
  | "game_quota_exceeded"
  | "room_full"
  | "room_conflict"
  | "controller_conflict"
  | "operation_in_progress"
  | "operation_cancelled";

export type RealtimeAdmissionDenial = {
  ok: false;
  reason: RealtimeAdmissionDenialReason;
  message: string;
  retryAfterSeconds: number | null;
};

export type RealtimeRoomLease = {
  roomId: string;
  leaseToken: string;
};

export type RealtimeControllerLease = {
  roomId: string;
  controllerId: string;
  leaseToken: string;
};

export type RealtimeAdmissionDecision<TLease> =
  | { ok: true; lease: TLease }
  | RealtimeAdmissionDenial;

export type RealtimeAdmissionStatus = {
  contractVersion: typeof REALTIME_ADMISSION_POLICY.contractVersion;
  authority: "database" | "local" | "unavailable";
  budgetRequirement: OperationalBudgetRequirement;
  instanceId: string;
  acceptingNewWork: boolean;
  draining: boolean;
  terminalAuthorityLost: boolean;
  pendingReconciliations: number;
  lastHeartbeatAt: string | null;
  lastError: string | null;
  policy: typeof REALTIME_ADMISSION_POLICY;
};

export interface RealtimeAdmissionService {
  start: () => Promise<void>;
  beginDrain: () => Promise<void>;
  stop: () => Promise<void>;
  admitRoom: (input: {
    roomId: string;
    appId?: string;
    gameId?: string;
    creatorId?: string;
    maxControllers: number;
    replacingLease?: RealtimeRoomLease;
  }) => Promise<RealtimeAdmissionDecision<RealtimeRoomLease>>;
  releaseRoom: (lease: RealtimeRoomLease) => Promise<void>;
  admitController: (input: {
    roomLease: RealtimeRoomLease;
    controllerId: string;
    existingLease?: RealtimeControllerLease;
    replacingLease?: RealtimeControllerLease;
  }) => Promise<RealtimeAdmissionDecision<RealtimeControllerLease>>;
  markControllerDisconnected: (
    lease: RealtimeControllerLease,
    resumeLeaseMs: number | null,
  ) => Promise<void>;
  releaseController: (lease: RealtimeControllerLease) => Promise<void>;
  getStatus: () => RealtimeAdmissionStatus;
  onTerminalAuthorityLoss: (
    listener: (failure: RealtimeAdmissionTerminalFailure) => void,
  ) => () => void;
}

export type RealtimeAdmissionTerminalFailure = {
  code: "instance_lease_lost";
  message: string;
};

const denial = (
  reason: RealtimeAdmissionDenialReason,
  message: string,
  retryAfterSeconds:
    | number
    | null = REALTIME_ADMISSION_POLICY.defaultRetryAfterSeconds,
): RealtimeAdmissionDenial => ({
  ok: false,
  reason,
  message,
  retryAfterSeconds,
});

const readCount = (rows: Array<{ value: number }>): number =>
  rows[0]?.value ?? 0;

const laneCapacity = (
  lane: OperationalLane,
  quotaEnforced: boolean,
): number => {
  if (lane === "realtime_room_admission") {
    return quotaEnforced
      ? REALTIME_ADMISSION_POLICY.sustainedRooms
      : REALTIME_ADMISSION_POLICY.burstRooms;
  }
  return quotaEnforced
    ? REALTIME_ADMISSION_POLICY.sustainedControllers
    : REALTIME_ADMISSION_POLICY.burstControllers;
};

const createLeaseToken = (): string => crypto.randomUUID();
const databaseNow = () => sql<Date>`clock_timestamp()`;
const databaseInstanceExpiry = () =>
  sql<Date>`clock_timestamp() + (${REALTIME_ADMISSION_POLICY.instanceLeaseTtlMs} * interval '1 millisecond')`;
const liveInstance = () =>
  realtimeAdmissionInstanceIsLive(realtimeAdmissionInstances.expiresAt);
const activeController = () =>
  sql<boolean>`(${realtimeControllerAdmissionLeases.resumeExpiresAt} is null or ${realtimeControllerAdmissionLeases.resumeExpiresAt} > clock_timestamp())`;

const controllerIdentityKey = ({
  roomId,
  controllerId,
}: Pick<RealtimeControllerLease, "roomId" | "controllerId">): string =>
  `${roomId}\u0000${controllerId}`;

const readAdmissionAuthority = async ({
  database,
  lane,
}: {
  database: Pick<ServerDatabase, "execute" | "select">;
  lane: OperationalLane;
}) =>
  readOperationalAuthoritySnapshot({
    database,
    tables: {
      operationalBudgetCycles,
      operationalBudgetEvidence,
      operationalLaneControls,
    },
    lane,
  });

export class DatabaseRealtimeAdmissionService implements RealtimeAdmissionService {
  private readonly database: ServerDatabase;
  private readonly logger: ServerLogger;
  private readonly instanceId: string;
  private readonly instanceLeaseToken = createLeaseToken();
  private readonly budgetRequirement: OperationalBudgetRequirement;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private registered = false;
  private leaseLost = false;
  private drainRequested = false;
  private draining = false;
  private available = false;
  private lastHeartbeatAt: Date | null = null;
  private lastError: string | null = null;
  private readonly pendingRoomReleases = new Map<string, RealtimeRoomLease>();
  private readonly pendingControllerMutations = new Map<
    string,
    | {
        kind: "disconnect";
        lease: RealtimeControllerLease;
        resumeLeaseMs: number;
      }
    | { kind: "release"; lease: RealtimeControllerLease }
  >();
  private readonly pendingControllerAdmissions = new Map<
    string,
    { lease: RealtimeControllerLease; recordedAt: number }
  >();
  private readonly terminalAuthorityLossListeners = new Set<
    (failure: RealtimeAdmissionTerminalFailure) => void
  >();

  constructor({
    database,
    logger,
    instanceId = `realtime-${crypto.randomUUID()}`,
    budgetRequirement,
  }: {
    database: ServerDatabase;
    logger: ServerLogger;
    instanceId?: string;
    budgetRequirement: OperationalBudgetRequirement;
  }) {
    this.database = database;
    this.logger = logger;
    this.instanceId = instanceId;
    this.budgetRequirement = budgetRequirement;
  }

  async start(): Promise<void> {
    if (this.heartbeatTimer) return;
    try {
      await this.registerInstance();
    } catch {
      // Readiness remains false while the heartbeat loop retries registration.
    }
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, REALTIME_ADMISSION_POLICY.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  async beginDrain(): Promise<void> {
    this.drainRequested = true;
    this.draining = true;
    if (!this.registered || this.leaseLost) return;
    try {
      const rows = await this.database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(${ADMISSION_LOCK_KEY})`,
        );
        return transaction
          .update(realtimeAdmissionInstances)
          .set({ drainingAt: databaseNow() })
          .where(
            and(
              eq(realtimeAdmissionInstances.instanceId, this.instanceId),
              eq(
                realtimeAdmissionInstances.leaseToken,
                this.instanceLeaseToken,
              ),
              liveInstance(),
            ),
          )
          .returning({ instanceId: realtimeAdmissionInstances.instanceId });
      });
      if (rows.length !== 1) {
        this.markLeaseLost(
          "Realtime admission instance lease expired before drain",
        );
      }
    } catch (error) {
      this.available = false;
      this.recordError(error, "Could not persist realtime drain state");
    }
  }

  async stop(): Promise<void> {
    this.drainRequested = true;
    this.draining = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      await this.database
        .delete(realtimeAdmissionInstances)
        .where(
          and(
            eq(realtimeAdmissionInstances.instanceId, this.instanceId),
            eq(realtimeAdmissionInstances.leaseToken, this.instanceLeaseToken),
          ),
        );
    } catch (error) {
      this.recordError(error, "Could not release realtime instance lease");
    } finally {
      this.available = false;
      this.registered = false;
      this.pendingRoomReleases.clear();
      this.pendingControllerMutations.clear();
      this.pendingControllerAdmissions.clear();
    }
  }

  async admitRoom({
    roomId,
    appId,
    gameId,
    creatorId,
    maxControllers,
    replacingLease,
  }: {
    roomId: string;
    appId?: string;
    gameId?: string;
    creatorId?: string;
    maxControllers: number;
    replacingLease?: RealtimeRoomLease;
  }): Promise<RealtimeAdmissionDecision<RealtimeRoomLease>> {
    if (this.draining) {
      return denial(
        "instance_draining",
        "This server is draining. Please try again.",
      );
    }
    if (!this.available) {
      return denial(
        "authority_unavailable",
        "Room capacity is temporarily unavailable. Please try again.",
      );
    }

    const lease: RealtimeRoomLease = {
      roomId,
      leaseToken: createLeaseToken(),
    };
    try {
      return await this.database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(${ADMISSION_LOCK_KEY})`,
        );

        if (this.draining) {
          return denial(
            "instance_draining",
            "This server is draining. Please try again.",
          );
        }

        const [instance] = await transaction
          .select({
            active: liveInstance(),
            drainingAt: realtimeAdmissionInstances.drainingAt,
          })
          .from(realtimeAdmissionInstances)
          .where(
            and(
              eq(realtimeAdmissionInstances.instanceId, this.instanceId),
              eq(
                realtimeAdmissionInstances.leaseToken,
                this.instanceLeaseToken,
              ),
            ),
          )
          .limit(1);
        if (!instance || !instance.active) {
          this.markLeaseLost(
            "Realtime admission instance lease expired or no longer exists",
          );
          return denial(
            "authority_unavailable",
            "Room capacity is temporarily unavailable. Please try again.",
          );
        }
        if (instance.drainingAt) {
          this.draining = true;
          return denial(
            "instance_draining",
            "This server is draining. Please try again.",
          );
        }

        const { control, budget } = await readAdmissionAuthority({
          database: transaction,
          lane: "realtime_room_admission",
        });
        const laneDecision = this.decideAdmissionPolicy({
          lane: "realtime_room_admission",
          control,
          budget,
        });
        if (laneDecision.outcome === "denied") {
          if (laneDecision.reason === "lane_paused") {
            return denial(
              "lane_paused",
              control.reason || "New rooms are temporarily paused.",
              laneDecision.retryAfterSeconds,
            );
          }
          return denial(
            laneDecision.reason === "budget_protection"
              ? "budget_protection"
              : "authority_unavailable",
            laneDecision.reason === "budget_protection"
              ? "New hosted rooms are temporarily paused by the production budget guard."
              : "Room capacity authority is temporarily unavailable. Please try again.",
            laneDecision.retryAfterSeconds,
          );
        }

        const [existing] = await transaction
          .select({
            leaseToken: realtimeRoomAdmissionLeases.leaseToken,
            instanceActive: liveInstance(),
          })
          .from(realtimeRoomAdmissionLeases)
          .innerJoin(
            realtimeAdmissionInstances,
            eq(
              realtimeRoomAdmissionLeases.instanceId,
              realtimeAdmissionInstances.instanceId,
            ),
          )
          .where(eq(realtimeRoomAdmissionLeases.roomId, roomId))
          .limit(1);

        if (existing?.instanceActive) {
          return denial(
            "room_conflict",
            "That room code is already in use. Please try again.",
            1,
          );
        }
        if (existing) {
          await transaction
            .delete(realtimeRoomAdmissionLeases)
            .where(eq(realtimeRoomAdmissionLeases.roomId, roomId));
        }

        const [replacement] = replacingLease
          ? await transaction
              .select({
                roomId: realtimeRoomAdmissionLeases.roomId,
                creatorId: realtimeRoomAdmissionLeases.creatorId,
                gameId: realtimeRoomAdmissionLeases.gameId,
              })
              .from(realtimeRoomAdmissionLeases)
              .where(
                and(
                  eq(realtimeRoomAdmissionLeases.roomId, replacingLease.roomId),
                  eq(
                    realtimeRoomAdmissionLeases.leaseToken,
                    replacingLease.leaseToken,
                  ),
                  eq(realtimeRoomAdmissionLeases.instanceId, this.instanceId),
                ),
              )
              .limit(1)
          : [];
        if (replacingLease && !replacement) {
          return denial(
            "authority_unavailable",
            "The previous room reservation could not be replaced safely.",
          );
        }

        const activeRoom = liveInstance();
        const globalRooms = readCount(
          await transaction
            .select({ value: count() })
            .from(realtimeRoomAdmissionLeases)
            .innerJoin(
              realtimeAdmissionInstances,
              and(
                eq(
                  realtimeRoomAdmissionLeases.instanceId,
                  realtimeAdmissionInstances.instanceId,
                ),
                activeRoom,
              ),
            ),
        );
        const effectiveGlobalRooms = globalRooms - (replacement ? 1 : 0);
        if (
          effectiveGlobalRooms >=
          laneCapacity("realtime_room_admission", laneDecision.quotaEnforced)
        ) {
          return denial(
            "global_capacity_exceeded",
            "Air Jam is at room capacity. Please try again shortly.",
          );
        }

        if (creatorId) {
          const creatorRooms = readCount(
            await transaction
              .select({ value: count() })
              .from(realtimeRoomAdmissionLeases)
              .innerJoin(
                realtimeAdmissionInstances,
                and(
                  eq(
                    realtimeRoomAdmissionLeases.instanceId,
                    realtimeAdmissionInstances.instanceId,
                  ),
                  liveInstance(),
                ),
              )
              .where(eq(realtimeRoomAdmissionLeases.creatorId, creatorId)),
          );
          const effectiveCreatorRooms =
            creatorRooms - (replacement?.creatorId === creatorId ? 1 : 0);
          const creatorDecision = this.decideAdmissionPolicy({
            lane: "realtime_room_admission",
            control,
            budget,
            quota: {
              authorityAvailable: true,
              current: effectiveCreatorRooms,
              limit: REALTIME_ADMISSION_POLICY.creatorRooms,
              requestedAmount: 1,
            },
          });
          if (creatorDecision.outcome === "denied") {
            return denial(
              "creator_quota_exceeded",
              "This creator has reached the concurrent room allowance.",
              creatorDecision.retryAfterSeconds ??
                REALTIME_ADMISSION_POLICY.defaultRetryAfterSeconds,
            );
          }
        }

        if (gameId) {
          const gameRooms = readCount(
            await transaction
              .select({ value: count() })
              .from(realtimeRoomAdmissionLeases)
              .innerJoin(
                realtimeAdmissionInstances,
                and(
                  eq(
                    realtimeRoomAdmissionLeases.instanceId,
                    realtimeAdmissionInstances.instanceId,
                  ),
                  liveInstance(),
                ),
              )
              .where(eq(realtimeRoomAdmissionLeases.gameId, gameId)),
          );
          const effectiveGameRooms =
            gameRooms - (replacement?.gameId === gameId ? 1 : 0);
          const gameDecision = this.decideAdmissionPolicy({
            lane: "realtime_room_admission",
            control,
            budget,
            quota: {
              authorityAvailable: true,
              current: effectiveGameRooms,
              limit: REALTIME_ADMISSION_POLICY.gameRooms,
              requestedAmount: 1,
            },
          });
          if (gameDecision.outcome === "denied") {
            return denial(
              "game_quota_exceeded",
              "This game has reached the concurrent room allowance.",
              gameDecision.retryAfterSeconds ??
                REALTIME_ADMISSION_POLICY.defaultRetryAfterSeconds,
            );
          }
        }

        if (replacingLease) {
          await transaction
            .delete(realtimeRoomAdmissionLeases)
            .where(
              and(
                eq(realtimeRoomAdmissionLeases.roomId, replacingLease.roomId),
                eq(
                  realtimeRoomAdmissionLeases.leaseToken,
                  replacingLease.leaseToken,
                ),
                eq(realtimeRoomAdmissionLeases.instanceId, this.instanceId),
              ),
            );
        }

        await transaction.insert(realtimeRoomAdmissionLeases).values({
          roomId,
          leaseToken: lease.leaseToken,
          instanceId: this.instanceId,
          appId,
          gameId,
          creatorId,
          maxControllers,
        });
        return { ok: true, lease };
      });
    } catch (error) {
      this.available = false;
      const reconciled = await this.reconcileRoomAdmission(lease);
      if (reconciled) return { ok: true, lease };
      this.pendingRoomReleases.set(lease.leaseToken, lease);
      this.recordError(error, "Realtime room admission failed");
      return denial(
        "authority_unavailable",
        "Room capacity is temporarily unavailable. Please try again.",
      );
    }
  }

  async releaseRoom(lease: RealtimeRoomLease): Promise<void> {
    try {
      await this.database
        .delete(realtimeRoomAdmissionLeases)
        .where(
          and(
            eq(realtimeRoomAdmissionLeases.roomId, lease.roomId),
            eq(realtimeRoomAdmissionLeases.leaseToken, lease.leaseToken),
            eq(realtimeRoomAdmissionLeases.instanceId, this.instanceId),
          ),
        );
      this.pendingRoomReleases.delete(lease.leaseToken);
      for (const [token, mutation] of this.pendingControllerMutations) {
        if (mutation.lease.roomId === lease.roomId) {
          this.pendingControllerMutations.delete(token);
        }
      }
    } catch (error) {
      this.available = false;
      this.pendingRoomReleases.set(lease.leaseToken, lease);
      this.recordError(error, "Could not release realtime room lease");
    }
  }

  async admitController({
    roomLease,
    controllerId,
    existingLease,
    replacingLease,
  }: {
    roomLease: RealtimeRoomLease;
    controllerId: string;
    existingLease?: RealtimeControllerLease;
    replacingLease?: RealtimeControllerLease;
  }): Promise<RealtimeAdmissionDecision<RealtimeControllerLease>> {
    if (this.draining && !existingLease) {
      return denial(
        "instance_draining",
        "This server is draining. Please try again.",
      );
    }
    if (!this.available && !existingLease) {
      return denial(
        "authority_unavailable",
        "Controller capacity is temporarily unavailable. Please try again.",
      );
    }

    const pendingKey = controllerIdentityKey({
      roomId: roomLease.roomId,
      controllerId,
    });
    const pendingAdmission = this.pendingControllerAdmissions.get(pendingKey);
    if (pendingAdmission) {
      const reconciled = await this.reconcileControllerAdmission(
        pendingAdmission.lease,
      );
      if (reconciled) {
        this.pendingControllerAdmissions.delete(pendingKey);
        return { ok: true, lease: pendingAdmission.lease };
      }
      if (!this.available) {
        return denial(
          "authority_unavailable",
          "Controller capacity is temporarily unavailable. Please try again.",
        );
      }
      this.pendingControllerAdmissions.delete(pendingKey);
    }

    const lease: RealtimeControllerLease = {
      roomId: roomLease.roomId,
      controllerId,
      leaseToken: createLeaseToken(),
    };

    try {
      return await this.database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(${ADMISSION_LOCK_KEY})`,
        );

        if (this.draining && !existingLease) {
          return denial(
            "instance_draining",
            "This server is draining. Please try again.",
          );
        }

        const [room] = await transaction
          .select({
            maxControllers: realtimeRoomAdmissionLeases.maxControllers,
            drainingAt: realtimeAdmissionInstances.drainingAt,
          })
          .from(realtimeRoomAdmissionLeases)
          .innerJoin(
            realtimeAdmissionInstances,
            and(
              eq(
                realtimeRoomAdmissionLeases.instanceId,
                realtimeAdmissionInstances.instanceId,
              ),
              liveInstance(),
            ),
          )
          .where(
            and(
              eq(realtimeRoomAdmissionLeases.roomId, roomLease.roomId),
              eq(realtimeRoomAdmissionLeases.leaseToken, roomLease.leaseToken),
              eq(realtimeRoomAdmissionLeases.instanceId, this.instanceId),
            ),
          )
          .limit(1);
        if (!room) {
          return denial(
            "authority_unavailable",
            "Room capacity authority expired. Please retry from the host.",
          );
        }

        const currentRows = await transaction
          .select({
            leaseToken: realtimeControllerAdmissionLeases.leaseToken,
            active: activeController(),
          })
          .from(realtimeControllerAdmissionLeases)
          .where(
            and(
              eq(realtimeControllerAdmissionLeases.roomId, roomLease.roomId),
              eq(realtimeControllerAdmissionLeases.controllerId, controllerId),
            ),
          )
          .limit(1);
        let current: (typeof currentRows)[number] | undefined = currentRows[0];
        if (current && !current.active) {
          await transaction
            .delete(realtimeControllerAdmissionLeases)
            .where(
              and(
                eq(realtimeControllerAdmissionLeases.roomId, roomLease.roomId),
                eq(
                  realtimeControllerAdmissionLeases.controllerId,
                  controllerId,
                ),
                eq(
                  realtimeControllerAdmissionLeases.leaseToken,
                  current.leaseToken,
                ),
              ),
            );
          current = undefined;
        }
        if (
          current &&
          (!existingLease || current.leaseToken !== existingLease.leaseToken)
        ) {
          return denial(
            "controller_conflict",
            "Controller slot is unavailable.",
            null,
          );
        }

        const [replacement] = replacingLease
          ? await transaction
              .select({
                roomId: realtimeControllerAdmissionLeases.roomId,
                controllerId: realtimeControllerAdmissionLeases.controllerId,
              })
              .from(realtimeControllerAdmissionLeases)
              .where(
                and(
                  eq(
                    realtimeControllerAdmissionLeases.roomId,
                    replacingLease.roomId,
                  ),
                  eq(
                    realtimeControllerAdmissionLeases.controllerId,
                    replacingLease.controllerId,
                  ),
                  eq(
                    realtimeControllerAdmissionLeases.leaseToken,
                    replacingLease.leaseToken,
                  ),
                  eq(
                    realtimeControllerAdmissionLeases.instanceId,
                    this.instanceId,
                  ),
                ),
              )
              .limit(1)
          : [];
        if (replacingLease && !replacement) {
          return denial(
            "authority_unavailable",
            "The previous controller reservation could not be replaced safely.",
          );
        }

        if (current && existingLease) {
          const resumed = await transaction
            .update(realtimeControllerAdmissionLeases)
            .set({
              leaseToken: lease.leaseToken,
              disconnectedAt: null,
              resumeExpiresAt: null,
            })
            .where(
              eq(
                realtimeControllerAdmissionLeases.leaseToken,
                existingLease.leaseToken,
              ),
            )
            .returning({
              controllerId: realtimeControllerAdmissionLeases.controllerId,
            });
          if (resumed.length !== 1) {
            return denial(
              "controller_conflict",
              "Controller slot is unavailable.",
              null,
            );
          }
          if (
            replacingLease &&
            replacingLease.leaseToken !== existingLease.leaseToken
          ) {
            await transaction
              .delete(realtimeControllerAdmissionLeases)
              .where(
                eq(
                  realtimeControllerAdmissionLeases.leaseToken,
                  replacingLease.leaseToken,
                ),
              );
          }
          return { ok: true, lease };
        }

        if (room.drainingAt) {
          this.draining = true;
          return denial(
            "instance_draining",
            "This server is draining. Please try again.",
          );
        }

        const { control, budget } = await readAdmissionAuthority({
          database: transaction,
          lane: "realtime_controller_admission",
        });
        const laneDecision = this.decideAdmissionPolicy({
          lane: "realtime_controller_admission",
          control,
          budget,
        });
        if (laneDecision.outcome === "denied") {
          if (laneDecision.reason === "lane_paused") {
            return denial(
              "lane_paused",
              control.reason || "New controllers are temporarily paused.",
              laneDecision.retryAfterSeconds,
            );
          }
          return denial(
            laneDecision.reason === "budget_protection"
              ? "budget_protection"
              : "authority_unavailable",
            laneDecision.reason === "budget_protection"
              ? "New hosted controllers are temporarily paused by the production budget guard."
              : "Controller capacity authority is temporarily unavailable. Please try again.",
            laneDecision.retryAfterSeconds,
          );
        }

        const controllerIsActive = activeController();
        const roomControllers = readCount(
          await transaction
            .select({ value: count() })
            .from(realtimeControllerAdmissionLeases)
            .where(
              and(
                eq(realtimeControllerAdmissionLeases.roomId, roomLease.roomId),
                controllerIsActive,
              ),
            ),
        );
        const effectiveRoomControllers =
          roomControllers - (replacement?.roomId === roomLease.roomId ? 1 : 0);
        if (effectiveRoomControllers >= room.maxControllers) {
          return denial("room_full", "Room full", null);
        }

        const globalControllers = readCount(
          await transaction
            .select({ value: count() })
            .from(realtimeControllerAdmissionLeases)
            .innerJoin(
              realtimeAdmissionInstances,
              and(
                eq(
                  realtimeControllerAdmissionLeases.instanceId,
                  realtimeAdmissionInstances.instanceId,
                ),
                liveInstance(),
              ),
            )
            .where(controllerIsActive),
        );
        const effectiveGlobalControllers =
          globalControllers - (replacement ? 1 : 0);
        if (
          effectiveGlobalControllers >=
          laneCapacity(
            "realtime_controller_admission",
            laneDecision.quotaEnforced,
          )
        ) {
          return denial(
            "global_capacity_exceeded",
            "Air Jam is at controller capacity. Please try again shortly.",
          );
        }

        if (replacingLease) {
          await transaction
            .delete(realtimeControllerAdmissionLeases)
            .where(
              and(
                eq(
                  realtimeControllerAdmissionLeases.roomId,
                  replacingLease.roomId,
                ),
                eq(
                  realtimeControllerAdmissionLeases.controllerId,
                  replacingLease.controllerId,
                ),
                eq(
                  realtimeControllerAdmissionLeases.leaseToken,
                  replacingLease.leaseToken,
                ),
                eq(
                  realtimeControllerAdmissionLeases.instanceId,
                  this.instanceId,
                ),
              ),
            );
        }

        await transaction.insert(realtimeControllerAdmissionLeases).values({
          roomId: roomLease.roomId,
          controllerId,
          leaseToken: lease.leaseToken,
          instanceId: this.instanceId,
        });
        return { ok: true, lease };
      });
    } catch (error) {
      this.available = false;
      this.pendingControllerAdmissions.set(pendingKey, {
        lease,
        recordedAt: Date.now(),
      });
      const reconciled = await this.reconcileControllerAdmission(lease);
      if (reconciled) {
        this.pendingControllerAdmissions.delete(pendingKey);
        if (existingLease) {
          this.pendingControllerMutations.delete(existingLease.leaseToken);
        }
        if (replacingLease) {
          this.pendingControllerMutations.delete(replacingLease.leaseToken);
        }
        return { ok: true, lease };
      }
      this.recordError(error, "Realtime controller admission failed");
      return denial(
        "authority_unavailable",
        "Controller capacity is temporarily unavailable. Please try again.",
      );
    }
  }

  async markControllerDisconnected(
    lease: RealtimeControllerLease,
    resumeLeaseMs: number | null,
  ): Promise<void> {
    if (!resumeLeaseMs || resumeLeaseMs <= 0) {
      await this.releaseController(lease);
      return;
    }
    const boundedResumeLeaseMs = Math.min(
      resumeLeaseMs,
      REALTIME_ADMISSION_POLICY.maximumControllerResumeLeaseMs,
    );
    try {
      await this.database
        .update(realtimeControllerAdmissionLeases)
        .set({
          disconnectedAt: databaseNow(),
          resumeExpiresAt: sql<Date>`clock_timestamp() + (${boundedResumeLeaseMs} * interval '1 millisecond')`,
        })
        .where(
          and(
            eq(realtimeControllerAdmissionLeases.leaseToken, lease.leaseToken),
            eq(realtimeControllerAdmissionLeases.instanceId, this.instanceId),
          ),
        );
      this.pendingControllerMutations.delete(lease.leaseToken);
    } catch (error) {
      this.available = false;
      this.pendingControllerMutations.set(lease.leaseToken, {
        kind: "disconnect",
        lease,
        resumeLeaseMs: boundedResumeLeaseMs,
      });
      this.recordError(error, "Could not update controller resume lease");
    }
  }

  async releaseController(lease: RealtimeControllerLease): Promise<void> {
    try {
      await this.database
        .delete(realtimeControllerAdmissionLeases)
        .where(
          and(
            eq(realtimeControllerAdmissionLeases.leaseToken, lease.leaseToken),
            eq(realtimeControllerAdmissionLeases.instanceId, this.instanceId),
          ),
        );
      this.pendingControllerMutations.delete(lease.leaseToken);
    } catch (error) {
      this.available = false;
      this.pendingControllerMutations.set(lease.leaseToken, {
        kind: "release",
        lease,
      });
      this.recordError(error, "Could not release realtime controller lease");
    }
  }

  getStatus(): RealtimeAdmissionStatus {
    return {
      contractVersion: REALTIME_ADMISSION_POLICY.contractVersion,
      authority: this.available ? "database" : "unavailable",
      budgetRequirement: this.budgetRequirement,
      instanceId: this.instanceId,
      acceptingNewWork: this.available && !this.draining,
      draining: this.draining,
      terminalAuthorityLost: this.leaseLost,
      pendingReconciliations:
        this.pendingRoomReleases.size +
        this.pendingControllerMutations.size +
        this.pendingControllerAdmissions.size,
      lastHeartbeatAt: this.lastHeartbeatAt?.toISOString() ?? null,
      lastError: this.lastError,
      policy: REALTIME_ADMISSION_POLICY,
    };
  }

  onTerminalAuthorityLoss(
    listener: (failure: RealtimeAdmissionTerminalFailure) => void,
  ): () => void {
    this.terminalAuthorityLossListeners.add(listener);
    if (this.leaseLost) {
      queueMicrotask(() => {
        if (this.terminalAuthorityLossListeners.has(listener)) {
          listener({
            code: "instance_lease_lost",
            message:
              this.lastError ??
              "Realtime admission instance authority was lost",
          });
        }
      });
    }
    return () => this.terminalAuthorityLossListeners.delete(listener);
  }

  private async registerInstance(): Promise<void> {
    if (this.leaseLost) return;
    try {
      await this.assertRegistrationAuthorityReady();
      const [registered] = await this.database.transaction(
        async (transaction) => {
          await transaction.execute(
            sql`select pg_advisory_xact_lock(${ADMISSION_LOCK_KEY})`,
          );
          await transaction
            .delete(realtimeAdmissionInstances)
            .where(lte(realtimeAdmissionInstances.expiresAt, databaseNow()));
          await transaction
            .update(realtimeAdmissionInstances)
            .set({ drainingAt: databaseNow() })
            .where(
              and(
                ne(realtimeAdmissionInstances.instanceId, this.instanceId),
                liveInstance(),
                isNull(realtimeAdmissionInstances.drainingAt),
              ),
            );
          return transaction
            .insert(realtimeAdmissionInstances)
            .values({
              instanceId: this.instanceId,
              leaseToken: this.instanceLeaseToken,
              startedAt: databaseNow(),
              heartbeatAt: databaseNow(),
              expiresAt: databaseInstanceExpiry(),
              ...(this.drainRequested ? { drainingAt: databaseNow() } : {}),
            })
            .returning({
              heartbeatAt: realtimeAdmissionInstances.heartbeatAt,
            });
        },
      );
      if (!registered) throw new Error("Realtime instance registration failed");
      this.registered = true;
      this.available = true;
      this.lastHeartbeatAt = registered.heartbeatAt;
      this.lastError = null;
    } catch (error) {
      this.recordError(
        error,
        "Could not register realtime admission authority",
      );
      throw error;
    }
  }

  private async assertRegistrationAuthorityReady(): Promise<void> {
    if (this.budgetRequirement === "not_applicable") return;
    const { budget } = await readAdmissionAuthority({
      database: this.database,
      lane: "realtime_room_admission",
    });
    if (budget.evidenceStatus !== "fresh") {
      throw new Error(
        `Realtime admission budget authority is ${budget.evidenceStatus}`,
      );
    }
  }

  private decideAdmissionPolicy(
    input: Omit<
      Parameters<typeof decideOperationalAdmissionPolicy>[0],
      "budgetRequirement"
    >,
  ) {
    return decideOperationalAdmissionPolicy({
      ...input,
      budgetRequirement: this.budgetRequirement,
    });
  }

  private async heartbeat(): Promise<void> {
    if (this.leaseLost) return;
    if (!this.registered) {
      try {
        await this.registerInstance();
      } catch {
        // registerInstance records the failure and the next tick retries.
      }
      return;
    }
    try {
      const rows = await this.database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(${ADMISSION_LOCK_KEY})`,
        );
        await transaction
          .delete(realtimeAdmissionInstances)
          .where(lte(realtimeAdmissionInstances.expiresAt, databaseNow()));

        if (!this.drainRequested) {
          const [instance] = await transaction
            .select({
              drainingAt: realtimeAdmissionInstances.drainingAt,
            })
            .from(realtimeAdmissionInstances)
            .where(
              and(
                eq(realtimeAdmissionInstances.instanceId, this.instanceId),
                eq(
                  realtimeAdmissionInstances.leaseToken,
                  this.instanceLeaseToken,
                ),
                liveInstance(),
              ),
            )
            .limit(1);

          if (instance?.drainingAt) {
            const [acceptingSuccessor] = await transaction
              .select({ instanceId: realtimeAdmissionInstances.instanceId })
              .from(realtimeAdmissionInstances)
              .where(
                and(
                  ne(realtimeAdmissionInstances.instanceId, this.instanceId),
                  liveInstance(),
                  isNull(realtimeAdmissionInstances.drainingAt),
                ),
              )
              .limit(1);

            if (!acceptingSuccessor) {
              await transaction
                .update(realtimeAdmissionInstances)
                .set({ drainingAt: null })
                .where(
                  and(
                    eq(realtimeAdmissionInstances.instanceId, this.instanceId),
                    eq(
                      realtimeAdmissionInstances.leaseToken,
                      this.instanceLeaseToken,
                    ),
                    liveInstance(),
                  ),
                );
            }
          }
        }

        return transaction
          .update(realtimeAdmissionInstances)
          .set({
            heartbeatAt: databaseNow(),
            expiresAt: databaseInstanceExpiry(),
            ...(this.drainRequested ? { drainingAt: databaseNow() } : {}),
          })
          .where(
            and(
              eq(realtimeAdmissionInstances.instanceId, this.instanceId),
              eq(
                realtimeAdmissionInstances.leaseToken,
                this.instanceLeaseToken,
              ),
              liveInstance(),
            ),
          )
          .returning({
            instanceId: realtimeAdmissionInstances.instanceId,
            heartbeatAt: realtimeAdmissionInstances.heartbeatAt,
            drainingAt: realtimeAdmissionInstances.drainingAt,
          });
      });
      if (rows.length !== 1) {
        this.markLeaseLost(
          "Realtime admission instance lease expired or no longer exists",
        );
        return;
      }
      this.available = true;
      this.draining = this.drainRequested || Boolean(rows[0]?.drainingAt);
      this.lastHeartbeatAt = rows[0]!.heartbeatAt;
      this.lastError = null;
      await this.flushPendingLeaseMutations();
    } catch (error) {
      this.available = false;
      this.recordError(error, "Realtime admission heartbeat failed");
      return;
    }

    if (!this.available) return;
    try {
      await this.assertRegistrationAuthorityReady();
    } catch (error) {
      this.available = false;
      this.recordError(
        error,
        "Realtime admission budget authority refresh failed",
      );
    }
  }

  private markLeaseLost(message: string): void {
    if (this.leaseLost) return;
    this.available = false;
    this.leaseLost = true;
    this.drainRequested = true;
    this.draining = true;
    this.lastError = message;
    this.logger.error({ instanceId: this.instanceId }, message);
    const failure: RealtimeAdmissionTerminalFailure = {
      code: "instance_lease_lost",
      message,
    };
    for (const listener of this.terminalAuthorityLossListeners) {
      listener(failure);
    }
  }

  private async flushPendingLeaseMutations(): Promise<void> {
    for (const lease of this.pendingRoomReleases.values()) {
      await this.releaseRoom(lease);
      if (!this.available) return;
    }

    for (const mutation of this.pendingControllerMutations.values()) {
      if (mutation.kind === "release") {
        await this.releaseController(mutation.lease);
      } else {
        await this.markControllerDisconnected(
          mutation.lease,
          mutation.resumeLeaseMs,
        );
      }
      if (!this.available) return;
    }

    const staleBefore =
      Date.now() - REALTIME_ADMISSION_POLICY.instanceLeaseTtlMs;
    for (const [key, admission] of this.pendingControllerAdmissions) {
      if (admission.recordedAt > staleBefore) continue;
      await this.releaseController(admission.lease);
      if (!this.available) return;
      this.pendingControllerAdmissions.delete(key);
    }
  }

  private async reconcileRoomAdmission(
    lease: RealtimeRoomLease,
  ): Promise<boolean> {
    try {
      const rows = await this.database
        .select({ roomId: realtimeRoomAdmissionLeases.roomId })
        .from(realtimeRoomAdmissionLeases)
        .where(
          and(
            eq(realtimeRoomAdmissionLeases.roomId, lease.roomId),
            eq(realtimeRoomAdmissionLeases.leaseToken, lease.leaseToken),
            eq(realtimeRoomAdmissionLeases.instanceId, this.instanceId),
          ),
        )
        .limit(1);
      this.available = true;
      return rows.length === 1;
    } catch {
      this.available = false;
      return false;
    }
  }

  private async reconcileControllerAdmission(
    lease: RealtimeControllerLease,
  ): Promise<boolean> {
    try {
      const rows = await this.database
        .select({
          controllerId: realtimeControllerAdmissionLeases.controllerId,
        })
        .from(realtimeControllerAdmissionLeases)
        .where(
          and(
            eq(realtimeControllerAdmissionLeases.roomId, lease.roomId),
            eq(
              realtimeControllerAdmissionLeases.controllerId,
              lease.controllerId,
            ),
            eq(realtimeControllerAdmissionLeases.leaseToken, lease.leaseToken),
            eq(realtimeControllerAdmissionLeases.instanceId, this.instanceId),
          ),
        )
        .limit(1);
      this.available = true;
      return rows.length === 1;
    } catch {
      this.available = false;
      return false;
    }
  }

  private recordError(error: unknown, message: string): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, instanceId: this.instanceId }, message);
  }
}

export const createLocalRealtimeAdmissionService = ({
  instanceId = `local-${crypto.randomUUID()}`,
}: {
  instanceId?: string;
} = {}): RealtimeAdmissionService => {
  type LocalRoomAdmission = {
    lease: RealtimeRoomLease;
    maxControllers: number;
    controllers: Map<string, RealtimeControllerLease>;
  };

  let draining = false;
  const rooms = new Map<string, LocalRoomAdmission>();

  const readRoom = (lease: RealtimeRoomLease): LocalRoomAdmission | null => {
    const room = rooms.get(lease.roomId);
    return room?.lease.leaseToken === lease.leaseToken ? room : null;
  };

  const readController = (
    lease: RealtimeControllerLease,
  ): RealtimeControllerLease | null => {
    const controller = rooms
      .get(lease.roomId)
      ?.controllers.get(lease.controllerId);
    return controller?.leaseToken === lease.leaseToken ? controller : null;
  };

  const deleteController = (lease: RealtimeControllerLease): void => {
    if (!readController(lease)) return;
    rooms.get(lease.roomId)?.controllers.delete(lease.controllerId);
  };

  return {
    start: async () => undefined,
    beginDrain: async () => {
      draining = true;
    },
    stop: async () => {
      draining = true;
      rooms.clear();
    },
    admitRoom: async ({ roomId, maxControllers, replacingLease }) => {
      if (draining) {
        return denial(
          "instance_draining",
          "This server is draining. Please try again.",
        );
      }
      if (rooms.has(roomId)) {
        return denial(
          "room_conflict",
          "That room code is already in use. Please try again.",
          1,
        );
      }
      if (replacingLease && !readRoom(replacingLease)) {
        return denial(
          "authority_unavailable",
          "The previous room reservation could not be replaced safely.",
        );
      }

      const lease = { roomId, leaseToken: createLeaseToken() };
      if (replacingLease) rooms.delete(replacingLease.roomId);
      rooms.set(roomId, {
        lease,
        maxControllers,
        controllers: new Map(),
      });
      return { ok: true, lease };
    },
    releaseRoom: async (lease) => {
      if (readRoom(lease)) rooms.delete(lease.roomId);
    },
    admitController: async ({
      roomLease,
      controllerId,
      existingLease,
      replacingLease,
    }) => {
      if (draining && !existingLease) {
        return denial(
          "instance_draining",
          "This server is draining. Please try again.",
        );
      }

      const room = readRoom(roomLease);
      if (!room) {
        return denial(
          "authority_unavailable",
          "Room capacity authority expired. Please retry from the host.",
        );
      }

      const current = room.controllers.get(controllerId);
      if (
        current &&
        (!existingLease || current.leaseToken !== existingLease.leaseToken)
      ) {
        return denial(
          "controller_conflict",
          "Controller slot is unavailable.",
          null,
        );
      }
      if (existingLease && !readController(existingLease)) {
        return denial(
          "controller_conflict",
          "Controller slot is unavailable.",
          null,
        );
      }
      if (replacingLease && !readController(replacingLease)) {
        return denial(
          "authority_unavailable",
          "The previous controller reservation could not be replaced safely.",
        );
      }

      const lease = {
        roomId: roomLease.roomId,
        controllerId,
        leaseToken: createLeaseToken(),
      };
      if (current && existingLease) {
        room.controllers.set(controllerId, lease);
        if (
          replacingLease &&
          replacingLease.leaseToken !== existingLease.leaseToken
        ) {
          deleteController(replacingLease);
        }
        return { ok: true, lease };
      }

      const replacementUsesTargetRoom =
        replacingLease?.roomId === roomLease.roomId;
      const effectiveControllerCount =
        room.controllers.size - (replacementUsesTargetRoom ? 1 : 0);
      if (effectiveControllerCount >= room.maxControllers) {
        return denial("room_full", "Room full", null);
      }

      if (replacingLease) deleteController(replacingLease);
      room.controllers.set(controllerId, lease);
      return { ok: true, lease };
    },
    markControllerDisconnected: async () => undefined,
    releaseController: async (lease) => {
      deleteController(lease);
    },
    getStatus: () => ({
      contractVersion: REALTIME_ADMISSION_POLICY.contractVersion,
      authority: "local",
      budgetRequirement: "not_applicable",
      instanceId,
      acceptingNewWork: !draining,
      draining,
      terminalAuthorityLost: false,
      pendingReconciliations: 0,
      lastHeartbeatAt: null,
      lastError: null,
      policy: REALTIME_ADMISSION_POLICY,
    }),
    onTerminalAuthorityLoss: () => () => undefined,
  };
};

export const createUnavailableRealtimeAdmissionService = ({
  instanceId = `unavailable-${crypto.randomUUID()}`,
  reason,
  budgetRequirement,
}: {
  instanceId?: string;
  reason: string;
  budgetRequirement: OperationalBudgetRequirement;
}): RealtimeAdmissionService => {
  const unavailable = async () =>
    denial(
      "authority_unavailable",
      "Realtime capacity is temporarily unavailable. Please try again.",
    );
  return {
    start: async () => undefined,
    beginDrain: async () => undefined,
    stop: async () => undefined,
    admitRoom: unavailable,
    releaseRoom: async () => undefined,
    admitController: unavailable,
    markControllerDisconnected: async () => undefined,
    releaseController: async () => undefined,
    getStatus: () => ({
      contractVersion: REALTIME_ADMISSION_POLICY.contractVersion,
      authority: "unavailable",
      budgetRequirement,
      instanceId,
      acceptingNewWork: false,
      draining: false,
      terminalAuthorityLost: false,
      pendingReconciliations: 0,
      lastHeartbeatAt: null,
      lastError: reason,
      policy: REALTIME_ADMISSION_POLICY,
    }),
    onTerminalAuthorityLoss: () => () => undefined,
  };
};
