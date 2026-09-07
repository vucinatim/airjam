import * as schema from "@/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setOperationalLaneControl } from "../operations/production-control-service";
import type { ReleaseStorage } from "../releases/release-storage";
import {
  OperationalJobConflictError,
  OperationalJobLeaseError,
  claimOperationalJob,
  completeOperationalJob,
  enqueueOperationalJob,
  failOperationalJobAttempt,
  getOperationalJob,
  heartbeatOperationalJob,
  previewOperationalJobCancellation,
  recordOperationalJobStage,
  repairExpiredOperationalJobs,
  replayOperationalJob,
  requestOperationalJobCancellation,
} from "./operational-job-service";
import {
  operationalJobExecutors,
  runOperationalJobWorkerCycle,
} from "./operational-job-worker";
import {
  ReleaseJobExecutionError,
  releaseJobExecutionContractVersion,
} from "./release-job-contract";
import { cleanupReleaseJobOrphanOutputs } from "./release-job-output-cleanup";

const databaseUrl = process.env.AIR_JAM_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("operational job PostgreSQL invariants", () => {
  const client = postgres(databaseUrl!, { max: 8 });
  const database = drizzle(client, { schema });
  const suffix = crypto.randomUUID();
  const baseTime = new Date("2042-01-01T00:00:00.000Z");
  const at = (offsetMs: number) => new Date(baseTime.getTime() + offsetMs);
  const wait = (milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  const waitForBlockedPeer = async ({
    blockerPid,
    queryFragment,
  }: {
    blockerPid: number;
    queryFragment: string;
  }) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = await client`
        select pid
        from pg_stat_activity
        where datname = current_database()
          and pid <> ${blockerPid}
          and state = 'active'
          and wait_event_type = 'Lock'
          and query ilike ${`%${queryFragment}%`}
        limit 1
      `;
      if (rows[0]) return;
      await wait(10);
    }
    throw new Error(`Timed out waiting for blocked query: ${queryFragment}.`);
  };

  const creatorA = `job_creator_a_${suffix}`;
  const creatorB = `job_creator_b_${suffix}`;
  const gameA = `job_game_a_${suffix}`;
  const gameB = `job_game_b_${suffix}`;
  const release = (label: string) => `job_release_${label}_${suffix}`;
  const generation = (releaseId: string) => `${releaseId}:generation:1`;

  const releases = {
    idempotency: release("idempotency"),
    active: release("active"),
    fairnessAFirst: release("fairness_a_first"),
    fairnessASecond: release("fairness_a_second"),
    fairnessB: release("fairness_b"),
    lease: release("lease"),
    retry: release("retry"),
    cancelQueued: release("cancel_queued"),
    cancelRunning: release("cancel_running"),
    replay: release("replay"),
    revisions: release("revisions"),
    crossKind: release("cross_kind"),
    deadline: release("deadline"),
    laneNormal: release("lane_normal"),
    laneRestricted: release("lane_restricted"),
    lanePaused: release("lane_paused"),
    repairEmpty: release("repair_empty"),
    operatorSafe: release("operator_safe"),
    provenanceOther: release("provenance_other"),
    canonicalJson: release("canonical_json"),
    lockClaim: release("lock_claim"),
    lockCompletion: release("lock_completion"),
    workerLifecycle: release("worker_lifecycle"),
  } as const;

  const releaseCreator = new Map<string, { creatorId: string; gameId: string }>(
    [
      ...Object.values(releases)
        .filter((releaseId) => releaseId !== releases.fairnessB)
        .map(
          (releaseId) =>
            [releaseId, { creatorId: creatorA, gameId: gameA }] as const,
        ),
      [releases.fairnessB, { creatorId: creatorB, gameId: gameB }] as const,
    ],
  );

  const enqueue = ({
    releaseId,
    idempotencyKey,
    kind = "release_artifact_processing",
    payload,
    priority = 0,
    now = baseTime,
  }: {
    releaseId: string;
    idempotencyKey: string;
    kind?:
      | "release_artifact_processing"
      | "release_browser_validation"
      | "release_image_moderation";
    payload?: Record<string, unknown>;
    priority?: number;
    now?: Date;
  }) => {
    const scope = releaseCreator.get(releaseId);
    if (!scope) throw new Error(`Missing test scope for ${releaseId}.`);
    const generationId = generation(releaseId);
    const canonicalPayload =
      payload ??
      (kind === "release_image_moderation"
        ? {
            contractVersion: 1,
            generationId,
            screenshot: {
              captureId: "test-capture",
              objectKey: `tests/operational-jobs/${suffix}/${generationId}/capture.png`,
              contentType: "image/png",
              sizeBytes: 1,
              width: 1,
              height: 1,
            },
          }
        : { contractVersion: 1, generationId });
    return enqueueOperationalJob({
      database,
      kind,
      creatorId: scope.creatorId,
      gameId: scope.gameId,
      releaseId,
      generationId,
      idempotencyKey: `${suffix}:${idempotencyKey}`,
      payload: canonicalPayload,
      priority,
      actor: "test:operational-jobs",
      reason: "Prove the durable operational job contract.",
      now,
    });
  };

  beforeAll(async () => {
    await database.insert(schema.users).values([
      {
        id: creatorA,
        name: "Operational jobs creator A",
        email: `${creatorA}@example.invalid`,
        emailVerified: true,
        createdAt: baseTime,
        updatedAt: baseTime,
      },
      {
        id: creatorB,
        name: "Operational jobs creator B",
        email: `${creatorB}@example.invalid`,
        emailVerified: true,
        createdAt: baseTime,
        updatedAt: baseTime,
      },
    ]);
    await database.insert(schema.games).values([
      {
        id: gameA,
        userId: creatorA,
        name: "Operational jobs game A",
        config: {},
        createdAt: baseTime,
        updatedAt: baseTime,
      },
      {
        id: gameB,
        userId: creatorB,
        name: "Operational jobs game B",
        config: {},
        createdAt: baseTime,
        updatedAt: baseTime,
      },
    ]);
    await database.insert(schema.gameReleases).values(
      Object.values(releases).map((releaseId) => {
        const scope = releaseCreator.get(releaseId);
        if (!scope) throw new Error(`Missing test scope for ${releaseId}.`);
        return {
          id: releaseId,
          gameId: scope.gameId,
          sourceKind: "upload" as const,
          status: "archived" as const,
          createdAt: baseTime,
        };
      }),
    );
    await database.insert(schema.gameReleaseGenerations).values(
      Object.values(releases).map((releaseId, index) => ({
        id: generation(releaseId),
        releaseId,
        sequence: 1,
        status: "ready" as const,
        originalFilename: `${releaseId}.zip`,
        contentType: "application/zip",
        declaredSizeBytes: 1,
        zipObjectKey: `tests/operational-jobs/${suffix}/${index}/game.zip`,
        siteRootKey: `tests/operational-jobs/${suffix}/${index}/site`,
        observedSizeBytes: 1,
        observedContentType: "application/zip",
        extractedSizeBytes: 0,
        fileCount: 1,
        entryPath: "index.html",
        contentHash: index.toString(16).padStart(64, "0"),
        createdAt: baseTime,
        uploadObservedAt: baseTime,
        processingStartedAt: baseTime,
        readyAt: baseTime,
      })),
    );
    for (const releaseId of Object.values(releases)) {
      await database
        .update(schema.gameReleases)
        .set({
          status: "ready",
          promotedGenerationId: generation(releaseId),
        })
        .where(eq(schema.gameReleases.id, releaseId));
    }
  });

  beforeEach(async () => {
    await database
      .delete(schema.operationalJobs)
      .where(inArray(schema.operationalJobs.creatorId, [creatorA, creatorB]));
    await database
      .delete(schema.operationalJobCommands)
      .where(
        inArray(schema.operationalJobCommands.actor, [
          "test:operational-jobs",
          "creator:cancel",
          "ops:replay",
          "reaper:expired-leases",
          "reaper:empty-proof",
          "ops:lane-proof",
        ]),
      );
    await database
      .delete(schema.operationalLaneControls)
      .where(
        inArray(schema.operationalLaneControls.lane, ["release_processing"]),
      );
  });

  afterAll(async () => {
    await database
      .delete(schema.operationalJobs)
      .where(inArray(schema.operationalJobs.creatorId, [creatorA, creatorB]));
    await database
      .delete(schema.operationalJobCommands)
      .where(
        inArray(schema.operationalJobCommands.actor, [
          "test:operational-jobs",
          "creator:cancel",
          "ops:replay",
          "reaper:expired-leases",
          "reaper:empty-proof",
          "ops:lane-proof",
        ]),
      );
    await database
      .delete(schema.operationalLaneControls)
      .where(
        inArray(schema.operationalLaneControls.lane, ["release_processing"]),
      );
    await database
      .delete(schema.games)
      .where(inArray(schema.games.id, [gameA, gameB]));
    await database
      .delete(schema.users)
      .where(inArray(schema.users.id, [creatorA, creatorB]));
    await client.end();
  });

  it("replays one concurrent canonical request and rejects conflicting reuse", async () => {
    const attempts = await Promise.all([
      enqueue({
        releaseId: releases.idempotency,
        idempotencyKey: "idempotency",
      }),
      enqueue({
        releaseId: releases.idempotency,
        idempotencyKey: "idempotency",
      }),
    ]);

    expect(new Set(attempts.map(({ job }) => job.id)).size).toBe(1);
    expect(attempts.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);

    const stored = await getOperationalJob({
      database,
      jobId: attempts[0].job.id,
    });
    expect(stored.events.map(({ kind }) => kind)).toEqual(["enqueued"]);

    await expect(
      enqueue({
        releaseId: releases.idempotency,
        idempotencyKey: "idempotency",
        priority: 1,
      }),
    ).rejects.toBeInstanceOf(OperationalJobConflictError);
  });

  it("serializes idempotency globally and hashes scheduling plus audit intent", async () => {
    const globalKey = `${suffix}:global-cross-kind`;
    const scope = releaseCreator.get(releases.idempotency)!;
    const attempts = await Promise.allSettled([
      enqueueOperationalJob({
        database,
        kind: "release_artifact_processing",
        ...scope,
        releaseId: releases.idempotency,
        generationId: generation(releases.idempotency),
        payload: {
          contractVersion: 1,
          generationId: generation(releases.idempotency),
        },
        idempotencyKey: globalKey,
        actor: "test:operational-jobs",
        reason: "First global idempotency contender.",
        now: baseTime,
      }),
      enqueueOperationalJob({
        database,
        kind: "release_browser_validation",
        ...scope,
        releaseId: releases.idempotency,
        generationId: generation(releases.idempotency),
        payload: {
          contractVersion: 1,
          generationId: generation(releases.idempotency),
        },
        idempotencyKey: globalKey,
        actor: "test:operational-jobs",
        reason: "Second global idempotency contender.",
        now: baseTime,
      }),
    ]);
    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      OperationalJobConflictError,
    );

    const scheduling = await enqueue({
      releaseId: releases.crossKind,
      idempotencyKey: "semantic-hash",
      priority: 4,
    });
    await expect(
      enqueue({
        releaseId: releases.crossKind,
        idempotencyKey: "semantic-hash",
        priority: 5,
      }),
    ).rejects.toBeInstanceOf(OperationalJobConflictError);
    await expect(
      enqueueOperationalJob({
        database,
        kind: scheduling.job.kind,
        creatorId: scope.creatorId,
        gameId: scope.gameId,
        releaseId: releases.crossKind,
        generationId: generation(releases.crossKind),
        payload: {
          contractVersion: 1,
          generationId: generation(releases.crossKind),
        },
        idempotencyKey: `${suffix}:semantic-hash`,
        priority: 4,
        correlationId: "caller-selected-correlation",
        actor: "different:actor",
        reason: "Changed audit intent must not silently replay.",
        now: baseTime,
      }),
    ).rejects.toBeInstanceOf(OperationalJobConflictError);
  });

  it("rejects non-JSON payloads before hashing or persistence", async () => {
    const scope = releaseCreator.get(releases.canonicalJson)!;
    const idempotencyKey = `${suffix}:canonical-json`;
    await expect(
      enqueueOperationalJob({
        database,
        kind: "release_artifact_processing",
        ...scope,
        releaseId: releases.canonicalJson,
        generationId: generation(releases.canonicalJson),
        idempotencyKey,
        payload: {
          contractVersion: 1,
          generationId: generation(releases.canonicalJson),
          observedAt: new Date("2042-01-01T00:00:00.000Z"),
        },
        actor: "test:operational-jobs",
        reason: "Reject values whose persisted JSON differs from their hash.",
        now: baseTime,
      }),
    ).rejects.toBeInstanceOf(OperationalJobConflictError);

    const accepted = await enqueueOperationalJob({
      database,
      kind: "release_artifact_processing",
      ...scope,
      releaseId: releases.canonicalJson,
      generationId: generation(releases.canonicalJson),
      idempotencyKey,
      payload: {
        contractVersion: 1,
        generationId: generation(releases.canonicalJson),
      },
      actor: "test:operational-jobs",
      reason: "Reject values whose persisted JSON differs from their hash.",
      now: baseTime,
    });
    expect(accepted.replayed).toBe(false);
  });

  it("allows only one active job for one kind and release under concurrent enqueue", async () => {
    const attempts = await Promise.allSettled([
      enqueue({
        releaseId: releases.active,
        idempotencyKey: "active-one",
        kind: "release_browser_validation",
      }),
      enqueue({
        releaseId: releases.active,
        idempotencyKey: "active-two",
        kind: "release_browser_validation",
      }),
    ]);

    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      OperationalJobConflictError,
    );

    const stored = await database.query.operationalJobs.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(table.kind, "release_browser_validation"),
          eq(table.releaseId, releases.active),
        ),
    });
    expect(stored).toHaveLength(1);
  });

  it("claims by priority while preserving per-creator fairness and global concurrency", async () => {
    const firstA = await enqueue({
      releaseId: releases.fairnessAFirst,
      idempotencyKey: "fairness-a-first",
      kind: "release_browser_validation",
      priority: 10,
      now: at(0),
    });
    const secondA = await enqueue({
      releaseId: releases.fairnessASecond,
      idempotencyKey: "fairness-a-second",
      kind: "release_browser_validation",
      priority: 9,
      now: at(1),
    });
    const firstB = await enqueue({
      releaseId: releases.fairnessB,
      idempotencyKey: "fairness-b",
      kind: "release_browser_validation",
      priority: 8,
      now: at(2),
    });

    const firstClaim = await claimOperationalJob({
      database,
      kind: "release_browser_validation",
      workerId: "worker:fairness-one",
      now: at(10),
    });
    const secondClaim = await claimOperationalJob({
      database,
      kind: "release_browser_validation",
      workerId: "worker:fairness-two",
      now: at(10),
    });
    const capacityClaim = await claimOperationalJob({
      database,
      kind: "release_browser_validation",
      workerId: "worker:fairness-three",
      now: at(10),
    });

    expect(firstClaim?.id).toBe(firstA.job.id);
    expect(secondClaim?.id).toBe(firstB.job.id);
    expect(secondClaim?.creatorId).toBe(creatorB);
    expect(capacityClaim).toBeNull();

    await Promise.all([
      completeOperationalJob({
        database,
        jobId: firstClaim!.id,
        leaseToken: firstClaim!.leaseToken!,
        result: { ok: true },
        workerId: "worker:fairness-one",
        reason: "Release the first fairness lease.",
        now: at(11),
      }),
      completeOperationalJob({
        database,
        jobId: secondClaim!.id,
        leaseToken: secondClaim!.leaseToken!,
        result: { ok: true },
        workerId: "worker:fairness-two",
        reason: "Release the second fairness lease.",
        now: at(11),
      }),
      requestOperationalJobCancellation({
        database,
        jobId: secondA.job.id,
        expectedRevision: secondA.job.revision,
        idempotencyKey: `${suffix}:cancel-fairness-candidate`,
        actor: "test:operational-jobs",
        reason: "Clean up the unclaimed fairness candidate.",
        now: at(11),
      }),
    ]);
  });

  it("enforces the creator concurrency ceiling across different job kinds", async () => {
    const artifactOne = await enqueue({
      releaseId: releases.fairnessAFirst,
      idempotencyKey: "creator-global-artifact-one",
    });
    const artifactTwo = await enqueue({
      releaseId: releases.fairnessASecond,
      idempotencyKey: "creator-global-artifact-two",
    });
    const creatorABrowser = await enqueue({
      releaseId: releases.lease,
      idempotencyKey: "creator-global-browser-a",
      kind: "release_browser_validation",
      priority: 10,
    });
    const creatorBBrowser = await enqueue({
      releaseId: releases.fairnessB,
      idempotencyKey: "creator-global-browser-b",
      kind: "release_browser_validation",
      priority: 1,
    });

    const claimedArtifacts = await Promise.all([
      claimOperationalJob({
        database,
        kind: "release_artifact_processing",
        workerId: "worker:creator-global-one",
        now: at(1_000),
      }),
      claimOperationalJob({
        database,
        kind: "release_artifact_processing",
        workerId: "worker:creator-global-two",
        now: at(1_000),
      }),
    ]);
    expect(new Set(claimedArtifacts.map((job) => job?.id))).toEqual(
      new Set([artifactOne.job.id, artifactTwo.job.id]),
    );

    const browserClaim = await claimOperationalJob({
      database,
      kind: "release_browser_validation",
      workerId: "worker:creator-global-browser",
      now: at(2_000),
    });
    expect(browserClaim?.id).toBe(creatorBBrowser.job.id);
    expect(browserClaim?.creatorId).toBe(creatorB);

    await Promise.all([
      ...claimedArtifacts.map((job, index) =>
        completeOperationalJob({
          database,
          jobId: job!.id,
          leaseToken: job!.leaseToken!,
          result: { index },
          workerId: job!.leaseOwner!,
          reason: "Release creator-wide capacity for the proof.",
          now: at(3_000),
        }),
      ),
      completeOperationalJob({
        database,
        jobId: browserClaim!.id,
        leaseToken: browserClaim!.leaseToken!,
        result: { creator: "b" },
        workerId: "worker:creator-global-browser",
        reason: "Release browser capacity for the proof.",
        now: at(3_000),
      }),
      requestOperationalJobCancellation({
        database,
        jobId: creatorABrowser.job.id,
        expectedRevision: creatorABrowser.job.revision,
        idempotencyKey: `${suffix}:cancel-creator-global-browser-a`,
        actor: "test:operational-jobs",
        reason: "Clean up the deferred creator A browser job.",
        now: at(3_000),
      }),
    ]);
  });

  it("heartbeats a fresh lease and fences wrong or expired lease holders", async () => {
    const enqueued = await enqueue({
      releaseId: releases.lease,
      idempotencyKey: "lease",
    });
    const claimed = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:lease",
      now: at(1_000),
    });
    expect(claimed?.id).toBe(enqueued.job.id);

    const heartbeat = await heartbeatOperationalJob({
      database,
      jobId: claimed!.id,
      leaseToken: claimed!.leaseToken!,
      workerId: "worker:lease",
      now: at(60_000),
    });
    expect(heartbeat.leaseExpiresAt).toEqual(at(360_000));

    await expect(
      recordOperationalJobStage({
        database,
        jobId: claimed!.id,
        leaseToken: "wrong-lease-token",
        progress: { stage: "artifact_validation" },
        workerId: "worker:stale",
        reason: "A stale worker must be fenced.",
        now: at(61_000),
      }),
    ).rejects.toBeInstanceOf(OperationalJobLeaseError);

    await expect(
      recordOperationalJobStage({
        database,
        jobId: claimed!.id,
        leaseToken: claimed!.leaseToken!,
        progress: { stage: "artifact_validation" },
        workerId: "worker:wrong-identity",
        reason: "A token holder cannot forge another worker identity.",
        now: at(61_000),
      }),
    ).rejects.toBeInstanceOf(OperationalJobLeaseError);

    await expect(
      heartbeatOperationalJob({
        database,
        jobId: claimed!.id,
        leaseToken: claimed!.leaseToken!,
        workerId: "worker:lease",
        now: heartbeat.leaseExpiresAt!,
      }),
    ).rejects.toBeInstanceOf(OperationalJobLeaseError);

    const staged = await recordOperationalJobStage({
      database,
      jobId: claimed!.id,
      leaseToken: claimed!.leaseToken!,
      progress: { stage: "artifact_validation", completedFiles: 2 },
      workerId: "worker:lease",
      reason: "Persist authoritative progress.",
      now: at(100_000),
    });
    expect(staged.progress).toEqual({
      stage: "artifact_validation",
      completedFiles: 2,
    });

    const completed = await completeOperationalJob({
      database,
      jobId: claimed!.id,
      leaseToken: claimed!.leaseToken!,
      result: { artifactId: "artifact_1" },
      workerId: "worker:lease",
      reason: "Complete under the current lease fence.",
      now: at(101_000),
    });
    expect(completed.status).toBe("succeeded");
    expect(completed.leaseToken).toBeNull();
  });

  it("caps leases at the absolute deadline and rejects every late worker mutation", async () => {
    const enqueued = await enqueue({
      releaseId: releases.deadline,
      idempotencyKey: "absolute-deadline",
    });
    const deadline = at(3_600_000);
    const claimed = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:deadline",
      now: at(3_500_000),
    });
    expect(claimed?.id).toBe(enqueued.job.id);
    expect(claimed?.leaseExpiresAt).toEqual(deadline);

    const heartbeat = await heartbeatOperationalJob({
      database,
      jobId: claimed!.id,
      leaseToken: claimed!.leaseToken!,
      workerId: "worker:deadline",
      now: at(3_550_000),
    });
    expect(heartbeat.leaseExpiresAt).toEqual(deadline);

    const lateMutations = await Promise.allSettled([
      heartbeatOperationalJob({
        database,
        jobId: claimed!.id,
        leaseToken: claimed!.leaseToken!,
        workerId: "worker:deadline",
        now: deadline,
      }),
      recordOperationalJobStage({
        database,
        jobId: claimed!.id,
        leaseToken: claimed!.leaseToken!,
        progress: { late: true },
        workerId: "worker:deadline",
        reason: "Late progress must be rejected.",
        now: deadline,
      }),
      completeOperationalJob({
        database,
        jobId: claimed!.id,
        leaseToken: claimed!.leaseToken!,
        result: { late: true },
        workerId: "worker:deadline",
        reason: "Late success must be rejected.",
        now: deadline,
      }),
      failOperationalJobAttempt({
        database,
        jobId: claimed!.id,
        leaseToken: claimed!.leaseToken!,
        error: { code: "late_failure" },
        retryable: true,
        workerId: "worker:deadline",
        reason: "Late failure must be owned by repair.",
        now: deadline,
      }),
    ]);
    expect(lateMutations).toHaveLength(4);
    for (const result of lateMutations) {
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
        OperationalJobLeaseError,
      );
    }

    const repair = await repairExpiredOperationalJobs({
      database,
      kind: "release_artifact_processing",
      actor: "reaper:expired-leases",
      reason: "Finalize work that reached its absolute deadline.",
      idempotencyKey: `${suffix}:repair-absolute-deadline`,
      now: deadline,
    });
    expect(repair.jobs).toMatchObject([
      {
        id: claimed!.id,
        status: "failed",
        lastErrorCode: "deadline_expired",
      },
    ]);
  });

  it("samples database time after advisory and row locks", async () => {
    const scope = releaseCreator.get(releases.lockClaim)!;
    const queued = await enqueueOperationalJob({
      database,
      kind: "release_artifact_processing",
      ...scope,
      releaseId: releases.lockClaim,
      generationId: generation(releases.lockClaim),
      payload: {
        contractVersion: 1,
        generationId: generation(releases.lockClaim),
      },
      idempotencyKey: `${suffix}:lock-claim`,
      actor: "test:operational-jobs",
      reason: "Prove claim time is sampled inside the lock fence.",
    });

    let blockedClaim: ReturnType<typeof claimOperationalJob> | undefined;
    await client.begin(async (blocker) => {
      const [backend] = await blocker`
        select pg_backend_pid()::integer as pid
      `;
      await blocker`
        select pg_advisory_xact_lock(
          hashtext('airjam:operational-jobs:claim')
        )
      `;
      await blocker`
        update operational_jobs
        set deadline_at = clock_timestamp() + interval '400 milliseconds'
        where id = ${queued.job.id}
      `;
      blockedClaim = claimOperationalJob({
        database,
        kind: "release_artifact_processing",
        workerId: "worker:lock-claim",
      });
      await waitForBlockedPeer({
        blockerPid: Number(backend!.pid),
        queryFragment: "pg_advisory_xact_lock",
      });
      await wait(500);
    });
    expect(await blockedClaim).toBeNull();

    const completionScope = releaseCreator.get(releases.lockCompletion)!;
    const completionJob = await enqueueOperationalJob({
      database,
      kind: "release_artifact_processing",
      ...completionScope,
      releaseId: releases.lockCompletion,
      generationId: generation(releases.lockCompletion),
      payload: {
        contractVersion: 1,
        generationId: generation(releases.lockCompletion),
      },
      idempotencyKey: `${suffix}:lock-completion`,
      actor: "test:operational-jobs",
      reason: "Prove completion time is sampled inside the row fence.",
    });
    const claimed = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:lock-completion",
    });
    expect(claimed?.id).toBe(completionJob.job.id);

    let blockedCompletion:
      | ReturnType<typeof completeOperationalJob>
      | undefined;
    await client.begin(async (blocker) => {
      const [backend] = await blocker`
        select pg_backend_pid()::integer as pid
      `;
      await blocker`
        update operational_jobs
        set lease_expires_at = clock_timestamp() + interval '400 milliseconds'
        where id = ${claimed!.id}
      `;
      blockedCompletion = completeOperationalJob({
        database,
        jobId: claimed!.id,
        leaseToken: claimed!.leaseToken!,
        result: { artifactId: "must-not-commit-after-lock-wait" },
        workerId: "worker:lock-completion",
        reason: "A stale pre-lock timestamp must not permit completion.",
      });
      await waitForBlockedPeer({
        blockerPid: Number(backend!.pid),
        queryFragment: "operational_jobs",
      });
      await wait(500);
    });
    await expect(blockedCompletion).rejects.toBeInstanceOf(
      OperationalJobLeaseError,
    );
  });

  it("claims in normal and restricted modes but stops atomically when paused", async () => {
    await setOperationalLaneControl({
      database,
      input: {
        lane: "release_processing",
        mode: "normal",
        reason: "Start the durable-job lane proof.",
        retryAfterSeconds: null,
        expectedRevision: 0,
        actor: "ops:lane-proof",
        idempotencyKey: `${suffix}:lane-normal`,
      },
      now: at(1),
    });
    const normal = await enqueue({
      releaseId: releases.laneNormal,
      idempotencyKey: "lane-normal-job",
    });
    const normalClaim = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:lane-normal",
      now: at(10),
    });
    expect(normalClaim?.id).toBe(normal.job.id);
    await completeOperationalJob({
      database,
      jobId: normalClaim!.id,
      leaseToken: normalClaim!.leaseToken!,
      result: { mode: "normal" },
      workerId: "worker:lane-normal",
      reason: "Release normal-mode capacity.",
      now: at(11),
    });

    await setOperationalLaneControl({
      database,
      input: {
        lane: "release_processing",
        mode: "restricted",
        reason: "Drain already admitted durable jobs.",
        retryAfterSeconds: null,
        expectedRevision: 1,
        actor: "ops:lane-proof",
        idempotencyKey: `${suffix}:lane-restricted`,
      },
      now: at(12),
    });
    const restricted = await enqueue({
      releaseId: releases.laneRestricted,
      idempotencyKey: "lane-restricted-job",
    });
    const restrictedClaim = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:lane-restricted",
      now: at(20),
    });
    expect(restrictedClaim?.id).toBe(restricted.job.id);
    await completeOperationalJob({
      database,
      jobId: restrictedClaim!.id,
      leaseToken: restrictedClaim!.leaseToken!,
      result: { mode: "restricted" },
      workerId: "worker:lane-restricted",
      reason: "Release restricted-mode capacity.",
      now: at(21),
    });

    const paused = await enqueue({
      releaseId: releases.lanePaused,
      idempotencyKey: "lane-paused-job",
    });
    await setOperationalLaneControl({
      database,
      input: {
        lane: "release_processing",
        mode: "paused",
        reason: "Prove queued work cannot start while paused.",
        retryAfterSeconds: 60,
        expectedRevision: 2,
        actor: "ops:lane-proof",
        idempotencyKey: `${suffix}:lane-paused`,
      },
      now: at(22),
    });
    await expect(
      claimOperationalJob({
        database,
        kind: "release_artifact_processing",
        workerId: "worker:lane-paused",
        now: at(30),
      }),
    ).resolves.toBeNull();
    await requestOperationalJobCancellation({
      database,
      jobId: paused.job.id,
      expectedRevision: paused.job.revision,
      idempotencyKey: `${suffix}:cancel-lane-paused`,
      actor: "ops:lane-proof",
      reason: "Clean up the paused-lane proof job.",
      now: at(31),
    });
  });

  it("repairs an expired lease into a bounded retry and permanently fences the old worker", async () => {
    const enqueued = await enqueue({
      releaseId: releases.lease,
      idempotencyKey: "expired-lease",
    });
    const claimed = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:expired-lease",
      now: at(1_000),
    });
    expect(claimed?.id).toBe(enqueued.job.id);
    expect(claimed?.leaseExpiresAt).toEqual(at(301_000));

    const repaired = await repairExpiredOperationalJobs({
      database,
      kind: "release_artifact_processing",
      actor: "reaper:expired-leases",
      reason: "Recover expired leases in the PostgreSQL proof.",
      idempotencyKey: `${suffix}:repair-expired-leases`,
      now: at(301_000),
    });
    expect(repaired).toMatchObject({ replayed: false });
    expect(repaired.jobs).toHaveLength(1);
    expect(repaired.jobs[0]).toMatchObject({
      id: claimed!.id,
      status: "queued",
      attemptCount: 1,
      leaseOwner: null,
      lastErrorCode: "lease_expired",
    });
    expect(repaired.jobs[0].availableAt).toBe(at(361_000).toISOString());
    await expect(
      repairExpiredOperationalJobs({
        database,
        kind: "release_artifact_processing",
        actor: "reaper:expired-leases",
        reason: "Recover expired leases in the PostgreSQL proof.",
        idempotencyKey: `${suffix}:repair-expired-leases`,
        now: at(302_000),
      }),
    ).resolves.toMatchObject({
      replayed: true,
      jobs: [{ id: claimed!.id, status: "queued" }],
    });

    await expect(
      heartbeatOperationalJob({
        database,
        jobId: claimed!.id,
        leaseToken: claimed!.leaseToken!,
        workerId: "worker:expired-lease",
        now: at(301_001),
      }),
    ).rejects.toBeInstanceOf(OperationalJobLeaseError);

    const earlyClaim = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:replacement-early",
      now: at(360_999),
    });
    expect(earlyClaim).toBeNull();

    const replacement = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:replacement",
      now: at(361_000),
    });
    expect(replacement).toMatchObject({
      id: claimed!.id,
      status: "running",
      attemptCount: 2,
      leaseOwner: "worker:replacement",
    });
    expect(replacement!.leaseToken).not.toBe(claimed!.leaseToken);

    const inspection = await getOperationalJob({
      database,
      jobId: claimed!.id,
    });
    expect(inspection.events.map(({ kind }) => kind)).toEqual([
      "enqueued",
      "claimed",
      "lease_recovered",
      "claimed",
    ]);
    expect(inspection.events.map(({ nextRevision }) => nextRevision)).toEqual([
      1, 2, 3, 4,
    ]);

    await completeOperationalJob({
      database,
      jobId: replacement!.id,
      leaseToken: replacement!.leaseToken!,
      result: { recovered: true },
      workerId: "worker:replacement",
      reason: "Complete the recovered job under the replacement lease.",
      now: at(362_000),
    });
  });

  it("replays an empty repair result without touching jobs that expire later", async () => {
    const idempotencyKey = `${suffix}:repair-empty-stable`;
    const empty = await repairExpiredOperationalJobs({
      database,
      kind: "release_artifact_processing",
      actor: "reaper:empty-proof",
      reason: "Prove an empty repair is still an immutable command result.",
      idempotencyKey,
      now: at(100),
    });
    expect(empty).toEqual({ jobs: [], replayed: false });

    const enqueued = await enqueue({
      releaseId: releases.repairEmpty,
      idempotencyKey: "repair-empty-job",
    });
    const claimed = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:repair-empty",
      now: at(1_000),
    });
    expect(claimed?.id).toBe(enqueued.job.id);

    const replay = await repairExpiredOperationalJobs({
      database,
      kind: "release_artifact_processing",
      actor: "reaper:empty-proof",
      reason: "Prove an empty repair is still an immutable command result.",
      idempotencyKey,
      now: at(301_000),
    });
    expect(replay).toEqual({ jobs: [], replayed: true });
    const stillRunning = await database.query.operationalJobs.findFirst({
      where: (table, { eq }) => eq(table.id, claimed!.id),
    });
    expect(stillRunning?.status).toBe("running");

    const repaired = await repairExpiredOperationalJobs({
      database,
      kind: "release_artifact_processing",
      actor: "reaper:empty-proof",
      reason: "A new command may repair the newly expired lease.",
      idempotencyKey: `${suffix}:repair-empty-new-command`,
      now: at(301_000),
    });
    expect(repaired.jobs).toMatchObject([
      { id: claimed!.id, status: "queued", lastErrorCode: "lease_expired" },
    ]);
  });

  it("schedules bounded retry and rejects work before its availability time", async () => {
    const enqueued = await enqueue({
      releaseId: releases.retry,
      idempotencyKey: "retry",
    });
    const firstClaim = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:retry-one",
      now: at(1_000),
    });
    expect(firstClaim?.id).toBe(enqueued.job.id);

    const retry = await failOperationalJobAttempt({
      database,
      jobId: firstClaim!.id,
      leaseToken: firstClaim!.leaseToken!,
      error: { code: "storage_unavailable" },
      retryable: true,
      workerId: "worker:retry-one",
      reason: "Retry transient object storage failure.",
      now: at(2_000),
    });
    expect(retry).toMatchObject({
      status: "queued",
      attemptCount: 1,
      lastError: { code: "storage_unavailable" },
      leaseToken: null,
    });
    expect(retry.availableAt).toEqual(at(62_000));

    const earlyClaim = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:retry-early",
      now: at(61_999),
    });
    expect(earlyClaim).toBeNull();

    const secondClaim = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:retry-two",
      now: at(62_000),
    });
    expect(secondClaim).toMatchObject({
      id: enqueued.job.id,
      status: "running",
      attemptCount: 2,
    });
    expect(secondClaim!.leaseToken).not.toBe(firstClaim!.leaseToken);

    const failed = await failOperationalJobAttempt({
      database,
      jobId: secondClaim!.id,
      leaseToken: secondClaim!.leaseToken!,
      error: { code: "invalid_archive" },
      retryable: false,
      workerId: "worker:retry-two",
      reason: "Invalid archives are terminal.",
      now: at(63_000),
    });
    expect(failed).toMatchObject({
      status: "failed",
      attemptCount: 2,
      lastError: { code: "invalid_archive" },
    });
    expect(failed.finishedAt).toEqual(at(63_000));
  });

  it("cancels queued work immediately and running work cooperatively", async () => {
    const queued = await enqueue({
      releaseId: releases.cancelQueued,
      idempotencyKey: "cancel-queued",
    });
    const queuedCancellationInput = {
      database,
      jobId: queued.job.id,
      expectedRevision: queued.job.revision,
      idempotencyKey: `${suffix}:cancel-queued-request`,
      actor: "creator:cancel",
      reason: "The queued release is no longer needed.",
    } as const;
    await expect(
      previewOperationalJobCancellation(queuedCancellationInput),
    ).resolves.toMatchObject({
      eligible: true,
      wouldReplay: false,
      nextStatus: "canceled",
      rejectionReason: null,
    });
    const canceledQueued = await requestOperationalJobCancellation({
      ...queuedCancellationInput,
      now: at(1_000),
    });
    expect(canceledQueued).toMatchObject({
      replayed: false,
      job: {
        status: "canceled",
        cancelRequestedBy: "creator:cancel",
        cancelReason: "The queued release is no longer needed.",
      },
    });
    await expect(
      previewOperationalJobCancellation(queuedCancellationInput),
    ).resolves.toMatchObject({
      eligible: true,
      wouldReplay: true,
      nextStatus: "canceled",
      rejectionReason: null,
    });
    await expect(
      previewOperationalJobCancellation({
        ...queuedCancellationInput,
        expectedRevision: canceledQueued.job.revision,
        idempotencyKey: `${suffix}:different-terminal-cancel`,
      }),
    ).resolves.toMatchObject({
      eligible: false,
      wouldReplay: false,
      nextStatus: null,
      rejectionReason:
        "Terminal canceled job cannot accept a new cancellation request.",
    });
    await expect(
      requestOperationalJobCancellation({
        database,
        jobId: queued.job.id,
        expectedRevision: queued.job.revision,
        idempotencyKey: `${suffix}:cancel-queued-request`,
        actor: "creator:cancel",
        reason: "The queued release is no longer needed.",
        now: at(2_000),
      }),
    ).resolves.toMatchObject({
      replayed: true,
      job: { id: queued.job.id, status: "canceled" },
    });

    const running = await enqueue({
      releaseId: releases.cancelRunning,
      idempotencyKey: "cancel-running",
    });
    const claimed = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:cancel",
      now: at(2_000),
    });
    expect(claimed?.id).toBe(running.job.id);

    const cancellation = await requestOperationalJobCancellation({
      database,
      jobId: claimed!.id,
      expectedRevision: claimed!.revision,
      idempotencyKey: `${suffix}:cancel-running-request`,
      actor: "creator:cancel",
      reason: "Stop the running release safely.",
      now: at(3_000),
    });
    expect(cancellation.job.status).toBe("cancel_requested");
    expect(cancellation.job).not.toHaveProperty("leaseToken");

    await expect(
      completeOperationalJob({
        database,
        jobId: claimed!.id,
        leaseToken: claimed!.leaseToken!,
        result: { shouldNotCommit: true },
        workerId: "worker:cancel",
        reason: "Canceled work cannot succeed.",
        now: at(4_000),
      }),
    ).rejects.toBeInstanceOf(OperationalJobLeaseError);

    const canceledRunning = await failOperationalJobAttempt({
      database,
      jobId: claimed!.id,
      leaseToken: claimed!.leaseToken!,
      error: { code: "cancel_acknowledged" },
      retryable: true,
      workerId: "worker:cancel",
      reason: "Acknowledge cooperative cancellation.",
      now: at(4_000),
    });
    expect(canceledRunning).toMatchObject({
      status: "canceled",
      lastError: { code: "cancel_acknowledged" },
      leaseToken: null,
    });
  });

  it("replays only terminal work with explicit lineage and stable correlation", async () => {
    await database.transaction(async (tx) => {
      await tx
        .update(schema.gameReleases)
        .set({
          status: "uploading",
          candidateGenerationId: generation(releases.replay),
          promotedGenerationId: null,
        })
        .where(eq(schema.gameReleases.id, releases.replay));
      await tx
        .update(schema.gameReleaseGenerations)
        .set({
          status: "awaiting_upload",
          siteRootKey: null,
          observedSizeBytes: null,
          observedContentType: null,
          observedEtag: null,
          observedLastModifiedAt: null,
          extractedSizeBytes: null,
          fileCount: null,
          entryPath: null,
          contentHash: null,
          uploadObservedAt: null,
          processingStartedAt: null,
          readyAt: null,
        })
        .where(
          eq(schema.gameReleaseGenerations.id, generation(releases.replay)),
        );
    });
    const original = await enqueue({
      releaseId: releases.replay,
      idempotencyKey: "replay-original",
      priority: 4,
    });

    await expect(
      replayOperationalJob({
        database,
        jobId: original.job.id,
        idempotencyKey: `${suffix}:replay-active`,
        actor: "ops:replay",
        reason: "Active work cannot be replayed.",
        now: at(1_000),
      }),
    ).rejects.toBeInstanceOf(OperationalJobConflictError);

    const claimed = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:replay",
      now: at(2_000),
    });
    await failOperationalJobAttempt({
      database,
      jobId: claimed!.id,
      leaseToken: claimed!.leaseToken!,
      error: { code: "storage_unavailable", retryable: false },
      retryable: false,
      workerId: "worker:replay",
      reason: "Make the original terminal before replay.",
      now: at(3_000),
    });

    const replayKey = `${suffix}:replay-terminal`;
    const replay = await replayOperationalJob({
      database,
      jobId: original.job.id,
      idempotencyKey: replayKey,
      actor: "ops:replay",
      reason: "Replay terminal work with explicit lineage.",
      now: at(4_000),
    });
    const idempotentReplay = await replayOperationalJob({
      database,
      jobId: original.job.id,
      idempotencyKey: replayKey,
      actor: "ops:replay",
      reason: "Replay terminal work with explicit lineage.",
      now: at(4_000),
    });

    expect(replay.replayed).toBe(false);
    expect(idempotentReplay).toMatchObject({
      replayed: true,
      job: { id: replay.job.id },
    });
    expect(replay.job).toMatchObject({
      status: "queued",
      replayOfJobId: original.job.id,
      correlationId: original.job.correlationId,
      priority: original.job.priority,
    });

    const storedReplay = await database.query.operationalJobs.findFirst({
      where: (table, { eq }) => eq(table.id, replay.job.id),
    });
    expect(storedReplay?.payload).toEqual({
      contractVersion: 1,
      generationId: generation(releases.replay),
    });
    await expect(
      database.query.gameReleases.findFirst({
        where: (table, { eq }) => eq(table.id, releases.replay),
      }),
    ).resolves.toMatchObject({
      status: "uploading",
      candidateGenerationId: generation(releases.replay),
    });

    const inspection = await getOperationalJob({
      database,
      jobId: replay.job.id,
    });
    expect(inspection.events).toHaveLength(1);
    expect(inspection.events[0]).toMatchObject({
      kind: "replayed",
      expectedRevision: 0,
      nextRevision: 1,
      detailKeys: ["replayOfJobId"],
    });
  });

  it("keeps worker secrets and raw JSON outside operator query projections", async () => {
    const enqueued = await enqueue({
      releaseId: releases.operatorSafe,
      idempotencyKey: "operator-safe",
    });
    const claimed = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:operator-safe",
      now: at(1_000),
    });
    await recordOperationalJobStage({
      database,
      jobId: claimed!.id,
      leaseToken: claimed!.leaseToken!,
      progress: { token: "progress-secret" },
      workerId: "worker:operator-safe",
      reason: "Persist sensitive worker detail for redaction proof.",
      now: at(2_000),
    });

    const inspection = await getOperationalJob({
      database,
      jobId: enqueued.job.id,
    });
    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain(claimed!.leaseToken!);
    expect(serialized).not.toContain("Bearer enqueue-secret");
    expect(serialized).not.toContain("progress-secret");
    expect(serialized).not.toContain('"leaseToken"');
    expect(serialized).not.toContain('"requestHash"');
    expect(serialized).not.toContain('"payload"');
    expect(serialized).not.toContain('"details"');
    expect(inspection.job.privateData).toMatchObject({
      hasPayload: true,
      hasProgress: true,
    });

    await failOperationalJobAttempt({
      database,
      jobId: claimed!.id,
      leaseToken: claimed!.leaseToken!,
      error: {
        code: "Bearer provider-error-secret",
        message: "provider-detail-secret",
      },
      retryable: false,
      workerId: "worker:operator-safe",
      reason: "Prove malformed provider error codes remain private.",
      now: at(3_000),
    });
    const failedInspection = await getOperationalJob({
      database,
      jobId: enqueued.job.id,
    });
    expect(failedInspection.job.lastErrorCode).toBeNull();
    expect(JSON.stringify(failedInspection)).not.toContain(
      "provider-error-secret",
    );
    expect(JSON.stringify(failedInspection)).not.toContain(
      "provider-detail-secret",
    );
  });

  it("enforces release-scoped check provenance and cascades it with the job", async () => {
    const enqueued = await enqueue({
      releaseId: releases.operatorSafe,
      idempotencyKey: "provenance",
    });
    const claimed = await claimOperationalJob({
      database,
      kind: "release_artifact_processing",
      workerId: "worker:provenance",
      now: at(1_000),
    });
    expect(claimed?.id).toBe(enqueued.job.id);

    await expect(
      database.insert(schema.gameReleaseChecks).values({
        id: `${suffix}:mismatched-check`,
        releaseId: releases.provenanceOther,
        generationId: generation(releases.provenanceOther),
        jobId: claimed!.id,
        jobAttempt: claimed!.attemptCount,
        kind: "artifact_validation",
        status: "passed",
        payload: {},
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    const checkId = `${suffix}:scoped-check`;
    await database.insert(schema.gameReleaseChecks).values({
      id: checkId,
      releaseId: releases.operatorSafe,
      generationId: generation(releases.operatorSafe),
      jobId: claimed!.id,
      jobAttempt: claimed!.attemptCount,
      kind: "artifact_validation",
      status: "passed",
      payload: {},
    });
    await database
      .delete(schema.operationalJobs)
      .where(inArray(schema.operationalJobs.id, [claimed!.id]));
    const deletedCheck = await database.query.gameReleaseChecks.findFirst({
      where: (table, { eq }) => eq(table.id, checkId),
    });
    expect(deletedCheck).toBeUndefined();
  });

  it("rejects cross-release replay lineage and self-causing events", async () => {
    const original = await enqueue({
      releaseId: releases.operatorSafe,
      idempotencyKey: "lineage-original",
    });
    const otherRelease = await enqueue({
      releaseId: releases.provenanceOther,
      idempotencyKey: "lineage-other-release",
    });

    await expect(
      database
        .update(schema.operationalJobs)
        .set({ replayOfJobId: original.job.id })
        .where(eq(schema.operationalJobs.id, otherRelease.job.id)),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    const event = await database.query.operationalJobEvents.findFirst({
      where: (table, { eq }) => eq(table.jobId, original.job.id),
    });
    expect(event).toBeDefined();
    await expect(
      database
        .update(schema.operationalJobEvents)
        .set({ causationEventId: event!.id })
        .where(eq(schema.operationalJobEvents.id, event!.id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("keeps append-only event revisions contiguous across retry and completion", async () => {
    const enqueued = await enqueue({
      releaseId: releases.revisions,
      idempotencyKey: "revisions",
      kind: "release_browser_validation",
    });
    const firstClaim = await claimOperationalJob({
      database,
      kind: "release_browser_validation",
      workerId: "worker:revisions-one",
      now: at(1_000),
    });
    await recordOperationalJobStage({
      database,
      jobId: firstClaim!.id,
      leaseToken: firstClaim!.leaseToken!,
      progress: { stage: "browser_validation", percent: 25 },
      workerId: "worker:revisions-one",
      reason: "Record the first attempt stage.",
      now: at(2_000),
    });
    const retried = await failOperationalJobAttempt({
      database,
      jobId: firstClaim!.id,
      leaseToken: firstClaim!.leaseToken!,
      error: { code: "browser_disconnected" },
      retryable: true,
      workerId: "worker:revisions-one",
      reason: "Retry the disconnected browser.",
      now: at(3_000),
    });
    const secondClaim = await claimOperationalJob({
      database,
      kind: "release_browser_validation",
      workerId: "worker:revisions-two",
      now: retried.availableAt,
    });
    await recordOperationalJobStage({
      database,
      jobId: secondClaim!.id,
      leaseToken: secondClaim!.leaseToken!,
      progress: { stage: "browser_validation", percent: 100 },
      workerId: "worker:revisions-two",
      reason: "Record the successful retry stage.",
      now: new Date(retried.availableAt.getTime() + 1_000),
    });
    const completed = await completeOperationalJob({
      database,
      jobId: secondClaim!.id,
      leaseToken: secondClaim!.leaseToken!,
      result: { screenshotObjectKey: "screenshots/revision-proof.png" },
      workerId: "worker:revisions-two",
      reason: "Commit the successful browser result.",
      now: new Date(retried.availableAt.getTime() + 2_000),
    });

    const inspection = await getOperationalJob({
      database,
      jobId: enqueued.job.id,
    });
    expect(inspection.job.revision).toBe(7);
    expect(completed.revision).toBe(7);
    expect(inspection.events.map(({ kind }) => kind)).toEqual([
      "enqueued",
      "claimed",
      "stage_recorded",
      "retry_scheduled",
      "claimed",
      "stage_recorded",
      "succeeded",
    ]);
    expect(
      inspection.events.map(({ expectedRevision }) => expectedRevision),
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(inspection.events.map(({ nextRevision }) => nextRevision)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it("dispatches retryable worker failures into a new attempt and cleans failed output", async () => {
    const enqueued = await enqueue({
      releaseId: releases.workerLifecycle,
      idempotencyKey: "worker-lifecycle",
      now: new Date(Date.now() - 1_000),
    });
    const outputRootKey = `tests/operational-jobs/${suffix}/failed-attempt`;
    const first = await runOperationalJobWorkerCycle({
      kind: "release_artifact_processing",
      workerId: "worker:lifecycle-one",
      database,
      executors: {
        ...operationalJobExecutors,
        artifact: async ({ reportProgress }) => {
          await reportProgress(
            {
              contractVersion: releaseJobExecutionContractVersion,
              stage: "writing_outputs",
              completedUnits: 1,
              totalUnits: 2,
            },
            { outputRootKey },
          );
          throw new ReleaseJobExecutionError({
            code: "object_storage_interrupted",
            message: "The object storage write was interrupted.",
            retryable: true,
            stage: "writing_outputs",
          });
        },
      },
    });
    expect(first).toMatchObject({
      status: "retried",
      jobId: enqueued.job.id,
    });

    await database
      .update(schema.operationalJobs)
      .set({ availableAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(schema.operationalJobs.id, enqueued.job.id));
    const second = await runOperationalJobWorkerCycle({
      kind: "release_artifact_processing",
      workerId: "worker:lifecycle-two",
      database,
      executors: {
        ...operationalJobExecutors,
        artifact: async ({
          database: jobDatabase,
          generationId,
          jobId,
          leaseToken,
          workerId,
        }) => {
          const result = {
            contractVersion: releaseJobExecutionContractVersion,
            generationId,
            siteRootKey: `tests/operational-jobs/${suffix}/successful-attempt`,
            contentHash: "a".repeat(64),
            extractedSizeBytes: 1,
            fileCount: 1,
            entryPath: "index.html",
            nextJobId: "test-downstream-job",
          } as const;
          await completeOperationalJob({
            database: jobDatabase,
            jobId,
            leaseToken,
            workerId,
            result,
            reason: "Complete the worker dispatcher lifecycle proof.",
          });
          return result;
        },
      },
    });
    expect(second).toMatchObject({
      status: "succeeded",
      jobId: enqueued.job.id,
    });

    const inspection = await getOperationalJob({
      database,
      jobId: enqueued.job.id,
    });
    expect(inspection.attempts).toMatchObject([
      {
        attempt: 1,
        status: "failed",
        privateData: { hasOutputRoot: true },
        lastErrorCode: "object_storage_interrupted",
      },
      { attempt: 2, status: "succeeded" },
    ]);
    expect(inspection.attempts[0]?.id).not.toBe(inspection.attempts[1]?.id);

    const deletedPrefixes: string[] = [];
    const cleanupStorage: ReleaseStorage = {
      async createArtifactUploadTarget() {
        throw new Error("Cleanup must not create upload targets.");
      },
      async createArtifactDownloadTarget() {
        throw new Error("Cleanup must not create download targets.");
      },
      async headObject() {
        throw new Error("Cleanup must not inspect objects.");
      },
      async readObject() {
        throw new Error("Cleanup must not read objects.");
      },
      async putObject() {
        throw new Error("Cleanup must not write objects.");
      },
      async deletePrefix(prefix) {
        deletedPrefixes.push(prefix);
      },
    };
    const cleanup = await cleanupReleaseJobOrphanOutputs({
      database,
      storage: cleanupStorage,
      actor: "worker:cleanup-proof",
      reason: "Remove the failed attempt's isolated output.",
    });
    expect(deletedPrefixes).toEqual([outputRootKey]);
    expect(cleanup.cleaned).toMatchObject([
      { attemptId: inspection.attempts[0]?.id, jobId: enqueued.job.id },
    ]);
    const cleanedInspection = await getOperationalJob({
      database,
      jobId: enqueued.job.id,
    });
    expect(cleanedInspection.attempts[0]?.outputCleanedAt).toEqual(
      expect.any(String),
    );
    expect(cleanedInspection.events.at(-1)?.kind).toBe("output_cleaned");
  });
});
