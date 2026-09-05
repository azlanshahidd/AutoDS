/**
 * Unit tests for src/pricing.ts
 *
 * These cover the highest-value business logic in the codebase — every
 * listing's sell price flows through calculateEbayPrice(). A wrong formula
 * silently under-prices or over-prices every item we sell.
 *
 * Coverage targets:
 *  - Base formula with global margin + fee
 *  - Per-supplier margin/fee overrides
 *  - Per-cost-tier matching (first tier, middle tier, fallback)
 *  - Edge cases: zero cost, negative input guard, rounding
 *  - parsePricingTiers: valid JSON, bad JSON, wrong shape, empty
 */
import { describe, it, expect } from "vitest";
import { calculateEbayPrice, parsePricingTiers, PricingTier } from "../../src/pricing";

// ── Base formula ──────────────────────────────────────────────────────────────

describe("calculateEbayPrice — base formula", () => {
  it("applies (cost + shipping) × (1 + margin) + fee", () => {
    // ($10 + $2.50) × 1.30 + $2.50 = $16.75
    const price = calculateEbayPrice({
      supplierUnitCost:     10,
      supplierShippingCost: 2.5,
      profitMarginPercent:  0.3,
      ebayFeeEstimate:      2.5,
    });
    expect(price).toBe(18.75);
  });

  it("rounds to 2 decimal places", () => {
    // ($7 + $1) × 1.30 + $2.50 = $12.90 — no rounding issue here
    // Use inputs that produce a repeating decimal
    const price = calculateEbayPrice({
      supplierUnitCost:     1,
      supplierShippingCost: 0,
      profitMarginPercent:  1 / 3, // 33.333...%
      ebayFeeEstimate:      0,
    });
    // 1 × 1.3333... = 1.3333... → rounds to 1.33
    expect(price).toBe(1.33);
  });

  it("handles zero shipping cost", () => {
    // $20 × 1.30 + $2.50 = $28.50
    const price = calculateEbayPrice({
      supplierUnitCost:     20,
      supplierShippingCost: 0,
      profitMarginPercent:  0.3,
      ebayFeeEstimate:      2.5,
    });
    expect(price).toBe(28.5);
  });

  it("handles zero fee estimate", () => {
    const price = calculateEbayPrice({
      supplierUnitCost:     10,
      supplierShippingCost: 0,
      profitMarginPercent:  0.5,
      ebayFeeEstimate:      0,
    });
    expect(price).toBe(15);
  });

  it("handles zero margin (cost-plus-fee only)", () => {
    const price = calculateEbayPrice({
      supplierUnitCost:     10,
      supplierShippingCost: 2,
      profitMarginPercent:  0,
      ebayFeeEstimate:      1,
    });
    expect(price).toBe(13);
  });

  it("throws on negative unit cost", () => {
    expect(() =>
      calculateEbayPrice({
        supplierUnitCost:     -1,
        supplierShippingCost: 0,
        profitMarginPercent:  0.3,
        ebayFeeEstimate:      2.5,
      })
    ).toThrow("cannot be negative");
  });

  it("throws on negative shipping cost", () => {
    expect(() =>
      calculateEbayPrice({
        supplierUnitCost:     5,
        supplierShippingCost: -0.01,
        profitMarginPercent:  0.3,
        ebayFeeEstimate:      2.5,
      })
    ).toThrow("cannot be negative");
  });
});

// ── Per-supplier overrides ────────────────────────────────────────────────────

describe("calculateEbayPrice — per-supplier overrides", () => {
  const base = {
    supplierUnitCost:     10,
    supplierShippingCost: 0,
    profitMarginPercent:  0.3,  // 30% global
    ebayFeeEstimate:      2.5,  // $2.50 global fee
  };

  it("supplierMarginOverride replaces global margin", () => {
    // ($10) × (1 + 0.40) + $2.50 = $16.50
    const price = calculateEbayPrice({ ...base, supplierMarginOverride: 0.4 });
    expect(price).toBe(16.5);
  });

  it("supplierFeeOverride replaces global fee", () => {
    // ($10) × 1.30 + $1.00 = $14.00
    const price = calculateEbayPrice({ ...base, supplierFeeOverride: 1.0 });
    expect(price).toBe(14.0);
  });

  it("both overrides applied simultaneously", () => {
    // ($10) × 1.20 + $1.00 = $13.00
    const price = calculateEbayPrice({
      ...base,
      supplierMarginOverride: 0.2,
      supplierFeeOverride:    1.0,
    });
    expect(price).toBe(13.0);
  });

  it("null override falls back to global values", () => {
    const price = calculateEbayPrice({
      ...base,
      supplierMarginOverride: null,
      supplierFeeOverride:    null,
    });
    // Same as base: $10 × 1.30 + $2.50 = $15.50
    expect(price).toBe(15.5);
  });
});

// ── Per-cost-tier rules ───────────────────────────────────────────────────────

