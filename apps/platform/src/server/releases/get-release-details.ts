import { db } from "@/db";
import {
  gameReleaseChecks,
  gameReleaseGenerations,
  gameReleaseReports,
  gameReleases,
  games,
  operationalJobs,
  users,
} from "@/db/schema";
import { resolveReleaseStorageRetentionState } from "@/lib/releases/release-retention-policy";
import {
  isReleaseOperationalJobKind,
  type ReleaseOperationalJobKind,
} from "@/server/jobs/release-job-contract";
import { desc, eq, inArray } from "drizzle-orm";

type GameRecord = typeof games.$inferSelect;
type ReleaseRecord = typeof gameReleases.$inferSelect;
type ReleaseGenerationRecord = typeof gameReleaseGenerations.$inferSelect;
type ReleaseCheckRecord = typeof gameReleaseChecks.$inferSelect;
type OperationalJobRecord = typeof operationalJobs.$inferSelect;
type ReleaseOperationalJobRecord = OperationalJobRecord & {
  kind: ReleaseOperationalJobKind;
  releaseId: string;
  generationId: string;
};

export const isReleaseOperationalJobRecord = (
  job: OperationalJobRecord,
): job is ReleaseOperationalJobRecord =>
  isReleaseOperationalJobKind(job.kind) &&
  job.releaseId !== null &&
  job.generationId !== null;

export const projectReleaseJob = (job: ReleaseOperationalJobRecord) => ({
  id: job.id,
  kind: job.kind,
  status: job.status,
  releaseId: job.releaseId,
  generationId: job.generationId,
  correlationId: job.correlationId,
  attemptCount: job.attemptCount,
  maxAttempts: job.maxAttempts,
  progressStage:
    typeof job.progress.stage === "string" ? job.progress.stage : null,
  progressMessage:
    typeof job.progress.message === "string" ? job.progress.message : null,
  lastErrorCode:
    job.lastError && typeof job.lastError.code === "string"
      ? job.lastError.code
      : null,
  lastErrorRetryable:
    job.lastError && typeof job.lastError.retryable === "boolean"
      ? job.lastError.retryable
      : null,
  availableAt: job.availableAt,
  deadlineAt: job.deadlineAt,
  createdAt: job.createdAt,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  updatedAt: job.updatedAt,
});

export const projectReleaseGeneration = (
  generation: ReleaseGenerationRecord,
  now = new Date(),
) => ({
  id: generation.id,
  releaseId: generation.releaseId,
  sequence: generation.sequence,
  status: generation.status,
  originalFilename: generation.originalFilename,
  contentType: generation.contentType,
  declaredSizeBytes: generation.declaredSizeBytes,
  observedSizeBytes: generation.observedSizeBytes,
  observedContentType: generation.observedContentType,
  observedEtag: generation.observedEtag,
  observedLastModifiedAt: generation.observedLastModifiedAt,
  extractedSizeBytes: generation.extractedSizeBytes,
  fileCount: generation.fileCount,
  entryPath: generation.entryPath,
  contentHash: generation.contentHash,
  createdAt: generation.createdAt,
  uploadObservedAt: generation.uploadObservedAt,
  processingStartedAt: generation.processingStartedAt,
  readyAt: generation.readyAt,
  failedAt: generation.failedAt,
  abandonedAt: generation.abandonedAt,
  storageRetention: {
    state: resolveReleaseStorageRetentionState({
      clock: {
        inactiveAt: generation.storageInactiveAt,
        warnedAt: generation.storageRetentionWarnedAt,
        eligibleAt: generation.storageRetentionEligibleAt,
        cleanupStartedAt: generation.storageCleanupStartedAt,
        deletedAt: generation.storageDeletedAt,
      },
      now,
    }),
    inactiveAt: generation.storageInactiveAt,
    warnedAt: generation.storageRetentionWarnedAt,
    eligibleAt: generation.storageRetentionEligibleAt,
    cleanupStartedAt: generation.storageCleanupStartedAt,
    deletedAt: generation.storageDeletedAt,
  },
});

export const projectReleaseCheck = (check: ReleaseCheckRecord) => ({
  id: check.id,
  releaseId: check.releaseId,
  generationId: check.generationId,
  jobId: check.jobId,
  jobAttempt: check.jobAttempt,
  kind: check.kind,
  status: check.status,
  summary: check.summary,
  createdAt: check.createdAt,
});

