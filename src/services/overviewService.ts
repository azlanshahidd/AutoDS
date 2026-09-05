/**
 * Overview service. Powers the dashboard overview page.
 *
 * Fixes applied:
 *  P2-012 — ordersProcessedToday now counts ALL orders received today
 *            (not just submitted/shipped/fulfilled), renamed to ordersReceivedToday
 *            and a separate ordersPlacedToday count added for actually-placed orders.
 *  P2-022 — failedJobsLast24h now excludes scout_pull failures (external
 *            dependency) and reports them separately as scoutPullFailuresLast24h.
 */
import Database from "better-sqlite3";
import { getAutoOrderEnabled } from "./runtimeConfigService";
import { getActiveAlerts } from "./alertService";

export interface OverviewStats {
  lastSyncRun:          { runAt: string; result: string } | null;
  lastOrderRoutingRun:  { runAt: string; result: string } | null;
  lastFulfillmentRun:   { runAt: string; result: string } | null;
  productsTracked:      number;
  /** All orders whose created_at date is today (regardless of status). */
  ordersReceivedToday:  number;
  /** Orders today with status submitted/shipped/fulfilled (actually placed). */
  ordersPlacedToday:    number;
  /** Failed/partial_failure runs today for price_stock, order_routing, fulfillment_tracking only. */
  failedJobsLast24h:    number;
  /** Failed/partial_failure scout_pull runs in the last 24 h (separate — external dependency). */
  scoutPullFailuresLast24h: number;
  autoOrderEnabled:     boolean;
  activeAlerts:         string[];
}

function lastRunOfType(
  db: Database.Database,
  type: string
): { runAt: string; result: string } | null {
  const row = db
    .prepare("SELECT run_at, result FROM sync_logs WHERE type = ? ORDER BY id DESC LIMIT 1")
    .get(type) as { run_at: string; result: string } | undefined;
  return row ? { runAt: row.run_at, result: row.result } : null;
}

export function getOverviewStats(db: Database.Database): OverviewStats {
  const productsTracked = (
    db.prepare("SELECT COUNT(*) as c FROM variants").get() as { c: number }
  ).c;

  // P2-012: count all orders received today regardless of status
  const ordersReceivedToday = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM orders WHERE date(created_at) = date('now')`
      )
      .get() as { c: number }
  ).c;

  // P2-012: also provide the count of actually-placed orders (not skipped)
  const ordersPlacedToday = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM orders
         WHERE date(created_at) = date('now')
           AND status IN ('submitted','shipped','fulfilled')`
      )
      .get() as { c: number }
  ).c;

  // P2-022: exclude scout_pull from "core jobs failed" metric
  const failedJobsLast24h = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM sync_logs
         WHERE result IN ('failure','partial_failure')
           AND type != 'scout_pull'
           AND run_at >= datetime('now', '-24 hours')`
      )
      .get() as { c: number }
  ).c;

  // P2-022: report scout failures separately
  const scoutPullFailuresLast24h = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM sync_logs
         WHERE result IN ('failure','partial_failure')
           AND type = 'scout_pull'
           AND run_at >= datetime('now', '-24 hours')`
      )
      .get() as { c: number }
  ).c;

  return {
    lastSyncRun:              lastRunOfType(db, "price_stock"),
    lastOrderRoutingRun:      lastRunOfType(db, "order_routing"),
    lastFulfillmentRun:       lastRunOfType(db, "fulfillment_tracking"),
    productsTracked,
    ordersReceivedToday,
    ordersPlacedToday,
    failedJobsLast24h,
    scoutPullFailuresLast24h,
    autoOrderEnabled:         getAutoOrderEnabled(db),
    activeAlerts:             getActiveAlerts(db),
  };
}
