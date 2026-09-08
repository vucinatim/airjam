-- airjam:migration-mode=online
-- airjam:verify=table:app_ids
-- airjam:verify=constraint:app_ids.app_ids_game_creator_fk
ALTER TABLE "app_ids" ADD COLUMN "creator_id" text;--> statement-breakpoint
UPDATE "app_ids"
SET "creator_id" = "games"."user_id"
FROM "games"
WHERE "games"."id" = "app_ids"."game_id"
  AND "app_ids"."creator_id" IS NULL;--> statement-breakpoint
ALTER TABLE "app_ids" ADD CONSTRAINT "app_ids_game_creator_fk" FOREIGN KEY ("game_id","creator_id") REFERENCES "public"."games"("id","user_id") ON DELETE no action ON UPDATE no action;
