/**
 * makeTestDb — creates a fully-migrated in-memory SQLite database for tests.
 *
 * Every call returns a fresh, isolated DB instance. No files are written to
 * disk, so tests can run in parallel without interference and CI never leaves
 * behind stale database files.
 *
 * Usage:
 *   const { db, config } = makeTestDb();
 *   // use db in route handlers / job runners
 *   db.close(); // call in afterEach / afterAll
 *
 * Seeded fixtures:
 *   - A product + variant (supplier_type='TEST', internal_sku='TEST-SKU-1')
 *   - A session token so authenticated API routes work without a real login
 *   - config table pre-populated with safe defaults via applyMigrations
 */
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/migrate";
import { hashPassword } from "../../src/auth/password";
import type { CoreConfig } from "../../src/config";

/** Minimal CoreConfig suitable for unit/integration tests. */
export function makeTestConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  return {
    port:                   4000,
    host:                   "127.0.0.1",
    dashboardAuthToken:     "test-auth-token",
    databaseFile:           ":memory:",
    encryptionKey:          "a".repeat(64), // 64 hex chars, all-zeroes equivalent
    activeSupplier:         "TEST",
    profitMarginPercent:    0.3,
    ebayFeeEstimate:        2.5,
    autoOrderEnabled:       false,
    safetyStockBuffer:      5,
    syncIntervalMinutes:    15,
    logFile:                "./logs/test.log",
    ebayClientId:           null,
    ebayClientSecret:       null,
    ebayRefreshToken:       null,
    ebayEnvironment:        "sandbox",
    veroBlocklistPath:      "./config/vero-blocklist.txt",
    scoutServiceUrl:        "http://127.0.0.1:4100",
    scoutPullTimeoutMs:     1000,
    alertWebhookUrl:        null,
    alertTelegramBotToken:  null,
    alertTelegramChatId:    null,
    alertFailureThreshold:  3,
    ...overrides,
  };
}

export const TEST_SESSION_TOKEN = "test-session-token-abc123";

export interface TestDb {
  db:     Database.Database;
  config: CoreConfig;
}

/**
 * Creates a fresh in-memory SQLite DB with:
 *  - Full schema applied (same as production)
 *  - Config table seeded with test defaults
 *  - A valid session token so API routes can authenticate
 *  - One product + variant fixture for jobs that need something to process
 */
export function makeTestDb(configOverrides: Partial<CoreConfig> = {}): TestDb {
  const config = makeTestConfig(configOverrides);

  // better-sqlite3 in-memory DB — never touches the filesystem
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  // Apply full schema + seed config defaults (same code path as production)
  applyMigrations(db, config);

  // Seed a test session token so API routes accept X-Auth-Token: test-session-token-abc123
  db.prepare(
    `INSERT INTO config (key, value, updated_at)
     VALUES ('ACTIVE_SESSION_TOKEN', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(TEST_SESSION_TOKEN);

  // Seed a dashboard password hash so the auth route works in tests
  db.prepare(
    `INSERT INTO config (key, value, updated_at)
     VALUES ('DASHBOARD_PASSWORD_HASH', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(hashPassword("test-password"));

  // Seed one product + variant for job smoke tests
  db.prepare(
    `INSERT INTO products (id, title, status) VALUES (1, 'Test Product', 'active')`
  ).run();
  db.prepare(
    `INSERT INTO variants
       (id, product_id, supplier_type, supplier_variant_id, internal_sku, ebay_sku,
        cost, shipping_cost, current_price, current_stock)
     VALUES (1, 1, 'TEST', 'TEST-VID-1', 'TEST-SKU-1', 'EBAY-TEST-SKU-1',
             10.00, 2.50, 15.50, 20)`
  ).run();

  return { db, config };
}

/**
 * Writes a config key/value into the test DB's config table.
 * Use this when a job reads settings live from DB (e.g. AUTO_ORDER_ENABLED).
 */
export function setTestConfig(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value);
}

/**
 * Seeds an order row — used by fulfillment smoke tests.
 */
export function seedOrder(
  db: Database.Database,
  overrides: {
    ebayOrderId?:    string;
    supplierType?:   string;
    supplierOrderId?: string;
    status?:         string;
  } = {}
): number {
  const result = db.prepare(
    `INSERT INTO orders (ebay_order_id, supplier_type, supplier_order_id, status)
     VALUES (?, ?, ?, ?)`
  ).run(
    overrides.ebayOrderId    ?? "EBAY-ORDER-001",
    overrides.supplierType   ?? "TEST",
    overrides.supplierOrderId ?? "TEST-SUPPLIER-ORDER-001",
    overrides.status         ?? "submitted"
  );
  return result.lastInsertRowid as number;
}
