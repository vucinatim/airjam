import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../db/schema";
import {
  claimOperationalJob,
  enqueueOperationalJob,
} from "../jobs/operational-job-service";
import { createReleaseGenerationJobPayload } from "../jobs/release-job-contract";
import {
  decideOperationalQuotaAdmissionWithDatabase,
  listOperationalQuotaUsage,
} from "./production-quota-service";

const databaseUrl = process.env.AIR_JAM_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);

describeWithPostgres("production quota PostgreSQL authority", () => {
  const client = postgres(databaseUrl!, { max: 4 });
  const database = drizzle(client, { schema });
  const suffix = crypto.randomUUID();
  const creatorId = `quota_creator_${suffix}`;
  const firstGameId = `quota_game_a_${suffix}`;
  const secondGameId = `quota_game_b_${suffix}`;
  const firstReleaseId = `quota_release_a_${suffix}`;
  const secondReleaseId = `quota_release_b_${suffix}`;
  const firstGenerationId = `quota_generation_a_${suffix}`;
  const secondGenerationId = `quota_generation_b_${suffix}`;
  const cycleId = `quota_cycle_${suffix}`;
  const realtimeInstanceId = `quota_realtime_instance_${suffix}`;
  const now = new Date();
  const cycleStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const cycleEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );

  beforeAll(async () => {
    await database.insert(schema.users).values({
      id: creatorId,
      name: "Quota authority test",
      email: `${creatorId}@example.invalid`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(schema.games).values([
      {
        id: firstGameId,
        userId: creatorId,
        name: "Quota game A",
        arcadeVisibility: "listed",
        config: {},
        createdAt: new Date(now.getTime() - 10_000),
        updatedAt: now,
      },
      {
        id: secondGameId,
        userId: creatorId,
        name: "Quota game B",
        config: {},
        createdAt: new Date(now.getTime() - 9_000),
        updatedAt: now,
      },
    ]);
    await database.insert(schema.gameReleases).values([
      {
        id: firstReleaseId,
        gameId: firstGameId,
        sourceKind: "upload",
        status: "archived",
        createdAt: new Date(now.getTime() - 8_000),
      },
      {
        id: secondReleaseId,
        gameId: firstGameId,
        sourceKind: "upload",
        status: "archived",
        createdAt: new Date(now.getTime() - 7_000),
      },
    ]);
    const generationReadyAt = new Date(now.getTime() - 6_000);
    await database.insert(schema.gameReleaseGenerations).values([
      {
        id: firstGenerationId,
        releaseId: firstReleaseId,
        sequence: 1,
        status: "ready",
        originalFilename: "game.zip",
        contentType: "application/zip",
        declaredSizeBytes: 200,
        observedSizeBytes: 200,
        observedContentType: "application/zip",
        extractedSizeBytes: 300,
        fileCount: 1,
        zipObjectKey: `tests/${suffix}/game.zip`,
        siteRootKey: `tests/${suffix}/site`,
        entryPath: "index.html",
        contentHash: "0".repeat(64),
        createdAt: generationReadyAt,
        uploadObservedAt: generationReadyAt,
        processingStartedAt: generationReadyAt,
        readyAt: generationReadyAt,
      },
      {
        id: secondGenerationId,
        releaseId: secondReleaseId,
        sequence: 1,
        status: "ready",
        originalFilename: "unpromoted.zip",
        contentType: "application/zip",
        declaredSizeBytes: 700,
        observedSizeBytes: 700,
        observedContentType: "application/zip",
        extractedSizeBytes: 800,
        fileCount: 1,
        zipObjectKey: `tests/${suffix}/unpromoted.zip`,
        siteRootKey: `tests/${suffix}/unpromoted-site`,
        entryPath: "index.html",
        contentHash: "1".repeat(64),
        createdAt: generationReadyAt,
        uploadObservedAt: generationReadyAt,
        processingStartedAt: generationReadyAt,
        readyAt: generationReadyAt,
      },
    ]);
    await database
      .update(schema.gameReleases)
      .set({
        status: "ready",
        promotedGenerationId: firstGenerationId,
      })
      .where(eq(schema.gameReleases.id, firstReleaseId));
    await database.insert(schema.gameMediaAssets).values([
      {
        id: `quota_media_a_${suffix}`,
        gameId: firstGameId,
        kind: "thumbnail",
        status: "ready",
        originalFilename: "a.png",
        mimeType: "image/png",
        sizeBytes: 100,
        storageKey: `tests/${suffix}/a.png`,
        createdAt: new Date(now.getTime() - 5_000),
        updatedAt: now,
      },
      {
        id: `quota_media_b_${suffix}`,
        gameId: secondGameId,
        kind: "thumbnail",
        status: "archived",
        originalFilename: "b.png",
        mimeType: "image/png",
        sizeBytes: 400,
        storageKey: `tests/${suffix}/b.png`,
        inactiveAt: now,
        createdAt: new Date(now.getTime() - 4_000),
        updatedAt: now,
      },
    ]);
    await database.insert(schema.gameReleaseChecks).values({
      id: `quota_check_${suffix}`,
      releaseId: firstReleaseId,
      generationId: firstGenerationId,
      kind: "screenshot_capture",
      status: "passed",
      createdAt: new Date(now.getTime() - 3_000),
    });
    await database.insert(schema.runtimeUsageSessions).values({
      id: `quota_session_${suffix}`,
      roomId: `quota_room_${suffix}`,
      startedAt: new Date(now.getTime() - 3_600_000),
      createdAt: new Date(now.getTime() - 3_600_000),
    });
    await database.insert(schema.runtimeUsageGameSegments).values({
      id: `quota_segment_${suffix}`,
      runtimeSessionId: `quota_session_${suffix}`,
      roomId: `quota_room_${suffix}`,
      gameId: firstGameId,
      startedAt: new Date(now.getTime() - 3_600_000),
      endedAt: now,
      startEventId: `quota_start_${suffix}`,
      endEventId: `quota_end_${suffix}`,
      createdAt: new Date(now.getTime() - 3_600_000),
    });
    await database.insert(schema.operationalBudgetCycles).values({
      id: cycleId,
      periodStart: cycleStart,
      periodEnd: cycleEnd,
      profile: "ordinary",
      normalTargetMicrousd: 25_000_000,
      warningMicrousd: 50_000_000,
      protectionMicrousd: 75_000_000,
      nearCeilingMicrousd: 90_000_000,
      ceilingMicrousd: 100_000_000,
      createdAt: now,
    });
    await database.insert(schema.operationalBudgetEvidence).values({
      id: `quota_evidence_${suffix}`,
      idempotencyKey: `quota_evidence_${suffix}`,
      cycleId,
      contractVersion: 1,
      provider: "test",
      scopeKind: "project",
      scopeId: `quota_project_${suffix}`,
      scopeName: "quota-test",
      scopeMetadata: {},
      currency: "USD",
      observedAt: now,
      actualAmountMicrousd: 1_000_000,
      projectedAmountMicrousd: 2_000_000,
      measurements: {},
      costBreakdownMicrousd: {},
      rateCard: {},
      sourceVersion: "quota-test@1",
      collectedBy: "test",
      reason: "Prove authoritative quota reads",
      createdAt: now,
    });
    await enqueueOperationalJob({
      database,
      kind: "release_browser_validation",
      creatorId,
      gameId: firstGameId,
      releaseId: firstReleaseId,
      generationId: firstGenerationId,
      idempotencyKey: `quota-active-job-${suffix}`,
      payload: createReleaseGenerationJobPayload({
        generationId: firstGenerationId,
      }),
      actor: `test:quota-active-job:${suffix}`,
      reason: "Prove live leased jobs are authoritative quota usage.",
      now,
    });
    await claimOperationalJob({
      database,
      kind: "release_browser_validation",
      workerId: `worker:quota:${suffix}`,
      now,
    });
    await database.insert(schema.realtimeAdmissionInstances).values({
      instanceId: realtimeInstanceId,
      leaseToken: `quota_realtime_lease_${suffix}`,
      startedAt: now,
      heartbeatAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await database.insert(schema.realtimeRoomAdmissionLeases).values({
      roomId: `quota_realtime_room_${suffix}`,
      leaseToken: `quota_room_lease_${suffix}`,
      instanceId: realtimeInstanceId,
      creatorId,
      gameId: firstGameId,
      maxControllers: 8,
      admittedAt: now,
    });
  });

  afterAll(async () => {
    await database
      .delete(schema.realtimeAdmissionInstances)
      .where(
        eq(schema.realtimeAdmissionInstances.instanceId, realtimeInstanceId),
      );
    await database
      .delete(schema.operationalBudgetEvidence)
      .where(eq(schema.operationalBudgetEvidence.cycleId, cycleId));
    await database
      .delete(schema.operationalBudgetCycles)
      .where(eq(schema.operationalBudgetCycles.id, cycleId));
    await database
      .delete(schema.runtimeUsageGameSegments)
      .where(eq(schema.runtimeUsageGameSegments.id, `quota_segment_${suffix}`));
    await database
      .delete(schema.runtimeUsageSessions)
      .where(eq(schema.runtimeUsageSessions.id, `quota_session_${suffix}`));
    await database
      .delete(schema.games)
      .where(eq(schema.games.userId, creatorId));
    await database
      .delete(schema.operationalJobCommands)
      .where(
        eq(
          schema.operationalJobCommands.actor,
          `test:quota-active-job:${suffix}`,
        ),
      );
    await database.delete(schema.users).where(eq(schema.users.id, creatorId));
    await client.end();
  });

  it("derives creator and game usage from lifecycle and runtime authority", async () => {
    const usage = await listOperationalQuotaUsage({
      database,
      creatorId,
      gameId: firstGameId,
      now,
    });
    const byKey = new Map(usage.map((item) => [item.key, item]));

    expect(byKey.get("creator_games")?.current).toBe(2);
    expect(byKey.get("creator_listed_games")?.current).toBe(1);
    expect(byKey.get("creator_managed_storage_bytes")?.current).toBe(2_500);
    expect(byKey.get("game_managed_storage_bytes")?.current).toBe(2_100);
    expect(byKey.get("creator_release_submissions_30d")?.current).toBe(2);
    expect(byKey.get("creator_browser_validations_day")?.current).toBe(1);
    expect(byKey.get("creator_room_seconds_30d")?.current).toBe(3_600);
    expect(byKey.get("creator_concurrent_release_jobs")).toMatchObject({
      authorityStatus: "available",
      current: 1,
    });
    expect(byKey.get("creator_concurrent_rooms")).toMatchObject({
      authorityStatus: "available",
      current: 1,
    });
    expect(byKey.get("game_concurrent_rooms")).toMatchObject({
      authorityStatus: "available",
      current: 1,
    });
  });

  it("combines authoritative usage with lane and budget state", async () => {
    const decision = await decideOperationalQuotaAdmissionWithDatabase({
      database,
      key: "creator_games",
      lane: "game_creation",
      creatorId,
      requestedAmount: 49,
      decisionId: `quota_decision_${suffix}`,
    });

    expect(decision).toMatchObject({
      outcome: "shadow_denied",
      reason: "quota_exceeded",
      budgetState: "normal",
      controlStatus: "available",
      projectedUsage: 51,
      usage: { current: 2, limit: 50 },
    });
  });

  it("runs the same decision through the canonical repo CLI", () => {
    const output = execFileSync(
      "pnpm",
      [
        "--silent",
        "run",
        "repo",
        "--",
        "platform",
        "operations",
        "quota",
        "check",
        "--key",
        "creator_games",
        "--lane",
        "game_creation",
        "--creator",
        creatorId,
        "--amount",
        "49",
        "--json",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: databaseUrl! },
      },
    );
    const result = JSON.parse(output);
    expect(result).toMatchObject({
      command: "quota-check",
      applied: false,
      result: {
        decision: {
          outcome: "shadow_denied",
          reason: "quota_exceeded",
          projectedUsage: 51,
        },
      },
    });
  });
});
