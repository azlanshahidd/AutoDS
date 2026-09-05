/**
 * publishListing.ts — Phase 3 end-to-end test harness.
 *
 * Takes a variant already fetched into the local DB (via
 * suppliers/fetchVariant.ts) and publishes it to eBay:
 *   1. Look up the variant's cost/shipping from SQLite.
 *   2. Compute the eBay price via the Section 4 pricing formula.
 *   3. Run the VeRO keyword filter — abort and flag for review on a match.
 *   4. createOrReplaceInventoryItem, createOffer, publishOffer.
 *   5. Store the resulting ebay_sku / ebay_offer_id back onto the variant.
 *
 * Usage:
 *   npm run publish-listing -- --sku=<internal_sku> --category=<ebayCategoryId> --location=<merchantLocationKey> [--title="..."]
 *
 * Prerequisites:
 *   - The variant must already exist in `variants` (run fetchVariant.ts first).
 *   - An eBay merchant location must already exist (run createEbayLocation.ts first).
 *   - EBAY_CLIENT_ID / EBAY_CLIENT_SECRET / EBAY_REFRESH_TOKEN must be set.
 */
import "dotenv/config";
import { loadConfig, ConfigError } from "../config";
import { getDb } from "../db/connection";
import { buildEbayClient, EbayNotConfiguredError } from "./ebayFactory";
import { calculateEbayPrice } from "../pricing";
import { checkVero } from "./veroFilter";
import { logger } from "../logger";

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [key, value] = a.slice(2).split("=");
      flags[key] = value ?? "true";
    }
  }
  return flags;
}

async function run() {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.sku || !flags.category || !flags.location) {
    console.error(
      "Usage: npm run publish-listing -- --sku=<internal_sku> --category=<ebayCategoryId> --location=<merchantLocationKey> [--title=\"...\"]"
    );
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n✗ ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const db = getDb(config.databaseFile);
  const variant = db
    .prepare(
      `SELECT variants.*, products.title as product_title, products.description as product_description
       FROM variants JOIN products ON products.id = variants.product_id
       WHERE internal_sku = ?`
    )
    .get(flags.sku) as any;

  if (!variant) {
    console.error(`\n✗ No variant found with internal_sku "${flags.sku}". Run fetch-variant first.\n`);
    process.exit(1);
  }

  const title = flags.title || variant.product_title;

  // --- VeRO check (Section 5) — runs BEFORE anything is published. ---
  let veroResult;
  try {
    veroResult = checkVero(title, variant.product_description, config.veroBlocklistPath);
  } catch (err) {
    console.error(`\n✗ ${(err as Error).message}\n`);
    process.exit(1);
  }

  if (veroResult.isBlocked) {
    db.prepare(
      `INSERT INTO sync_logs (type, result, error_message, details_json) VALUES ('order_routing', 'failure', ?, ?)`
    ).run(
      `Publish blocked by VeRO filter: matched keyword(s) ${veroResult.matchedKeywords.join(", ")}`,
      JSON.stringify({ sku: flags.sku, title, matchedKeywords: veroResult.matchedKeywords })
    );
    console.error(
      `\n✗ Publish BLOCKED — title/description matched restricted keyword(s): ${veroResult.matchedKeywords.join(", ")}\n` +
        `  Flagged for manual review. Nothing was sent to eBay.\n`
    );
    process.exit(1);
  }

  // --- Pricing formula (Section 4) ---
  const price = calculateEbayPrice({
    supplierUnitCost: variant.cost,
    supplierShippingCost: variant.shipping_cost,
    profitMarginPercent: config.profitMarginPercent,
    ebayFeeEstimate: config.ebayFeeEstimate,
  });
  console.log(
    `Computed eBay price: $${price} (cost=$${variant.cost} + shipping=$${variant.shipping_cost}, margin=${config.profitMarginPercent * 100}%, fee est=$${config.ebayFeeEstimate})`
  );

  // --- Safety stock buffer (Section 5) ---
  const effectiveQuantity = variant.current_stock < config.safetyStockBuffer ? 0 : variant.current_stock;
  if (effectiveQuantity === 0 && variant.current_stock > 0) {
    console.log(
      `Stock (${variant.current_stock}) is below the safety buffer (${config.safetyStockBuffer}) — listing quantity 0 to prevent overselling.`
    );
  }

  let ebayClient;
  try {
    ebayClient = buildEbayClient(config);
  } catch (err) {
    if (err instanceof EbayNotConfiguredError) {
      console.error(`\n✗ ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const ebaySku = `core-${variant.supplier_type.toLowerCase()}-${variant.supplier_variant_id}`;

  try {
    console.log(`\nCreating inventory item ${ebaySku}...`);
    await ebayClient.createOrReplaceInventoryItem({
      sku: ebaySku,
      title,
      description: variant.product_description || title,
      quantity: effectiveQuantity,
    });

    console.log("Creating offer...");
    const { offerId } = await ebayClient.createOffer({
      sku: ebaySku,
      marketplaceId: "EBAY_US",
      price,
      currency: "USD",
      categoryId: flags.category,
      quantity: effectiveQuantity,
      merchantLocationKey: flags.location,
      listingDescription: variant.product_description || title,
    });

    console.log(`Publishing offer ${offerId}...`);
    const { listingId } = await ebayClient.publishOffer(offerId);

    db.prepare(
      `UPDATE variants SET ebay_sku = ?, ebay_offer_id = ?, current_price = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(ebaySku, offerId, price, variant.id);

    db.prepare(`INSERT INTO sync_logs (type, result, details_json) VALUES ('order_routing', 'success', ?)`).run(
      JSON.stringify({ sku: flags.sku, ebaySku, offerId, listingId, price })
    );

    console.log(`\n✓ Published! eBay listing ID: ${listingId}\n  Offer ID: ${offerId}\n  SKU: ${ebaySku}\n  Price: $${price}\n`);
  } catch (err) {
    logger.error("publishListing failed", { error: (err as Error).message, sku: flags.sku });
    db.prepare(`INSERT INTO sync_logs (type, result, error_message) VALUES ('order_routing', 'failure', ?)`).run(
      (err as Error).message
    );
    console.error(`\n✗ Publish failed: ${(err as Error).message}\n`);
    process.exit(1);
  } finally {
    db.close();
  }
}

run();
