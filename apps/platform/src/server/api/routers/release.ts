import { db } from "@/db";
import { gameReleaseReports } from "@/db/schema";
import {
  gameReleaseStatusValues,
  releaseReportSourceSchema,
} from "@/lib/releases/release-contract";
import { MAX_RELEASE_ZIP_BYTES } from "@/lib/releases/release-policy";
import { findPublicReleaseBySlugOrId } from "@/server/releases/public-release-record";
import {
  archiveOwnedRelease,
  createOwnedDraftRelease,
  finalizeOwnedReleaseUpload,
  getOwnedRelease,
  listOwnedGameReleases,
  listReleasesForOperations,
  publishOwnedRelease,
  quarantineReleaseForOperations,
  requestOwnedReleaseGenerationExport,
  requestOwnedReleaseUploadTarget,
} from "@/server/releases/release-application-service";
import { z } from "zod";
import {
  RATE_LIMITS,
  createTRPCRouter,
  opsProcedure,
  protectedProcedure,
  publicProcedure,
  rateLimitMiddleware,
} from "../trpc";

const createDraftReleaseInput = z.object({
  gameId: z.string(),
  versionLabel: z.string().trim().min(1).max(100).optional(),
});

const releaseStatusMutationInput = z.object({
  releaseId: z.string(),
});

const releaseGenerationMutationInput = releaseStatusMutationInput.extend({
  generationId: z.string().trim().min(1),
});

const requestUploadTargetInput = z.object({
  releaseId: z.string(),
  originalFilename: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive().max(MAX_RELEASE_ZIP_BYTES),
});

const reportPublicReleaseInput = z.object({
  slugOrId: z.string().trim().min(1),
  source: releaseReportSourceSchema,
  reason: z.string().trim().min(3).max(120),
  details: z.string().trim().max(2000).optional(),
  reporterEmail: z.string().trim().email().max(320).optional(),
});

type OwnedReleaseDetails = Awaited<ReturnType<typeof getOwnedRelease>>;

const toReleaseRecord = (details: OwnedReleaseDetails) => {
  const {
    candidateGeneration,
    checks,
    game,
    generations,
    owner,
    promotedGeneration,
    reports,
    ...release
  } = details;
  return release;
};

const toCreatorReleaseRecord = (details: OwnedReleaseDetails) => {
  const { game, owner, ...release } = details;
  return release;
};

export const releaseRouter = createTRPCRouter({
  listByGame: protectedProcedure
    .input(z.object({ gameId: z.string() }))
    .query(async ({ input, ctx }) => {
      const { releases } = await listOwnedGameReleases({
        actor: { userId: ctx.user.id },
        gameReference: { kind: "id", gameId: input.gameId },
      });
      return releases.map(toCreatorReleaseRecord);
    }),

  get: protectedProcedure
    .input(z.object({ releaseId: z.string() }))
    .query(async ({ input, ctx }) => {
      return getOwnedRelease({
        actor: { userId: ctx.user.id },
        releaseId: input.releaseId,
      });
    }),

  createDraft: protectedProcedure
    .use(rateLimitMiddleware("release.createDraft", RATE_LIMITS.releaseCreate))
    .input(createDraftReleaseInput)
    .mutation(async ({ input, ctx }) => {
      const release = await createOwnedDraftRelease({
        actor: { userId: ctx.user.id },
        gameReference: { kind: "id", gameId: input.gameId },
        versionLabel: input.versionLabel,
      });
      return toReleaseRecord(release);
    }),

  listStatuses: protectedProcedure.query(async () => {
    return gameReleaseStatusValues;
  }),

  listOps: opsProcedure.query(async ({ ctx }) =>
    listReleasesForOperations({
      actor: { userId: ctx.user.id, role: ctx.user.role },
    }),
  ),

  requestUploadTarget: protectedProcedure
    .use(
      rateLimitMiddleware(
        "release.requestUploadTarget",
        RATE_LIMITS.releaseCreate,
      ),
    )
    .input(requestUploadTargetInput)
    .mutation(async ({ input, ctx }) => {
      const result = await requestOwnedReleaseUploadTarget({
        actor: { userId: ctx.user.id },
        releaseId: input.releaseId,
        originalFilename: input.originalFilename,
        sizeBytes: input.sizeBytes,
      });
      return {
        release: toReleaseRecord(result.release),
        generation: result.generation,
        upload: result.upload,
      };
    }),

  finalizeUpload: protectedProcedure
    .input(releaseGenerationMutationInput)
    .mutation(async ({ input, ctx }) => {
      const result = await finalizeOwnedReleaseUpload({
        actor: { userId: ctx.user.id },
        releaseId: input.releaseId,
        generationId: input.generationId,
      });
      return {
        release: toCreatorReleaseRecord(result.release),
        generation: result.generation,
        job: result.job,
      };
    }),

  requestExport: protectedProcedure
    .input(releaseGenerationMutationInput)
    .mutation(async ({ input, ctx }) => {
      return requestOwnedReleaseGenerationExport({
        actor: { userId: ctx.user.id },
        releaseId: input.releaseId,
        generationId: input.generationId,
      });
    }),

  publish: protectedProcedure
    .input(releaseStatusMutationInput)
    .mutation(async ({ input, ctx }) => {
      const release = await publishOwnedRelease({
        actor: { userId: ctx.user.id },
        releaseId: input.releaseId,
      });
      return toReleaseRecord(release);
    }),

  archive: protectedProcedure
    .input(releaseStatusMutationInput)
    .mutation(async ({ input, ctx }) => {
      const release = await archiveOwnedRelease({
        actor: { userId: ctx.user.id },
        releaseId: input.releaseId,
      });
      return toReleaseRecord(release);
    }),

  quarantine: opsProcedure
    .input(releaseStatusMutationInput)
    .mutation(async ({ input, ctx }) => {
      return quarantineReleaseForOperations({
        actor: { userId: ctx.user.id, role: ctx.user.role },
        releaseId: input.releaseId,
      });
    }),

  reportPublic: publicProcedure
    .input(reportPublicReleaseInput)
    .mutation(async ({ input }) => {
      const publicRelease = await findPublicReleaseBySlugOrId(input.slugOrId);

      const [report] = await db
        .insert(gameReleaseReports)
        .values({
          id: crypto.randomUUID(),
          releaseId: publicRelease.releaseId,
          status: "open",
          source: input.source,
          reason: input.reason.trim(),
          details: input.details?.trim() || null,
          reporterEmail: input.reporterEmail?.trim() || null,
        })
        .returning();

      return report;
    }),
});
