/**
 * Product Sync Loop (Phase 4) — Reliability Edition.
 *
 * Changes from the original:
 *   Task 1  — Job locking: acquires/releases a DB lock so two runs can never
 *             overlap (handles crashes leaving stale locks via timeout).
 *   Task 3  — Idempotency: eBay bulk updates are idempotent by design (PUT
 *             is safe to re-run); local DB update is in a transaction.
 *   Task 4  — Circuit breaker: if CJ or eBay are repeatedly failing,
 *             the circuit opens and the entire sync skips that service
 *             for OPEN_WINDOW_MS rather than hammering it every cycle.
 *   Task 5  — Quarantine: variants that fail consecutively N times are
 *             flagged quarantined=1 and skipped until manually cleared.
 *   Task 7  — Dry-run: pass dryRun=true to log what would happen without
 *             writing to eBay or updating the DB (safe for staging tests).
 *   Task 8  — Transactions: variant DB updates wrapped in a transaction.
 */
import Database from "better-sqlite3";
import { CoreConfig } from "../config";
import { getSupplierProvider, UnknownSupplierError } from "../suppliers/supplierFactory";
import { calculateEbayPrice, parsePricingTiers, PricingTier } from "../pricing";
import { buildEbayClient, EbayNotConfiguredError } from "../ebay/ebayFactory";
import { EbayPriceQuantityUpdate } from "../ebay/ebayClient";
import { withLiveAutoOrderEnabled } from "../services/runtimeConfigService";
import { getPricingOverridesForSupplier } from "../services/suppliersService";
import { recordJobOutcome } from "../services/alertService";
import { acquireLock, releaseLock } from "../services/jobLock";
import { isOpen as cbIsOpen, recordSuccess as cbSuccess, recordFailure as cbFail } from "../services/circuitBreaker";
import { isQuarantined, recordVariantSuccess, recordVariantFailure } from "../services/quarantine";
import { logger } from "../logger";

interface VariantRow {
  id: number;
  product_id: number;
  supplier_type: string;
  supplier_variant_id: string;
  internal_sku: string;
  ebay_sku: string | null;
  ebay_offer_id: string | null;
  cost: number | null;
  shipping_cost: number | null;
  current_price: number | null;
  current_stock: number | null;
  ebay_push_pending: number; // 1 = local data is ahead of eBay; push needed
}

export interface SyncRunSummary {
  totalVariants:         number;
  changed:               number;
  unchanged:             number;
  failed:                number;
  pushedToEbay:          number;
  skippedPushKillSwitch: number;
  skippedQuarantine:     number;
  skippedCircuitOpen:    number;
  dryRun:                boolean;
  result: "success" | "partial_failure" | "failure";
  errors: Array<{ sku: string; message: string }>;
}

