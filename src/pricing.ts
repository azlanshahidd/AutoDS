/**
 * Pricing formula (Section 4) — extended with per-supplier overrides and
 * per-cost-tier rules.
 *
 * ## Base formula (unchanged from v1)
 *
 *   eBayPrice = (unitCost + shippingCost) × (1 + margin) + fee
 *
 * ## Per-supplier overrides
 *
 * Each supplier row in the DB can carry `margin_override` and/or
 * `fee_override`. When set (non-null), they replace the global
 * PROFIT_MARGIN_PERCENT / EBAY_FEE_ESTIMATE for that supplier's variants.
 * Pass them via `PricingInputs.supplierMarginOverride` /
 * `PricingInputs.supplierFeeOverride`; the function picks the right value
 * automatically.
 *
 * ## Per-tier rules
 *
 * A single global margin often under-prices cheap items and over-prices
 * expensive ones. Pass an array of `PricingTier` rules to apply a different
 * margin (and optionally a flat markup) depending on total supplier cost.
 *
 * Tiers are evaluated in ascending `maxCost` order; the first tier whose
 * `maxCost` is ≥ totalCost wins. If no tier matches (totalCost exceeds all
 * maxCost values) the global/supplier margin is used as the fallback.
 *
 * Example tier config:
 *
 *   [
 *     { maxCost: 10,  marginPercent: 0.60, flatMarkup: 0 },  // < $10: 60% margin
 *     { maxCost: 30,  marginPercent: 0.35, flatMarkup: 0 },  // $10–$30: 35%
 *     { maxCost: 100, marginPercent: 0.25, flatMarkup: 2 },  // $30–$100: 25% + $2
 *   ]
 *   // > $100: falls back to global/supplier margin
 *
 * Tiers are global config — stored as JSON in the `config` table under key
 * `PRICING_TIERS` and loaded by the sync loop.
 */

export interface PricingTier {
  /** Upper bound (inclusive) of the total supplier cost (unit + shipping) this tier applies to. */
  maxCost:       number;
  /** Margin to apply when this tier matches, e.g. 0.40 for 40%. */
  marginPercent: number;
  /** Optional flat markup added on top of the percentage markup, in USD. Default 0. */
  flatMarkup?:   number;
}

export interface PricingInputs {
  supplierUnitCost:     number;
  supplierShippingCost: number;
  /** Global margin from config (e.g. 0.30 for 30%). */
  profitMarginPercent:  number;
  /** Global flat eBay fee estimate from config. */
  ebayFeeEstimate:      number;
  /** Per-supplier margin override — null means use profitMarginPercent. */
  supplierMarginOverride?: number | null;
  /** Per-supplier fee override — null means use ebayFeeEstimate. */
  supplierFeeOverride?:    number | null;
  /** Optional per-tier rules. When supplied, the matching tier's margin
   *  takes priority over both the global and per-supplier margin. */
  tiers?: PricingTier[];
}

export function calculateEbayPrice(inputs: PricingInputs): number {
  const {
    supplierUnitCost,
    supplierShippingCost,
    profitMarginPercent,
    ebayFeeEstimate,
    supplierMarginOverride,
    supplierFeeOverride,
    tiers,
  } = inputs;

  /**
   * Why we throw instead of returning 0: a negative cost input is almost
   * certainly a data error (e.g. a supplier API returning a null that got
   * coerced to -1). Silently pricing at $0 would create a real eBay listing
   * at $0. Throwing surfaces the problem immediately in the sync log.
   */
  if (supplierUnitCost < 0 || supplierShippingCost < 0) {
    throw new Error("Pricing inputs cannot be negative.");
  }

  const totalCost = supplierUnitCost + supplierShippingCost;

  // ── 1. Resolve effective fee ──────────────────────────────────────────────
  // Per-supplier override wins over global; no tier override for fee.
  // Rationale: eBay fees don't vary by item cost; they're flat platform costs.
  const effectiveFee =
    supplierFeeOverride != null ? supplierFeeOverride : ebayFeeEstimate;

  // ── 2. Resolve effective margin ───────────────────────────────────────────
  // Priority: matching tier > per-supplier override > global margin.
  //
  // Why this order?
  //   - Tiers are cost-bracket rules ("cheap items need higher margin").
  //     They should win over everything else because they encode the most
  //     specific pricing knowledge about the item.
  //   - Per-supplier overrides encode knowledge about a specific supplier's
  //     reliability/margins. They should win over the global default.
  //   - Global margin is the catch-all fallback.
  let effectiveMargin = supplierMarginOverride != null
    ? supplierMarginOverride
    : profitMarginPercent;
  let flatMarkup = 0;

  if (tiers && tiers.length > 0) {
    // Sort ascending by maxCost so we find the lowest matching tier.
    // "Lowest matching" = first tier whose maxCost ≥ totalCost.
    // This means tiers define UPPER bounds, not ranges:
    //   { maxCost: 10 } = "apply when totalCost ≤ $10"
    const sorted = [...tiers].sort((a, b) => a.maxCost - b.maxCost);
    const matchedTier = sorted.find((t) => totalCost <= t.maxCost);
    if (matchedTier) {
      effectiveMargin = matchedTier.marginPercent;
      flatMarkup      = matchedTier.flatMarkup ?? 0;
    }
    // If no tier matched (cost exceeds all maxCost values), effectiveMargin
    // stays as the supplier/global fallback resolved above.
  }

  // ── 3. Apply formula ──────────────────────────────────────────────────────
  //
  //   price = (unitCost + shippingCost) × (1 + margin) + fee + flatMarkup
  //
  // Note: fee and flatMarkup are added AFTER the margin multiplication.
  // This is intentional — we want margin on the supplier cost, not on
  // eBay's fees (which we don't control and don't profit from).
  const raw = totalCost * (1 + effectiveMargin) + effectiveFee + flatMarkup;

  // Round to 2 decimal places to avoid floating-point noise in eBay's API
  // (e.g. $12.999999999 becomes $13.00).
  return Math.round(raw * 100) / 100;
}

// ── Tier config helpers ───────────────────────────────────────────────────────

/**
 * Parses the PRICING_TIERS JSON string from the config table.
 * Returns an empty array (no tier rules) on any parse/validation failure
 * so a bad config value never breaks the sync loop.
 */
export function parsePricingTiers(raw: string | null | undefined): PricingTier[] {
  if (!raw || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is PricingTier =>
          typeof t === "object" &&
          t !== null &&
          typeof t.maxCost === "number" &&
          typeof t.marginPercent === "number"
      )
      .map((t) => ({
        maxCost:       t.maxCost,
        marginPercent: t.marginPercent,
        flatMarkup:    typeof t.flatMarkup === "number" ? t.flatMarkup : 0,
      }));
  } catch {
    return [];
  }
}
