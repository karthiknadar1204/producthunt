import type { Context } from "hono";
import { Queue } from "bullmq";
import redis from "../utils/redis";
import { db } from "../config/db";
import { products } from "../config/schema";
import { fetchProductHuntFeed } from "../services/producthunt.ingest";

const producthuntQueue = new Queue("producthunt", {
  connection: redis as import("bullmq").ConnectionOptions,
});

const RATE_LIMIT = 100;
const WINDOW_MS = 60_000;
const DEDUPE_TTL = 300;

export async function ingest(c: Context) {
  const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "127.0.0.1";

  const rateKey = `rate:producthunt:${ip}`;
  const requests = await redis.incr(rateKey);
  if (requests === 1) await redis.expire(rateKey, Math.floor(WINDOW_MS / 1000));
  if (requests > RATE_LIMIT) {
    return c.json({ error: "Rate limited", retryAfter: 60 }, 429);
  }

  const dedupeKey = "dedupe:producthunt:ingest";
  const exists = await redis.set(dedupeKey, "1", "EX", DEDUPE_TTL, "NX");
  if (!exists) {
    return c.json({ error: "Ingest already in progress", retry: true }, 409);
  }

  const feed = await fetchProductHuntFeed();
  for (const p of feed) {
    await db
      .insert(products)
      .values({
        url: p.link,
        link: p.link,
        title: p.title,
        tagline: p.tagline ?? null,
        status: "pending",
      })
      .onConflictDoNothing({ target: products.url });
  }

  const job = await producthuntQueue.add(
    "process",
    {},
    {
      attempts: 3,
      backoff: { type: "fixed", delay: 1000 },
    }
  );

  return c.json(
    {
      message: "Ingest queued",
      jobId: job.id,
      status: "pending",
    },
    202
  );
}
