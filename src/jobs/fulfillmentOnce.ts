/**
 * fulfillmentOnce.ts — manually triggers one fulfillment/tracking cycle.
 *
 * Usage:
 *   npm run fulfillment-once                       — real eBay + supplier calls
 *   npm run fulfillment-once -- --fake-ebay        — fake eBay client (test logic)
 *   npm run fulfillment-once -- --dry-run          — log what would happen, no writes
 *   npm run fulfillment-once -- --fake-ebay --dry-run
 */
import "dotenv/config";
import { loadConfig, ConfigError } from "../config";
import { getDb } from "../db/connection";
import { runFulfillmentOnce } from "./fulfillmentLoop";
import { EbayClient } from "../ebay/ebayClient";

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [key, value] = a.slice(2).split("=");
      flags[key] = value ?? true;
    }
  }
  return flags;
}

async function run() {
  const flags  = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(flags["dry-run"]);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) { console.error(`\n✗ ${err.message}\n`); process.exit(1); }
    throw err;
  }

  const db = getDb(config.databaseFile);

  let ebayClientOverride: Pick<EbayClient, "getOrderById" | "createShippingFulfillment"> | undefined;

  if (flags["fake-ebay"]) {
    console.log("Using fake eBay client (--fake-ebay) — no real eBay calls.\n");
    ebayClientOverride = {
      async getOrderById(orderId) {
        console.log(`  [fake eBay] getOrderById(${orderId})`);
        return {
          orderId, orderFulfillmentStatus: "NOT_STARTED", orderPaymentStatus: "PAID",
          buyer: {}, lineItems: [{ lineItemId: "fake-line-item-1", sku: "fake-sku", quantity: 1 }],
          shippingAddress: {}, raw: {},
        };
      },
      async createShippingFulfillment(params) {
        console.log(`  [fake eBay] createShippingFulfillment(orderId=${params.orderId}, tracking=${params.trackingNumber})`);
      },
    };
  }

  if (dryRun) console.log("🔍 DRY RUN — no writes will be made.\n");
  console.log("Running one fulfillment cycle...\n");

  const summary = await runFulfillmentOnce(db, config, ebayClientOverride, { dryRun });

  console.log("Summary:");
  console.log(`  Candidates checked:      ${summary.candidatesChecked}`);
  console.log(`  Not yet shipped:         ${summary.notYetShipped}`);
  console.log(`  Fulfilled:               ${summary.fulfilled}`);
  console.log(`  Failed:                  ${summary.failed}`);
  console.log(`  Skipped (circuit open):  ${summary.skippedCircuitOpen}`);
  console.log(`  Result:                  ${summary.result}${dryRun ? " (dry run)" : ""}`);
  if (summary.errors.length > 0) {
    console.log("\n  Errors:");
    for (const e of summary.errors) console.log(`    - ${e.ebayOrderId}: ${e.message}`);
  }
  console.log();
  db.close();
}

run();
