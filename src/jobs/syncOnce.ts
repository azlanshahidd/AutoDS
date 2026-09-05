/**
 * syncOnce.ts — manually triggers a single sync cycle.
 *
 * Usage:
 *   npm run sync-once              — real sync (updates DB + eBay)
 *   npm run sync-once -- --dry-run — logs what would happen, no writes
 */
import "dotenv/config";
import { loadConfig, ConfigError } from "../config";
import { getDb } from "../db/connection";
import { runSyncOnce } from "./syncLoop";

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
  const flags = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(flags["dry-run"]);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) { console.error(`\n✗ ${err.message}\n`); process.exit(1); }
    throw err;
  }

  const db = getDb(config.databaseFile);

  if (dryRun) console.log("🔍 DRY RUN — no writes will be made to the DB or eBay.\n");
  console.log("Running one sync cycle...\n");

  const summary = await runSyncOnce(db, config, { dryRun });

  console.log("Summary:");
  console.log(`  Total variants:          ${summary.totalVariants}`);
  console.log(`  Changed:                 ${summary.changed}`);
  console.log(`  Unchanged:               ${summary.unchanged}`);
  console.log(`  Failed:                  ${summary.failed}`);
  console.log(`  Pushed to eBay:          ${summary.pushedToEbay}`);
  console.log(`  Skipped (kill switch):   ${summary.skippedPushKillSwitch}`);
  console.log(`  Skipped (quarantine):    ${summary.skippedQuarantine}`);
  console.log(`  Skipped (circuit open):  ${summary.skippedCircuitOpen}`);
  console.log(`  Result:                  ${summary.result}${dryRun ? " (dry run)" : ""}`);
  if (summary.errors.length > 0) {
    console.log("\n  Errors:");
    for (const e of summary.errors) console.log(`    - ${e.sku}: ${e.message}`);
  }
  console.log();
  db.close();
}

run();
