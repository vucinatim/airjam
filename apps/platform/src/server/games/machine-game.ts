import { db } from "@/db";
import { appIds, games } from "@/db/schema";
import { arcadeVisibilitySchema } from "@/lib/games/arcade-visibility";
import {
  gameConfigSourceUrlSchema,
  gameConfigTemplateIdSchema,
  parseGameConfig,
  parseGameConfigLenient,
} from "@/lib/games/game-config-contract";
import type { PlatformMachineOwnedGameSummary } from "@air-jam/sdk/platform-machine";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { PlatformMachineAuthError } from "../auth/machine-auth-errors";

const machineOwnedGameSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const toMachineNotFoundError = (message: string) =>
  new PlatformMachineAuthError({
    code: "not_found",
    message,
    status: 404,
  });

const toMachineConflictError = (message: string) =>
  new PlatformMachineAuthError({
    code: "conflict",
    message,
    status: 409,
  });

const toMachineValidationError = (message: string) =>
  new PlatformMachineAuthError({
    code: "validation_failed",
    message,
    status: 400,
  });

export const serializeOwnedGameForMachine = (
  game: typeof games.$inferSelect,
): PlatformMachineOwnedGameSummary => {
  const config = parseGameConfigLenient(game.config);

  return {
    id: game.id,
    slug: game.slug ?? null,
    name: game.name,
    description: game.description ?? null,
    url: game.url ?? null,
    arcadeVisibility: arcadeVisibilitySchema.parse(game.arcadeVisibility),
    sourceUrl: config.sourceUrl ?? null,
    templateId: config.templateId ?? null,
    createdAt: game.createdAt.toISOString(),
    updatedAt: game.updatedAt.toISOString(),
  };
};

export const listOwnedGamesForMachine = async (userId: string) => {
  const ownedGames = await db
    .select()
    .from(games)
    .where(eq(games.userId, userId))
    .orderBy(desc(games.updatedAt));

  return ownedGames.map(serializeOwnedGameForMachine);
};

export const assertOwnedGameBySlugOrIdForMachine = async ({
  slugOrId,
  userId,
}: {
  slugOrId: string;
  userId: string;
}) => {
  const normalized = slugOrId.trim();

  const gameBySlug = await db.query.games.findFirst({
    where: and(eq(games.slug, normalized), eq(games.userId, userId)),
  });
  if (gameBySlug) {
    return gameBySlug;
  }

  const gameById = await db.query.games.findFirst({
    where: and(eq(games.id, normalized), eq(games.userId, userId)),
  });
  if (gameById) {
    return gameById;
  }

  throw toMachineNotFoundError(`No owned game matched "${normalized}".`);
};

const assertArcadeVisibilityAllowed = async ({
  gameId,
  arcadeVisibility,
}: {
  gameId: string;
  arcadeVisibility: "hidden" | "listed";
}) => {
  if (arcadeVisibility !== "listed") {
    return;
  }

  const liveRelease = await db.query.gameReleases.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.gameId, gameId), eq(table.status, "live")),
  });

  if (!liveRelease) {
    throw toMachineValidationError(
      "A game can only be listed in Arcade after a hosted release is made live.",
    );
  }
};

export const createOwnedGameForMachine = async ({
  userId,
  input,
}: {
  userId: string;
  input: {
    name: string;
    slug?: string;
    description?: string;
    url?: string;
    arcadeVisibility?: "hidden" | "listed";
    sourceUrl?: string;
    templateId?: string;
  };
}) => {
  const gameId = crypto.randomUUID();
  const normalizedSlug = input.slug
    ? machineOwnedGameSlugSchema.parse(input.slug)
    : null;
  const arcadeVisibility = input.arcadeVisibility ?? "hidden";

  await assertArcadeVisibilityAllowed({ gameId, arcadeVisibility });

  try {
    const [game] = await db
      .insert(games)
      .values({
        id: gameId,
        userId,
        name: input.name.trim(),
        slug: normalizedSlug,
        description: input.description?.trim() || null,
        url: input.url?.trim() || null,
        arcadeVisibility,
        config: parseGameConfig({
          ...(input.sourceUrl
            ? { sourceUrl: gameConfigSourceUrlSchema.parse(input.sourceUrl) }
            : {}),
          ...(input.templateId
            ? { templateId: gameConfigTemplateIdSchema.parse(input.templateId) }
            : {}),
        }),
      })
      .returning();

    await db.insert(appIds).values({
      id: crypto.randomUUID(),
      gameId,
      creatorId: userId,
      key: `aj_app_${crypto.randomUUID().replace(/-/g, "")}`,
    });

    return serializeOwnedGameForMachine(game);
  } catch (error) {
    if (error instanceof Error && error.message.includes("23505")) {
      throw toMachineConflictError(
        normalizedSlug
          ? `Slug "${normalizedSlug}" is already taken.`
          : "A unique hosted game field is already taken.",
      );
    }
    throw error;
  }
};

export const updateOwnedGameForMachine = async ({
  slugOrId,
  userId,
  input,
}: {
  slugOrId: string;
  userId: string;
  input: {
    name?: string;
    slug?: string;
    description?: string | null;
    url?: string | null;
    arcadeVisibility?: "hidden" | "listed";
    sourceUrl?: string | null;
    templateId?: string | null;
  };
}) => {
  const existingGame = await assertOwnedGameBySlugOrIdForMachine({
    slugOrId,
    userId,
  });

  if (input.arcadeVisibility) {
    await assertArcadeVisibilityAllowed({
      gameId: existingGame.id,
      arcadeVisibility: input.arcadeVisibility,
    });
  }

  const configPatch = { ...parseGameConfigLenient(existingGame.config) };

  if (input.sourceUrl !== undefined) {
    if (input.sourceUrl) {
      configPatch.sourceUrl = gameConfigSourceUrlSchema.parse(input.sourceUrl);
    } else {
      delete configPatch.sourceUrl;
    }
  }

  if (input.templateId !== undefined) {
    if (input.templateId) {
      configPatch.templateId = gameConfigTemplateIdSchema.parse(
        input.templateId,
      );
    } else {
      delete configPatch.templateId;
    }
  }

  try {
    const [updatedGame] = await db
      .update(games)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.slug !== undefined
          ? { slug: machineOwnedGameSlugSchema.parse(input.slug) }
          : {}),
        ...(input.description !== undefined
          ? { description: input.description?.trim() || null }
          : {}),
        ...(input.url !== undefined ? { url: input.url?.trim() || null } : {}),
        ...(input.arcadeVisibility !== undefined
          ? { arcadeVisibility: input.arcadeVisibility }
          : {}),
        config: parseGameConfig(configPatch),
        updatedAt: new Date(),
      })
      .where(eq(games.id, existingGame.id))
      .returning();

    return serializeOwnedGameForMachine(updatedGame);
  } catch (error) {
    if (error instanceof Error && error.message.includes("23505")) {
      throw toMachineConflictError("Slug already taken. Please choose another.");
    }
    throw error;
  }
};
