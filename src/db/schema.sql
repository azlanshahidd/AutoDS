-- Core Service SQLite schema (Section 6 of the master build prompt).
-- Applied idempotently by migrate.ts via `CREATE TABLE IF NOT EXISTS`.

-- suppliers: supplier name/key (e.g., CJ, EPROLO), encrypted API key/secret
-- fields, connection status, last-tested timestamp.
CREATE TABLE IF NOT EXISTS suppliers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_key        TEXT NOT NULL UNIQUE,       -- e.g. 'CJ', 'EPROLO', 'ALIEXPRESS', 'TEST'
  display_name        TEXT NOT NULL,
  -- Encrypted (AES-256-GCM) blobs, never plaintext. Format: iv:authTag:ciphertext (hex).
  encrypted_api_key    TEXT,
  encrypted_api_secret TEXT,
  status              TEXT NOT NULL DEFAULT 'unconfigured' CHECK (status IN ('unconfigured','connected','failed','disabled')),
  last_tested_at      TEXT,
  -- Per-supplier pricing overrides (NULL = use global config value).
  -- margin_override:  e.g. 0.40 = 40%; overrides PROFIT_MARGIN_PERCENT for this supplier's variants.
  -- fee_override:     flat USD override for EBAY_FEE_ESTIMATE for this supplier's variants.
  margin_override      REAL,
  fee_override         REAL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- products: internal product record.
CREATE TABLE IF NOT EXISTS products (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT,
  category     TEXT,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','flagged','archived')),
  meta_title        TEXT,   -- SEO meta title (50-60 chars), for <title> tag / Google preview
  meta_description  TEXT,   -- SEO meta description (150-160 chars), for <meta> / link preview
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- variants: supplier_type + supplier_variant_id <-> internal product ID <-> eBay SKU/offer ID,
-- cost, current stock, current price. This is the required variant-level SKU mapping
-- (Section 5 guardrail) — never mapped at the parent product/title level.
CREATE TABLE IF NOT EXISTS variants (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id           INTEGER NOT NULL REFERENCES products(id),
  supplier_type        TEXT NOT NULL,             -- e.g. 'CJ', 'EPROLO' — drives plugin routing (Section 4a)
  supplier_variant_id  TEXT NOT NULL,             -- supplier's specific variant/SKU id (color/size level)
  internal_sku         TEXT NOT NULL UNIQUE,
  ebay_sku             TEXT,
  ebay_offer_id        TEXT,
  cost                 REAL,
  shipping_cost        REAL DEFAULT 0,
  current_price        REAL,
  current_stock        INTEGER,
  last_synced_at       TEXT,
  -- Task 6: dirty flag — set to 1 when local data is fresher than what eBay
  -- has. Cleared to 0 only after a successful bulkUpdatePriceQuantity call.
  -- Ensures a crash between DB update and eBay push is retried next run.
  ebay_push_pending    INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (supplier_type, supplier_variant_id)
);

-- orders: eBay Order ID, CJ/supplier Order ID (nullable until created), status, timestamps.
CREATE TABLE IF NOT EXISTS orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ebay_order_id    TEXT NOT NULL UNIQUE,          -- used as the idempotency key (Section 5)
  supplier_type    TEXT NOT NULL,
  supplier_order_id TEXT,                          -- nullable until the supplier order is actually created
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (
                     status IN ('pending','submitted','shipped','fulfilled','failed','skipped_auto_order_disabled')
                   ),
  tracking_number  TEXT,
  carrier          TEXT,
  -- Fulfillment dead-letter: consecutive failure counter + quarantine flag.
  -- After ORDER_QUARANTINE_THRESHOLD failures the order is skipped by the
  -- fulfillment loop until manually cleared from the dashboard.
  fulfillment_failure_count  INTEGER NOT NULL DEFAULT 0,
  quarantined                INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0,1)),
  quarantined_at             TEXT,
  last_fulfillment_error     TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- sync_logs: every sync run — timestamp, type, result, error message if any.
CREATE TABLE IF NOT EXISTS sync_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at        TEXT NOT NULL DEFAULT (datetime('now')),
  type          TEXT NOT NULL CHECK (type IN ('price_stock','order_routing','fulfillment_tracking','scout_pull')),
  result        TEXT NOT NULL CHECK (result IN ('success','partial_failure','failure')),
  error_message TEXT,
  details_json  TEXT                                -- optional structured details (counts, skipped items, etc.)
);

