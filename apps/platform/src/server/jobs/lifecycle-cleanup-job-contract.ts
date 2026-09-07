import { operationalJobResourceKindValues } from "@air-jam/database-contract";
import { z } from "zod";

export const lifecycleCleanupJobContractVersion = 1 as const;

export const lifecycleCleanupResourceKindSchema = z.enum(
  operationalJobResourceKindValues,
);

export const lifecycleCleanupRetentionClassValues = [
  "terminal_release_generation_24h",
  "superseded_unpublished_release_180d",
  "inactive_game_media_24h",
] as const;

export const lifecycleCleanupRetentionClassSchema = z.enum(
  lifecycleCleanupRetentionClassValues,
);

export type LifecycleCleanupRetentionClass =
  (typeof lifecycleCleanupRetentionClassValues)[number];

export const lifecycleCleanupJobPayloadSchema = z
  .object({
    contractVersion: z.literal(lifecycleCleanupJobContractVersion),
    resourceKind: lifecycleCleanupResourceKindSchema,
    resourceId: z.string().trim().min(1),
    retentionClass: lifecycleCleanupRetentionClassSchema,
    eligibleAt: z.string().datetime({ offset: true }),
    plannedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedRetentionClasses =
      value.resourceKind === "release_generation"
        ? [
            "terminal_release_generation_24h",
            "superseded_unpublished_release_180d",
          ]
        : ["inactive_game_media_24h"];
    if (!expectedRetentionClasses.includes(value.retentionClass)) {
      context.addIssue({
        code: "custom",
        path: ["retentionClass"],
        message: `${value.resourceKind} requires one of: ${expectedRetentionClasses.join(", ")}.`,
      });
    }
    if (Date.parse(value.eligibleAt) > Date.parse(value.plannedAt)) {
      context.addIssue({
        code: "custom",
        path: ["eligibleAt"],
        message: "Cleanup cannot be planned before the retention deadline.",
      });
    }
  });

export type LifecycleCleanupJobPayload = z.infer<
  typeof lifecycleCleanupJobPayloadSchema
>;

export const lifecycleCleanupJobProgressSchema = z
  .object({
    contractVersion: z.literal(lifecycleCleanupJobContractVersion),
    stage: z.enum(["revalidating", "inventorying", "deleting", "committing"]),
    message: z.string().trim().min(1),
    objectCount: z.number().int().nonnegative().optional(),
    bytes: z.number().int().nonnegative().optional(),
  })
  .strict();

export type LifecycleCleanupJobProgress = z.infer<
  typeof lifecycleCleanupJobProgressSchema
>;

export const lifecycleCleanupDeletedObjectSchema = z
  .object({
    key: z.string().trim().min(1),
    sizeBytes: z.number().int().nonnegative(),
    etag: z.string().nullable(),
  })
  .strict();

export const lifecycleCleanupOutputManifestSchema = z
  .object({
    objects: z.array(lifecycleCleanupDeletedObjectSchema).max(10_000),
  })
  .strict();

export const lifecycleCleanupJobResultSchema = z
  .object({
    contractVersion: z.literal(lifecycleCleanupJobContractVersion),
    resourceKind: lifecycleCleanupResourceKindSchema,
    resourceId: z.string().trim().min(1),
    retentionClass: lifecycleCleanupRetentionClassSchema,
    disposition: z.enum(["deleted", "already_deleted"]),
    storageRootKey: z.string().trim().min(1),
    objects: z.array(lifecycleCleanupDeletedObjectSchema).max(10_000),
    objectCount: z.number().int().nonnegative(),
    bytesDeleted: z.number().int().nonnegative(),
    storageDeletedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.objectCount !== value.objects.length) {
      context.addIssue({
        code: "custom",
        path: ["objectCount"],
        message: "Object count must match the immutable deletion manifest.",
      });
    }
    const manifestBytes = value.objects.reduce(
      (total, object) => total + object.sizeBytes,
      0,
    );
    if (value.bytesDeleted !== manifestBytes) {
      context.addIssue({
        code: "custom",
        path: ["bytesDeleted"],
        message: "Deleted bytes must match the immutable deletion manifest.",
      });
    }
  });

export type LifecycleCleanupJobResult = z.infer<
  typeof lifecycleCleanupJobResultSchema
>;

export const lifecycleCleanupJobErrorSchema = z
  .object({
    contractVersion: z.literal(lifecycleCleanupJobContractVersion),
    code: z.enum([
      "resource_not_found",
      "resource_no_longer_eligible",
      "storage_inventory_failed",
      "storage_delete_failed",
      "cleanup_commit_failed",
      "unexpected_cleanup_error",
    ]),
    message: z.string().trim().min(1),
    stage: lifecycleCleanupJobProgressSchema.shape.stage.nullable(),
    retryable: z.boolean(),
  })
  .strict();

export type LifecycleCleanupJobError = z.infer<
  typeof lifecycleCleanupJobErrorSchema
>;

export class LifecycleCleanupExecutionError extends Error {
  readonly code: LifecycleCleanupJobError["code"];
  readonly stage: LifecycleCleanupJobError["stage"];
  readonly retryable: boolean;

  constructor({
    code,
    message,
    stage,
    retryable,
  }: Omit<LifecycleCleanupJobError, "contractVersion">) {
    super(message);
    this.name = "LifecycleCleanupExecutionError";
    this.code = code;
    this.stage = stage;
    this.retryable = retryable;
  }
}

export const serializeLifecycleCleanupExecutionError = ({
  error,
  stage,
}: {
  error: unknown;
  stage: LifecycleCleanupJobError["stage"];
}): LifecycleCleanupJobError =>
  lifecycleCleanupJobErrorSchema.parse(
    error instanceof LifecycleCleanupExecutionError
      ? {
          contractVersion: lifecycleCleanupJobContractVersion,
          code: error.code,
          message: error.message,
          stage: error.stage ?? stage,
          retryable: error.retryable,
        }
      : {
          contractVersion: lifecycleCleanupJobContractVersion,
          code: "unexpected_cleanup_error",
          message: "Lifecycle cleanup failed unexpectedly.",
          stage,
          retryable: true,
        },
  );
