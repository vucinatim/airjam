-- airjam:migration-mode=online
-- airjam:verify=table:realtime_admission_instances
-- airjam:verify=table:realtime_room_admission_leases
-- airjam:verify=table:realtime_controller_admission_leases
-- airjam:verify=constraint:app_ids.app_ids_creator_id_not_null_check
-- airjam:verify=constraint:realtime_room_admission_leases.realtime_room_admission_instance_fk
-- airjam:verify=constraint:realtime_room_admission_leases.realtime_room_admission_leases_identity_key
-- airjam:verify=constraint:realtime_controller_admission_leases.realtime_controller_admission_room_fk
CREATE TABLE "realtime_admission_instances" (
	"instance_id" text PRIMARY KEY NOT NULL,
	"lease_token" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"draining_at" timestamp with time zone,
	CONSTRAINT "realtime_admission_instances_lease_token_unique" UNIQUE("lease_token"),
	CONSTRAINT "realtime_admission_instances_required_text_check" CHECK (length(btrim("realtime_admission_instances"."instance_id")) > 0 and length(btrim("realtime_admission_instances"."lease_token")) > 0),
	CONSTRAINT "realtime_admission_instances_chronology_check" CHECK ("realtime_admission_instances"."heartbeat_at" >= "realtime_admission_instances"."started_at" and "realtime_admission_instances"."expires_at" > "realtime_admission_instances"."heartbeat_at" and ("realtime_admission_instances"."draining_at" is null or "realtime_admission_instances"."draining_at" >= "realtime_admission_instances"."started_at"))
);
--> statement-breakpoint
CREATE TABLE "realtime_controller_admission_leases" (
	"room_id" text NOT NULL,
	"controller_id" text NOT NULL,
	"lease_token" text NOT NULL,
	"instance_id" text NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"resume_expires_at" timestamp with time zone,
	CONSTRAINT "realtime_controller_admission_leases_room_id_controller_id_pk" PRIMARY KEY("room_id","controller_id"),
	CONSTRAINT "realtime_controller_admission_leases_lease_token_unique" UNIQUE("lease_token"),
	CONSTRAINT "realtime_controller_admission_leases_required_text_check" CHECK (length(btrim("realtime_controller_admission_leases"."room_id")) > 0 and length(btrim("realtime_controller_admission_leases"."controller_id")) > 0 and length(btrim("realtime_controller_admission_leases"."lease_token")) > 0 and length(btrim("realtime_controller_admission_leases"."instance_id")) > 0),
	CONSTRAINT "realtime_controller_admission_leases_resume_check" CHECK (("realtime_controller_admission_leases"."disconnected_at" is null and "realtime_controller_admission_leases"."resume_expires_at" is null) or ("realtime_controller_admission_leases"."disconnected_at" is not null and "realtime_controller_admission_leases"."resume_expires_at" > "realtime_controller_admission_leases"."disconnected_at"))
);
--> statement-breakpoint
CREATE TABLE "realtime_room_admission_leases" (
	"room_id" text PRIMARY KEY NOT NULL,
	"lease_token" text NOT NULL,
	"instance_id" text NOT NULL,
	"app_id" text,
	"game_id" text,
	"creator_id" text,
	"max_controllers" integer NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "realtime_room_admission_leases_lease_token_unique" UNIQUE("lease_token"),
	CONSTRAINT "realtime_room_admission_leases_identity_key" UNIQUE("room_id","instance_id"),
	CONSTRAINT "realtime_room_admission_leases_required_text_check" CHECK (length(btrim("realtime_room_admission_leases"."room_id")) > 0 and length(btrim("realtime_room_admission_leases"."lease_token")) > 0 and length(btrim("realtime_room_admission_leases"."instance_id")) > 0),
	CONSTRAINT "realtime_room_admission_leases_max_controllers_check" CHECK ("realtime_room_admission_leases"."max_controllers" > 0)
);
--> statement-breakpoint
UPDATE "app_ids"
SET "creator_id" = "games"."user_id"
FROM "games"
WHERE "games"."id" = "app_ids"."game_id"
  AND "app_ids"."creator_id" IS NULL;--> statement-breakpoint
ALTER TABLE "app_ids" ADD CONSTRAINT "app_ids_creator_id_not_null_check" CHECK ("app_ids"."creator_id" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "app_ids" VALIDATE CONSTRAINT "app_ids_creator_id_not_null_check";--> statement-breakpoint
ALTER TABLE "app_ids" ALTER COLUMN "creator_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "realtime_controller_admission_leases" ADD CONSTRAINT "realtime_controller_admission_room_fk" FOREIGN KEY ("room_id","instance_id") REFERENCES "public"."realtime_room_admission_leases"("room_id","instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "realtime_room_admission_leases" ADD CONSTRAINT "realtime_room_admission_instance_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."realtime_admission_instances"("instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "realtime_admission_instances_expiry_idx" ON "realtime_admission_instances" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "realtime_controller_admission_leases_resume_expiry_idx" ON "realtime_controller_admission_leases" USING btree ("resume_expires_at");--> statement-breakpoint
CREATE INDEX "realtime_controller_admission_leases_instance_idx" ON "realtime_controller_admission_leases" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "realtime_room_admission_leases_creator_idx" ON "realtime_room_admission_leases" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "realtime_room_admission_leases_game_idx" ON "realtime_room_admission_leases" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "realtime_room_admission_leases_instance_idx" ON "realtime_room_admission_leases" USING btree ("instance_id");
