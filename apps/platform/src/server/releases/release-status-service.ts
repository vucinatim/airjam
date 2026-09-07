import { db } from "@/db";
import { gameReleaseGenerations, gameReleases, games } from "@/db/schema";
import { canTransitionReleaseStatus } from "@/lib/releases/release-policy";
import { and, eq, inArray, sql } from "drizzle-orm";

export const quarantineRelease = async ({
  releaseId,
  checkedAt,
}: {
  releaseId: string;
  checkedAt?: Date;
}) => {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${gameReleases.id} from ${gameReleases} where ${gameReleases.id} = ${releaseId} for update`,
    );
    const release = await tx.query.gameReleases.findFirst({
      where: (gameReleases, { eq }) => eq(gameReleases.id, releaseId),
    });

    if (!release) {
      throw new Error("Release not found.");
    }

    if (release.status === "quarantined") {
      return release;
    }

    if (!canTransitionReleaseStatus(release.status, "quarantined")) {
      throw new Error(
        `Illegal release status transition: ${release.status} -> quarantined`,
      );
    }

    const now = checkedAt ?? new Date();
    if (release.candidateGenerationId) {
      await tx
        .update(gameReleaseGenerations)
        .set({ status: "abandoned", abandonedAt: now })
        .where(
          and(
            eq(gameReleaseGenerations.id, release.candidateGenerationId),
            inArray(gameReleaseGenerations.status, [
              "awaiting_upload",
              "processing",
            ]),
          ),
        );
    }
    const [quarantinedRelease] = await tx
      .update(gameReleases)
      .set({
        status: "quarantined",
        candidateGenerationId: null,
        checkedAt: checkedAt ?? release.checkedAt,
        quarantinedAt: now,
      })
      .where(eq(gameReleases.id, releaseId))
      .returning();

    if (release.status === "live") {
      await tx
        .update(games)
        .set({
          arcadeVisibility: "hidden",
          updatedAt: now,
        })
        .where(eq(games.id, release.gameId));
    }

    return quarantinedRelease;
  });
};

export const publishReleaseWithDatabase = async ({
  database,
  releaseId,
}: {
  database: typeof db;
  releaseId: string;
}) => {
  return database.transaction(async (tx) => {
    const initialRelease = await tx.query.gameReleases.findFirst({
      where: (table, { eq }) => eq(table.id, releaseId),
    });

    if (!initialRelease) {
      throw new Error("Release not found.");
    }

    await tx.execute(
      sql`select ${games.id} from ${games} where ${games.id} = ${initialRelease.gameId} for update`,
    );

    const release = await tx.query.gameReleases.findFirst({
      where: (table, { eq }) => eq(table.id, releaseId),
    });

    if (!release) {
      throw new Error("Release not found.");
    }

    if (release.status === "live") {
      return release;
    }

    if (release.status !== "ready") {
      throw new Error("Only ready releases can be published.");
    }

    if (!release.promotedGenerationId) {
      throw new Error("Ready release has no promoted generation.");
    }

    const [promotedGeneration] = await tx
      .select()
      .from(gameReleaseGenerations)
      .where(
        and(
          eq(gameReleaseGenerations.id, release.promotedGenerationId),
          eq(gameReleaseGenerations.releaseId, release.id),
          eq(gameReleaseGenerations.status, "ready"),
        ),
      )
      .for("update");
    if (!promotedGeneration) {
      throw new Error("Promoted release generation is not ready.");
    }
    if (
      promotedGeneration.storageCleanupStartedAt ||
      promotedGeneration.storageDeletedAt
    ) {
      throw new Error(
        "Release storage cleanup has started and the generation can no longer be published.",
      );
    }

    const now = new Date();
    const existingLiveReleases = await tx
      .select({ id: gameReleases.id })
      .from(gameReleases)
      .where(
        and(
          eq(gameReleases.gameId, release.gameId),
          eq(gameReleases.status, "live"),
        ),
      );

    const existingLiveReleaseIds = existingLiveReleases.map((item) => item.id);
    if (existingLiveReleaseIds.length > 0) {
      await tx
        .update(gameReleases)
        .set({
          status: "archived",
          archivedAt: now,
        })
        .where(inArray(gameReleases.id, existingLiveReleaseIds));
    }

    await tx
      .update(gameReleaseGenerations)
      .set({
        storageInactiveAt: null,
        storageRetentionWarnedAt: null,
        storageRetentionEligibleAt: null,
      })
      .where(eq(gameReleaseGenerations.id, promotedGeneration.id));

    const [publishedRelease] = await tx
      .update(gameReleases)
      .set({
        status: "live",
        publishedAt: now,
        archivedAt: null,
        quarantinedAt: null,
      })
      .where(
        and(eq(gameReleases.id, releaseId), eq(gameReleases.status, "ready")),
      )
      .returning();

    if (!publishedRelease) {
      throw new Error("Release publish state changed concurrently.");
    }

    return publishedRelease;
  });
};

export const publishRelease = ({ releaseId }: { releaseId: string }) =>
  publishReleaseWithDatabase({ database: db, releaseId });

export const archiveRelease = async ({ releaseId }: { releaseId: string }) => {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select ${gameReleases.id} from ${gameReleases} where ${gameReleases.id} = ${releaseId} for update`,
    );
    const release = await tx.query.gameReleases.findFirst({
      where: (table, { eq }) => eq(table.id, releaseId),
    });

    if (!release) {
      throw new Error("Release not found.");
    }

    if (release.status === "archived") {
      return release;
    }

    const now = new Date();
    if (release.candidateGenerationId) {
      await tx
        .update(gameReleaseGenerations)
        .set({ status: "abandoned", abandonedAt: now })
        .where(
          and(
            eq(gameReleaseGenerations.id, release.candidateGenerationId),
            inArray(gameReleaseGenerations.status, [
              "awaiting_upload",
              "processing",
            ]),
          ),
        );
    }
    const [archivedRelease] = await tx
      .update(gameReleases)
      .set({
        status: "archived",
        candidateGenerationId: null,
        archivedAt: now,
      })
      .where(eq(gameReleases.id, releaseId))
      .returning();

    if (release.status === "live") {
      await tx
        .update(games)
        .set({
          arcadeVisibility: "hidden",
          updatedAt: now,
        })
        .where(eq(games.id, release.gameId));
    }

    return archivedRelease;
  });
};