describe("calculateEbayPrice — pricing tiers", () => {
  const tiers: PricingTier[] = [
    { maxCost: 10,  marginPercent: 0.60 },           // cheap items: 60%
    { maxCost: 30,  marginPercent: 0.35 },           // mid range: 35%
    { maxCost: 100, marginPercent: 0.25, flatMarkup: 2 }, // expensive: 25% + $2
  ];

  it("matches the first (lowest) tier when cost is within it", () => {
    // totalCost = $5. Tier 1 (maxCost=10) matches.
    // $5 × 1.60 + $2.50 = $10.50
    const price = calculateEbayPrice({
      supplierUnitCost:     5,
      supplierShippingCost: 0,
      profitMarginPercent:  0.3,
      ebayFeeEstimate:      2.5,
      tiers,
    });
    expect(price).toBe(10.5);
  });

  it("matches the correct tier when cost is at the exact boundary", () => {
    // totalCost = $10 exactly — should still match tier 1 (maxCost: 10, ≤)
    const price = calculateEbayPrice({
      supplierUnitCost:     10,
      supplierShippingCost: 0,
      profitMarginPercent:  0.3,
      ebayFeeEstimate:      2.5,
      tiers,
    });
    // $10 × 1.60 + $2.50 = $18.50
    expect(price).toBe(18.5);
  });

  it("matches the middle tier", () => {
    // totalCost = $20. Tier 2 (maxCost=30) matches.
    // $20 × 1.35 + $2.50 = $29.50
    const price = calculateEbayPrice({
      supplierUnitCost:     20,
      supplierShippingCost: 0,
      profitMarginPercent:  0.3,
      ebayFeeEstimate:      2.5,
      tiers,
    });
    expect(price).toBe(29.5);
  });

  it("applies flatMarkup from tier", () => {
    // totalCost = $50. Tier 3 (maxCost=100) matches: 25% + $2 flat.
    // $50 × 1.25 + $2.50 + $2 = $66.00
    const price = calculateEbayPrice({
      supplierUnitCost:     50,
      supplierShippingCost: 0,
      profitMarginPercent:  0.3,
      ebayFeeEstimate:      2.5,
      tiers,
    });
    expect(price).toBe(67.0);
  });

  it("falls back to global margin when cost exceeds all tier maxCosts", () => {
    // totalCost = $150 — no tier matches. Uses global 30%.
    // $150 × 1.30 + $2.50 = $197.50
    const price = calculateEbayPrice({
      supplierUnitCost:     150,
      supplierShippingCost: 0,
      profitMarginPercent:  0.3,
      ebayFeeEstimate:      2.5,
      tiers,
    });
    expect(price).toBe(197.5);
  });

  it("tiers take priority over supplierMarginOverride", () => {
    // totalCost = $5 → tier 1 (60%) wins over supplierMarginOverride (40%)
    const price = calculateEbayPrice({
      supplierUnitCost:     5,
      supplierShippingCost: 0,
      profitMarginPercent:  0.3,
      ebayFeeEstimate:      2.5,
      supplierMarginOverride: 0.4,
      tiers,
    });
    // $5 × 1.60 + $2.50 = $10.50
    expect(price).toBe(10.5);
  });

  it("empty tiers array uses global margin", () => {
    const price = calculateEbayPrice({
      supplierUnitCost:     10,
      supplierShippingCost: 0,
      profitMarginPercent:  0.3,
      ebayFeeEstimate:      2.5,
      tiers: [],
    });
    expect(price).toBe(15.5);
  });
});

// ── parsePricingTiers ─────────────────────────────────────────────────────────

describe("parsePricingTiers", () => {
  it("parses a valid JSON array", () => {
    const raw = JSON.stringify([
      { maxCost: 10, marginPercent: 0.5 },
      { maxCost: 50, marginPercent: 0.3, flatMarkup: 1 },
    ]);
    const tiers = parsePricingTiers(raw);
    expect(tiers).toHaveLength(2);
    expect(tiers[0].marginPercent).toBe(0.5);
    expect(tiers[1].flatMarkup).toBe(1);
  });

  it("returns empty array for null input", () => {
    expect(parsePricingTiers(null)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parsePricingTiers("")).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parsePricingTiers("{not json")).toEqual([]);
  });

  it("returns empty array when JSON is not an array", () => {
    expect(parsePricingTiers('{"maxCost":10}')).toEqual([]);
  });

  it("filters out objects missing required fields", () => {
    const raw = JSON.stringify([
      { maxCost: 10, marginPercent: 0.5 },   // valid
      { maxCost: 20 },                        // missing marginPercent
      { marginPercent: 0.3 },                 // missing maxCost
      "not an object",                        // wrong type
    ]);
    const tiers = parsePricingTiers(raw);
    expect(tiers).toHaveLength(1);
    expect(tiers[0].maxCost).toBe(10);
  });

  it("defaults flatMarkup to 0 when not provided", () => {
    const raw = JSON.stringify([{ maxCost: 10, marginPercent: 0.4 }]);
    const tiers = parsePricingTiers(raw);
    expect(tiers[0].flatMarkup).toBe(0);
  });
});
