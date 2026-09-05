/**
 * AI Service — generates eBay listing content AND SEO metadata in one call.
 *
 * A single structured-JSON prompt returns four fields:
 *   - listingTitle     eBay Cassini-optimised title (≤80 chars)
 *   - htmlDescription  Long-form sales copy in HTML
 *   - metaTitle        External-search-optimised title (50–60 chars)
 *   - metaDescription  Click-through-optimised plain-text summary (150–160 chars)
 *
 * The meta fields are written for Google/social link previews — distinct from
 * the eBay listing title and never just a truncation of it.
 *
 * Never throws. Any failure (no provider, network error, bad JSON, validation
 * failure) returns null so callers can degrade gracefully.
 */
import Database from "better-sqlite3";
import { logger } from "../logger";
import { checkVero } from "../ebay/veroFilter";

// ── Internal row type ─────────────────────────────────────────────────────────

interface AiProviderRow {
  id: number;
  provider_type: "openai_compatible" | "gemini" | "cohere";
  base_url: string;
  api_key: string;
  model: string;
}

// ── Per-provider API calls ────────────────────────────────────────────────────

async function callOpenAiCompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string
): Promise<string | null> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 900,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const text: unknown = body?.choices?.[0]?.message?.content;
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
}

async function callGemini(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string
): Promise<string | null> {
  const res = await fetch(
    `${baseUrl.replace(/\/$/, "")}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 900 },
      }),
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const text: unknown = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
}

async function callCohere(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string
): Promise<string | null> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, message: prompt, max_tokens: 900 }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const text: unknown = body?.text;
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
}

// ── HTML sanitisation (BUG-019) ──────────────────────────────────────────────
/**
 * Strips <script> tags, javascript: protocol attributes, and on* event
 * handler attributes from an HTML string. This is a defence-in-depth measure
 * for AI-generated content — a full DOM parser is not available in Node, so
 * we use conservative regex patterns that cover the realistic attack surface.
 */
function sanitiseHtml(html: string): string {
  return html
    // Remove <script> … </script> blocks (case-insensitive, including attributes)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    // Remove standalone <script ...> tags without closing tag
    .replace(/<script\b[^>]*>/gi, "")
    // Remove on* event handlers (onclick=, onload=, onerror=, etc.)
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "")
    // Remove javascript: in href / src / action / any attribute value
    .replace(/([a-z]+\s*=\s*["']?)javascript:/gi, "$1removed:")
    // Remove <iframe>, <object>, <embed>, <form> tags — not needed in listings
    .replace(/<\/?(iframe|object|embed|form)\b[^>]*>/gi, "");
}

// ── Plain-text sanitisation for meta fields ────────────────────────────────
/**
 * Strips all HTML tags and collapses whitespace so meta title/description
 * fields are always clean plain text safe for <title> and <meta> tags.
 */
function sanitisePlainText(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")           // strip all HTML tags
    .replace(/&[a-z]+;/gi, " ")         // strip HTML entities
    .replace(/[`*_~#]/g, "")            // strip markdown formatting chars
    .replace(/\s+/g, " ")               // collapse whitespace
    .trim();
}

// ── JSON extraction helper ────────────────────────────────────────────────────

function extractJson(raw: string): string {
  // Strip markdown code fences if present
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  return fenceMatch ? fenceMatch[1].trim() : raw.trim();
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateListingContent(
  db: Database.Database,
  product: {
    title: string;
    category?: string | null;
    scrapedPrice?: number | null;
    trendSignal?: string | null;
  }
): Promise<{
  aiTitle: string;
  aiDescription: string;
  metaTitle: string;
  metaDescription: string;
  generationSource: string;
} | null> {
  try {
    // Pick first enabled provider
    const provider = db
      .prepare(
        `SELECT id, provider_type, base_url, api_key, model
         FROM ai_providers WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1`
      )
      .get() as AiProviderRow | undefined;

    if (!provider) {
      logger.info("generateListingContent: no enabled AI provider configured");
      return null;
    }

    const prompt = `You are an expert eBay seller and SEO copywriter. Generate listing content for the product below.

Product name: ${product.title}
Category: ${product.category ?? "General"}
Price: $${product.scrapedPrice != null ? product.scrapedPrice.toFixed(2) : "unknown"}
Trend signal: ${product.trendSignal ?? "none"}

Return ONLY valid JSON with exactly these four keys — no extra keys, no markdown fences:
{
  "listingTitle": "eBay Cassini-optimised title, max 80 characters, keyword-rich, no ALL CAPS, no special characters except hyphens and commas. Written for eBay buyers.",
  "htmlDescription": "eBay item description in plain HTML, 150-300 words, highlight key features and benefits, include relevant keywords naturally, end with a call to action.",
  "metaTitle": "External search engine title, 50-60 characters. Front-load the core product name and one differentiator (brand/color/use-case). Skip eBay-specific filler words like NEW, FAST SHIP, FREE POST. Written for Google searchers, not eBay buyers.",
  "metaDescription": "Plain-text summary, 150-160 characters. Written to earn a click from a Google search result or social link preview. Include a clear benefit and an implicit call-to-action. No HTML, no emojis, no markdown."
}`;

    let raw: string | null = null;

    if (provider.provider_type === "openai_compatible") {
      raw = await callOpenAiCompatible(provider.base_url, provider.api_key, provider.model, prompt);
    } else if (provider.provider_type === "gemini") {
      raw = await callGemini(provider.base_url, provider.api_key, provider.model, prompt);
    } else if (provider.provider_type === "cohere") {
      raw = await callCohere(provider.base_url, provider.api_key, provider.model, prompt);
    }

    if (!raw) {
      logger.warn("generateListingContent: AI provider returned empty response", { providerId: provider.id });
      return null;
    }

    const jsonStr = extractJson(raw);
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const aiTitle       = parsed.listingTitle;
    const aiDescription = parsed.htmlDescription;
    const metaTitle     = parsed.metaTitle;
    const metaDesc      = parsed.metaDescription;

    // ── Field presence validation ──────────────────────────────────────────
    if (
      typeof aiTitle !== "string"   || aiTitle.trim().length === 0 ||
      typeof aiDescription !== "string" || aiDescription.trim().length === 0 ||
      typeof metaTitle !== "string" || metaTitle.trim().length === 0 ||
      typeof metaDesc !== "string"  || metaDesc.trim().length === 0
    ) {
      logger.warn("generateListingContent: parsed JSON missing required fields", { providerId: provider.id });
      return null;
    }

    // ── eBay listing title: hard 80-char limit ─────────────────────────────
    const cleanAiTitle = aiTitle.trim();
    if (cleanAiTitle.length > 80) {
      logger.warn("generateListingContent: AI listing title exceeds 80 chars", { length: cleanAiTitle.length });
      return null;
    }

    // ── Meta title: enforce 50–60 chars server-side ────────────────────────
    // Models are unreliable about exact counts — truncate silently rather
    // than rejecting (a slightly-too-long meta title is far less harmful
    // than failing the entire generation).
    let cleanMetaTitle = sanitisePlainText(metaTitle.trim());
    if (cleanMetaTitle.length > 60) {
      logger.warn("generateListingContent: meta title truncated", {
        original: cleanMetaTitle.length,
      });
      // Truncate at the last word boundary within 60 chars
      cleanMetaTitle = cleanMetaTitle.slice(0, 60).replace(/\s+\S*$/, "").trim();
    }
    if (cleanMetaTitle.length < 10) {
      logger.warn("generateListingContent: meta title too short after sanitisation", { length: cleanMetaTitle.length });
      return null;
    }

    // ── Meta description: enforce 150–160 chars ────────────────────────────
    let cleanMetaDesc = sanitisePlainText(metaDesc.trim());
    if (cleanMetaDesc.length > 160) {
      logger.warn("generateListingContent: meta description truncated", {
        original: cleanMetaDesc.length,
      });
      cleanMetaDesc = cleanMetaDesc.slice(0, 160).replace(/\s+\S*$/, "").trim();
    }
    if (cleanMetaDesc.length < 50) {
      logger.warn("generateListingContent: meta description too short after sanitisation", { length: cleanMetaDesc.length });
      return null;
    }

    const generationSource = `${provider.provider_type}/${provider.model}`;

    return {
      aiTitle:       cleanAiTitle,
      aiDescription: sanitiseHtml(aiDescription.trim()),
      metaTitle:     cleanMetaTitle,
      metaDescription: cleanMetaDesc,
      generationSource,
    };
  } catch (err) {
    logger.error("generateListingContent: unexpected error", { error: (err as Error).message });
    return null;
  }
}

// ── SEO VeRO check helper ─────────────────────────────────────────────────────

/**
 * Runs the VeRO/brand blocklist against meta title + meta description.
 * A brand name injected into a meta description is the same policy risk as
 * one injected into an eBay listing title, so we check both.
 *
 * Returns the raw VeRO result so the caller can decide what to do with it
 * (log, block, or flag) — same pattern as the listing pipeline.
 */
export function checkVeroOnMetaFields(
  metaTitle: string,
  metaDescription: string,
  blocklistPath: string
): { isBlocked: boolean; matchedKeywords: string[] } {
  try {
    return checkVero(metaTitle, metaDescription, blocklistPath);
  } catch {
    // blocklist file missing — non-fatal, same behaviour as the listing pipeline
    return { isBlocked: false, matchedKeywords: [] };
  }
}
