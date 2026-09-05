/**
 * fetchVariant.ts — manual test harness for Phase 2.
 *
 * Fetches stock/price for a given supplier variant id through whichever
 * plugin is registered for ACTIVE_SUPPLIER (or a --supplier override), and
 * upserts the result into the `variants` table. This is deliberately a
 * thin script, not part of the sync loop (Phase 4) — it exists so the
 * abstraction layer can be exercised and inspected end-to-end before the
 * scheduled sync loop is built.
 *
 * Usage:
 *   npm run fetch-variant -- <supplierVariantId> [--supplier=CJ|TEST] [--sku=internal-sku] [--product-title="..."]
 *
 * Examples:
 *   npm run fetch-variant -- TEST-VARIANT-1 --supplier=TEST --sku=sku-1
 *   npm run fetch-variant -- 92511400-C758-4474-93CA-66D442F5F787 --supplier=CJ --sku=my-real-sku
 */
import "dotenv/config";
import { loadConfig, ConfigError } from "../config";
import { getDb } from "../db/connection";
import { getSupplierProvider } from "./supplierFactory";
import { logger } from "../logger";

function parseArgs(argv: string[]) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flags: Record<string, string> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [key, value] = a.slice(2).split("=");
      flags[key] = value ?? "true";
    }
  }
  return { supplierVariantId: positional[0], flags };
}

async function run() {
  const { supplierVariantId, flags } = parseArgs(process.argv.slice(2));

  if (!supplierVariantId) {
    console.error("Usage: npm run fetch-variant -- <supplierVariantId> [--supplier=CJ|TEST] [--sku=internal-sku]");
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n✗ Configuration error.\n\n  ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const supplierKey = (flags.supplier || config.activeSupplier).toUpperCase();
  const internalSku = flags.sku || `${supplierKey.toLowerCase()}-${supplierVariantId}`;
  const productTitle = flags["product-title"] || `Imported via fetchVariant (${supplierKey})`;

  console.log(`Fetching variant "${supplierVariantId}" via supplier "${supplierKey}"...`);

  const plugin = (() => {
    try {
      return getSupplierProvider(supplierKey);
    } catch (err) {
      console.error(`\n✗ ${(err as Error).message}\n`);
      process.exit(1);
    }
  })();

  let result;
  try {
    result = await plugin.getStockAndPrice(supplierVariantId);
  } catch (err) {
    logger.error("fetchVariant: getStockAndPrice failed", { error: (err as Error).message, supplierKey, supplierVariantId });
    console.error(`\n✗ Fetch failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  console.log("Fetched:", result);

  const db = getDb(config.databaseFile);

  const upsert = db.transaction(() => {
    let product = db
      .prepare("SELECT id FROM products WHERE title = ?")
      .get(productTitle) as { id: number } | undefined;

    if (!product) {
      const info = db
        .prepare("INSERT INTO products (title, status) VALUES (?, 'active')")
        .run(productTitle);
      product = { id: Number(info.lastInsertRowid) };
    }

    db.prepare(
      `INSERT INTO variants (product_id, supplier_type, supplier_variant_id, internal_sku, cost, shipping_cost, current_price, current_stock, last_synced_at)
       VALUES (@product_id, @supplier_type, @supplier_variant_id, @internal_sku, @cost, @shipping_cost, @current_price, @current_stock, datetime('now'))
       ON CONFLICT(supplier_type, supplier_variant_id) DO UPDATE SET
         cost = excluded.cost,
         shipping_cost = excluded.shipping_cost,
         current_price = excluded.current_price,
         current_stock = excluded.current_stock,
         last_synced_at = excluded.last_synced_at,
         updated_at = datetime('now')`
    ).run({
      product_id: product.id,
      supplier_type: supplierKey,
      supplier_variant_id: supplierVariantId,
      internal_sku: internalSku,
      cost: result.cost,
      shipping_cost: result.shippingCost,
      current_price: null, // eBay price is computed by the pricing formula in Phase 3/4, not stored here
      current_stock: result.stock,
    });
  });

  upsert();

  const stored = db
    .prepare("SELECT * FROM variants WHERE supplier_type = ? AND supplier_variant_id = ?")
    .get(supplierKey, supplierVariantId);

  console.log("\n✓ Stored in variants table:", stored, "\n");
  db.close();
}

run();
