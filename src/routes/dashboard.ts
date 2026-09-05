/**
 * Dashboard data routes — Overview, Products, Orders, Logs, Auto-order toggle.
 *
 * Fixes applied:
 *  P2-001 — parseIntId guard on DELETE /api/logs/:id
 *  P2-006 — DELETE /api/logs?type= validates type is a known value
 *  P2-007 — GET    /api/logs?type= validates type is a known value
 */
import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import { CoreConfig } from "../config";
import { getOverviewStats } from "../services/overviewService";
import { getAutoOrderEnabled, setAutoOrderEnabled } from "../services/runtimeConfigService";
import { buildEbayClient, EbayNotConfiguredError } from "../ebay/ebayFactory";
import { logger } from "../logger";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseIntId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const VALID_LOG_TYPES = [
  "price_stock",
  "order_routing",
  "fulfillment_tracking",
  "scout_pull",
] as const;

type LogType = typeof VALID_LOG_TYPES[number];

function parseLogType(raw: unknown): LogType | null | "invalid" {
  if (raw === undefined) return null;               // no filter — all types
  if (typeof raw !== "string") return "invalid";
  if ((VALID_LOG_TYPES as readonly string[]).includes(raw)) return raw as LogType;
  return "invalid";
}

// ── Router ────────────────────────────────────────────────────────────────────

