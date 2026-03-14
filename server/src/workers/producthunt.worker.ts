import "dotenv/config";
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import redis from "../utils/redis";
import { db } from "../config/db";
import { products, comments } from "../config/schema";
import { processOneProduct, toStagehandCookie, type ExportedCookie } from "../services/producthunt.ingest";
import { Stagehand } from "@browserbasehq/stagehand";

const worker = new Worker(
  "producthunt",
  async (job) => {
    const pending = await db.select().from(products).where(eq(products.status, "pending"));
    if (pending.length === 0) {
      await redis.del("dedupe:producthunt:ingest");
      return { status: "success", count: 0 };
    }

    const stagehand = new Stagehand({
      env: (process.env.STAGEHAND_ENV as "BROWSERBASE" | "LOCAL") ?? "LOCAL",
      model: process.env.STAGEHAND_MODEL ?? "openai/gpt-4o-mini",
      verbose: 1,
    });
    await stagehand.init();
    const cookiesJson = process.env.PRODUCTHUNT_COOKIES_JSON;
    if (cookiesJson) {
      try {
        const exported = JSON.parse(cookiesJson) as ExportedCookie[];
        await stagehand.context.addCookies(exported.map(toStagehandCookie));
      } catch (_) {}
    }
    if (!stagehand.context.pages().length) await stagehand.context.newPage();

    for (const product of pending) {
      const link = product.link ?? product.url;
      if (!link) {
        await db
          .update(products)
          .set({ processedAt: new Date(), status: "failed", processingError: "Missing link/url" })
          .where(eq(products.id, product.id));
        continue;
      }
      let result: { suggestedComment?: string; commentPosted: boolean; error?: string };
      try {
        result = await processOneProduct(stagehand, {
          link,
          title: product.title,
          tagline: product.tagline ?? undefined,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db
          .update(products)
          .set({ processedAt: new Date(), status: "failed", processingError: msg })
          .where(eq(products.id, product.id));
        continue;
      }
      const hadCommentToPost = result.suggestedComment != null && result.suggestedComment !== "";
      const failed =
        result.error ||
        (hadCommentToPost && !result.commentPosted);
      const status = failed ? "failed" : "processed";
      const processingError = failed ? (result.error ?? "Comment not posted") : null;
      await db
        .update(products)
        .set({
          processedAt: new Date(),
          status,
          processingError,
        })
        .where(eq(products.id, product.id));
      if (result.commentPosted && result.suggestedComment) {
        await db.insert(comments).values({
          productId: product.id,
          commentText: result.suggestedComment,
        });
      }
    }

    await stagehand.close();
    await redis.del("dedupe:producthunt:ingest");
    return { status: "success", count: pending.length };
  },
  {
    connection: redis as import("bullmq").ConnectionOptions,
    concurrency: 1,
  }
);

worker.on("failed", (job, err) => {
  console.log(`Job ${job?.id} failed: ${err.message}`);
});
