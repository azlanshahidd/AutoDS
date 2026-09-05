/**
 * Config loader (Phase 1).
 *
 * Reads process.env (populated from .env via dotenv in index.ts / migrate.ts),
 * applies sane defaults where the master build prompt specifies one, and
 * throws a clear, human-readable error if a value that has NO safe default
 * is missing. This must run before anything else touches the database or
 * starts a server, so misconfiguration fails fast and loudly instead of
 * causing confusing errors later.
 *
 * NOTE: config values that are meant to be editable at runtime from the
 * dashboard (profit margin, stock buffer, sync interval, AUTO_ORDER_ENABLED)
 * are seeded into the `config` DB table on migration (see db/migrate.ts) and
 * are the source of truth once the app is running. The .env values here are
 * only the *initial seed* / fallback for first boot.
 */

export interface CoreConfig {
  port: number;
  host: string;
  dashboardAuthToken: string;
  databaseFile: string;
  encryptionKey: string; // 64 hex chars = 32 bytes, for AES-256-GCM
  activeSupplier: string;
  profitMarginPercent: number;
  ebayFeeEstimate: number;
  autoOrderEnabled: boolean;
  safetyStockBuffer: number;
  syncIntervalMinutes: number;
  logFile: string;
  ebayClientId: string | null;
  ebayClientSecret: string | null;
  ebayRefreshToken: string | null;
  ebayEnvironment: "production" | "sandbox";
  veroBlocklistPath: string;
  scoutServiceUrl: string;
  scoutPullTimeoutMs: number;
  alertWebhookUrl: string | null;
  alertTelegramBotToken: string | null;
  alertTelegramChatId: string | null;
  alertFailureThreshold: number;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(
      `Missing required environment variable "${key}". ` +
        `Copy .env.example to .env and set a value for ${key} before starting the service.`
    );
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value.trim() === "" ? fallback : value;
}

function parseBool(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

function parseNumberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) {
    throw new ConfigError(
      `Environment variable "${key}" must be a number, got "${raw}".`
    );
  }
  return n;
}

/**
 * Loads and validates config. Throws ConfigError with a clear message if
 * something required is missing or malformed — callers (index.ts, migrate.ts)
 * should let this throw propagate to a top-level handler that logs and exits
 * non-zero, rather than starting the service in a broken state.
 */
export function loadConfig(): CoreConfig {
  // Required — no safe default exists for these (security-sensitive / must be
  // explicitly chosen by the operator).
  const dashboardAuthToken = requireEnv("DASHBOARD_AUTH_TOKEN");
  const encryptionKey = requireEnv("ENCRYPTION_KEY");

  if (encryptionKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(encryptionKey)) {
    throw new ConfigError(
      `ENCRYPTION_KEY must be a 64-character hex string (32 bytes) for AES-256-GCM. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }

  if (dashboardAuthToken === "change_me_to_a_long_random_string") {
    throw new ConfigError(
      `DASHBOARD_AUTH_TOKEN is still set to the placeholder value from .env.example. ` +
        `Set it to a real random string before starting the service.`
    );
  }

  // Everything below has a sane, documented default per Section 4 / Section 5
  // of the build spec, so these are optional in .env.
  const port = parseNumberEnv("PORT", 4000);
  const host = optionalEnv("HOST", "127.0.0.1");
  const databaseFile = optionalEnv("DATABASE_FILE", "./data/core.db");
  const activeSupplier = optionalEnv("ACTIVE_SUPPLIER", "CJ");
  const profitMarginPercent = parseNumberEnv("PROFIT_MARGIN_PERCENT", 0.3);
  const ebayFeeEstimate = parseNumberEnv("EBAY_FEE_ESTIMATE", 2.5);
  const autoOrderEnabled = parseBool(optionalEnv("AUTO_ORDER_ENABLED", "false"));
  const safetyStockBuffer = parseNumberEnv("SAFETY_STOCK_BUFFER", 5);
  const syncIntervalMinutes = parseNumberEnv("SYNC_INTERVAL_MINUTES", 15);
  const logFile = optionalEnv("LOG_FILE", "./logs/core.log");

  // eBay credentials are NOT required to start the service (Phase 0-2 work
  // without them) — they're only required once the Phase 3+ eBay-calling
  // code paths actually run. We surface them as null rather than throwing,
  // so ebayClient.ts / routes that need them can give a clear "not
  // configured yet" error at the point of use instead of blocking startup.
  const ebayClientId = process.env.EBAY_CLIENT_ID || null;
  const ebayClientSecret = process.env.EBAY_CLIENT_SECRET || null;
  const ebayRefreshToken = process.env.EBAY_REFRESH_TOKEN || null;
  const ebayEnvironment = (optionalEnv("EBAY_ENVIRONMENT", "production") as "production" | "sandbox");
  if (ebayEnvironment !== "production" && ebayEnvironment !== "sandbox") {
    throw new ConfigError(`EBAY_ENVIRONMENT must be "production" or "sandbox", got "${ebayEnvironment}".`);
  }
  const veroBlocklistPath = optionalEnv("VERO_BLOCKLIST_PATH", "./config/vero-blocklist.txt");

  // Scout Service pull config (Phase 8). Never required for Core Service to
  // start — a missing/unreachable Scout Service must never block Core.
  const scoutServiceUrl = optionalEnv("SCOUT_SERVICE_URL", "http://127.0.0.1:4100");
  const scoutPullTimeoutMs = parseNumberEnv("SCOUT_PULL_TIMEOUT_MS", 8000);

  // Alerting (Phase 9). All optional — if none are set, alerts are simply
  // never sent (failures are still fully visible in sync_logs/dashboard).
  const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL || null;
  const alertTelegramBotToken = process.env.ALERT_TELEGRAM_BOT_TOKEN || null;
  const alertTelegramChatId = process.env.ALERT_TELEGRAM_CHAT_ID || null;
  const alertFailureThreshold = parseNumberEnv("ALERT_FAILURE_THRESHOLD", 3);

  if (syncIntervalMinutes < 5) {
    throw new ConfigError(
      `SYNC_INTERVAL_MINUTES is set to ${syncIntervalMinutes}, which is below the ` +
        `minimum of 5 minutes required to avoid rate-limit/bot-detection issues (Section 5). ` +
        `Set it to 5 or higher (15-30 is the recommended default).`
    );
  }

  return {
    port,
    host,
    dashboardAuthToken,
    databaseFile,
    encryptionKey,
    activeSupplier,
    profitMarginPercent,
    ebayFeeEstimate,
    autoOrderEnabled,
    safetyStockBuffer,
    syncIntervalMinutes,
    logFile,
    ebayClientId,
    ebayClientSecret,
    ebayRefreshToken,
    ebayEnvironment,
    veroBlocklistPath,
    scoutServiceUrl,
    scoutPullTimeoutMs,
    alertWebhookUrl,
    alertTelegramBotToken,
    alertTelegramChatId,
    alertFailureThreshold,
  };
}

export { ConfigError };
