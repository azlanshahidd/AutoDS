/**
 * testPricingAndVero.ts — verifies the pricing formula and VeRO filter
 * work correctly, without needing any eBay credentials. Run with:
 *   npm run test-pricing-vero
 *
 * This is a lightweight assertion script, not a full test framework — it's
 * meant to be run manually as a sanity check, per the phase's "test before
 * continuing" requirement, for the two pieces of Phase 3 that don't depend
 * on live eBay access.
 */
import "dotenv/config";
import { calculateEbayPrice } from "../pricing";
import { checkVero } from "./veroFilter";
import path from "path";

let failures = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? "✓" : "✗"} ${label}${pass ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!pass) failures++;
}

console.log("--- Pricing formula ---");

// eBayPrice = (cjUnitCost + cjShippingCost) * (1 + profitMarginPercent) + eBayFeeEstimate
assertEqual(
  calculateEbayPrice({ supplierUnitCost: 10, supplierShippingCost: 2, profitMarginPercent: 0.3, ebayFeeEstimate: 2.5 }),
  (10 + 2) * 1.3 + 2.5,
  "Basic formula matches spec exactly"
);

assertEqual(
  calculateEbayPrice({ supplierUnitCost: 0, supplierShippingCost: 0, profitMarginPercent: 0, ebayFeeEstimate: 0 }),
  0,
  "Zero inputs produce zero"
);

assertEqual(
  calculateEbayPrice({ supplierUnitCost: 19.99, supplierShippingCost: 3.5, profitMarginPercent: 0.35, ebayFeeEstimate: 2.5 }),
  Math.round(((19.99 + 3.5) * 1.35 + 2.5) * 100) / 100,
  "Rounds to 2 decimal places"
);

try {
  calculateEbayPrice({ supplierUnitCost: -5, supplierShippingCost: 0, profitMarginPercent: 0.3, ebayFeeEstimate: 2.5 });
  console.log("✗ Negative cost should have thrown");
  failures++;
} catch {
  console.log("✓ Negative cost throws as expected");
}

console.log("\n--- VeRO filter ---");

const blocklistPath = path.join(__dirname, "../../config/vero-blocklist.txt");

const blockedResult = checkVero("Nike Air Max Running Shoes", "Brand new, never worn", blocklistPath);
assertEqual(blockedResult.isBlocked, true, 'Title containing "Nike" is blocked');
assertEqual(blockedResult.matchedKeywords.includes("nike"), true, 'Matched keyword includes "nike"');

const cleanResult = checkVero("Generic Running Shoes", "Comfortable everyday sneakers", blocklistPath);
assertEqual(cleanResult.isBlocked, false, "Unbranded title is not blocked");

const wordBoundaryResult = checkVero("Unikey Smart Lock", "A keyless entry system", blocklistPath);
assertEqual(wordBoundaryResult.isBlocked, false, '"Unikey" does not false-positive on "nike"');

const descriptionMatch = checkVero("Kids Backpack", "Featuring your favorite Marvel superheroes", blocklistPath);
assertEqual(descriptionMatch.isBlocked, true, "Match in description (not just title) is caught");

console.log(`\n${failures === 0 ? "✓ All checks passed." : `✗ ${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
