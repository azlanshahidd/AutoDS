/**
 * Order Routing Loop (Phase 5) — Reliability Edition.
 *
 * Reliability additions:
 *   Task 1  — DB job lock (acquires before run, releases in finally).
 *   Task 3  — Idempotency already solid (ebay_order_id UNIQUE key + UPSERT).
 *             Extended: upsert is now wrapped in a transaction (Task 8).
 *   Task 4  — Circuit breaker on eBay (fetch) and per-supplier (createOrder).
 *   Task 7  — dryRun mode: logs what would be ordered without calling suppliers.
 *   Task 8  — DB writes (upsertOrderRow) wrapped in transactions.
 */
import Database from "better-sqlite3";
import { CoreConfig } from "../config";
import { getSupplierProvider, UnknownSupplierError } from "../suppliers/supplierFactory";
import { SupplierOrderPayload } from "../suppliers/SupplierProvider";
import { buildEbayClient, EbayNotConfiguredError } from "../ebay/ebayFactory";
import { EbayClient, EbayOrder } from "../ebay/ebayClient";
import { withLiveAutoOrderEnabled } from "../services/runtimeConfigService";
import { recordJobOutcome } from "../services/alertService";
import { acquireLock, releaseLock } from "../services/jobLock";
import { isOpen as cbIsOpen, recordSuccess as cbSuccess, recordFailure as cbFail } from "../services/circuitBreaker";
import { logger } from "../logger";

interface VariantRow {
  id: number;
  supplier_type: string;
  supplier_variant_id: string;
  internal_sku: string;
  ebay_sku: string | null;
}

interface OrderRow {
  id: number;
  ebay_order_id: string;
  supplier_type: string;
  supplier_order_id: string | null;
  status: string;
}

export class MultiSupplierOrderError extends Error {
  constructor(ebayOrderId: string, supplierTypes: string[]) {
    super(
      `eBay order ${ebayOrderId} has line items from multiple suppliers ` +
        `(${supplierTypes.join(", ")}) — v1 only supports one supplier per order. ` +
        `Flagged for manual review.`
    );
    this.name = "MultiSupplierOrderError";
  }
}

export interface OrderRoutingSummary {
  ordersFetched:        number;
  alreadyProcessed:     number;
  submitted:            number;
  loggedNotSubmitted:   number;
  failed:               number;
  skippedCircuitOpen:   number;
  dryRun:               boolean;
  result: "success" | "partial_failure" | "failure";
  errors: Array<{ ebayOrderId: string; message: string }>;
}

function buildSupplierPayload(order: EbayOrder, variants: VariantRow[]): SupplierOrderPayload {
  return {
    referenceId: order.orderId,
    shippingAddress: {
      name:        order.shippingAddress.fullName || "Unknown",
      line1:       order.shippingAddress.addressLine1 || "",
      line2:       order.shippingAddress.addressLine2,
      city:        order.shippingAddress.city || "",
      state:       order.shippingAddress.stateOrProvince,
      postalCode:  order.shippingAddress.postalCode || "",
      countryCode: order.shippingAddress.countryCode || "US",
      phone:       order.shippingAddress.phoneNumber,
    },
    lineItems: order.lineItems.map((li) => {
      const variant = variants.find((v) => v.ebay_sku === li.sku);
      if (!variant) {
        throw new Error(`No local variant found for eBay SKU "${li.sku}" (order ${order.orderId}).`);
      }
      return { supplierVariantId: variant.supplier_variant_id, quantity: li.quantity };
    }),
  };
}

function resolveOrderSupplierType(order: EbayOrder, variants: VariantRow[]): string {
  const supplierTypes = new Set<string>();
  for (const li of order.lineItems) {
    const variant = variants.find((v) => v.ebay_sku === li.sku);
    if (variant) supplierTypes.add(variant.supplier_type);
  }
  if (supplierTypes.size === 0) {
    throw new Error(`No known variants matched any line item SKU for order ${order.orderId}.`);
  }
  if (supplierTypes.size > 1) {
    throw new MultiSupplierOrderError(order.orderId, Array.from(supplierTypes));
  }
  return Array.from(supplierTypes)[0];
}

