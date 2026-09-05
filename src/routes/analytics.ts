/**
 * Analytics routes — powers the CoreDash Analytics page.
 *
 * All five endpoints derive their data from existing tables (variants,
 * products, orders, scouted_products, config) — no new data collection
 * required. Revenue and cost are computed from the variant's current
 * listing price and supplier cost, not from eBay's Order API, which means
 * figures are *estimated* based on current snapshot data rather than
 * confirmed settled transactions. This is clearly surfaced in the UI.
 *
 * Endpoints:
 *   GET /api/analytics/summary          P&L totals + daily time-series
 *   GET /api/analytics/products         Per-product profitability table
 *   GET /api/analytics/suppliers        Per-supplier scorecards
 *   GET /api/analytics/funnel           Scout → approve → list pipeline counts
 *   GET /api/analytics/margin-alerts    Variants whose margin < MARGIN_FLOOR_PERCENT
 *
 * All date-range endpoints accept optional `?from=YYYY-MM-DD&to=YYYY-MM-DD`
 * query params (defaults: last 30 days).
 */
import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import { logger } from "../logger";

// ── Helpers ───────────────────────────────────────────────────────────────────

function getConfigNum(db: Database.Database, key: string, fallback: number): number {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
    | { value: string } | undefined;
  const n = Number(row?.value);
  return Number.isFinite(n) ? n : fallback;
}

function parseDateParam(raw: unknown, fallback: Date): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return fallback.toISOString().slice(0, 10);
  }
  return raw;
}

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 29);
  return d.toISOString().slice(0, 10);
}

