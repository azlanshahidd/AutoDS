/**
 * orderRoutingOnce.ts — manually triggers one order-routing cycle.
 *
 * Usage:
 *   npm run order-routing-once                        — real eBay orders
 *   npm run order-routing-once -- --fake-order        — fake order (test idempotency/kill-switch)
 *   npm run order-routing-once -- --dry-run           — log what would be ordered, no writes
 *   npm run order-routing-once -- --fake-order --dry-run
 */
import "dotenv/config";
import { loadConfig, ConfigError } from "../config";
import { getDb } from "../db/connection";
import { runOrderRoutingOnce } from "./orderRoutingLoop";
import { EbayOrder } from "../ebay/ebayClient";

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

  let ordersOverride: EbayOrder[] | undefined;

  if (flags["fake-order"]) {
    let ebaySku = flags["ebay-sku"] as string | undefined;
    if (!ebaySku) {
      const row = db.prepare("SELECT ebay_sku FROM variants WHERE ebay_sku IS NOT NULL LIMIT 1").get() as
        | { ebay_sku: string } | undefined;
      if (!row) {
        console.error("\n✗ No published variant found. Pass --ebay-sku=<sku> explicitly.\n");
        process.exit(1);
      }
      ebaySku = row.ebay_sku;
    }
    const fakeOrderId = (flags["order-id"] as string) || `FAKE-EBAY-ORDER-${Date.now()}`;
    ordersOverride = [{
      orderId: fakeOrderId,
      orderFulfillmentStatus: "NOT_STARTED",
      orderPaymentStatus:     "PAID",
      buyer: { username: "test_buyer" },
      lineItems: [{ lineItemId: "fake-line-item-1", sku: ebaySku, quantity: 1 }],
      shippingAddress: {
        fullName: "Test Buyer", addressLine1: "123 Test St",
        city: "Austin", stateOrProvince: "TX", postalCode: "78701", countryCode: "US",
      },
      raw: {},
    }];
    console.log(`Using fake order "${fakeOrderId}" for SKU "${ebaySku}" (--fake-order).`);
  }

  if (dryRun) console.log("🔍 DRY RUN — no writes will be made.\n");
  console.log("Running one order-routing cycle...\n");

  const summary = await runOrderRoutingOnce(db, config, ordersOverride, { dryRun });

  console.log("Summary:");
  console.log(`  Orders fetched:          ${summary.ordersFetched}`);
  console.log(`  Already processed:       ${summary.alreadyProcessed}`);
  console.log(`  Submitted this run:      ${summary.submitted}`);
  console.log(`  Logged, not submitted:   ${summary.loggedNotSubmitted}`);
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
