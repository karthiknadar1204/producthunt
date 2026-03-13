import { Hono } from "hono";
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

const productPostSchema = z.object({
  title: z.string().describe("product or launch name"),
  tagline: z.string().optional().describe("short one-line description"),
  link: z.string().url().optional().nullable().describe("link to the product or post page"),
});

const postsSchema = z.array(productPostSchema);

const rankingUpvotesSchema = z.object({
  ranking: z.number().optional().describe("position or rank number if visible"),
  upvotes: z.number().optional().describe("total upvote count for the product"),
});

const commentSchema = z.object({
  text: z.string().describe("comment body text"),
  upvotes: z.number().describe("number of upvotes on this comment"),
});
const commentsSchema = z.array(commentSchema);

const MAX_PRODUCTS_TO_DETAIL = 5;
const TOP_COMMENTS_PER_PRODUCT = 7;

const producthuntRouter = new Hono();

producthuntRouter.post("/posts", async (c) => {
  console.log("[producthunt] POST /posts — request started");

  const stagehand = new Stagehand({
    env: (process.env.STAGEHAND_ENV as "BROWSERBASE" | "LOCAL") ?? "LOCAL",
    model: process.env.STAGEHAND_MODEL ?? "openai/gpt-4o",
    verbose: 1,
  });

  try {
    console.log("[producthunt] Initializing Stagehand...");
    await stagehand.init();

    const page = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());
    console.log("[producthunt] Navigating to Product Hunt...");
    await page.goto("https://www.producthunt.com/", {
      waitUntil: "domcontentloaded",
      timeoutMs: 30_000,
    });

    console.log("[producthunt] Waiting for feed to render...");
    await new Promise((r) => setTimeout(r, 5000));

    console.log("[producthunt] Scrolling to main feed...");
    try {
      await stagehand.act("scroll down to the main list of product launch cards", { page, timeout: 30_000 });
    } catch (scrollErr) {
      console.log("[producthunt] Scroll skipped (continuing):", scrollErr instanceof Error ? scrollErr.message : scrollErr);
    }

    console.log("[producthunt] Finding feed container for targeted extraction...");
    const feedActions = await stagehand.observe(
      "find the main content area that contains the list of product launch cards with titles like 'Top Products Launching Today'",
      { page, timeout: 15_000 }
    );
    const feedSelector = feedActions[0]?.selector;

    const extractOptions: { page: typeof page; timeout: number; selector?: string } = { page, timeout: 60_000 };
    if (feedSelector) extractOptions.selector = feedSelector;

    console.log("[producthunt] Extracting post cards...");
    const posts = await stagehand.extract(
      "Extract every product launch card in this section. Each card has: a product title (e.g. Naoma AI, Needle 2.0), a short tagline, and optionally a link to the product page. Return one object per card with keys: title (string), tagline (string, optional), link (string URL to the product page, optional).",
      postsSchema,
      extractOptions
    );
    console.log("[producthunt] Extracted", posts.length, "posts");

    const withLinks = posts.filter((p): p is typeof p & { link: string } => !!p.link);
    const toDetail = withLinks.slice(0, MAX_PRODUCTS_TO_DETAIL);
    console.log("[producthunt] Visiting", toDetail.length, "product pages for ranking, upvotes, and top comments...");

    const products: Array<{
      title: string;
      tagline?: string;
      link: string;
      ranking?: number;
      upvotes?: number;
      topComments: Array<{ text: string; upvotes: number }>;
    }> = [];

    for (let i = 0; i < toDetail.length; i++) {
      const post = toDetail[i];
      const rankOnList = i + 1;
      console.log("[producthunt] Opening product", rankOnList, post.title, post.link);

      await page.goto(post.link, { waitUntil: "domcontentloaded", timeoutMs: 30_000 });
      await new Promise((r) => setTimeout(r, 3000));

      let ranking: number | undefined;
      let upvotes: number | undefined;
      try {
        const rankUp = await stagehand.extract(
          "Extract the product's upvote count and its ranking position (if shown on the page).",
          rankingUpvotesSchema,
          { page, timeout: 15_000 }
        );
        ranking = rankUp.ranking ?? rankOnList;
        upvotes = rankUp.upvotes;
      } catch {
        ranking = rankOnList;
      }

      try {
        await stagehand.act("scroll down to the comments section", { page, timeout: 20_000 });
      } catch {
        // continue without scroll
      }
      await new Promise((r) => setTimeout(r, 2000));

      let comments: Array<{ text: string; upvotes: number }> = [];
      try {
        const raw = await stagehand.extract(
          "Extract all visible comments: for each comment get the comment text and the number of upvotes. Return as array of objects with keys: text (string), upvotes (number).",
          commentsSchema,
          { page, timeout: 30_000 }
        );
        comments = raw
          .filter((c) => typeof c.upvotes === "number")
          .sort((a, b) => b.upvotes - a.upvotes)
          .slice(0, TOP_COMMENTS_PER_PRODUCT);
      } catch (e) {
        console.log("[producthunt] Comments extract failed for", post.title, e instanceof Error ? e.message : e);
      }

      products.push({
        title: post.title,
        tagline: post.tagline,
        link: post.link,
        ranking,
        upvotes,
        topComments: comments,
      });
    }

    console.log("[producthunt] Closing Stagehand...");
    await stagehand.close();

    console.log("[producthunt] Done — returning products with top comments");
    return c.json({ ok: true, products });
  } catch (err) {
    console.error("[producthunt] Error:", err);
    await stagehand.close().catch(() => {});
    const message = err instanceof Error ? err.message : "Stagehand run failed";
    return c.json({ ok: false, error: message }, 500);
  }
});

export default producthuntRouter;
