/**
 * scoutPullOnce.ts — manually triggers one Scout pull cycle.
 *
 * Usage:
 *   npm run scout-pull-once             — real pull (stores to DB)
 *   npm run scout-pull-once -- --dry-run — fetch only, log what would be stored
 */
import "dotenv/config";
import { loadConfig, ConfigError } from "../config";
import { getDb } from "../db/connection";
import { pullFromScout } from "../services/scoutPullService";
import { logger } from "../logger";

function parseArgs(argv: string[]) {
  const flags: Record<string, boolean | string> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [key, value] = a.slice(2).split("=");
      flags[key] = value ?? true;
    }
  }
  return flags;
}

async function run() {
  const flags  = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(flags["dry-run"]);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) { console.error(`\n✗ ${err.message}\n`); process.exit(1); }
    throw err;
  }

  const db = getDb(config.databaseFile);

  if (dryRun) {
    // Dry-run: fetch candidates and log them without writing to DB.
    // We call pullFromScout which will acquire the lock, fetch, and store —
    // but to implement a pure dry-run without modifying pullFromScout's
    // signature we fetch directly here.
    const { getFirstActiveScraper } = await import("../routes/scrapers");
    const scraper   = getFirstActiveScraper(db, config.encryptionKey);
    const scoutUrl  = scraper?.baseUrl ?? config.scoutServiceUrl;
    const apiKey    = scraper?.apiKey  ?? "";
    const timeoutMs = config.scoutPullTimeoutMs;

    console.log(`🔍 DRY RUN — fetching from ${scoutUrl} (no DB writes).\n`);
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await fetch(`${scoutUrl}/api/v1/scout-trends`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const candidates = await res.json();
      console.log(`Fetched ${Array.isArray(candidates) ? candidates.length : "?"} candidate(s):`);
      if (Array.isArray(candidates)) {
        for (const c of candidates.slice(0, 10)) {
          console.log(`  - [${c.status}] ${c.title} (${c.scraped_price != null ? `$${c.scraped_price}` : "no price"})`);
        }
        if (candidates.length > 10) console.log(`  ... and ${candidates.length - 10} more`);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
    }
    db.close();
    return;
  }

  console.log(`Pulling from Scout Service at ${config.scoutServiceUrl} (timeout ${config.scoutPullTimeoutMs}ms)...\n`);
  const summary = await pullFromScout(db, config);

  console.log("Summary:");
  console.log(`  Fetched:               ${summary.fetched}`);
  console.log(`  Stored:                ${summary.stored}`);
  console.log(`  Skipped (dup):         ${summary.skippedDuplicate}`);
  console.log(`  Matched to a variant:  ${summary.matched}`);
  console.log(`  Result:                ${summary.result}`);
  if (summary.errorMessage) console.log(`  Error:                 ${summary.errorMessage}`);
  console.log();

  db.close();
}

run();