export async function runOrderRoutingOnce(
  db: Database.Database,
  staticConfig: CoreConfig,
  ordersOverride?: EbayOrder[],
  opts: { dryRun?: boolean } = {}
): Promise<OrderRoutingSummary> {
  const dryRun = opts.dryRun ?? false;
  const config = withLiveAutoOrderEnabled(db, staticConfig);

  const summary: OrderRoutingSummary = {
    ordersFetched:        0,
    alreadyProcessed:     0,
    submitted:            0,
    loggedNotSubmitted:   0,
    failed:               0,
    skippedCircuitOpen:   0,
    dryRun,
    result:               "success",
    errors:               [],
  };

  // Task 1: acquire job lock
  if (!dryRun) {
    if (!acquireLock(db, "order_routing")) {
      logger.warn("Order routing: could not acquire lock — skipping tick.");
      return summary;
    }
  }

  try {
    // Task 4: check eBay circuit before fetching orders
    if (cbIsOpen(db, "EBAY") && !ordersOverride) {
      logger.warn("Order routing: eBay circuit open — skipping this cycle");
      summary.skippedCircuitOpen += 1;
      if (!dryRun) {
        recordLog(db, "success", null, summary); // not a failure — deliberate skip
        await recordJobOutcome(db, config, "order_routing", "success");
      }
      return summary;
    }

    let orders: EbayOrder[];
    let ebayClient: EbayClient | null = null;

    if (ordersOverride) {
      orders = ordersOverride;
    } else {
      try {
        ebayClient = buildEbayClient(config);
        orders     = await ebayClient.getNewPaidOrders();
        cbSuccess(db, "EBAY");
      } catch (err) {
        const message = err instanceof EbayNotConfiguredError ? err.message : (err as Error).message;
        cbFail(db, "EBAY", message);
        logger.error("Order routing: could not fetch orders from eBay", { error: message });
        if (!dryRun) {
          recordLog(db, "failure", message, summary);
          await recordJobOutcome(db, config, "order_routing", "failure");
        }
        summary.result = "failure";
        summary.errors.push({ ebayOrderId: "(fetch)", message });
        return summary;
      }
    }

    summary.ordersFetched = orders.length;

    if (orders.length === 0) {
      if (!dryRun) {
        recordLog(db, "success", null, summary);
        await recordJobOutcome(db, config, "order_routing", "success");
      }
      return summary;
    }

    const allVariants = db
      .prepare("SELECT id, supplier_type, supplier_variant_id, internal_sku, ebay_sku FROM variants WHERE ebay_sku IS NOT NULL")
      .all() as VariantRow[];

    for (const order of orders) {
      try {
        const existing = db
          .prepare("SELECT * FROM orders WHERE ebay_order_id = ?")
          .get(order.orderId) as OrderRow | undefined;

        // Task 3: idempotency — already submitted orders are skipped
        if (existing?.supplier_order_id) {
          summary.alreadyProcessed += 1;
          logger.info("Order routing: already submitted, skipping", {
            ebayOrderId: order.orderId, supplierOrderId: existing.supplier_order_id,
          });
          continue;
        }

        const supplierType = resolveOrderSupplierType(order, allVariants);
        const payload      = buildSupplierPayload(order, allVariants);

        if (!config.autoOrderEnabled) {
          if (!dryRun) upsertOrderRow(db, order.orderId, supplierType, null, "skipped_auto_order_disabled");
          summary.loggedNotSubmitted += 1;
          logger.info("Order routing: AUTO_ORDER_ENABLED=false, logging intent only", {
            ebayOrderId: order.orderId, supplierType, lineItems: payload.lineItems,
          });
          continue;
        }

        if (dryRun) {
          summary.loggedNotSubmitted += 1;
          logger.info("Order routing [DRY RUN]: would submit order", {
            ebayOrderId: order.orderId, supplierType, lineItems: payload.lineItems,
          });
          continue;
        }

        // Task 4: check circuit breaker for this supplier before calling
        if (cbIsOpen(db, supplierType)) {
          summary.skippedCircuitOpen += 1;
          logger.warn(`Order routing: circuit open for ${supplierType}, skipping order`, { ebayOrderId: order.orderId });
          continue;
        }

        const plugin = getSupplierProvider(supplierType);
        const result = await plugin.createOrder(payload);
        cbSuccess(db, supplierType);

        // Task 8: wrap DB write in transaction
        db.transaction(() => {
          upsertOrderRow(db, order.orderId, supplierType, result.supplierOrderId, "submitted");
        })();

        summary.submitted += 1;
        logger.info("Order routing: submitted supplier order", {
          ebayOrderId: order.orderId, supplierType, supplierOrderId: result.supplierOrderId,
        });
      } catch (err) {
        summary.failed += 1;
        const message =
          err instanceof MultiSupplierOrderError || err instanceof UnknownSupplierError
            ? err.message
            : (err as Error).message;

        // Task 4: record circuit failure for the supplier if applicable
        try {
          const supplierType = resolveOrderSupplierType(order, allVariants);
          cbFail(db, supplierType, message);
        } catch { /* resolveOrderSupplierType can itself throw — ignore here */ }

        summary.errors.push({ ebayOrderId: order.orderId, message });
        logger.error("Order routing: order failed, continuing with rest of batch", {
          ebayOrderId: order.orderId, error: message,
        });
        // No rethrow — supplier_order_id stays null so it's retried next cycle
      }
    }

    summary.result =
      summary.failed === 0 ? "success"
      : summary.failed < orders.length ? "partial_failure"
      : "failure";

    if (!dryRun) {
      recordLog(db, summary.result, summary.errors.length > 0
        ? summary.errors.map((e) => `${e.ebayOrderId}: ${e.message}`).join("; ")
        : null, summary);
      await recordJobOutcome(db, config, "order_routing", summary.result);
    }

    return summary;
  } finally {
    if (!dryRun) releaseLock(db, "order_routing");
  }
}

function upsertOrderRow(
  db: Database.Database,
  ebayOrderId: string,
  supplierType: string,
  supplierOrderId: string | null,
  status: string
) {
  db.prepare(
    `INSERT INTO orders (ebay_order_id, supplier_type, supplier_order_id, status)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ebay_order_id) DO UPDATE SET
       supplier_type    = excluded.supplier_type,
       supplier_order_id = COALESCE(excluded.supplier_order_id, orders.supplier_order_id),
       status           = excluded.status,
       updated_at       = datetime('now')`
  ).run(ebayOrderId, supplierType, supplierOrderId, status);
}

function recordLog(
  db: Database.Database,
  result: string,
  errorMessage: string | null,
  summary: OrderRoutingSummary
) {
  db.prepare(
    `INSERT INTO sync_logs (type, result, error_message, details_json) VALUES ('order_routing', ?, ?, ?)`
  ).run(result, errorMessage, JSON.stringify(summary));
}
