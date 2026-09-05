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
import { getOverviewStats } from "../services/overviewService";
import { getAutoOrderEnabled, setAutoOrderEnabled } from "../services/runtimeConfigService";
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

export function dashboardRouter(db: Database.Database): Router {
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

  return router;
}
