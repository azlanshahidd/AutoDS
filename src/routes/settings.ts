/**
 * Settings routes.
 *
 * Fixes applied:
 *  P2-005 — GET /api/settings masks ebayClientSecret, ebayRefreshToken,
 *            cjApiKey, cjApiSecret, alertTelegramBotToken in the response.
 *  P2-011 — removed dead setDashboardToken import.
 *  P2-013 — PATCH validates profitMarginPercent and ebayFeeEstimate >= 0.
 *  P2-014 — PATCH clamps scoutPullTimeoutMs >= 1000 and safetyStockBuffer >= 0.
 */
import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import { CoreConfig } from "../config";
import { getSettings, patchSettings, SettingsPatch, getServerInfo } from "../services/runtimeConfigService";
import { logger } from "../logger";
import { verifyPassword, hashPassword } from "../auth/password";

/** Show last 4 chars only — same pattern as supplier key masking. */
function maskValue(v: string): string {
  if (!v) return "";
  if (v.length <= 4) return "••••";
  return `••••${v.slice(-4)}`;
}

export function settingsRouter(db: Database.Database, bootConfig: CoreConfig): Router {
  const router = Router();

  // GET /api/settings
  router.get("/", (_req: Request, res: Response) => {
    try {
      const raw = getSettings(db, bootConfig);

      // P2-005: mask sensitive credential fields before sending to browser
      const settings = {
        ...raw,
        ebayClientSecret:      maskValue(raw.ebayClientSecret),
        ebayRefreshToken:      maskValue(raw.ebayRefreshToken),
        cjApiKey:              maskValue(raw.cjApiKey),
        cjApiSecret:           maskValue(raw.cjApiSecret),
        alertTelegramBotToken: maskValue(raw.alertTelegramBotToken),
      };

      res.json({ settings, serverInfo: getServerInfo(bootConfig) });
    } catch (err) {
      logger.error("Failed to load settings", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to load settings." });
    }
  });

  // PATCH /api/settings
  router.patch("/", (req: Request, res: Response) => {
    const body: SettingsPatch = req.body || {};

    if (
      body.ebayEnvironment !== undefined &&
      body.ebayEnvironment !== "production" &&
      body.ebayEnvironment !== "sandbox"
    ) {
      return res.status(400).json({ error: "ebayEnvironment must be 'production' or 'sandbox'." });
    }
    if (body.syncIntervalMinutes !== undefined && Number(body.syncIntervalMinutes) < 5) {
      return res.status(400).json({ error: "syncIntervalMinutes must be at least 5." });
    }

    const numericFields: (keyof SettingsPatch)[] = [
      "profitMarginPercent", "ebayFeeEstimate", "safetyStockBuffer",
      "syncIntervalMinutes", "scoutPullTimeoutMs", "alertFailureThreshold",
    ];
    for (const field of numericFields) {
      if (body[field] !== undefined && isNaN(Number(body[field]))) {
        return res.status(400).json({ error: `${field} must be a number.` });
      }
    }

    // P2-013: profit margin and eBay fee must be non-negative
    if (body.profitMarginPercent !== undefined && Number(body.profitMarginPercent) < 0) {
      return res.status(400).json({ error: "profitMarginPercent must be >= 0." });
    }
    if (body.ebayFeeEstimate !== undefined && Number(body.ebayFeeEstimate) < 0) {
      return res.status(400).json({ error: "ebayFeeEstimate must be >= 0." });
    }

    // P2-014: safety stock must be >= 0, pull timeout must be >= 1000ms
    if (body.safetyStockBuffer !== undefined && Number(body.safetyStockBuffer) < 0) {
      return res.status(400).json({ error: "safetyStockBuffer must be >= 0." });
    }
    if (body.scoutPullTimeoutMs !== undefined && Number(body.scoutPullTimeoutMs) < 1000) {
      return res.status(400).json({ error: "scoutPullTimeoutMs must be at least 1000 (1 second)." });
    }

    // P2-005: if the frontend sends back a masked placeholder, don't overwrite
    // the real stored value.  Masked values start with "••••".
    const maskedFields: (keyof SettingsPatch)[] = [
      "ebayClientSecret", "ebayRefreshToken",
      "cjApiKey", "cjApiSecret", "alertTelegramBotToken",
    ];
    for (const field of maskedFields) {
      const v = body[field];
      if (typeof v === "string" && v.startsWith("••••")) {
        delete (body as Record<string, unknown>)[field];
      }
    }

    try {
      patchSettings(db, body);
      const raw = getSettings(db, bootConfig);
      const settings = {
        ...raw,
        ebayClientSecret:      maskValue(raw.ebayClientSecret),
        ebayRefreshToken:      maskValue(raw.ebayRefreshToken),
        cjApiKey:              maskValue(raw.cjApiKey),
        cjApiSecret:           maskValue(raw.cjApiSecret),
        alertTelegramBotToken: maskValue(raw.alertTelegramBotToken),
      };
      logger.info("Settings updated via dashboard", { fields: Object.keys(body) });
      res.json({ settings, serverInfo: getServerInfo(bootConfig) });
    } catch (err) {
      logger.error("Failed to update settings", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to save settings." });
    }
  });

  // POST /api/settings/change-password
  router.post("/change-password", (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "currentPassword and newPassword are required." });
    }
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      return res.status(400).json({ error: "currentPassword and newPassword must be strings." });
    }
    if (newPassword.trim().length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters." });
    }
    if (currentPassword.length > 1024 || newPassword.length > 1024) {
      return res.status(400).json({ error: "Password must be 1024 characters or fewer." });
    }

    const storedHash = (
      db.prepare("SELECT value FROM config WHERE key = 'DASHBOARD_PASSWORD_HASH'").get() as
        | { value: string }
        | undefined
    )?.value;
    if (!storedHash || !verifyPassword(currentPassword, storedHash)) {
      return res.status(403).json({ error: "Current password is incorrect." });
    }

    try {
      const newHash = hashPassword(newPassword.trim());
      db.prepare(
        `INSERT INTO config (key, value, updated_at) VALUES ('DASHBOARD_PASSWORD_HASH', ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      ).run(newHash);
      db.prepare(
        `INSERT INTO config (key, value, updated_at) VALUES ('ACTIVE_SESSION_TOKEN', '', datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = '', updated_at = datetime('now')`
      ).run();
      logger.info("Dashboard password changed via settings");
      res.json({ success: true });
    } catch (err) {
      logger.error("Failed to change password", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to change password." });
    }
  });

  return router;
}
