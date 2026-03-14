CREATE TYPE "public"."product_status" AS ENUM('pending', 'processed', 'skipped');--> statement-breakpoint
CREATE TABLE "comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" serial NOT NULL,
	"comment_text" text NOT NULL,
	"posted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"ph_product_id" text,
	"url" text,
	"title" text NOT NULL,
	"tagline" text,
	"link" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"status" "product_status" DEFAULT 'pending',
	CONSTRAINT "products_ph_product_id_unique" UNIQUE("ph_product_id"),
	CONSTRAINT "products_url_unique" UNIQUE("url")
);
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;