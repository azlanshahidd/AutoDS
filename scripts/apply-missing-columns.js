/**
 * One-shot migration script — adds columns that schema.sql now defines
 * but that may be missing from an existing core.db created before the
 * reliability/auto-listing phases were added.
 *
 * Run once: node scripts/apply-missing-columns.js
 * Safe to re-run — skips columns that already exist.
 */
const Database = require("better-sqlite3");
const path     = require("path");

const dbPath = process.env.DATABASE_FILE
  ? path.resolve(process.env.DATABASE_FILE)
  : path.join(__dirname, "..", "data", "core.db");

console.log(`\nApplying missing columns to: ${dbPath}\n`);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function cols(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function addIfMissing(table, column, definition) {
  if (!cols(table).includes(column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    console.log(`  + ${table}.${column}`);
  } else {
    console.log(`  ✓ ${table}.${column} (already exists)`);
  }
}

// orders — reliability phase (quarantine + fulfillment tracking)
addIfMissing("orders", "fulfillment_failure_count", "INTEGER NOT NULL DEFAULT 0");
addIfMissing("orders", "quarantined",               "INTEGER NOT NULL DEFAULT 0");
addIfMissing("orders", "quarantined_at",             "TEXT");
addIfMissing("orders", "last_fulfillment_error",     "TEXT");

// variants — reliability phase (dirty flag for eBay push idempotency)
addIfMissing("variants", "ebay_push_pending", "INTEGER NOT NULL DEFAULT 0");

// scouted_products — listing pipeline + SEO + optimistic lock
addIfMissing("scouted_products", "listing_status",        "TEXT NOT NULL DEFAULT 'none'");
addIfMissing("scouted_products", "ebay_listing_id",       "TEXT");
addIfMissing("scouted_products", "ebay_category_id",      "TEXT");
addIfMissing("scouted_products", "image_urls",            "TEXT");
addIfMissing("scouted_products", "listing_error",         "TEXT");
addIfMissing("scouted_products", "ai_title",              "TEXT");
addIfMissing("scouted_products", "ai_description",        "TEXT");
addIfMissing("scouted_products", "meta_title",            "TEXT");
addIfMissing("scouted_products", "meta_description",      "TEXT");
addIfMissing("scouted_products", "meta_generated_at",     "TEXT");
addIfMissing("scouted_products", "meta_generation_source","TEXT");
addIfMissing("scouted_products", "updated_at",            "TEXT NOT NULL DEFAULT (datetime('now'))");

// Back-fill updated_at from created_at so optimistic lock works immediately
db.prepare("UPDATE scouted_products SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = ''").run();

// products — SEO meta fields
addIfMissing("products", "meta_title",       "TEXT");
addIfMissing("products", "meta_description", "TEXT");

// suppliers — per-supplier pricing overrides
addIfMissing("suppliers", "margin_override", "REAL");
addIfMissing("suppliers", "fee_override",    "REAL");

// Now create any missing indexes (safe to run after columns exist)
const indexes = [
  "CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)",
  "CREATE INDEX IF NOT EXISTS idx_orders_quarantined ON orders(quarantined) WHERE quarantined = 1",
  "CREATE INDEX IF NOT EXISTS idx_variant_failures_quarantined ON variant_failures(quarantined) WHERE quarantined = 1",
];

for (const sql of indexes) {
  try {
    db.prepare(sql).run();
    const name = sql.match(/idx_\w+/)?.[0] ?? sql;
    console.log(`  ✓ index ${name}`);
  } catch (e) {
    console.log(`  ~ index skipped: ${e.message}`);
  }
}

db.close();
console.log("\nDone. Run npm run dev to start the server.\n");
