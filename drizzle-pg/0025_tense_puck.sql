ALTER TABLE "audit_lighthouse_results" ADD COLUMN "screenshot_r2_key" text;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "og_image_url" text;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "og_image_alt" text;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "og_image_width" integer;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "og_image_height" integer;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "twitter_image" text;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "favicons_json" text;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "google_site_verification" text;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "bing_site_verification" text;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "analytics_ids_json" text;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "share_password_hash" text;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "share_created_at" text;--> statement-breakpoint
CREATE UNIQUE INDEX "audits_share_token_idx" ON "audits" USING btree ("share_token");