-- config: key/value store for runtime-configurable settings (profit margin,
-- stock buffer threshold, sync interval, AUTO_ORDER_ENABLED, etc.). This is
-- the source of truth once the app is running; .env only seeds it on first boot.
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- scouted_products: candidate items pulled from the Scout Service for manual
-- review (Phase 8), extended in Phase 4 with listing pipeline fields.
CREATE TABLE IF NOT EXISTS scouted_products (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT NOT NULL,
  source_url       TEXT,
  scraped_price    REAL,
  matched_supplier TEXT,
  matched_cost     REAL,
  estimated_margin REAL,
  trend_signal     TEXT,
  status           TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','approved','discarded')),
  -- Phase 4: listing pipeline fields
  listing_status   TEXT NOT NULL DEFAULT 'none' CHECK (listing_status IN
                     ('none','queued','vero_blocked','quality_fail','publishing','published','failed')),
  ebay_listing_id  TEXT,                          -- eBay listing ID once published
  ebay_category_id TEXT,                          -- eBay category ID (user-supplied or auto-detected)
  image_urls       TEXT,                          -- JSON array of image URL strings
  listing_error    TEXT,                          -- last pipeline error message for display
  scouted_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_variants_product_id    ON variants(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_ebay_order_id   ON orders(ebay_order_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_run_at        ON sync_logs(run_at);
-- Task 8: fulfillment loop queries orders by status; partial index for quarantine lookup.
CREATE INDEX IF NOT EXISTS idx_orders_status           ON orders(status);

-- scrapers: external scraping services Core pulls trending candidates from.
-- Connected by pasting a single connection token from the scraper dashboard.
-- api_key is stored encrypted (AES-256-GCM iv:authTag:ciphertext hex).
-- api_key_hash (SHA-256) is used for fast inbound push-auth without decryption.
CREATE TABLE IF NOT EXISTS scrapers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  base_url       TEXT NOT NULL UNIQUE,
  api_key        TEXT NOT NULL DEFAULT '',   -- encrypted blob
  api_key_hash   TEXT NOT NULL DEFAULT '',   -- SHA-256 of raw key
  status         TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('untested','connected','failed')),
  last_tested_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- job_locks: DB-backed mutex so a job type can never run concurrently even
-- after a crash (in-memory flags are lost on restart). The scheduler acquires
-- a lock row before running and clears it on completion or timeout.
-- stale_after_seconds: if a lock is older than this, it's considered stale
-- (process crashed mid-run) and may be forcibly released.
CREATE TABLE IF NOT EXISTS job_locks (
  job_type       TEXT PRIMARY KEY,
  locked_at      TEXT NOT NULL DEFAULT (datetime('now')),
  stale_after_s  INTEGER NOT NULL DEFAULT 600   -- 10 min safety timeout
);

-- variant_failures: tracks consecutive failures per variant for the quarantine
-- mechanism. Reset to 0 on any successful sync of that variant.
-- quarantined=1 means the variant is skipped by the sync loop until manually
-- cleared from the dashboard or via the CLI.
CREATE TABLE IF NOT EXISTS variant_failures (
  variant_id         INTEGER PRIMARY KEY REFERENCES variants(id),
  consecutive_fails  INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  quarantined        INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0,1)),
  quarantined_at     TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- circuit_breaker: tracks open/half-open/closed state per external service.
-- When open, the job loop skips all calls to that service until the
-- recovery window passes.
CREATE TABLE IF NOT EXISTS circuit_breaker (
  service_key        TEXT PRIMARY KEY,           -- e.g. 'CJ', 'EBAY', 'SCOUT'
  state              TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed','open','half-open')),
  failure_count      INTEGER NOT NULL DEFAULT 0,
  last_failure_at    TEXT,
  open_until         TEXT,                        -- epoch when it transitions to half-open
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
-- api_key is stored plaintext (same security posture as scrapers/eBay credentials).
CREATE TABLE IF NOT EXISTS ai_providers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  provider_type  TEXT NOT NULL CHECK (provider_type IN ('openai_compatible','gemini','cohere')),
  base_url       TEXT NOT NULL,
  api_key        TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  status         TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('untested','connected','failed')),
  last_tested_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Task 8: partial indexes — must appear after the tables they reference.
-- Quarantined-order lookup (fulfillment loop exclusion + dashboard query).
CREATE INDEX IF NOT EXISTS idx_orders_quarantined ON orders(quarantined) WHERE quarantined = 1;
-- Quarantined-variant lookup (sync loop skip + dashboard query).
CREATE INDEX IF NOT EXISTS idx_variant_failures_quarantined ON variant_failures(quarantined) WHERE quarantined = 1;
