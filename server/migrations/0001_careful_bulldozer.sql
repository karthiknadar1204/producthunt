ALTER TYPE "public"."product_status" ADD VALUE 'failed';--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "processing_error" text;