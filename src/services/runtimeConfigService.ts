/**
 * Runtime config service.
 *
 * All settings that were previously only in .env are stored here in the
 * `config` key/value table so they can be read and changed from the dashboard
 * at any time without editing files or restarting the process.
 *
 * Keys that take effect immediately (no restart needed):
 *   AUTO_ORDER_ENABLED, PROFIT_MARGIN_PERCENT, EBAY_FEE_ESTIMATE,
 *   SAFETY_STOCK_BUFFER, EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN,
 *   EBAY_ENVIRONMENT, SCOUT_SERVICE_URL, ALERT_WEBHOOK_URL,
 *   ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID, ALERT_FAILURE_THRESHOLD
 *
 * Keys that take effect on the next job tick (cron already running):
 *   SYNC_INTERVAL_MINUTES — changing this does NOT restart the cron; the new
 *   value is picked up the next time a scheduler is (re)started. A banner in
 *   the UI informs the user of this.
 */
import Database from "better-sqlite3";
import { CoreConfig } from "../config";

// ─── generic helpers ─────────────────────────────────────────────────────────

function getKey(db: Database.Database, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setKey(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value);
}

function getAll(db: Database.Database): Record<string, string> {
  const rows = db
    .prepare("SELECT key, value FROM config ORDER BY key")
    .all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ─── auto-order (used by job loops) ──────────────────────────────────────────

export function getAutoOrderEnabled(db: Database.Database): boolean {
  return (getKey(db, "AUTO_ORDER_ENABLED") ?? "false").toLowerCase() === "true";
}

export function setAutoOrderEnabled(db: Database.Database, enabled: boolean): boolean {
  setKey(db, "AUTO_ORDER_ENABLED", String(enabled));
  return enabled;
}

export function withLiveAutoOrderEnabled(db: Database.Database, config: CoreConfig): CoreConfig {
  return { ...config, autoOrderEnabled: getAutoOrderEnabled(db) };
}

// ─── full settings read/write (used by /api/settings) ────────────────────────

export interface CoreSettings {
  // Pricing
  profitMarginPercent: number;
  ebayFeeEstimate: number;
  // Guardrails
  autoOrderEnabled: boolean;
  safetyStockBuffer: number;
  syncIntervalMinutes: number;
  // eBay
  ebayClientId: string;
  ebayClientSecret: string;
  ebayRefreshToken: string;
  ebayEnvironment: "production" | "sandbox";
  // eBay listing pipeline
  autoListEnabled: boolean;
  ebayMerchantLocation: string;
  ebayMarketplaceId: string;
  // Supplier
  activeSupplier: string;
  cjApiKey: string;
  cjApiSecret: string;
  veroBlocklistPath: string;
  // Scout connection
  scoutPullTimeoutMs: number;
  // Alerts
  alertWebhookUrl: string;
  alertTelegramBotToken: string;
  alertTelegramChatId: string;
  alertFailureThreshold: number;
  // SEO metadata
  seoAutoRegenerate: boolean;
  // Analytics
  marginFloorPercent: number;
  // Pricing tiers (JSON array of PricingTier objects — see pricing.ts)
  pricingTiersJson: string;
}

export function getSettings(db: Database.Database, bootConfig: CoreConfig): CoreSettings {
  const all = getAll(db);

  function str(key: string, fallback: string): string {
    return all[key] ?? fallback;
  }
  function num(key: string, fallback: number): number {
    const v = all[key];
    const n = v !== undefined ? Number(v) : NaN;
    return Number.isNaN(n) ? fallback : n;
  }
  function bool(key: string, fallback: boolean): boolean {
    const v = all[key];
    if (v === undefined) return fallback;
    return v.toLowerCase() === "true";
  }

  return {
    profitMarginPercent:   num("PROFIT_MARGIN_PERCENT",    bootConfig.profitMarginPercent),
    ebayFeeEstimate:       num("EBAY_FEE_ESTIMATE",         bootConfig.ebayFeeEstimate),
    autoOrderEnabled:      bool("AUTO_ORDER_ENABLED",       bootConfig.autoOrderEnabled),
    safetyStockBuffer:     num("SAFETY_STOCK_BUFFER",       bootConfig.safetyStockBuffer),
    syncIntervalMinutes:   num("SYNC_INTERVAL_MINUTES",     bootConfig.syncIntervalMinutes),
    ebayClientId:          str("EBAY_CLIENT_ID",            bootConfig.ebayClientId ?? ""),
    ebayClientSecret:      str("EBAY_CLIENT_SECRET",        bootConfig.ebayClientSecret ?? ""),
    ebayRefreshToken:      str("EBAY_REFRESH_TOKEN",        bootConfig.ebayRefreshToken ?? ""),
    ebayEnvironment:       (str("EBAY_ENVIRONMENT",         bootConfig.ebayEnvironment)) as "production" | "sandbox",
    autoListEnabled:       bool("AUTO_LIST_ENABLED",        false),
    ebayMerchantLocation:  str("EBAY_MERCHANT_LOCATION",    ""),
    ebayMarketplaceId:     str("EBAY_MARKETPLACE_ID",       "EBAY_US"),
    activeSupplier:        str("ACTIVE_SUPPLIER",           bootConfig.activeSupplier),
    cjApiKey:              str("CJ_API_KEY",                process.env.CJ_API_KEY ?? ""),
    cjApiSecret:           str("CJ_API_SECRET",             process.env.CJ_API_SECRET ?? ""),
    veroBlocklistPath:     str("VERO_BLOCKLIST_PATH",       bootConfig.veroBlocklistPath),
    scoutPullTimeoutMs:    num("SCOUT_PULL_TIMEOUT_MS",     bootConfig.scoutPullTimeoutMs),
    alertWebhookUrl:       str("ALERT_WEBHOOK_URL",         bootConfig.alertWebhookUrl ?? ""),
    alertTelegramBotToken: str("ALERT_TELEGRAM_BOT_TOKEN",  bootConfig.alertTelegramBotToken ?? ""),
    alertTelegramChatId:   str("ALERT_TELEGRAM_CHAT_ID",    bootConfig.alertTelegramChatId ?? ""),
    alertFailureThreshold: num("ALERT_FAILURE_THRESHOLD",   bootConfig.alertFailureThreshold),
    seoAutoRegenerate:     bool("AUTO_REGENERATE_SEO_ON_CHANGE", true),
    marginFloorPercent:    num("MARGIN_FLOOR_PERCENT", 0.10),
    pricingTiersJson:      str("PRICING_TIERS", "[]"),
  };
}

export type SettingsPatch = Partial<CoreSettings>;

export function patchSettings(db: Database.Database, patch: SettingsPatch): void {
  const map: Record<keyof CoreSettings, (v: unknown) => string> = {
    profitMarginPercent:   (v) => String(Math.max(0, Number(v))),
    ebayFeeEstimate:       (v) => String(Math.max(0, Number(v))),
    autoOrderEnabled:      (v) => String(Boolean(v)),
    safetyStockBuffer:     (v) => String(Math.max(0, Math.round(Number(v)))),
    syncIntervalMinutes:   (v) => String(Math.max(5, Math.round(Number(v)))),
    ebayClientId:          (v) => String(v ?? ""),
    ebayClientSecret:      (v) => String(v ?? ""),
    ebayRefreshToken:      (v) => String(v ?? ""),
    ebayEnvironment:       (v) => (v === "production" ? "production" : "sandbox"),
    autoListEnabled:       (v) => String(Boolean(v)),
    ebayMerchantLocation:  (v) => String(v ?? ""),
    ebayMarketplaceId:     (v) => String(v ?? "EBAY_US"),
    activeSupplier:        (v) => String(v ?? "CJ"),
    cjApiKey:              (v) => String(v ?? ""),
    cjApiSecret:           (v) => String(v ?? ""),
    veroBlocklistPath:     (v) => String(v ?? ""),
    scoutPullTimeoutMs:    (v) => String(Math.max(1000, Number(v))),
    alertWebhookUrl:       (v) => String(v ?? ""),
    alertTelegramBotToken: (v) => String(v ?? ""),
    alertTelegramChatId:   (v) => String(v ?? ""),
    alertFailureThreshold: (v) => String(Math.max(1, Math.round(Number(v)))),
    seoAutoRegenerate:     (v) => String(Boolean(v)),
    marginFloorPercent:    (v) => String(Math.min(1, Math.max(0, Number(v)))),
    pricingTiersJson:      (v) => {
      // Validate that the value is parseable JSON array before storing.
      // Silently fall back to "[]" if the client sends garbage.
      try {
        const parsed = JSON.parse(String(v ?? "[]"));
        return Array.isArray(parsed) ? JSON.stringify(parsed) : "[]";
      } catch {
        return "[]";
      }
    },
  };

  const dbKeyMap: Record<keyof CoreSettings, string> = {
    profitMarginPercent:   "PROFIT_MARGIN_PERCENT",
    ebayFeeEstimate:       "EBAY_FEE_ESTIMATE",
    autoOrderEnabled:      "AUTO_ORDER_ENABLED",
    safetyStockBuffer:     "SAFETY_STOCK_BUFFER",
    syncIntervalMinutes:   "SYNC_INTERVAL_MINUTES",
    ebayClientId:          "EBAY_CLIENT_ID",
    ebayClientSecret:      "EBAY_CLIENT_SECRET",
    ebayRefreshToken:      "EBAY_REFRESH_TOKEN",
    ebayEnvironment:       "EBAY_ENVIRONMENT",
    autoListEnabled:       "AUTO_LIST_ENABLED",
    ebayMerchantLocation:  "EBAY_MERCHANT_LOCATION",
    ebayMarketplaceId:     "EBAY_MARKETPLACE_ID",
    activeSupplier:        "ACTIVE_SUPPLIER",
    cjApiKey:              "CJ_API_KEY",
    cjApiSecret:           "CJ_API_SECRET",
    veroBlocklistPath:     "VERO_BLOCKLIST_PATH",
    scoutPullTimeoutMs:    "SCOUT_PULL_TIMEOUT_MS",
    alertWebhookUrl:       "ALERT_WEBHOOK_URL",
    alertTelegramBotToken: "ALERT_TELEGRAM_BOT_TOKEN",
    alertTelegramChatId:   "ALERT_TELEGRAM_CHAT_ID",
    alertFailureThreshold: "ALERT_FAILURE_THRESHOLD",
    seoAutoRegenerate:     "AUTO_REGENERATE_SEO_ON_CHANGE",
    marginFloorPercent:    "MARGIN_FLOOR_PERCENT",
    pricingTiersJson:      "PRICING_TIERS",
  };

  for (const [field, value] of Object.entries(patch) as [keyof CoreSettings, unknown][]) {
    if (value === undefined) continue;
    const dbKey = dbKeyMap[field];
    const serialize = map[field];
    if (dbKey && serialize) {
      setKey(db, dbKey, serialize(value));
    }
  }
}

// ─── server info (read-only, shown in dashboard) ─────────────────────────────

export interface ServerInfo {
  port: number;
  host: string;
  databaseFile: string;
  logFile: string;
  encryptionKeySet: boolean;
}

export function getServerInfo(bootConfig: CoreConfig): ServerInfo {
  return {
    port: bootConfig.port,
    host: bootConfig.host,
    databaseFile: bootConfig.databaseFile,
    logFile: bootConfig.logFile,
    encryptionKeySet: Boolean(bootConfig.encryptionKey),
  };
}

// ─── dashboard token change ───────────────────────────────────────────────────
// Stored in the config table under DASHBOARD_AUTH_TOKEN so the new token is
// used for all requests after the current request completes. The caller
// (settings route) must update the in-memory token reference after writing.

export function setDashboardToken(db: Database.Database, newToken: string): void {
  setKey(db, "DASHBOARD_AUTH_TOKEN", newToken);
}

export function getDashboardToken(db: Database.Database, bootFallback: string): string {
  return getKey(db, "DASHBOARD_AUTH_TOKEN") ?? bootFallback;
}
