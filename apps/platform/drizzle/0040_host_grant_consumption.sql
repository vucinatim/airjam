-- airjam:migration-mode=online
-- airjam:verify=table:realtime_host_grant_consumptions
-- airjam:verify=constraint:realtime_host_grant_consumptions.realtime_host_grant_consumptions_required_text_check
-- airjam:verify=constraint:realtime_host_grant_consumptions.realtime_host_grant_consumptions_session_kind_check
-- airjam:verify=constraint:realtime_host_grant_consumptions.realtime_host_grant_consumptions_intent_check
-- airjam:verify=constraint:realtime_host_grant_consumptions.realtime_host_grant_consumptions_chronology_check
-- airjam:verify=index:realtime_host_grant_consumptions_expiry_idx
CREATE TABLE "realtime_host_grant_consumptions" (
	"jti" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"abuse_session_id" text NOT NULL,
	"session_kind" text NOT NULL,
	"intent" text NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "realtime_host_grant_consumptions_required_text_check" CHECK (length(btrim("realtime_host_grant_consumptions"."jti")) > 0 and length(btrim("realtime_host_grant_consumptions"."app_id")) > 0 and length(btrim("realtime_host_grant_consumptions"."abuse_session_id")) > 0),
	CONSTRAINT "realtime_host_grant_consumptions_session_kind_check" CHECK ("realtime_host_grant_consumptions"."session_kind" in ('game', 'system')),
	CONSTRAINT "realtime_host_grant_consumptions_intent_check" CHECK ("realtime_host_grant_consumptions"."intent" in ('create_room', 'system_register')),
	CONSTRAINT "realtime_host_grant_consumptions_chronology_check" CHECK ("realtime_host_grant_consumptions"."expires_at" > "realtime_host_grant_consumptions"."consumed_at")
);
--> statement-breakpoint
CREATE INDEX "realtime_host_grant_consumptions_expiry_idx" ON "realtime_host_grant_consumptions" USING btree ("expires_at");
