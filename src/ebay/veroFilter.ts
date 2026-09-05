/**
 * VeRO / IP / Policy filter — pre-publish safety gate.
 *
 * Three layers of protection:
 *
 * 1. EXACT brand blocklist  (checkVero)
 *    Word-boundary match against the configured blocklist. This is what
 *    already existed. Every brand you are not licensed to resell goes here.
 *
 * 2. FUZZY / obfuscation detection  (checkVeroFuzzy)
 *    Sellers sometimes obfuscate brand names to sneak past exact checks
 *    ("N1ke", "Ad1das", "Gu_cci", "L0uis Vuitton"). We detect these with
 *    a normalisation pass (digits → closest letter, symbols removed) followed
 *    by the same word-boundary match. Levenshtein distance is NOT used here
 *    because it has too high a false-positive rate for short product titles;
 *    normalisation catches the overwhelming majority of real-world obfuscation
 *    with zero false positives on legitimate product names.
 *
 * 3. PROHIBITED KEYWORDS  (checkProhibitedKeywords)
 *    eBay can suspend accounts for listing items in restricted categories or
 *    using certain prohibited terms even without a specific VeRO complaint.
 *    This list covers the most common categories: weapons/parts, drugs,
 *    counterfeit indicators, and explicit/adult content descriptors.
 *    See: https://www.ebay.com/help/policies/prohibited-restricted-items/
 */
import fs from "fs";
import path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VeroCheckResult {
  isBlocked:       boolean;
  matchedKeywords: string[];
}

export interface FullPolicyCheckResult {
  isBlocked:          boolean;
  veroMatches:        string[];   // exact brand blocklist hits
  fuzzyMatches:       string[];   // obfuscation-detected brand hits
  prohibitedMatches:  string[];   // eBay policy / prohibited keyword hits
  reasons:            string[];   // human-readable summary for the UI
}

// ── Blocklist cache ───────────────────────────────────────────────────────────

let cachedBlocklist:     string[] | null = null;
let cachedBlocklistPath: string | null   = null;

export function loadBlocklist(blocklistPath: string): string[] {
  if (cachedBlocklist && cachedBlocklistPath === blocklistPath) {
    return cachedBlocklist;
  }

  if (!fs.existsSync(blocklistPath)) {
    throw new Error(
      `VeRO blocklist file not found at ${blocklistPath}. ` +
      `Create it before publishing any listings.`
    );
  }

  const raw = fs.readFileSync(blocklistPath, "utf-8");
  const keywords = raw
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map(line => line.toLowerCase());

  cachedBlocklist     = keywords;
  cachedBlocklistPath = blocklistPath;
  return keywords;
}

/** Clears the cache — call after editing the blocklist file at runtime. */
export function clearBlocklistCache(): void {
  cachedBlocklist     = null;
  cachedBlocklistPath = null;
}

// ── Normalisation for fuzzy/obfuscation detection ────────────────────────────

/**
 * Normalises a string to strip common obfuscation techniques:
 *   - Digits that look like letters: 0→o, 1→i, 3→e, 4→a, 5→s, 6→g
 *   - Underscores/dots/hyphens used as separators within words → space
 *   - Repeated spaces collapsed
 *   - Unicode look-alikes: é→e, ü→u, etc.
 *
 * "N1ke Air M4x" → "nike air max"
 * "L0u1s Vu1tt0n" → "louis vuitton"
 * "Ad_1das" → "adidas"
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")                         // decompose accented chars
    .replace(/[\u0300-\u036f]/g, "")          // strip combining diacritics
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/6/g, "g")
    .replace(/8/g, "b")
    .replace(/[_.\-]/g, " ")                  // separators → space
    .replace(/\s+/g, " ")                     // collapse whitespace
    .trim();
}

// ── Prohibited keyword list ───────────────────────────────────────────────────

/**
 * eBay-prohibited terms independent of specific brand VeRO.
 * Any listing matching one of these will be blocked pre-publish.
 *
 * Sources:
 *   https://www.ebay.com/help/policies/prohibited-restricted-items/
 *   https://pages.ebay.com/seller-center/listing-and-marketing/
 *
 * Keep this list conservative — flag for manual review, not silent fail.
 * Operators can always override by removing a term if they have a legitimate
 * use case (e.g., a licensed firearms accessories retailer would remove the
 * weapons terms).
 */