export async function runSyncOnce(
  db: Database.Database,
  staticConfig: CoreConfig,
  opts: { dryRun?: boolean } = {}
): Promise<SyncRunSummary> {
  const dryRun = opts.dryRun ?? false;
  const config = withLiveAutoOrderEnabled(db, staticConfig);

  const summary: SyncRunSummary = {
    totalVariants:         0,
    changed:               0,
    unchanged:             0,
    failed:                0,
    pushedToEbay:          0,
    skippedPushKillSwitch: 0,
    skippedQuarantine:     0,
    skippedCircuitOpen:    0,
    dryRun,
    result:                "success",
    errors:                [],
  };

  // Task 1: acquire DB job lock — skip if another run is in progress
  if (!dryRun) {
    const locked = acquireLock(db, "price_stock");
    if (!locked) {
      logger.warn("Sync run: could not acquire lock — another run is in progress, skipping tick.");
      return { ...summary, result: "success" }; // not a failure — just skip
    }
  }

  try {
    const variants = db.prepare("SELECT * FROM variants").all() as VariantRow[];
    summary.totalVariants = variants.length;

    if (variants.length === 0) {
      logger.info("Sync run: no variants tracked yet, nothing to do.");
      if (!dryRun) {
        recordSyncLog(db, "success", summary);
        await recordJobOutcome(db, config, "price_stock", "success");
      }
      return summary;
    }

    // Load pricing tiers once per run (from config table)
    const tiersRaw = (
      db.prepare("SELECT value FROM config WHERE key = 'PRICING_TIERS'").get() as
        | { value: string } | undefined
    )?.value ?? "[]";
    const pricingTiers: PricingTier[] = parsePricingTiers(tiersRaw);

    const priceQuantityBatch: EbayPriceQuantityUpdate[] = [];
    const batchMeta: Array<{ variantId: number; sku: string }> = [];

    for (const variant of variants) {
      // Task 5: skip quarantined variants
      if (isQuarantined(db, variant.id)) {
        summary.skippedQuarantine += 1;
        logger.info("Sync: skipping quarantined variant", { sku: variant.internal_sku });
        continue;
      }

      // Task 4: check circuit breaker for this supplier
      if (cbIsOpen(db, variant.supplier_type)) {
        summary.skippedCircuitOpen += 1;
        logger.info(`Sync: circuit open for ${variant.supplier_type}, skipping variant`, { sku: variant.internal_sku });
        continue;
      }

      try {
        const plugin = getSupplierProvider(variant.supplier_type);
        const fresh  = await plugin.getStockAndPrice(variant.supplier_variant_id);

        // Task 4: record circuit breaker success for this supplier
        cbSuccess(db, variant.supplier_type);

        const effectiveStock = fresh.stock < config.safetyStockBuffer ? 0 : fresh.stock;

        // Per-supplier pricing overrides (NULL = fall back to global config)
        const overrides = getPricingOverridesForSupplier(db, variant.supplier_type);

        const newPrice = calculateEbayPrice({
          supplierUnitCost:      fresh.cost,
          supplierShippingCost:  fresh.shippingCost,
          profitMarginPercent:   config.profitMarginPercent,
          ebayFeeEstimate:       config.ebayFeeEstimate,
          supplierMarginOverride: overrides.marginOverride,
          supplierFeeOverride:    overrides.feeOverride,
          tiers:                  pricingTiers,
        });

        const priceChanged = variant.current_price === null || Math.abs(variant.current_price - newPrice) > 0.001;
        const stockChanged = variant.current_stock === null || variant.current_stock !== effectiveStock;
        const costChanged  = variant.cost === null || Math.abs((variant.cost ?? 0) - fresh.cost) > 0.001;

        // Task 8: wrap each variant's DB update in a transaction.
        // Task 6: set ebay_push_pending=1 when data changed so a crash
        // between here and the eBay push is recovered on the next run.
        const needsEbayPush = (priceChanged || stockChanged) && Boolean(variant.ebay_sku);
        if (!dryRun) {
          db.transaction(() => {
            db.prepare(
              `UPDATE variants
                 SET cost = ?, shipping_cost = ?, current_stock = ?, current_price = ?,
                     ebay_push_pending = ?,
                     last_synced_at = datetime('now'), updated_at = datetime('now')
               WHERE id = ?`
            ).run(
              fresh.cost, fresh.shippingCost, effectiveStock, newPrice,
              needsEbayPush ? 1 : variant.ebay_push_pending, // preserve flag if already set
              variant.id
            );
          })();
        }

        // Task 5: reset failure counter on success
        if (!dryRun) recordVariantSuccess(db, variant.id);

        if (!priceChanged && !stockChanged && !costChanged) {
          // Task 6: even when nothing changed, if a previous run set
          // ebay_push_pending=1 (crash between DB update and eBay push),
          // we must still add this variant to the batch so the push completes.
          if (!dryRun && variant.ebay_push_pending && variant.ebay_sku && config.autoOrderEnabled) {
            priceQuantityBatch.push({ sku: variant.ebay_sku, price: newPrice, currency: "USD", quantity: effectiveStock });
            batchMeta.push({ variantId: variant.id, sku: variant.internal_sku });
            logger.info("Sync: recovering pending eBay push (no data change, flag set)", {
              sku: variant.internal_sku,
            });
          }
          summary.unchanged += 1;
          continue;
        }

        summary.changed += 1;
        logger.info("Sync: variant changed", {
          sku: variant.internal_sku,
          priceChanged, stockChanged, costChanged,
          oldPrice: variant.current_price, newPrice,
          oldStock: variant.current_stock, newStock: effectiveStock,
          dryRun,
        });

        if (variant.ebay_sku) {
          if (!config.autoOrderEnabled) {
            summary.skippedPushKillSwitch += 1;
            logger.info("Sync: AUTO_ORDER_ENABLED=false, not pushing to eBay", {
              sku: variant.internal_sku, wouldSetPrice: newPrice, wouldSetStock: effectiveStock,
            });
          } else if (dryRun) {
            logger.info("Sync [DRY RUN]: would push to eBay", {
              sku: variant.internal_sku, price: newPrice, stock: effectiveStock,
            });
          } else if (needsEbayPush || variant.ebay_push_pending) {
            // Task 6: include variants that were already pending from a prior
            // crashed run (ebay_push_pending=1) even if nothing changed this
            // cycle — ensures the eBay push is never silently lost.
            if (variant.ebay_push_pending && !needsEbayPush) {
              logger.info("Sync: recovering pending eBay push from previous run", {
                sku: variant.internal_sku, price: newPrice, stock: effectiveStock,
              });
            }
            priceQuantityBatch.push({ sku: variant.ebay_sku, price: newPrice, currency: "USD", quantity: effectiveStock });
            batchMeta.push({ variantId: variant.id, sku: variant.internal_sku });
          }
        }
      } catch (err) {
        summary.failed += 1;
        const message = err instanceof UnknownSupplierError ? err.message : (err as Error).message;
        summary.errors.push({ sku: variant.internal_sku, message });

        // Task 4: record circuit breaker failure
        cbFail(db, variant.supplier_type, message);

        // Task 5: record variant-level failure (may quarantine)
        if (!dryRun) recordVariantFailure(db, variant.id, message);

        logger.error("Sync: variant failed, continuing with rest of run", {
          sku: variant.internal_sku, supplierType: variant.supplier_type, error: message,
        });
      }
    }

    // Push batched eBay updates (Task 4: circuit breaker on eBay)
    if (priceQuantityBatch.length > 0 && !dryRun) {
      if (cbIsOpen(db, "EBAY")) {
        logger.warn("Sync: eBay circuit open — skipping bulk price/quantity push this cycle");
        summary.skippedCircuitOpen += priceQuantityBatch.length;
      } else {
        try {
          const ebayClient = buildEbayClient(config);
          for (let i = 0; i < priceQuantityBatch.length; i += 25) {
            const chunk = priceQuantityBatch.slice(i, i + 25);
            const chunkMeta = batchMeta.slice(i, i + 25);
            await ebayClient.bulkUpdatePriceQuantity(chunk);

            // Task 6: clear ebay_push_pending on each successfully pushed chunk
            // immediately, so a crash mid-batch only re-pushes the remaining
            // chunks rather than the whole batch.
            db.transaction(() => {
              for (const m of chunkMeta) {
                db.prepare(
                  "UPDATE variants SET ebay_push_pending = 0 WHERE id = ?"
                ).run(m.variantId);
              }
            })();

            summary.pushedToEbay += chunk.length;
          }
          cbSuccess(db, "EBAY");
          logger.info("Sync: pushed price/quantity updates to eBay", { count: summary.pushedToEbay });
        } catch (err) {
          const message = err instanceof EbayNotConfiguredError ? err.message : (err as Error).message;
          cbFail(db, "EBAY", message);
          // Task 6: ebay_push_pending stays 1 on affected variants — next run
          // will recover them automatically even if prices haven't changed.
          logger.error("Sync: failed to push batched updates to eBay — local DB still updated, will retry next cycle", {
            error: message, affectedSkus: batchMeta.map((m) => m.sku),
          });
          summary.failed   += batchMeta.length;
          summary.errors.push({ sku: `batch(${batchMeta.length} items)`, message });
        }
      }
    }

    summary.result =
      summary.failed === 0             ? "success"
      : summary.failed < summary.totalVariants ? "partial_failure"
      : "failure";

    if (!dryRun) {
      recordSyncLog(db, summary.result, summary);
      await recordJobOutcome(db, config, "price_stock", summary.result);
    }

    return summary;
  } finally {
    // Task 1: always release the lock, even if the job throws
    if (!dryRun) releaseLock(db, "price_stock");
  }
}

function recordSyncLog(db: Database.Database, result: SyncRunSummary["result"], summary: SyncRunSummary) {
  db.prepare(
    `INSERT INTO sync_logs (type, result, error_message, details_json) VALUES ('price_stock', ?, ?, ?)`
  ).run(
    result,
    summary.errors.length > 0 ? summary.errors.map((e) => `${e.sku}: ${e.message}`).join("; ") : null,
    JSON.stringify(summary)
  );
}
