/**
 * VeRO/keyword filter (Section 5). Checks a product's title/description
 * against a configurable blocklist of restricted brand/trademark keywords
 * before it's ever published to eBay. On a match, the product must be
 * skipped and flagged for manual review — never published automatically.
 *
 * The blocklist lives in a plain text file (one keyword per line, case-
 * insensitive, `#` starts a comment) so it's easy to maintain without
 * touching code, per the "configurable blocklist" requirement.
 */
import fs from "fs";
import path from "path";

export interface VeroCheckResult {
  isBlocked: boolean;
  matchedKeywords: string[];
}

let cachedBlocklist: string[] | null = null;
let cachedBlocklistPath: string | null = null;

export function loadBlocklist(blocklistPath: string): string[] {
  if (cachedBlocklist && cachedBlocklistPath === blocklistPath) {
    return cachedBlocklist;
  }

  if (!fs.existsSync(blocklistPath)) {
    throw new Error(
      `VeRO blocklist file not found at ${blocklistPath}. Create it (see vero-blocklist.example.txt) before publishing any listings.`
    );
  }

  const raw = fs.readFileSync(blocklistPath, "utf-8");
  const keywords = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.toLowerCase());

  cachedBlocklist = keywords;
  cachedBlocklistPath = blocklistPath;
  return keywords;
}

/** Clears the cache — call after editing the blocklist file at runtime. */
export function clearBlocklistCache(): void {
  cachedBlocklist = null;
  cachedBlocklistPath = null;
}

/**
 * Checks title + description against the blocklist. Word-boundary matching
 * is used so e.g. "nike" doesn't false-positive on "unikey", but does match
 * "Nike Air Max" or "nike-branded".
 */
export function checkVero(
  title: string,
  description: string | undefined,
  blocklistPath: string
): VeroCheckResult {
  const keywords = loadBlocklist(blocklistPath);
  const haystack = `${title} ${description || ""}`.toLowerCase();

  const matched: string[] = [];
  for (const keyword of keywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    if (pattern.test(haystack)) {
      matched.push(keyword);
    }
  }

  return { isBlocked: matched.length > 0, matchedKeywords: matched };
}

export function defaultBlocklistPath(): string {
  return path.join(process.cwd(), "config", "vero-blocklist.txt");
}