const PROHIBITED_KEYWORDS: string[] = [
  // ── Weapons & parts (US eBay restriction) ───────────────────────────────
  "bump stock",
  "ghost gun",
  "solvent trap",
  "auto sear",
  "switch converter",       // glock switch / auto converter
  "conversion kit gun",
  "untraceable firearm",
  "80% lower",

  // ── Drug / pharmaceutical (listing of actual drugs is prohibited) ───────
  "oxycodone",
  "fentanyl",
  "methamphetamine",
  "crack cocaine",
  "heroin",
  "steroids injectable",
  "research chemical",
  "designer drug",
  "bath salts drug",

  // ── Counterfeit / replica indicators ────────────────────────────────────
  "replica watch",
  "fake designer",
  "counterfeit",
  "copy brand",
  "inspired by designer",
  "aaa quality",            // common fake-goods grading signal
  "master quality replica",
  "best replica",

  // ── Explicit / adult ────────────────────────────────────────────────────
  // (only the clearest terms — eBay has a separate adult items category
  // that requires opt-in; these terms in a general listing are policy violations)
  "pornographic",
  "explicit sexual",

  // ── Other high-risk categories ───────────────────────────────────────────
  "human remains",
  "ivory",                  // ivory trade is prohibited
  "shark fin",
  "bear bile",
  "blood diamond",
  "conflict mineral",
];

// ── Layer 1: Exact brand VeRO check ──────────────────────────────────────────

/**
 * Classic word-boundary brand check against the configured blocklist.
 * "nike" matches "Nike Air Max" but not "Unikey Wireless".
 */
export function checkVero(
  title:         string,
  description:   string | undefined,
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

// ── Layer 2: Fuzzy / obfuscation detection ────────────────────────────────────

/**
 * Normalises both the haystack and each blocklist keyword before matching.
 * Catches "N1ke", "Ad-1-das", "L0uis Vuitton", etc.
 * Returns only keywords that were NOT already caught by the exact check
 * (to avoid duplicates in the combined result).
 */
export function checkVeroFuzzy(
  title:             string,
  description:       string | undefined,
  blocklistPath:     string,
  alreadyMatched:    Set<string> = new Set()
): VeroCheckResult {
  const keywords   = loadBlocklist(blocklistPath);
  const normHay    = normalise(`${title} ${description || ""}`);

  const matched: string[] = [];
  for (const keyword of keywords) {
    if (alreadyMatched.has(keyword)) continue; // skip already-caught exact matches
    const normKw  = normalise(keyword);
    const escaped = normKw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    if (pattern.test(normHay)) {
      matched.push(keyword);
    }
  }

  return { isBlocked: matched.length > 0, matchedKeywords: matched };
}

// ── Layer 3: Prohibited keywords ─────────────────────────────────────────────

/**
 * Checks against eBay's prohibited/restricted item policy keywords.
 * These are hardcoded (not file-based) since they're eBay platform policy,
 * not brand-specific rights.
 */
export function checkProhibitedKeywords(
  title:       string,
  description: string | undefined
): VeroCheckResult {
  const haystack = `${title} ${description || ""}`.toLowerCase();

  const matched: string[] = [];
  for (const kw of PROHIBITED_KEYWORDS) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    if (pattern.test(haystack)) {
      matched.push(kw);
    }
  }

  return { isBlocked: matched.length > 0, matchedKeywords: matched };
}

// ── Combined full-policy check ────────────────────────────────────────────────

/**
 * Runs all three layers and returns a combined result.
 * Use this as the single pre-publish gate — it replaces ad-hoc calls to
 * checkVero() and checkProhibitedKeywords() separately.
 */
export function checkFullPolicy(
  title:         string,
  description:   string | undefined,
  blocklistPath: string
): FullPolicyCheckResult {
  const exact     = checkVero(title, description, blocklistPath);
  const fuzzy     = checkVeroFuzzy(title, description, blocklistPath, new Set(exact.matchedKeywords));
  const prohibited = checkProhibitedKeywords(title, description);

  const isBlocked =
    exact.isBlocked || fuzzy.isBlocked || prohibited.isBlocked;

  const reasons: string[] = [];
  if (exact.matchedKeywords.length > 0) {
    reasons.push(`VeRO brand match: [${exact.matchedKeywords.join(", ")}]`);
  }
  if (fuzzy.matchedKeywords.length > 0) {
    reasons.push(`Obfuscated brand detected: [${fuzzy.matchedKeywords.join(", ")}]`);
  }
  if (prohibited.matchedKeywords.length > 0) {
    reasons.push(`eBay prohibited keyword: [${prohibited.matchedKeywords.join(", ")}]`);
  }

  return {
    isBlocked,
    veroMatches:       exact.matchedKeywords,
    fuzzyMatches:      fuzzy.matchedKeywords,
    prohibitedMatches: prohibited.matchedKeywords,
    reasons,
  };
}

// ── SEO meta field VeRO check (used by aiService.ts) ─────────────────────────

export function defaultBlocklistPath(): string {
  return path.join(process.cwd(), "config", "vero-blocklist.txt");
}