export function dashboardRouter(db: Database.Database, config: CoreConfig): Router {
  const router = Router();

  // GET /api/overview
  router.get("/overview", (_req: Request, res: Response) => {
    try {
      res.json(getOverviewStats(db));
    } catch (err) {
      logger.error("Failed to load overview stats", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to load overview stats." });
    }
  });

  // GET /api/overview/setup-status — lightweight check for the onboarding checklist
  router.get("/overview/setup-status", (_req: Request, res: Response) => {
    try {
      const getConfig = (key: string) =>
        (db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? "";

      const ebayClientId    = getConfig("EBAY_CLIENT_ID");
      const ebayRefreshToken = getConfig("EBAY_REFRESH_TOKEN");

      const supplierRow = db
        .prepare("SELECT id FROM suppliers WHERE status = 'connected' LIMIT 1")
        .get();

      const aiProviderRow = db
        .prepare("SELECT id FROM ai_providers WHERE enabled = 1 AND status = 'connected' LIMIT 1")
        .get();

      res.json({
        ebayConfigured:       Boolean(ebayClientId && ebayRefreshToken),
        supplierConnected:    Boolean(supplierRow),
        aiProviderConfigured: Boolean(aiProviderRow),
      });
    } catch (err) {
      logger.error("Failed to load setup status", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to load setup status." });
    }
  });

  // GET /api/config/auto-order-enabled
  router.get("/config/auto-order-enabled", (_req: Request, res: Response) => {
    res.json({ enabled: getAutoOrderEnabled(db) });
  });

  // PATCH /api/config/auto-order-enabled
  router.patch("/config/auto-order-enabled", (req: Request, res: Response) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "Body must include boolean 'enabled'." });
    }
    const updated = setAutoOrderEnabled(db, enabled);
    logger.info("AUTO_ORDER_ENABLED changed via dashboard", { enabled: updated });
    res.json({ enabled: updated });
  });

  // GET /api/products
  router.get("/products", (_req: Request, res: Response) => {
    try {
      const rows = db
        .prepare(
          `SELECT variants.internal_sku, variants.supplier_type, variants.supplier_variant_id,
                  variants.current_price, variants.current_stock, variants.last_synced_at,
                  variants.ebay_sku, products.title as product_title
           FROM variants JOIN products ON products.id = variants.product_id
           ORDER BY variants.updated_at DESC`
        )
        .all();
      res.json({ products: rows });
    } catch (err) {
      logger.error("Failed to load products", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to load products." });
    }
  });

  // PATCH /api/products/:sku/price — inline price override from the Products table.
  // Overwrites current_price and sets ebay_push_pending=1 so the next sync cycle
  // pushes the new price to eBay even if the supplier cost hasn't changed.
  router.patch("/products/:sku/price", (req: Request, res: Response) => {
    const { sku } = req.params;
    const { price } = req.body || {};

    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: "price must be a non-negative finite number." });
    }
    if (price > 100_000) {
      return res.status(400).json({ error: "price must be below $100,000." });
    }

    try {
      const result = db
        .prepare(
          `UPDATE variants
             SET current_price = ?, ebay_push_pending = 1, updated_at = datetime('now')
           WHERE internal_sku = ?`
        )
        .run(Math.round(price * 100) / 100, sku);

      if (result.changes === 0) {
        return res.status(404).json({ error: `No variant found with SKU "${sku}".` });
      }

      logger.info("Variant price manually overridden", { sku, price });
      res.json({ internalSku: sku, currentPrice: Math.round(price * 100) / 100 });
    } catch (err) {
      logger.error("Failed to update variant price", { error: (err as Error).message, sku });
      res.status(500).json({ error: "Failed to update price." });
    }
  });

  // GET /api/orders
  router.get("/orders", (_req: Request, res: Response) => {
    try {
      const rows = db
        .prepare(
          `SELECT ebay_order_id, supplier_type, supplier_order_id, status,
                  tracking_number, carrier, created_at, updated_at
           FROM orders ORDER BY created_at DESC`
        )
        .all();
      res.json({ orders: rows });
    } catch (err) {
      logger.error("Failed to load orders", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to load orders." });
    }
  });

  // GET /api/logs — P2-007: validate type param
  router.get("/logs", (req: Request, res: Response) => {
    const typeResult = parseLogType(req.query.type);
    if (typeResult === "invalid") {
      return res.status(400).json({
        error: `Invalid log type. Must be one of: ${VALID_LOG_TYPES.join(", ")}`,
      });
    }

    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const rows = typeResult
        ? db
            .prepare(`SELECT * FROM sync_logs WHERE type = ? ORDER BY id DESC LIMIT ?`)
            .all(typeResult, limit)
        : db
            .prepare(`SELECT * FROM sync_logs ORDER BY id DESC LIMIT ?`)
            .all(limit);
      res.json({ logs: rows });
    } catch (err) {
      logger.error("Failed to load logs", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to load logs." });
    }
  });

  // DELETE /api/logs/:id — P2-001: parseIntId
  router.delete("/logs/:id", (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    try {
      const result = db.prepare("DELETE FROM sync_logs WHERE id = ?").run(id);
      if (result.changes === 0)
        return res.status(404).json({ error: "Log entry not found." });
      logger.info("Log entry deleted", { id });
      res.status(204).send();
    } catch (err) {
      logger.error("Failed to delete log entry", { error: (err as Error).message, id });
      res.status(500).json({ error: "Failed to delete log entry." });
    }
  });

  // DELETE /api/logs — P2-006: validate type param
  router.delete("/logs", (req: Request, res: Response) => {
    const typeResult = parseLogType(req.query.type);
    if (typeResult === "invalid") {
      return res.status(400).json({
        error: `Invalid log type. Must be one of: ${VALID_LOG_TYPES.join(", ")}`,
      });
    }

    try {
      const result = typeResult
        ? db.prepare("DELETE FROM sync_logs WHERE type = ?").run(typeResult)
        : db.prepare("DELETE FROM sync_logs").run();
      logger.info("Logs cleared", { type: typeResult ?? "all", deleted: result.changes });
      res.json({ deleted: result.changes });
    } catch (err) {
      logger.error("Failed to clear logs", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to clear logs." });
    }
  });

  // GET /api/seller-health — eBay seller performance metrics via Analytics API.
  // Returns null metrics gracefully when eBay credentials aren't configured,
  // the sandbox doesn't support Analytics, or the scope is missing.
  // Results are cached for 1 hour — polling this every 8 seconds would be wasteful
  // and could hit rate limits. The frontend polls it once on page load.
  let cachedHealth: unknown = null;
  let healthCachedAt = 0;
  const HEALTH_CACHE_MS = 60 * 60 * 1000; // 1 hour

  router.get("/seller-health", async (_req: Request, res: Response) => {
    // Serve from cache if fresh
    if (cachedHealth && Date.now() - healthCachedAt < HEALTH_CACHE_MS) {
      return res.json(cachedHealth);
    }

    try {
      const ebayClient = buildEbayClient(config);
      const profile = await ebayClient.getSellerStandards();

      // Derive alert state from known eBay thresholds
      let alertLevel: "ok" | "warning" | "critical" = "ok";
      const alerts: string[] = [];

      if (profile) {
        for (const m of profile.metrics) {
          const pct = m.value != null ? m.value * 100 : null;
          if (pct === null) continue;

          if (m.name === "TRANSACTION_DEFECT_RATE") {
            if (pct >= 2)   { alertLevel = "critical"; alerts.push(`Transaction defect rate ${pct.toFixed(2)}% ≥ 2% (account at risk)`); }
            else if (pct >= 0.5) { if (alertLevel !== "critical") alertLevel = "warning"; alerts.push(`Transaction defect rate ${pct.toFixed(2)}% (Top Rated threshold: 0.5%)`); }
          }
          if (m.name === "LATE_SHIPMENT_RATE") {
            if (pct >= 10)  { alertLevel = "critical"; alerts.push(`Late shipment rate ${pct.toFixed(2)}% ≥ 10% (account at risk)`); }
            else if (pct >= 3)  { if (alertLevel !== "critical") alertLevel = "warning"; alerts.push(`Late shipment rate ${pct.toFixed(2)}% (Top Rated threshold: 3%)`); }
          }
          if (m.name === "CASES_CLOSED_WITHOUT_SELLER_RESOLUTION") {
            if (pct >= 0.3) { alertLevel = "critical"; alerts.push(`Cases closed without resolution ${pct.toFixed(2)}% ≥ 0.3% (account at risk)`); }
          }
        }

        if (profile.standardsLevel === "BELOW_STANDARD") {
          alertLevel = "critical";
          alerts.unshift("Seller account is BELOW STANDARD — immediate action required.");
        }
      }

      const response = { profile, alertLevel, alerts, fetchedAt: new Date().toISOString() };
      cachedHealth   = response;
      healthCachedAt = Date.now();
      res.json(response);
    } catch (err) {
      const message = err instanceof EbayNotConfiguredError ? "eBay not configured" : (err as Error).message;
      const response = { profile: null, alertLevel: "ok" as const, alerts: [], fetchedAt: new Date().toISOString(), unavailableReason: message };
      cachedHealth   = response;
      healthCachedAt = Date.now();
      res.json(response);
    }
  });

  return router;
}
