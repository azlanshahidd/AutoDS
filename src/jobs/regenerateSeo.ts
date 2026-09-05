/**
 * regenerateSeo.ts — bulk backfill / refresh SEO meta fields.
 *
 * Re-generates meta_title and meta_description (plus ai_title / ai_description
 * if also missing) for all scouted_products rows that match the given filter,
 * using the same generateListingContent() pipeline already used by the live app.
 *
 * Usage:
 *   npm run regenerate-seo
 *       Regenerate ALL rows that have no meta_title yet (safe first-run default).
 *
 *   npm run regenerate-seo -- --all
 *       Regenerate every row, overwriting existing SEO fields.
 *
 *   npm run regenerate-seo -- --supplier=CJ
 *       Only rows where matched_supplier = CJ (case-insensitive).
 *
 *   npm run regenerate-seo -- --status=approved
 *       Only rows with the given status (pending_review | approved | discarded).
 *
 *   npm run regenerate-seo -- --dry-run
 *       Show which rows would be processed without making any AI calls or DB writes.
 *
 *   npm run regenerate-seo -- --all --supplier=CJ --dry-run
 *       Flags can be combined freely.
 *
 * Rate limiting: The script processes rows sequentially with a 500 ms pause
 * between calls to avoid hammering the AI provider. Pass --concurrency=N to
 * raise the sequential batch size (still processes batches sequentially).
 */
import "dotenv/config";
import { loadConfig, ConfigError } from "../config";
import { getDb } from "../db/connection";
import { applyMigrations } from "../db/migrate";
import { generateListingContent, checkVeroOnMetaFields } from "../routes/aiService";
import { logger } from "../logger";

// ── Arg parsing ───────────────────────────────────────────────────────────────

interface CliFlags {
  all:         boolean;
  dryRun:      boolean;
  supplier:    string | null;
  status:      string | null;
  concurrency: number;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    all:         false,
    dryRun:      false,
    supplier:    null,
    status:      null,
    concurrency: 1,
  };
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const [key, value] = a.slice(2).split("=");
    switch (key) {
      case "all":         flags.all         = true;                break;
      case "dry-run":     flags.dryRun      = true;                break;
      case "supplier":    flags.supplier    = value ?? null;       break;
      case "status":      flags.status      = value ?? null;       break;
      case "concurrency": flags.concurrency = Math.max(1, parseInt(value ?? "1", 10) || 1); break;
    }
  }
  return flags;
}

// ── Sleep helper ──────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface ScoutedRow {
  id:               number;
  title:            string;
  scraped_price:    number | null;
  trend_signal:     string | null;
  matched_supplier: string | null;
  status:           string;
  meta_title:       string | null;
  meta_description: string | null;
}

async function run() {
  const flags = parseArgs(process.argv.slice(2));

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) { console.error(`\n✗ ${err.message}\n`); process.exit(1); }
    throw err;
  }

  const db = getDb(config.databaseFile);

  // Ensure schema is up to date before reading/writing the new SEO columns
  applyMigrations(db, config);

  // ── Build query filters ───────────────────────────────────────────────────
  const where: string[] = [];
  const params: unknown[] = [];

  if (!flags.all) {
    // Default: only rows missing meta_title
    where.push("(meta_title IS NULL OR meta_title = '')");
  }
  if (flags.supplier) {
    where.push("lower(matched_supplier) = lower(?)");
    params.push(flags.supplier);
  }
  if (flags.status) {
    const validStatuses = ["pending_review", "approved", "discarded"];
    if (!validStatuses.includes(flags.status)) {
      console.error(`\n✗ Invalid --status value "${flags.status}". Must be one of: ${validStatuses.join(", ")}\n`);
      process.exit(1);
    }
    where.push("status = ?");
    params.push(flags.status);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT id, title, scraped_price, trend_signal, matched_supplier, status,
              meta_title, meta_description
       FROM scouted_products
       ${whereClause}
       ORDER BY id ASC`
    )
    .all(...params) as ScoutedRow[];

  // ── Dry run ───────────────────────────────────────────────────────────────
  if (flags.dryRun) {
    console.log(`\n🔍 DRY RUN — ${rows.length} row(s) would be processed (no AI calls, no DB writes).\n`);
    for (const row of rows.slice(0, 20)) {
      const hasMeta = row.meta_title ? "✓ has SEO" : "✗ missing SEO";
      console.log(`  [${row.id}] ${row.title.slice(0, 60)}${row.title.length > 60 ? "…" : ""} (${hasMeta})`);
    }
    if (rows.length > 20) console.log(`  … and ${rows.length - 20} more`);
    console.log();
    db.close();
    return;
  }

  if (rows.length === 0) {
    console.log("\n✓ Nothing to regenerate — all matching rows already have SEO fields.\n");
    db.close();
    return;
  }

  // ── Check AI provider ─────────────────────────────────────────────────────
  const provider = db
    .prepare("SELECT id FROM ai_providers WHERE enabled = 1 LIMIT 1")
    .get();
  if (!provider) {
    console.error("\n✗ No enabled AI provider found. Configure one in CoreDash → AI Providers.\n");
    process.exit(1);
  }

  console.log(`\n⚡ Regenerating SEO fields for ${rows.length} item(s)...\n`);

  let succeeded = 0;
  let failed    = 0;
  let veroBlock = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const prefix = `[${i + 1}/${rows.length}] #${row.id}`;

    process.stdout.write(`  ${prefix} "${row.title.slice(0, 50)}${row.title.length > 50 ? "…" : ""}" … `);

    const result = await generateListingContent(db, {
      title:        row.title,
      scrapedPrice: row.scraped_price,
      trendSignal:  row.trend_signal,
    });

    if (!result) {
      console.log("✗ FAILED (AI returned null)");
      logger.warn("regenerate-seo: generation failed", { id: row.id });
      failed++;
    } else {
      // VeRO check on meta fields
      const metaVero = checkVeroOnMetaFields(
        result.metaTitle,
        result.metaDescription,
        config.veroBlocklistPath
      );

      if (metaVero.isBlocked) {
        console.log(`✗ VERO BLOCKED [${metaVero.matchedKeywords.join(", ")}]`);
        logger.warn("regenerate-seo: VeRO blocked", { id: row.id, keywords: metaVero.matchedKeywords });
        veroBlock++;
      } else {
        db.prepare(
          `UPDATE scouted_products
             SET ai_title               = COALESCE(ai_title, ?),
                 ai_description         = COALESCE(ai_description, ?),
                 meta_title             = ?,
                 meta_description       = ?,
                 meta_generated_at      = datetime('now'),
                 meta_generation_source = ?,
                 updated_at             = datetime('now')
           WHERE id = ?`
        ).run(
          result.aiTitle,
          result.aiDescription,
          result.metaTitle,
          result.metaDescription,
          result.generationSource,
          row.id
        );
        console.log(`✓  meta: "${result.metaTitle.slice(0, 40)}…"`);
        succeeded++;
      }
    }

    // Rate-limit: 500 ms between calls (skip after the last row)
    if (i < rows.length - 1) {
      await sleep(500);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`
────────────────────────────────────────
  Total processed : ${rows.length}
  Succeeded       : ${succeeded}
  VeRO blocked    : ${veroBlock}
  Failed          : ${failed}
────────────────────────────────────────
`);

  if (veroBlock > 0) {
    console.log("ℹ  VeRO-blocked items were skipped — check the logs and edit manually.\n");
  }

  db.close();
}

run().catch(err => {
  console.error(`\n✗ Unexpected error: ${(err as Error).message}\n`);
  process.exit(1);
});
