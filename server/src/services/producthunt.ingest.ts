import { Stagehand } from "@browserbasehq/stagehand";
import OpenAI from "openai";
import { z } from "zod";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type ExportedCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expirationDate?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string | null;
};

export function toStagehandCookie(c: ExportedCookie): {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
} {
  const sameSite = c.sameSite === "lax" ? "Lax" : c.sameSite === "strict" ? "Strict" : c.sameSite === "none" ? "None" : undefined;
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    ...(c.expirationDate != null && c.expirationDate > 0 ? { expires: Math.floor(c.expirationDate) } : {}),
    ...(c.httpOnly != null ? { httpOnly: c.httpOnly } : {}),
    ...(c.secure != null ? { secure: c.secure } : {}),
    ...(sameSite ? { sameSite } : {}),
  };
}

const productPostSchema = z.object({
  title: z.string(),
  tagline: z.string().optional().nullable(),
  link: z.string().url().optional().nullable(),
});
const postsSchema = z.array(productPostSchema);

const rankingUpvotesSchema = z.object({
  ranking: z.number().optional(),
  upvotes: z.number().optional(),
});
const commentSchema = z.object({ text: z.string(), upvotes: z.number() });
const commentsSchema = z.array(commentSchema);

const MAX_PRODUCTS_TO_DETAIL = 5;
const TOP_COMMENTS_PER_PRODUCT = 7;

async function analyzeAndSuggestComment(
  productTitle: string,
  topComments: Array<{ text: string; upvotes: number }>
): Promise<{ analysis: string; suggestedComment: string }> {
  if (topComments.length === 0) return { analysis: "", suggestedComment: "" };
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: `Product: "${productTitle}". Top upvoted comments:\n${topComments.map((c) => `[${c.upvotes} upvotes] ${c.text}`).join("\n\n")}\n\nIn 1–2 sentences: what makes these comments work? Then write ONE short comment in the same tone. Reply:\nANALYSIS: <1-2 sentences>\nCOMMENT: <your comment>`,
      },
    ],
    max_tokens: 300,
  });
  const text = res.choices[0]?.message?.content?.trim() ?? "";
  const analysisMatch = text.match(/ANALYSIS:\s*(.+?)(?=COMMENT:|$)/is);
  const commentMatch = text.match(/COMMENT:\s*(.+?)$/is);
  return {
    analysis: analysisMatch?.[1]?.trim() ?? "",
    suggestedComment: commentMatch?.[1]?.trim() ?? "",
  };
}

export type FeedItem = { title: string; tagline?: string; link: string };

/** Assumes stagehand is inited and page exists. Caller must have navigated to PH. */
async function getFeedWithStagehand(stagehand: Stagehand): Promise<FeedItem[]> {
  const page = stagehand.context.pages()[0]!;
  await new Promise((r) => setTimeout(r, 5000));
  try {
    await stagehand.act("scroll down to the main list of product launch cards", { page, timeout: 30_000 });
  } catch (_) {}
  const feedActions = await stagehand.observe(
    "find the main content area that contains the list of product launch cards with titles like 'Top Products Launching Today'",
    { page, timeout: 15_000 }
  );
  const feedSelector = feedActions[0]?.selector;
  const extractOptions: { page: typeof page; timeout: number; selector?: string } = { page, timeout: 60_000 };
  if (feedSelector) extractOptions.selector = feedSelector;
  const posts = await stagehand.extract(
    "Extract every product launch card. Each card: title, tagline (optional), link (optional URL). Keys: title, tagline, link.",
    postsSchema,
    extractOptions
  );
  const withLinks = posts.filter((p): p is typeof p & { link: string } => !!p.link);
  return withLinks.slice(0, MAX_PRODUCTS_TO_DETAIL).map((p) => ({ title: p.title, tagline: p.tagline ?? undefined, link: p.link }));
}

/** Fetch only feed data (title, tagline, link) for products table. No product page visits. */
export async function fetchProductHuntFeed(): Promise<FeedItem[]> {
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
  const page = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());
  await page.goto("https://www.producthunt.com/", { waitUntil: "domcontentloaded", timeoutMs: 30_000 });
  const feed = await getFeedWithStagehand(stagehand);
  await stagehand.close();
  return feed;
}

