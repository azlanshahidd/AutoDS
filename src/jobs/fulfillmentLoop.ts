/**
 * Fulfillment & Tracking Loop (Phase 6) — Reliability Edition.
 *
 * Reliability additions:
 *   Task 1  — DB job lock.
 *   Task 4  — Circuit breaker on eBay and per-supplier.
 *   Task 7  — dryRun mode.
 *   Task 8  — Order status update wrapped in a transaction.
 */
import Database from "better-sqlite3";
import { CoreConfig } from "../config";
import { getSupplierProvider, UnknownSupplierError } from "../suppliers/supplierFactory";
import { buildEbayClient, EbayNotConfiguredError } from "../ebay/ebayFactory";
import { EbayClient } from "../ebay/ebayClient";
import { recordJobOutcome } from "../services/alertService";
import { acquireLock, releaseLock } from "../services/jobLock";
import { isOpen as cbIsOpen, recordSuccess as cbSuccess, recordFailure as cbFail } from "../services/circuitBreaker";
import { logger } from "../logger";

interface OrderRow {
  id: number;
  ebay_order_id: string;
  supplier_type: string;
  supplier_order_id: string;
  status: string;
}

export interface FulfillmentSummary {
  candidatesChecked:  number;
  notYetShipped:      number;
  fulfilled:          number;
  failed:             number;
  skippedCircuitOpen: number;
  dryRun:             boolean;
  result: "success" | "partial_failure" | "failure";
  errors: Array<{ ebayOrderId: string; message: string }>;
}

