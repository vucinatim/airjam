-- airjam:migration-mode=operational_lanes
-- airjam:affected-lanes=release_submission,artifact_ingestion,release_processing,lifecycle_cleanup
-- airjam:verify=constraint:game_release_generations.game_release_generations_storage_retention_check
-- airjam:verify=constraint:game_release_generations.game_release_generations_storage_cleanup_check
-- airjam:verify=index:game_release_generations_cleanup_idx
ALTER TABLE "game_release_generations" DROP CONSTRAINT "game_release_generations_storage_cleanup_check";--> statement-breakpoint
DROP INDEX "game_release_generations_cleanup_idx";--> statement-breakpoint
ALTER TABLE "game_release_generations" ADD COLUMN "storage_inactive_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "game_release_generations" ADD COLUMN "storage_retention_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "game_release_generations" ADD COLUMN "storage_retention_eligible_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "game_release_generations_cleanup_idx" ON "game_release_generations" USING btree ("status","storage_retention_eligible_at","created_at") WHERE "game_release_generations"."storage_deleted_at" is null and ("game_release_generations"."status" in ('failed', 'abandoned') or ("game_release_generations"."status" = 'ready' and "game_release_generations"."storage_retention_eligible_at" is not null));--> statement-breakpoint
ALTER TABLE "game_release_generations" ADD CONSTRAINT "game_release_generations_storage_retention_check" CHECK ((
        "game_release_generations"."storage_inactive_at" is null
        and "game_release_generations"."storage_retention_warned_at" is null
        and "game_release_generations"."storage_retention_eligible_at" is null
      ) or (
        "game_release_generations"."status" = 'ready'
        and "game_release_generations"."storage_inactive_at" is not null
        and (
          ("game_release_generations"."storage_retention_warned_at" is null and "game_release_generations"."storage_retention_eligible_at" is null)
          or (
            "game_release_generations"."storage_retention_warned_at" is not null
            and "game_release_generations"."storage_retention_eligible_at" is not null
            and "game_release_generations"."storage_retention_warned_at" >= "game_release_generations"."storage_inactive_at"
            and "game_release_generations"."storage_retention_eligible_at" >= "game_release_generations"."storage_inactive_at" + interval '180 days'
            and "game_release_generations"."storage_retention_eligible_at" >= "game_release_generations"."storage_retention_warned_at" + interval '7 days'
          )
        )
      ));--> statement-breakpoint
ALTER TABLE "game_release_generations" ADD CONSTRAINT "game_release_generations_storage_cleanup_check" CHECK (("game_release_generations"."storage_cleanup_started_at" is null and "game_release_generations"."storage_deleted_at" is null) or ("game_release_generations"."storage_cleanup_started_at" is not null and ("game_release_generations"."status" in ('failed', 'abandoned') or ("game_release_generations"."status" = 'ready' and "game_release_generations"."storage_retention_eligible_at" is not null)) and ("game_release_generations"."storage_deleted_at" is null or "game_release_generations"."storage_deleted_at" >= "game_release_generations"."storage_cleanup_started_at")));