const loadReleaseDetails = async ({
  game,
  releases,
}: {
  game: GameRecord;
  releases: ReleaseRecord[];
}) => {
  if (releases.length === 0) {
    return [];
  }

  const releaseIds = releases.map((release) => release.id);
  const [owner, generations, checks, reports, jobs] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, game.userId) }),
    db
      .select()
      .from(gameReleaseGenerations)
      .where(inArray(gameReleaseGenerations.releaseId, releaseIds))
      .orderBy(desc(gameReleaseGenerations.sequence)),
    db
      .select()
      .from(gameReleaseChecks)
      .where(inArray(gameReleaseChecks.releaseId, releaseIds))
      .orderBy(desc(gameReleaseChecks.createdAt)),
    db
      .select()
      .from(gameReleaseReports)
      .where(inArray(gameReleaseReports.releaseId, releaseIds))
      .orderBy(desc(gameReleaseReports.createdAt)),
    db
      .select()
      .from(operationalJobs)
      .where(inArray(operationalJobs.releaseId, releaseIds))
      .orderBy(desc(operationalJobs.createdAt)),
  ]);

  const generationsByReleaseId = new Map<
    string,
    ReturnType<typeof projectReleaseGeneration>[]
  >();
  const checksByReleaseId = new Map<string, (typeof checks)[number][]>();
  const reportsByReleaseId = new Map<string, (typeof reports)[number][]>();
  const jobsByReleaseId = new Map<
    string,
    ReturnType<typeof projectReleaseJob>[]
  >();

  for (const generation of generations) {
    const releaseGenerations =
      generationsByReleaseId.get(generation.releaseId) ?? [];
    releaseGenerations.push(projectReleaseGeneration(generation));
    generationsByReleaseId.set(generation.releaseId, releaseGenerations);
  }

  for (const check of checks) {
    const releaseChecks = checksByReleaseId.get(check.releaseId) ?? [];
    releaseChecks.push(check);
    checksByReleaseId.set(check.releaseId, releaseChecks);
  }

  for (const report of reports) {
    const releaseReports = reportsByReleaseId.get(report.releaseId) ?? [];
    releaseReports.push(report);
    reportsByReleaseId.set(report.releaseId, releaseReports);
  }

  for (const job of jobs) {
    if (!isReleaseOperationalJobRecord(job)) continue;
    const releaseJobs = jobsByReleaseId.get(job.releaseId) ?? [];
    releaseJobs.push(projectReleaseJob(job));
    jobsByReleaseId.set(job.releaseId, releaseJobs);
  }

  const ownerProjection = owner
    ? {
        id: owner.id,
        name: owner.name,
        email: owner.email,
        role: owner.role,
      }
    : null;

  return releases.map((release) => {
    const releaseGenerations = generationsByReleaseId.get(release.id) ?? [];
    const generationById = new Map(
      releaseGenerations.map((generation) => [generation.id, generation]),
    );

    return {
      ...release,
      game,
      owner: ownerProjection,
      generations: releaseGenerations,
      candidateGeneration: release.candidateGenerationId
        ? (generationById.get(release.candidateGenerationId) ?? null)
        : null,
      promotedGeneration: release.promotedGenerationId
        ? (generationById.get(release.promotedGenerationId) ?? null)
        : null,
      checks: (checksByReleaseId.get(release.id) ?? []).map(
        projectReleaseCheck,
      ),
      jobs: jobsByReleaseId.get(release.id) ?? [],
      reports: reportsByReleaseId.get(release.id) ?? [],
    };
  });
};

export const listReleaseDetailsByGame = async (game: GameRecord) => {
  const releases = await db.query.gameReleases.findMany({
    where: (table, { eq }) => eq(table.gameId, game.id),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });

  return loadReleaseDetails({ game, releases });
};

export const getReleaseDetails = async (releaseId: string) => {
  const release = await db.query.gameReleases.findFirst({
    where: (table, { eq }) => eq(table.id, releaseId),
  });

  if (!release) {
    return null;
  }

  const game = await db.query.games.findFirst({
    where: (table, { eq }) => eq(table.id, release.gameId),
  });

  if (!game) {
    throw new Error("Release game is missing.");
  }

  const [details] = await loadReleaseDetails({ game, releases: [release] });
  return details ?? null;
};