export async function runFulfillmentOnce(
  db: Database.Database,
  config: CoreConfig,
  ebayClientOverride?: Pick<EbayClient, "getOrderById" | "createShippingFulfillment">,
  opts: { dryRun?: boolean } = {}
): Promise<FulfillmentSummary> {
  const dryRun = opts.dryRun ?? false;

  const summary: FulfillmentSummary = {
    candidatesChecked:  0,
    notYetShipped:      0,
    fulfilled:          0,
    failed:             0,
    skippedCircuitOpen: 0,
    dryRun,
    result:             "success",
    errors:             [],
  };

  // Task 1: acquire job lock
  if (!dryRun) {
    if (!acquireLock(db, "fulfillment_tracking")) {
      logger.warn("Fulfillment: could not acquire lock — skipping tick.");
      return summary;
    }
  }

  try {
    const candidates = db
      .prepare("SELECT * FROM orders WHERE status = 'submitted' AND supplier_order_id IS NOT NULL")
      .all() as OrderRow[];

    summary.candidatesChecked = candidates.length;

    if (candidates.length === 0) {
      if (!dryRun) {
        recordLog(db, "success", null, summary);
        await recordJobOutcome(db, config, "fulfillment_tracking", "success");
      }
      return summary;
    }

    let ebayClient: Pick<EbayClient, "getOrderById" | "createShippingFulfillment">;
    if (ebayClientOverride) {
      ebayClient = ebayClientOverride;
    } else if (cbIsOpen(db, "EBAY")) {
      logger.warn("Fulfillment: eBay circuit open — skipping this cycle");
      summary.skippedCircuitOpen = candidates.length;
      if (!dryRun) {
        recordLog(db, "success", null, summary);
        await recordJobOutcome(db, config, "fulfillment_tracking", "success");
      }
      return summary;
    } else {
      try {
        ebayClient = buildEbayClient(config);
      } catch (err) {
        const message = err instanceof EbayNotConfiguredError ? err.message : (err as Error).message;
        cbFail(db, "EBAY", message);
        logger.error("Fulfillment: eBay not available, skipping this run", { error: message });
        if (!dryRun) {
          recordLog(db, "failure", message, summary);
          await recordJobOutcome(db, config, "fulfillment_tracking", "failure");
        }
        summary.result = "failure";
        summary.errors.push({ ebayOrderId: "(all)", message });
        return summary;
      }
    }

    for (const order of candidates) {
      // Task 4: check circuit breaker for this supplier
      if (cbIsOpen(db, order.supplier_type)) {
        summary.skippedCircuitOpen += 1;
        logger.info(`Fulfillment: circuit open for ${order.supplier_type}, skipping order`, {
          ebayOrderId: order.ebay_order_id,
        });
        continue;
      }

      try {
        const plugin = getSupplierProvider(order.supplier_type);
        const status = await plugin.getOrderStatus(order.supplier_order_id);
        cbSuccess(db, order.supplier_type);

        if (!status.isShipped) {
          summary.notYetShipped += 1;
          continue;
        }

        const tracking = await plugin.getTrackingInfo(order.supplier_order_id);
        if (!tracking.hasTracking || !tracking.trackingNumber) {
          summary.notYetShipped += 1;
          logger.info("Fulfillment: order shipped but no tracking number yet, will retry", {
            ebayOrderId: order.ebay_order_id, supplierOrderId: order.supplier_order_id,
          });
          continue;
        }

        if (dryRun) {
          summary.fulfilled += 1;
          logger.info("Fulfillment [DRY RUN]: would push tracking to eBay", {
            ebayOrderId: order.ebay_order_id,
            trackingNumber: tracking.trackingNumber,
            carrier: tracking.carrier,
          });
          continue;
        }

        const ebayOrder = await ebayClient.getOrderById(order.ebay_order_id);
        if (ebayOrder.lineItems.length === 0) {
          throw new Error(`eBay order ${order.ebay_order_id} has no line items to fulfill.`);
        }

        for (const li of ebayOrder.lineItems) {
          await ebayClient.createShippingFulfillment({
            orderId:             order.ebay_order_id,
            lineItemId:          li.lineItemId,
            quantity:            li.quantity,
            trackingNumber:      tracking.trackingNumber,
            shippingCarrierCode: normalizeCarrierCode(tracking.carrier),
          });
        }
        cbSuccess(db, "EBAY");

        // Task 8: wrap order status update in a transaction
        db.transaction(() => {
          db.prepare(
            `UPDATE orders
               SET status = 'shipped', tracking_number = ?, carrier = ?,
                   updated_at = datetime('now')
             WHERE id = ?`
          ).run(tracking.trackingNumber, tracking.carrier, order.id);
        })();

        summary.fulfilled += 1;
        logger.info("Fulfillment: pushed tracking to eBay", {
          ebayOrderId: order.ebay_order_id,
          trackingNumber: tracking.trackingNumber,
          carrier: tracking.carrier,
        });
      } catch (err) {
        summary.failed += 1;
        const message = err instanceof UnknownSupplierError ? err.message : (err as Error).message;
        cbFail(db, order.supplier_type, message);
        summary.errors.push({ ebayOrderId: order.ebay_order_id, message });
        logger.error("Fulfillment: order failed, continuing with rest of batch", {
          ebayOrderId: order.ebay_order_id, error: message,
        });
        // No status change — order stays 'submitted' and retries next cycle
      }
    }

    summary.result =
      summary.failed === 0 ? "success"
      : summary.failed < candidates.length ? "partial_failure"
      : "failure";

    if (!dryRun) {
      recordLog(db, summary.result,
        summary.errors.length > 0
          ? summary.errors.map((e) => `${e.ebayOrderId}: ${e.message}`).join("; ")
          : null,
        summary);
      await recordJobOutcome(db, config, "fulfillment_tracking", summary.result);
    }

    return summary;
  } finally {
    if (!dryRun) releaseLock(db, "fulfillment_tracking");
  }
}

function normalizeCarrierCode(carrier: string | null): string {
  if (!carrier) return "OTHER";
  const n = carrier.toUpperCase();
  if (n.includes("USPS"))  return "USPS";
  if (n.includes("FEDEX")) return "FEDEX";
  if (n.includes("UPS"))   return "UPS";
  if (n.includes("DHL"))   return "DHL";
  return "OTHER";
}

function recordLog(db: Database.Database, result: string, errorMessage: string | null, summary: FulfillmentSummary) {
  db.prepare(
    `INSERT INTO sync_logs (type, result, error_message, details_json) VALUES ('fulfillment_tracking', ?, ?, ?)`
  ).run(result, errorMessage, JSON.stringify(summary));
}