/** Try to type comment and submit using Playwright selectors (fallback when Stagehand picks wrong element). */
async function typeCommentAndSubmitWithPlaywright(page: { locator: (s: string) => { count: () => Promise<number>; first: () => { fill: (t: string) => Promise<void> } }; evaluate: (fn: () => boolean) => Promise<boolean> }, suggestedComment: string): Promise<boolean> {
  const textarea = page.locator("textarea");
  if ((await textarea.count()) > 0) {
    await textarea.first().fill(suggestedComment);
  } else {
    const ce = page.locator('[contenteditable="true"]');
    if ((await ce.count()) > 0) {
      await ce.first().fill(suggestedComment);
    } else {
      return false;
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], input[type='submit']"));
    for (const el of candidates) {
      const text = (el.textContent || (el as HTMLInputElement).value || "").trim();
      if (text === "Comment") {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  });
}

/** Process one product: visit page, get comments, suggest and post comment. Does not init/close stagehand. */
export async function processOneProduct(
  stagehand: Stagehand,
  product: { link: string; title: string; tagline?: string }
): Promise<{ suggestedComment?: string; commentPosted: boolean; error?: string }> {
  const page = stagehand.context.pages()[0]!;
  await page.goto(product.link, { waitUntil: "domcontentloaded", timeoutMs: 30_000 });
  await new Promise((r) => setTimeout(r, 3000));

  try {
    await stagehand.act("scroll down to the comments section", { page, timeout: 20_000 });
  } catch {}
  await new Promise((r) => setTimeout(r, 2000));

  let comments: Array<{ text: string; upvotes: number }> = [];
  try {
    const raw = await stagehand.extract(
      "Extract visible comments: text and upvotes. Array of { text, upvotes }.",
      commentsSchema,
      { page, timeout: 30_000 }
    );
    comments = raw
      .filter((c) => typeof c.upvotes === "number")
      .sort((a, b) => b.upvotes - a.upvotes)
      .slice(0, TOP_COMMENTS_PER_PRODUCT);
  } catch (_) {}

  let suggestedComment = "";
  let commentPosted = false;
  let error: string | undefined;
  if (comments.length > 0) {
    const result = await analyzeAndSuggestComment(product.title, comments);
    suggestedComment = result.suggestedComment;
    if (suggestedComment) {
      let typed = false;
      try {
        await stagehand.act("type %comment% into the comment box", { page, timeout: 15_000, variables: { comment: suggestedComment } });
        typed = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("unsupported-element") || msg.includes("fill") || msg.includes("Failed to fill")) {
          try {
            commentPosted = await typeCommentAndSubmitWithPlaywright(page, suggestedComment);
            typed = true;
            if (!commentPosted) error = "Playwright fallback: comment not submitted";
          } catch (fallbackErr) {
            error = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          }
        } else {
          error = msg;
        }
      }
      if (typed && !commentPosted) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const clicked = await page.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll("button, [role='button'], input[type='submit']"));
            for (const el of candidates) {
              const text = (el.textContent || (el as HTMLInputElement).value || "").trim();
              if (text === "Comment") {
                (el as HTMLElement).click();
                return true;
              }
            }
            return false;
          });
          if (clicked) commentPosted = true;
        } catch (_) {}
      }
      if (!commentPosted && !error) {
        try {
          const actions = await stagehand.observe("find the Comment button next to Cancel at the bottom of the comment box", { page, timeout: 10_000 });
          const toClick = actions.find((a) => a.method === "click" && a.description?.toLowerCase().includes("comment"));
          if (toClick) {
            await stagehand.act(toClick, { page, timeout: 10_000 });
            commentPosted = true;
          }
        } catch (_) {}
      }
      if (!commentPosted && !error) {
        try {
          await stagehand.act("click the Comment button next to the Cancel button", { page, timeout: 12_000 });
          commentPosted = true;
        } catch (_) {}
      }
      if (!commentPosted && !error) error = "Could not submit comment (button not found or click failed)";
    }
  }
  return { suggestedComment: suggestedComment || undefined, commentPosted, error };
}

export type IngestProduct = {
  title: string;
  tagline?: string;
  link: string;
  ranking?: number;
  upvotes?: number;
  topComments: Array<{ text: string; upvotes: number }>;
  analysis?: string;
  suggestedComment?: string;
  commentPosted?: boolean;
};

/** Full flow in one go (for POST /posts): fetch feed then process each product. */
export async function runProductHuntIngestion(): Promise<{ products: IngestProduct[] }> {
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
  const page = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());
  await page.goto("https://www.producthunt.com/", { waitUntil: "domcontentloaded", timeoutMs: 30_000 });
  const feed = await getFeedWithStagehand(stagehand);
  const products: IngestProduct[] = [];
  for (const p of feed) {
    const result = await processOneProduct(stagehand, p);
    products.push({
      ...p,
      topComments: [],
      suggestedComment: result.suggestedComment,
      commentPosted: result.commentPosted,
    });
  }
  await stagehand.close();
  return { products };
}
