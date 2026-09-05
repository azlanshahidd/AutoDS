/**
 * Migration logic (Phase 1, extended in Phase 9 for automatic startup runs).
 *
 * - Creates all tables from schema.sql (idempotent — safe to re-run).
 * - Seeds the `config` key/value table with defaults from Section 1/4/5 of
 *   the build spec, but only for keys that don't already exist, so re-running
 *   this never clobbers settings changed later from the dashboard.
 *
 * Exposed as `applyMigrations(db, config)` so both the CLI script (`npm run
 * migrate`) below and the server's own startup (index.ts) can call the same
 * logic — the server runs it automatically on every boot (harmless/no-op if
 * already applied), so a fresh deploy (e.g. on Railway) never needs a
 * separate manual migration step.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { loadConfig, ConfigError, CoreConfig } from "../config";
import { getDb } from "./connection";
import { logger } from "../logger";
import { hashPassword } from "../auth/password";

export function applyMigrations(db: Database.Database, config: CoreConfig): string[] {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf-8");

  // Split schema into two passes:
  //   Pass 1 — table/trigger/view definitions (everything except CREATE INDEX)
  //   Pass 2 — index definitions (applied AFTER ALTER TABLE column additions so
  //             partial indexes like idx_orders_quarantined don't fail on an
  //             existing DB that hasn't had the column added yet)
  const tableStatements = schemaSql
    .split(/;\s*\n/)
    .filter(s => s.trim().length > 0 && !/^\s*CREATE\s+(UNIQUE\s+)?INDEX/i.test(s))
    .join(";\n") + ";";

  const indexStatements = schemaSql
    .split(/;\s*\n/)
    .filter(s => /^\s*CREATE\s+(UNIQUE\s+)?INDEX/i.test(s))
    .join(";\n");

  // Apply table definitions first
  const applyTables = db.transaction(() => {
    db.exec(tableStatements);
  });
  applyTables();

  // Idempotent column additions — ALTER TABLE ADD COLUMN fails if the column
  // already exists, so we check PRAGMA table_info first.
  const scoutedCols = db
    .prepare("PRAGMA table_info(scouted_products)")
    .all() as { name: string }[];
  if (!scoutedCols.find((c) => c.name === "ai_title")) {
    db.prepare("ALTER TABLE scouted_products ADD COLUMN ai_title TEXT").run();
  }
  if (!scoutedCols.find((c) => c.name === "ai_description")) {
    db.prepare("ALTER TABLE scouted_products ADD COLUMN ai_description TEXT").run();
  }
  // Phase 4: listing pipeline columns
  if (!scoutedCols.find((c) => c.name === "listing_status")) {
    db.prepare("ALTER TABLE scouted_products ADD COLUMN listing_status TEXT NOT NULL DEFAULT 'none'").run();
  }
  if (!scoutedCols.find((c) => c.name === "ebay_listing_id")) {
    db.prepare("ALTER TABLE scouted_products ADD COLUMN ebay_listing_id TEXT").run();
  }
  if (!scoutedCols.find((c) => c.name === "ebay_category_id")) {
    db.prepare("ALTER TABLE scouted_products ADD COLUMN ebay_category_id TEXT").run();
  }
  if (!scoutedCols.find((c) => c.name === "image_urls")) {
    db.prepare("ALTER TABLE scouted_products ADD COLUMN image_urls TEXT").run();
  }
  if (!scoutedCols.find((c) => c.name === "listing_error")) {
    db.prepare("ALTER TABLE scouted_products ADD COLUMN listing_error TEXT").run();
  }
  // SEO metadata columns — meta title/description for external search engines
  // and link-preview cards, distinct from the eBay listing title/description.
  if (!scoutedCols.find((c) => c.name === "meta_title")) {
    db.prepare("ALTER TABLE scouted_products ADD COLUMN meta_title TEXT").run();
  }
  if (!scoutedCols.find((c) => c.name === "meta_description")) {
    db.prepare("ALTER TABLE scouted_products ADD COLUMN meta_description TEXT").run();
  }
  if (!scoutedCols.find((c) => c.name === "meta_generated_at")) {
    db.prepare("ALTER TABLE scouted_products ADD COLUMN meta_generated_at TEXT").run();
  }
  if (!scoutedCols.find((c) => c.name === "meta_generation_source")) {
    db.prepare("ALTER TABLE scouted_products ADD COLUMN meta_generation_source TEXT").run();
  }
  // updated_at — used by the optimistic-lock approve/discard and the pipeline
  if (!scoutedCols.find((c) => c.name === "updated_at")) {
    db.prepare("ALTER TABLE scouted_products ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))").run();
    // Back-fill existing rows to created_at so the lock works immediately
    db.prepare("UPDATE scouted_products SET updated_at = created_at WHERE updated_at IS NULL").run();
  }

  // SEO metadata columns on products table — written at publish time from the
  // scouted item's generated meta fields.
  const productCols = db
    .prepare("PRAGMA table_info(products)")
    .all() as { name: string }[];
  if (!productCols.find((c) => c.name === "meta_title")) {
    db.prepare("ALTER TABLE products ADD COLUMN meta_title TEXT").run();
  }
  if (!productCols.find((c) => c.name === "meta_description")) {
    db.prepare("ALTER TABLE products ADD COLUMN meta_description TEXT").run();
  }

  // Per-supplier pricing override columns — NULL means "use global config".
  const supplierCols = db
    .prepare("PRAGMA table_info(suppliers)")
    .all() as { name: string }[];
  if (!supplierCols.find((c) => c.name === "margin_override")) {
    db.prepare("ALTER TABLE suppliers ADD COLUMN margin_override REAL").run();
  }
  if (!supplierCols.find((c) => c.name === "fee_override")) {
    db.prepare("ALTER TABLE suppliers ADD COLUMN fee_override REAL").run();
  }

  // BUG-004: add api_key_hash column to scrapers if it doesn't exist yet.
  // Existing rows get a placeholder hash of their current (still plaintext)
  // key — they will be re-hashed properly when the scraper is reconnected
  // via the dashboard, which also encrypts the key going forward.
  const scraperCols = db
    .prepare("PRAGMA table_info(scrapers)")
    .all() as { name: string }[];
  if (!scraperCols.find((c) => c.name === "api_key_hash")) {
    db.prepare("ALTER TABLE scrapers ADD COLUMN api_key_hash TEXT NOT NULL DEFAULT ''").run();
    const rows = db
      .prepare("SELECT id, api_key FROM scrapers WHERE api_key != ''")
      .all() as { id: number; api_key: string }[];
    const backfill = db.prepare("UPDATE scrapers SET api_key_hash = ? WHERE id = ?");
    const cryptoMod = require("crypto") as typeof import("crypto");
    const backfillAll = db.transaction(() => {
      for (const r of rows) {
        const hash = cryptoMod.createHash("sha256").update(r.api_key).digest("hex");
        backfill.run(hash, r.id);
      }
    });
    backfillAll();
  }

  // Reliability Phase — idempotent additions for new tables.
  // Task 5: order quarantine columns — add to existing orders table for DBs
  // created before this reliability phase.
  const orderCols = db
    .prepare("PRAGMA table_info(orders)")
    .all() as { name: string }[];
  if (!orderCols.find((c) => c.name === "fulfillment_failure_count")) {
    db.prepare("ALTER TABLE orders ADD COLUMN fulfillment_failure_count INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!orderCols.find((c) => c.name === "quarantined")) {
    db.prepare("ALTER TABLE orders ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!orderCols.find((c) => c.name === "quarantined_at")) {
    db.prepare("ALTER TABLE orders ADD COLUMN quarantined_at TEXT").run();
  }
  if (!orderCols.find((c) => c.name === "last_fulfillment_error")) {
    db.prepare("ALTER TABLE orders ADD COLUMN last_fulfillment_error TEXT").run();
  }

  // Task 6: ebay_push_pending flag on variants — set when local DB is updated
  // with fresh supplier data, cleared only after a successful eBay bulk push.
  // Allows the sync loop to retry the eBay push after a crash between the
  // DB update and the eBay API call (previously the push was silently lost).
  const variantCols = db
    .prepare("PRAGMA table_info(variants)")
    .all() as { name: string }[];
  if (!variantCols.find((c) => c.name === "ebay_push_pending")) {
    db.prepare("ALTER TABLE variants ADD COLUMN ebay_push_pending INTEGER NOT NULL DEFAULT 0").run();
  }

  // variant_failures: per-variant failure counting and quarantine flag.
  // circuit_breaker: per-service open/half-open/closed state.
  // These are created by schema.sql via CREATE TABLE IF NOT EXISTS, but
  // we also do explicit checks here in case the schema was applied before
  // these tables were added.
  const existingTables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((r) => r.name)
  );
  if (!existingTables.has("job_locks")) {
    db.prepare(`CREATE TABLE IF NOT EXISTS job_locks (
      job_type       TEXT PRIMARY KEY,
      locked_at      TEXT NOT NULL DEFAULT (datetime('now')),
      stale_after_s  INTEGER NOT NULL DEFAULT 600
    )`).run();
  }
  if (!existingTables.has("variant_failures")) {
    db.prepare(`CREATE TABLE IF NOT EXISTS variant_failures (
      variant_id         INTEGER PRIMARY KEY REFERENCES variants(id),
      consecutive_fails  INTEGER NOT NULL DEFAULT 0,
      last_error         TEXT,
      quarantined        INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0,1)),
      quarantined_at     TEXT,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();
  }
  if (!existingTables.has("circuit_breaker")) {
    db.prepare(`CREATE TABLE IF NOT EXISTS circuit_breaker (
      service_key        TEXT PRIMARY KEY,
      state              TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half-open')),
      failure_count      INTEGER NOT NULL DEFAULT 0,
      last_failure_at    TEXT,
      open_until         TEXT,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();
  }

  // Pass 2 — apply indexes AFTER all ALTER TABLE column additions above,
  // so partial indexes referencing newly-added columns (e.g. quarantined)
  // find the column already present on existing databases.
  if (indexStatements.trim().length > 0) {
    const applyIndexes = db.transaction(() => {
      db.exec(indexStatements + ";");
    });
    applyIndexes();
  }

  // Seed default runtime config (only where not already present).
  // All settings that were previously .env-only are seeded here so the
  // dashboard settings page can read and write them without touching any file.
  const defaults: Record<string, string> = {
    // Guardrails
    AUTO_ORDER_ENABLED:      String(config.autoOrderEnabled),
    SYNC_INTERVAL_MINUTES:   String(config.syncIntervalMinutes),
    SAFETY_STOCK_BUFFER:     String(config.safetyStockBuffer),
    // Pricing
    PROFIT_MARGIN_PERCENT:   String(config.profitMarginPercent),
    EBAY_FEE_ESTIMATE:       String(config.ebayFeeEstimate),
    // Supplier
    ACTIVE_SUPPLIER:         config.activeSupplier,
    // eBay credentials
    EBAY_CLIENT_ID:          config.ebayClientId ?? "",
    EBAY_CLIENT_SECRET:      config.ebayClientSecret ?? "",
    EBAY_REFRESH_TOKEN:      config.ebayRefreshToken ?? "",
    EBAY_ENVIRONMENT:        config.ebayEnvironment,
    CJ_API_KEY:              process.env.CJ_API_KEY ?? "",
    CJ_API_SECRET:           process.env.CJ_API_SECRET ?? "",
    VERO_BLOCKLIST_PATH:     config.veroBlocklistPath,
    // Scout connection
    SCOUT_PULL_TIMEOUT_MS:   String(config.scoutPullTimeoutMs),
    // Alerts
    ALERT_WEBHOOK_URL:       config.alertWebhookUrl ?? "",
    ALERT_TELEGRAM_BOT_TOKEN:config.alertTelegramBotToken ?? "",
    ALERT_TELEGRAM_CHAT_ID:  config.alertTelegramChatId ?? "",
    ALERT_FAILURE_THRESHOLD: String(config.alertFailureThreshold),
    // Phase 4: listing pipeline
    AUTO_LIST_ENABLED:            "false",   // false = "Review before publish" (safe default)
    EBAY_MERCHANT_LOCATION:       "",        // merchantLocationKey required for eBay offers
    EBAY_MARKETPLACE_ID:          "EBAY_US", // default marketplace
    // SEO metadata
    AUTO_REGENERATE_SEO_ON_CHANGE: "true",   // auto-regenerate SEO fields on title/category/price changes
    // Per-tier pricing rules (JSON array of PricingTier objects, see pricing.ts).
    // Empty by default — add tiers in Settings to apply cost-bracket margins.
    PRICING_TIERS:                 "[]",
    // Analytics: margin floor for alerts. Variants below this % gross margin
    // appear in the Analytics → Margin Alerts panel.
    MARGIN_FLOOR_PERCENT:          "0.10",  // 10% default floor
  };

  const insertIfMissing = db.prepare(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO NOTHING`
  );

  const seed = db.transaction((entries: Record<string, string>) => {
    for (const [key, value] of Object.entries(entries)) {
      insertIfMissing.run(key, value);
    }
  });
  seed(defaults);

  // Seed the initial dashboard password hash from DASHBOARD_AUTH_TOKEN.
  // Only done if no password has been set yet — never overwrites an existing password.
  const existing = db.prepare("SELECT value FROM config WHERE key = 'DASHBOARD_PASSWORD_HASH'").get();
  if (!existing) {
    const initialPassword = config.dashboardAuthToken;
    const hash = hashPassword(initialPassword);
    db.prepare(`INSERT INTO config (key, value, updated_at) VALUES ('DASHBOARD_PASSWORD_HASH', ?, datetime('now'))`).run(hash);
    logger.info("Initial dashboard password seeded from DASHBOARD_AUTH_TOKEN");
  }

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];

  return tables.map((t) => t.name);
}

function run() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // eslint-disable-next-line no-console
      console.error(`\n✗ Configuration error — migration aborted.\n\n  ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const db = getDb(config.databaseFile);

  let tableNames: string[];
  try {
    tableNames = applyMigrations(db, config);
  } catch (err) {
    console.error(`\n✗ Failed to apply schema.\n\n  ${(err as Error).message}\n`);
    process.exit(1);
  }

  logger.info("Migration complete", { databaseFile: config.databaseFile, tables: tableNames });
  console.log(`\n✓ Migration complete.\n  Database: ${config.databaseFile}\n  Tables: ${tableNames.join(", ")}\n`);

  db.close();
}

if (require.main === module) {
  run();
}