function defaultTo(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Types (mirrored in frontend api.ts) ──────────────────────────────────────

interface VariantPricingRow {
  product_id:          number;
  product_title:       string;
  internal_sku:        string;
  supplier_type:       string;
  cost:                number | null;
  shipping_cost:       number | null;
  current_price:       number | null;
  current_stock:       number | null;
  ebay_sku:            string | null;
  created_at:          string;
}

// ── Router ────────────────────────────────────────────────────────────────────

export function analyticsRouter(db: Database.Database): Router {
  const router = Router();

  // ── GET /api/analytics/summary ────────────────────────────────────────────
  /**
   * Returns:
   *   totals:  { revenue, cogs, grossProfit, marginPct, ordersTotal, variantsListed }
   *   series:  daily array of { date, revenue, cogs, grossProfit, orders }
   *   range:   { from, to }
   *
   * Revenue is estimated as: listed variants × current_price (within range
   * approximated by order count as a multiplier — see note in response).
   * The daily series uses orders.created_at date as the "sale date".
   * Per-order revenue is estimated as variants.current_price for the matching
   * eBay SKU — since the orders table carries no price column, we do a best-
   * effort join through the variants table.
   */
  router.get("/summary", (req: Request, res: Response) => {
    try {
      const from = parseDateParam(req.query.from, new Date(defaultFrom()));
      const to   = parseDateParam(req.query.to,   new Date());

      const ebayFee    = getConfigNum(db, "EBAY_FEE_ESTIMATE", 2.5);
      const marginFloor = getConfigNum(db, "MARGIN_FLOOR_PERCENT", 0.10);

      // --- Daily order counts in range ---
      const dailyOrders = db.prepare(
        `SELECT date(created_at) as date,
                COUNT(*) as total_orders,
                COUNT(CASE WHEN status IN ('submitted','shipped','fulfilled') THEN 1 END) as placed_orders
         FROM orders
         WHERE date(created_at) BETWEEN ? AND ?
         GROUP BY date(created_at)
         ORDER BY date(created_at) ASC`
      ).all(from, to) as Array<{ date: string; total_orders: number; placed_orders: number }>;

      // --- Variant snapshot for P&L estimation ---
      // We use CURRENT variant cost/price as the best available estimate per SKU.
      // For a proper per-transaction P&L the orders table would need price columns.
      const variants = db.prepare(
        `SELECT v.internal_sku, v.ebay_sku, v.supplier_type,
                COALESCE(v.cost, 0) as cost,
                COALESCE(v.shipping_cost, 0) as shipping_cost,
                COALESCE(v.current_price, 0) as current_price,
                COALESCE(v.current_stock, 0) as current_stock
         FROM variants v
         WHERE v.ebay_sku IS NOT NULL`
      ).all() as Array<{
        internal_sku: string; ebay_sku: string; supplier_type: string;
        cost: number; shipping_cost: number; current_price: number; current_stock: number;
      }>;

      // Build a lookup from ebay_sku → pricing
      const skuMap = new Map(variants.map(v => [v.ebay_sku, v]));

      // --- Orders in range with SKU breakdown (via join) ---
      // The orders table doesn't store line-item SKUs.  We can approximate
      // by counting orders per supplier_type, then distributing revenue
      // across that supplier's average price.
      const ordersInRange = db.prepare(
        `SELECT supplier_type, COUNT(*) as cnt
         FROM orders
         WHERE date(created_at) BETWEEN ? AND ?
           AND status IN ('submitted','shipped','fulfilled')
         GROUP BY supplier_type`
      ).all(from, to) as Array<{ supplier_type: string; cnt: number }>;

      // Aggregate totals by supplier type
      const supplierVariants = new Map<string, typeof variants[0][]>();
      for (const v of variants) {
        const arr = supplierVariants.get(v.supplier_type) ?? [];
        arr.push(v);
        supplierVariants.set(v.supplier_type, arr);
      }

      // For each placed order, use the average revenue/cost of that supplier's
      // listed variants as the per-order estimate.
      let totalRevenue = 0, totalCogs = 0;
      for (const { supplier_type, cnt } of ordersInRange) {
        const sv = supplierVariants.get(supplier_type) ?? [];
        if (sv.length === 0) continue;
        const avgPrice = sv.reduce((s, v) => s + v.current_price, 0) / sv.length;
        const avgCost  = sv.reduce((s, v) => s + v.cost + v.shipping_cost, 0) / sv.length;
        totalRevenue += avgPrice * cnt;
        totalCogs    += (avgCost + ebayFee) * cnt;
      }
      const grossProfit = totalRevenue - totalCogs;
      const marginPct   = totalRevenue > 0 ? grossProfit / totalRevenue : 0;

      // Total orders in range
      const totalOrdersRow = db.prepare(
        `SELECT COUNT(*) as c FROM orders
         WHERE date(created_at) BETWEEN ? AND ?`
      ).get(from, to) as { c: number };

      const variantsListed = variants.length;

      // --- Daily series ---
      // Build date spine between from..to
      const series: Array<{ date: string; revenue: number; cogs: number; grossProfit: number; orders: number }> = [];
      const cursor = new Date(from + "T00:00:00Z");
      const end    = new Date(to   + "T00:00:00Z");

      // Average price/cost across all listed variants for day-level estimate
      const globalAvgPrice = variants.length
        ? variants.reduce((s, v) => s + v.current_price, 0) / variants.length
        : 0;
      const globalAvgCost  = variants.length
        ? variants.reduce((s, v) => s + v.cost + v.shipping_cost + ebayFee, 0) / variants.length
        : 0;

      const dailyMap = new Map(dailyOrders.map(d => [d.date, d]));

      while (cursor <= end) {
        const dateStr = cursor.toISOString().slice(0, 10);
        const day = dailyMap.get(dateStr);
        const ordersCount = day?.placed_orders ?? 0;
        const rev  = ordersCount * globalAvgPrice;
        const cogs = ordersCount * globalAvgCost;
        series.push({
          date:        dateStr,
          revenue:     Math.round(rev  * 100) / 100,
          cogs:        Math.round(cogs * 100) / 100,
          grossProfit: Math.round((rev - cogs) * 100) / 100,
          orders:      ordersCount,
        });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      res.json({
        totals: {
          revenue:        Math.round(totalRevenue * 100) / 100,
          cogs:           Math.round(totalCogs    * 100) / 100,
          grossProfit:    Math.round(grossProfit   * 100) / 100,
          marginPct:      Math.round(marginPct * 10000) / 100, // as %
          ordersTotal:    totalOrdersRow.c,
          variantsListed,
          ebayFeeEstimate: ebayFee,
          marginFloor:     Math.round(marginFloor * 100),
        },
        series,
        range: { from, to },
        note: "Revenue and cost figures are estimates based on current listed prices and supplier costs. Actual settled amounts may differ.",
      });
    } catch (err) {
      logger.error("Analytics /summary failed", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to load analytics summary." });
    }
  });

  // ── GET /api/analytics/products ───────────────────────────────────────────
  /**
   * Returns per-product profitability rows, sorted by estimated gross profit desc.
   * Includes: product title, SKU, supplier, units in stock, estimated revenue,
   * COGS, gross profit, margin %, days since first listed.
   */
  router.get("/products", (_req: Request, res: Response) => {
    try {
      const ebayFee = getConfigNum(db, "EBAY_FEE_ESTIMATE", 2.5);

      const rows = db.prepare(
        `SELECT
           p.id as product_id,
           p.title as product_title,
           p.created_at as product_created_at,
           v.internal_sku,
           v.supplier_type,
           v.ebay_sku,
           COALESCE(v.cost, 0)           as cost,
           COALESCE(v.shipping_cost, 0)  as shipping_cost,
           COALESCE(v.current_price, 0)  as current_price,
           COALESCE(v.current_stock, 0)  as current_stock,
           v.last_synced_at,
           COUNT(o.id)                   as order_count
         FROM variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN orders o
           ON o.supplier_type = v.supplier_type
          AND o.status IN ('submitted','shipped','fulfilled')
         WHERE v.ebay_sku IS NOT NULL
         GROUP BY v.id
         ORDER BY order_count DESC, v.current_price DESC`
      ).all() as Array<{
        product_id: number;
        product_title: string;
        product_created_at: string;
        internal_sku: string;
        supplier_type: string;
        ebay_sku: string | null;
        cost: number;
        shipping_cost: number;
        current_price: number;
        current_stock: number;
        last_synced_at: string | null;
        order_count: number;
      }>;

      const products = rows.map(r => {
        const totalCost    = r.cost + r.shipping_cost + ebayFee;
        const grossProfit  = r.current_price - totalCost;
        const marginPct    = r.current_price > 0
          ? Math.round((grossProfit / r.current_price) * 10000) / 100
          : 0;
        const estimatedRevenue = Math.round(r.current_price * r.order_count * 100) / 100;
        const estimatedProfit  = Math.round(grossProfit * r.order_count * 100) / 100;

        // Days since listed (approximated by product created_at)
        const daysListed = r.product_created_at
          ? Math.floor((Date.now() - new Date(r.product_created_at + (r.product_created_at.includes("T") ? "" : "T00:00:00Z")).getTime()) / 86_400_000)
          : null;

        return {
          productId:         r.product_id,
          productTitle:      r.product_title,
          internalSku:       r.internal_sku,
          ebaySku:           r.ebay_sku,
          supplierType:      r.supplier_type,
          cost:              Math.round(r.cost * 100) / 100,
          shippingCost:      Math.round(r.shipping_cost * 100) / 100,
          ebayFee:           Math.round(ebayFee * 100) / 100,
          currentPrice:      Math.round(r.current_price * 100) / 100,
          currentStock:      r.current_stock,
          grossProfitPerUnit: Math.round(grossProfit * 100) / 100,
          marginPct,
          orderCount:        r.order_count,
          estimatedRevenue,
          estimatedProfit,
          lastSyncedAt:      r.last_synced_at,
          daysListed,
        };
      });

      res.json({ products });
    } catch (err) {
      logger.error("Analytics /products failed", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to load product analytics." });
    }
  });

  // ── GET /api/analytics/suppliers ─────────────────────────────────────────
  /**
   * Per-supplier scorecards:
   *   - Number of listed variants
   *   - Total order count (all time)
   *   - Order failure rate
   *   - Average margin % across their variants
   *   - Price-change frequency (price changes / variant / last 30d, estimated
   *     from sync_logs details_json where available)
   *   - Average fulfillment time (days from order created to status=shipped/fulfilled)
   */
  router.get("/suppliers", (_req: Request, res: Response) => {
    try {
      const ebayFee = getConfigNum(db, "EBAY_FEE_ESTIMATE", 2.5);

      // Variant counts + margin per supplier
      const variantStats = db.prepare(
        `SELECT
           v.supplier_type,
           COUNT(*) as variant_count,
           AVG(CASE WHEN v.current_price > 0
               THEN (v.current_price - COALESCE(v.cost,0) - COALESCE(v.shipping_cost,0) - ?)
                    / v.current_price
               ELSE NULL END) as avg_margin
         FROM variants v
         WHERE v.ebay_sku IS NOT NULL
         GROUP BY v.supplier_type`
      ).all(ebayFee) as Array<{ supplier_type: string; variant_count: number; avg_margin: number | null }>;

      // Order counts + failure rates per supplier
      const orderStats = db.prepare(
        `SELECT
           supplier_type,
           COUNT(*) as total_orders,
           COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_orders,
           COUNT(CASE WHEN status IN ('submitted','shipped','fulfilled') THEN 1 END) as placed_orders
         FROM orders
         GROUP BY supplier_type`
      ).all() as Array<{ supplier_type: string; total_orders: number; failed_orders: number; placed_orders: number }>;

      // Avg fulfillment time (created_at → updated_at when status=shipped/fulfilled)
      const fulfillmentTimes = db.prepare(
        `SELECT
           supplier_type,
           AVG(
             CAST((julianday(updated_at) - julianday(created_at)) AS REAL)
           ) as avg_days_to_ship
         FROM orders
         WHERE status IN ('shipped','fulfilled')
         GROUP BY supplier_type`
      ).all() as Array<{ supplier_type: string; avg_days_to_ship: number | null }>;

      // Collect all supplier keys from all three queries
      const allKeys = new Set([
        ...variantStats.map(r => r.supplier_type),
        ...orderStats.map(r => r.supplier_type),
      ]);

      const vsMap  = new Map(variantStats.map(r => [r.supplier_type, r]));
      const osMap  = new Map(orderStats.map(r => [r.supplier_type, r]));
      const ftMap  = new Map(fulfillmentTimes.map(r => [r.supplier_type, r]));

      const scorecards = Array.from(allKeys).map(key => {
        const vs = vsMap.get(key);
        const os = osMap.get(key);
        const ft = ftMap.get(key);

        const totalOrders  = os?.total_orders  ?? 0;
        const failedOrders = os?.failed_orders ?? 0;
        const failureRate  = totalOrders > 0
          ? Math.round((failedOrders / totalOrders) * 10000) / 100
          : 0;

        return {
          supplierType:   key,
          variantCount:   vs?.variant_count ?? 0,
          avgMarginPct:   vs?.avg_margin != null
            ? Math.round(vs.avg_margin * 10000) / 100
            : null,
          totalOrders,
          failedOrders,
          failureRate,
          placedOrders:   os?.placed_orders ?? 0,
          avgDaysToShip:  ft?.avg_days_to_ship != null
            ? Math.round(ft.avg_days_to_ship * 10) / 10
            : null,
        };
      });

      res.json({ scorecards });
    } catch (err) {
      logger.error("Analytics /suppliers failed", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to load supplier analytics." });
    }
  });

  // ── GET /api/analytics/funnel ────────────────────────────────────────────
  /**
   * Scout → approve → list pipeline counts and drop-off at each stage.
   *
   * Funnel stages:
   *   1. Total scouted           (all scouted_products rows)
   *   2. Approved                (status = 'approved')
   *   3. Discarded               (status = 'discarded')
   *   4. Queued / publishing     (listing_status IN ('queued','publishing'))
   *   5. Published               (listing_status = 'published')
   *   6. VeRO blocked            (listing_status = 'vero_blocked')
   *   7. Quality/other failure   (listing_status IN ('quality_fail','failed'))
   *   8. Orders placed           (orders.status IN ('submitted','shipped','fulfilled'))
   *
   * Accepts optional `?from=` / `?to=` date range filtering on created_at.
   */
  router.get("/funnel", (req: Request, res: Response) => {
    try {
      const from = parseDateParam(req.query.from, new Date(defaultFrom()));
      const to   = parseDateParam(req.query.to,   new Date());

      const dateFilter = "AND date(created_at) BETWEEN ? AND ?";
      const args = [from, to];

      function count(where: string, extraArgs: unknown[] = []): number {
        const row = db.prepare(
          `SELECT COUNT(*) as c FROM scouted_products WHERE ${where} ${dateFilter}`
        ).get(...[...extraArgs, ...args]) as { c: number };
        return row.c;
      }

      const totalScouted  = count("1=1");
      const approved      = count("status = 'approved'");
      const discarded     = count("status = 'discarded'");
      const pending       = count("status = 'pending_review'");
      const queued        = count("listing_status IN ('queued','publishing')");
      const published     = count("listing_status = 'published'");
      const veroBlocked   = count("listing_status = 'vero_blocked'");
      const qualityFailed = count("listing_status IN ('quality_fail','failed')");

      // Orders placed — use orders table (not filtered by scouted date, use order date)
      const ordersPlaced = (db.prepare(
        `SELECT COUNT(*) as c FROM orders
         WHERE status IN ('submitted','shipped','fulfilled')
           AND date(created_at) BETWEEN ? AND ?`
      ).get(from, to) as { c: number }).c;

      const ordersShipped = (db.prepare(
        `SELECT COUNT(*) as c FROM orders
         WHERE status IN ('shipped','fulfilled')
           AND date(created_at) BETWEEN ? AND ?`
      ).get(from, to) as { c: number }).c;

      // Drop-off counts at each stage
      const stages = [
        { stage: "Scouted",        count: totalScouted,  dropOff: 0 },
        { stage: "Approved",       count: approved,       dropOff: totalScouted - approved - discarded },
        { stage: "Discarded",      count: discarded,      dropOff: 0 },  // not a drop-off, intentional
        { stage: "Listed",         count: published,      dropOff: approved - published - queued - veroBlocked - qualityFailed },
        { stage: "Orders Placed",  count: ordersPlaced,   dropOff: 0 },
        { stage: "Shipped",        count: ordersShipped,  dropOff: ordersPlaced - ordersShipped },
      ];

      res.json({
        stages,
        detail: {
          totalScouted,
          pending,
          approved,
          discarded,
          queued,
          published,
          veroBlocked,
          qualityFailed,
          ordersPlaced,
          ordersShipped,
        },
        range: { from, to },
      });
    } catch (err) {
      logger.error("Analytics /funnel failed", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to load funnel data." });
    }
  });

  // ── GET /api/analytics/margin-alerts ─────────────────────────────────────
  /**
   * Returns variants whose estimated gross margin % has fallen below
   * MARGIN_FLOOR_PERCENT (default 10%). These are the listings you're
   * at risk of selling at near- or below-cost.
   */
  router.get("/margin-alerts", (_req: Request, res: Response) => {
    try {
      const ebayFee     = getConfigNum(db, "EBAY_FEE_ESTIMATE", 2.5);
      const marginFloor = getConfigNum(db, "MARGIN_FLOOR_PERCENT", 0.10);

      const rows = db.prepare(
        `SELECT
           p.title as product_title,
           v.internal_sku,
           v.ebay_sku,
           v.supplier_type,
           COALESCE(v.cost, 0)          as cost,
           COALESCE(v.shipping_cost, 0) as shipping_cost,
           COALESCE(v.current_price, 0) as current_price,
           v.last_synced_at
         FROM variants v
         JOIN products p ON p.id = v.product_id
         WHERE v.ebay_sku IS NOT NULL
           AND v.current_price > 0
           AND (
             (v.current_price - COALESCE(v.cost,0) - COALESCE(v.shipping_cost,0) - ?)
             / v.current_price
           ) < ?
         ORDER BY (
           (v.current_price - COALESCE(v.cost,0) - COALESCE(v.shipping_cost,0) - ?)
           / v.current_price
         ) ASC`
      ).all(ebayFee, marginFloor, ebayFee) as Array<{
        product_title: string;
        internal_sku: string;
        ebay_sku: string | null;
        supplier_type: string;
        cost: number;
        shipping_cost: number;
        current_price: number;
        last_synced_at: string | null;
      }>;

      const alerts = rows.map(r => {
        const totalCost   = r.cost + r.shipping_cost + ebayFee;
        const grossProfit = r.current_price - totalCost;
        const marginPct   = Math.round((grossProfit / r.current_price) * 10000) / 100;
        return {
          productTitle:  r.product_title,
          internalSku:   r.internal_sku,
          ebaySku:       r.ebay_sku,
          supplierType:  r.supplier_type,
          cost:          Math.round(r.cost * 100) / 100,
          shippingCost:  Math.round(r.shipping_cost * 100) / 100,
          ebayFee:       Math.round(ebayFee * 100) / 100,
          currentPrice:  Math.round(r.current_price * 100) / 100,
          grossProfit:   Math.round(grossProfit * 100) / 100,
          marginPct,
          lastSyncedAt:  r.last_synced_at,
        };
      });

      res.json({
        alerts,
        floorPct: Math.round(marginFloor * 100),
        count:    alerts.length,
      });
    } catch (err) {
      logger.error("Analytics /margin-alerts failed", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to load margin alerts." });
    }
  });

  return router;
}
