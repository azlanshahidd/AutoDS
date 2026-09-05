/**
 * Order quarantine / dead-letter mechanism (Reliability Phase, Task 5).
 *
 * Mirrors quarantine.ts (variant dead-letter) but applies to the fulfillment
 * loop: after ORDER_QUARANTINE_THRESHOLD consecutive failures on the same
 * order, that order is flagged quarantined=1 and skipped by the fulfillment
 * loop until a human reviews it from the dashboard.
 *
 * "Permanently broken" examples this catches:
 *   - Supplier order was cancelled/deleted on their side (getOrderStatus → 404)
 *   - eBay order ID no longer exists (getOrderById → 404)
 *   - createShippingFulfillment rejected by eBay (order already cancelled)
 *
 * Without quarantine, these orders stay at status='submitted' and generate
 * identical error log lines on every fulfillment cycle indefinitely.
 *
 * State is stored directly on the `orders` table (two new columns added by
 * migration) so no extra join is needed in the fulfillment loop query.
 */
import Database from "better-sqlite3";
import { logger } from "../logger";

/** Consecutive failures before an order is quarantined. */
export const ORDER_QUARANTINE_THRESHOLD = 5;

/**
 * Returns true if this order is currently quarantined (fulfillment loop
 * should skip it).
 */
export function isOrderQuarantined(db: Database.Database, orderId: number): boolean {
  const row = db
    .prepare("SELECT quarantined FROM orders WHERE id = ?")
    .get(orderId) as { quarantined: number } | undefined;
  return row?.quarantined === 1;
}

/**
 * Call this when a fulfillment step SUCCEEDS for an order.
 * Resets the consecutive failure counter (does not un-quarantine — once
 * quarantined, a human must clear it via the dashboard).
 */
export function recordOrderSuccess(db: Database.Database, orderId: number): void {
  db.prepare(
    `UPDATE orders
     SET fulfillment_failure_count = 0,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(orderId);
}

/**
 * Call this when a fulfillment step FAILS for an order.
 * Returns true if the order just crossed the quarantine threshold.
 */
export function recordOrderFailure(
  db: Database.Database,
  orderId: number,
  ebayOrderId: string,
  error: string
): boolean {
  const row = db
    .prepare("SELECT fulfillment_failure_count, quarantined FROM orders WHERE id = ?")
    .get(orderId) as { fulfillment_failure_count: number; quarantined: number } | undefined;

  const prevFails   = row?.fulfillment_failure_count ?? 0;
  const newFails    = prevFails + 1;
  const nowQuarantine = newFails >= ORDER_QUARANTINE_THRESHOLD && !row?.quarantined;

  db.prepare(
    `UPDATE orders
     SET fulfillment_failure_count = ?,
         quarantined               = CASE WHEN ? THEN 1 ELSE quarantined END,
         quarantined_at            = CASE WHEN ? THEN datetime('now') ELSE quarantined_at END,
         last_fulfillment_error    = ?,
         updated_at                = datetime('now')
     WHERE id = ?`
  ).run(newFails, nowQuarantine ? 1 : 0, nowQuarantine ? 1 : 0, error.slice(0, 500), orderId);

  if (nowQuarantine) {
    logger.warn(
      `Order ${ebayOrderId} quarantined after ${newFails} consecutive fulfillment failures — ` +
        `skipping in future runs until manually cleared. Last error: ${error.slice(0, 200)}`
    );
  }

  return nowQuarantine;
}

/**
 * Manually clears an order from quarantine (called from dashboard).
 * Also resets the failure counter so it gets a fresh start.
 */
export function clearOrderQuarantine(db: Database.Database, orderId: number): void {
  db.prepare(
    `UPDATE orders
     SET quarantined               = 0,
         quarantined_at            = NULL,
         fulfillment_failure_count = 0,
         last_fulfillment_error    = NULL,
         updated_at                = datetime('now')
     WHERE id = ?`
  ).run(orderId);
  logger.info(`Order ${orderId} cleared from fulfillment quarantine.`);
}

/**
 * Returns all currently quarantined orders for the dashboard / health overview.
 */
export function getQuarantinedOrders(db: Database.Database): Array<{
  orderId:               number;
  ebayOrderId:           string;
  supplierType:          string;
  supplierOrderId:       string | null;
  fulfillmentFailures:   number;
  lastFulfillmentError:  string | null;
  quarantinedAt:         string | null;
}> {
  return (
    db
      .prepare(
        `SELECT id, ebay_order_id, supplier_type, supplier_order_id,
                fulfillment_failure_count, last_fulfillment_error, quarantined_at
         FROM orders
         WHERE quarantined = 1
         ORDER BY quarantined_at DESC`
      )
      .all() as Array<{
        id:                       number;
        ebay_order_id:            string;
        supplier_type:            string;
        supplier_order_id:        string | null;
        fulfillment_failure_count: number;
        last_fulfillment_error:   string | null;
        quarantined_at:           string | null;
      }>
  ).map((r) => ({
    orderId:              r.id,
    ebayOrderId:          r.ebay_order_id,
    supplierType:         r.supplier_type,
    supplierOrderId:      r.supplier_order_id,
    fulfillmentFailures:  r.fulfillment_failure_count,
    lastFulfillmentError: r.last_fulfillment_error,
    quarantinedAt:        r.quarantined_at,
  }));
}
