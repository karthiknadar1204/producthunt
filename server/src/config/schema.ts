import { pgTable, serial, text, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const productStatusEnum = pgEnum('product_status', ['pending', 'processed', 'skipped', 'failed']);

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  phProductId: text("ph_product_id").unique(),
  url: text("url").unique(),
  title: text("title").notNull(),
  tagline: text("tagline"),
  link: text("link"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
  status: productStatusEnum("status").default("pending"),
  processingError: text("processing_error"),
});

export const comments = pgTable("comments", {
  id: serial("id").primaryKey(),
  productId: serial("product_id")
    .references(() => products.id, { onDelete: "cascade" })
    .notNull(),
  commentText: text("comment_text").notNull(),
  postedAt: timestamp("posted_at").defaultNow().notNull(),
});
