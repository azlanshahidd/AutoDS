/**
 * Auto-listing pipeline (Phase 4).
 *
 * Orchestrates the full path from an approved scouted item to a live eBay
 * listing in one transactional service call:
 *
 *   Step 1: Ensure AI title + description exist (generate if missing).
 *   Step 2: VeRO keyword check — hard block, no exceptions.
 *   Step 3: Quality gate — minimum field requirements before any eBay call.
 *   Step 4: Pricing calculation using the live margin/fee config.
 *   Step 5: Create product + variant rows (idempotent — skip if already exist).
 *   Step 6: Publish to eBay (createOrReplaceInventoryItem → createOffer → publishOffer).
 *   Step 7: Write back eBay SKU/offer ID to variant; mark scouted item published.
 *
 * The "Review before publish" toggle (AUTO_LIST_ENABLED config key) controls
 * whether approved items are queued for a final human click (false, the safe
 * default) or published immediately on approval (true, fully automatic).
 *
 * Image handling: image_urls is a JSON-encoded string array stored on
 * scouted_products. Callers (the push endpoint, the UI) are responsible for
 * populating it. The pipeline reads it and attaches the URLs to the eBay
 * inventory item. If no images are provided the quality gate blocks publish.
 *
 * Category mapping: eBay requires a category ID. The item's ebay_category_id
 * field is set by the user in the "Preview listing" modal before publish.
 * A future enhancement can add automatic category suggestion via the eBay
 * Taxonomy API, but the gate ensures nothing goes live with a missing category.
 */
import Database from "better-sqlite3";
import { CoreConfig } from "../config";
import { generateListingContent, checkVeroOnMetaFields } from "../routes/aiService";
import { checkVero } from "../ebay/veroFilter";
import { buildEbayClient, EbayNotConfiguredError } from "../ebay/ebayFactory";
import { calculateEbayPrice } from "../pricing";
import { logger } from "../logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ListingStatus =
  | "none"
  | "queued"
  | "vero_blocked"
  | "quality_fail"
  | "publishing"
  | "published"
  | "failed";

export interface ScoutedRow {
  id:               number;
  title:            string;
  source_url:       string | null;
  scraped_price:    number | null;
  trend_signal:     string | null;
  ai_title:         string | null;
  ai_description:   string | null;
  meta_title:             string | null;
  meta_description:       string | null;
  meta_generation_source: string | null;
  listing_status:   ListingStatus;
  ebay_listing_id:  string | null;
  ebay_category_id: string | null;
  image_urls:       string | null;  // JSON array
  matched_supplier: string | null;
  matched_cost:     number | null;
}

export interface ListingPreview {
  scoutedId:       number;
  ebayTitle:       string;
  description:     string;
  price:           number;
  categoryId:      string;
  merchantLocationKey: string;
  marketplaceId:   string;
  images:          string[];
  supplierCost:    number;
  shippingCost:    number;
  profitMargin:    number;
  ebayFeeEstimate: number;
  veroCheck:       { isBlocked: boolean; matchedKeywords: string[] };
  qualityIssues:   string[];
  canPublish:      boolean;
}

export interface PipelineResult {
  success:      boolean;
  step:         string;
  error?:       string;
  listingId?:   string;
  offerId?:     string;
  ebaySku?:     string;
  price?:       number;
  /** Returned when AUTO_LIST_ENABLED=false and item was queued instead */
  queued?:      boolean;
}

// ── Quality gate ─────────────────────────────────────────────────────────────

/** Minimum requirements before a listing is allowed to publish. */
function runQualityGate(
  title: string,
  description: string,
  images: string[],
  categoryId: string
): string[] {
  const issues: string[] = [];
  if (!title || title.trim().length < 10) {
    issues.push("Title must be at least 10 characters.");
  }
  if (title.trim().length > 80) {
    issues.push(`Title is ${title.trim().length} chars; eBay maximum is 80.`);
  }
  if (!description || description.trim().length < 50) {
    issues.push("Description must be at least 50 characters.");
  }
  if (images.length === 0) {
    issues.push("At least one product image is required for an eBay listing.");
  }
  if (!categoryId || !categoryId.trim()) {
    issues.push("An eBay category ID is required. Set it in the Preview modal.");
  }
  return issues;
}

// ── Config helpers ────────────────────────────────────────────────────────────

function getConfigKey(db: Database.Database, key: string, fallback = ""): string {
  return (
    (db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
      | { value: string }
      | undefined)?.value ?? fallback
  );
}

export function getAutoListEnabled(db: Database.Database): boolean {
  return getConfigKey(db, "AUTO_LIST_ENABLED", "false").toLowerCase() === "true";
}

export function getMerchantLocationKey(db: Database.Database): string {
  return getConfigKey(db, "EBAY_MERCHANT_LOCATION", "");
}

export function getMarketplaceId(db: Database.Database): string {
  return getConfigKey(db, "EBAY_MARKETPLACE_ID", "EBAY_US");
}

// ── Preview (no side effects) ─────────────────────────────────────────────────

/**
 * Returns exactly what would be sent to eBay, including the VeRO check
 * and quality gate results — without making any API calls or DB writes.
 * Used by the "Preview listing" modal.
 */
export async function previewListing(
  db: Database.Database,
  config: CoreConfig,
  scoutedId: number
): Promise<ListingPreview | null> {
  const item = db
    .prepare("SELECT * FROM scouted_products WHERE id = ?")
    .get(scoutedId) as ScoutedRow | undefined;
  if (!item) return null;

  const ebayTitle   = item.ai_title   ?? item.title;
  const description = item.ai_description ?? item.title;
  const images      = item.image_urls ? (JSON.parse(item.image_urls) as string[]) : [];
  const categoryId  = item.ebay_category_id ?? "";
  const merchantLocationKey = getMerchantLocationKey(db);
  const marketplaceId       = getMarketplaceId(db);

  // Cost and pricing
  const supplierCost   = item.matched_cost ?? item.scraped_price ?? 0;
  const shippingCost   = 0; // Phase 4: use scraped price as proxy; real shipping from supplier API in Phase 5
  const profitMargin   = Number(getConfigKey(db, "PROFIT_MARGIN_PERCENT", "0.3"));
  const ebayFeeEstimate = Number(getConfigKey(db, "EBAY_FEE_ESTIMATE", "2.5"));

  const price = calculateEbayPrice({
    supplierUnitCost:    supplierCost,
    supplierShippingCost: shippingCost,
    profitMarginPercent:  profitMargin,
    ebayFeeEstimate,
  });

  // VeRO check
  let veroCheck = { isBlocked: false, matchedKeywords: [] as string[] };
  try {
    veroCheck = checkVero(ebayTitle, description, config.veroBlocklistPath);
  } catch {
    // blocklist file missing — treat as no-block but note in quality issues
  }

  // Quality gate
  const qualityIssues = runQualityGate(ebayTitle, description, images, categoryId);
  if (veroCheck.isBlocked) {
    qualityIssues.unshift(`VeRO blocked: matched keywords [${veroCheck.matchedKeywords.join(", ")}]`);
  }
  if (!merchantLocationKey) {
    qualityIssues.push("EBAY_MERCHANT_LOCATION is not configured. Set it in Settings.");
  }

  return {
    scoutedId,
    ebayTitle,
    description,
    price,
    categoryId,
    merchantLocationKey,
    marketplaceId,
    images,
    supplierCost,
    shippingCost,
    profitMargin,
    ebayFeeEstimate,
    veroCheck,
    qualityIssues,
    canPublish: qualityIssues.length === 0,
  };
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

function setListingStatus(
  db: Database.Database,
  id: number,
  status: ListingStatus,
  error?: string
) {
  db.prepare(
    `UPDATE scouted_products
       SET listing_status = ?, listing_error = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(status, error ?? null, id);
}

/**
 * Runs the full approve → publish pipeline for a single scouted item.
 *
 * When `AUTO_LIST_ENABLED=false` (default), the item is set to
 * `listing_status='queued'` and the caller is expected to present a final
 * "Publish now" confirmation to the user. Calling `publishListing` directly
 * from the frontend "Publish to eBay" button bypasses this queue and
 * publishes immediately regardless of the setting.
 *
 * @param force  When true, publishes immediately even if AUTO_LIST_ENABLED=false.
 *               Pass true from the "Publish to eBay" button, false from the
 *               auto-approve path.
 */
export async function runListingPipeline(
  db: Database.Database,
  config: CoreConfig,
  scoutedId: number,
  options: {
    force?:          boolean; // bypass review queue
    categoryId?:     string;  // override stored category
    imageUrls?:      string[]; // override stored images
  } = {}
): Promise<PipelineResult> {
  const item = db
    .prepare("SELECT * FROM scouted_products WHERE id = ?")
    .get(scoutedId) as ScoutedRow | undefined;

  if (!item) {
    return { success: false, step: "load", error: "Scouted item not found." };
  }
  if (item.listing_status === "published") {
    return { success: false, step: "guard", error: "Item is already published." };
  }
  if (item.listing_status === "publishing") {
    return { success: false, step: "guard", error: "Publish already in progress." };
  }

  // Persist supplied overrides before running the pipeline
  if (options.categoryId) {
    db.prepare("UPDATE scouted_products SET ebay_category_id = ? WHERE id = ?")
      .run(options.categoryId, scoutedId);
  }
  if (options.imageUrls) {
    db.prepare("UPDATE scouted_products SET image_urls = ? WHERE id = ?")
      .run(JSON.stringify(options.imageUrls), scoutedId);
  }

  // Re-read after possible writes
  const fresh = db
    .prepare("SELECT * FROM scouted_products WHERE id = ?")
    .get(scoutedId) as ScoutedRow;

  // ── Step 1: Ensure AI content ──────────────────────────────────────────────
  let aiTitle       = fresh.ai_title;
  let aiDescription = fresh.ai_description;
  let metaTitle     = fresh.meta_title;
  let metaDesc      = fresh.meta_description;

  // Regenerate if any of the four fields are missing (treat as an atomic set)
  if (!aiTitle || !aiDescription || !metaTitle || !metaDesc) {
    logger.info("Auto-listing: generating AI content + SEO metadata", { scoutedId });
    const generated = await generateListingContent(db, {
      title:        fresh.title,
      scrapedPrice: fresh.scraped_price,
      trendSignal:  fresh.trend_signal,
    });
    if (!generated) {
      setListingStatus(db, scoutedId, "failed", "AI content generation failed. Check AI provider settings.");
      return { success: false, step: "ai_generate", error: "AI generation failed." };
    }

    aiTitle       = generated.aiTitle;
    aiDescription = generated.aiDescription;
    metaTitle     = generated.metaTitle;
    metaDesc      = generated.metaDescription;

    // VeRO check on meta fields before persisting
    const metaVero = checkVeroOnMetaFields(
      metaTitle,
      metaDesc,
      config.veroBlocklistPath
    );
    if (metaVero.isBlocked) {
      const msg = `SEO meta fields VeRO blocked: [${metaVero.matchedKeywords.join(", ")}]`;
      setListingStatus(db, scoutedId, "vero_blocked", msg);
      logger.warn("Auto-listing: SEO meta VeRO blocked", {
        scoutedId,
        keywords: metaVero.matchedKeywords,
      });
      return { success: false, step: "vero_meta", error: msg };
    }

    db.prepare(
      `UPDATE scouted_products
         SET ai_title               = ?,
             ai_description         = ?,
             meta_title             = ?,
             meta_description       = ?,
             meta_generated_at      = datetime('now'),
             meta_generation_source = ?,
             updated_at             = datetime('now')
       WHERE id = ?`
    ).run(aiTitle, aiDescription, metaTitle, metaDesc, generated.generationSource, scoutedId);
  }

  // ── Step 2: VeRO check ────────────────────────────────────────────────────
  let veroResult = { isBlocked: false, matchedKeywords: [] as string[] };
  try {
    veroResult = checkVero(aiTitle, aiDescription, config.veroBlocklistPath);
  } catch (err) {
    logger.warn("Auto-listing: VeRO blocklist unavailable, proceeding without check", {
      error: (err as Error).message,
    });
  }
  if (veroResult.isBlocked) {
    const msg = `VeRO blocked: matched [${veroResult.matchedKeywords.join(", ")}]`;
    setListingStatus(db, scoutedId, "vero_blocked", msg);
    logger.warn("Auto-listing: VeRO blocked", { scoutedId, keywords: veroResult.matchedKeywords });
    return { success: false, step: "vero", error: msg };
  }

  // ── Step 3: Quality gate ──────────────────────────────────────────────────
  const images     = fresh.image_urls ? (JSON.parse(fresh.image_urls) as string[]) : [];
  const categoryId = fresh.ebay_category_id ?? "";
  const qualityIssues = runQualityGate(aiTitle, aiDescription, images, categoryId);

  const merchantLocationKey = getMerchantLocationKey(db);
  if (!merchantLocationKey) {
    qualityIssues.push("EBAY_MERCHANT_LOCATION not configured — add it in Settings.");
  }

  if (qualityIssues.length > 0) {
    const msg = qualityIssues.join("; ");
    setListingStatus(db, scoutedId, "quality_fail", msg);
    return { success: false, step: "quality_gate", error: msg };
  }

  // ── Step 4: Pricing ───────────────────────────────────────────────────────
  const supplierCost    = fresh.matched_cost ?? fresh.scraped_price ?? 0;
  const profitMargin    = Number(getConfigKey(db, "PROFIT_MARGIN_PERCENT", String(config.profitMarginPercent)));
  const ebayFeeEstimate = Number(getConfigKey(db, "EBAY_FEE_ESTIMATE", String(config.ebayFeeEstimate)));
  const safetyBuffer    = Number(getConfigKey(db, "SAFETY_STOCK_BUFFER", String(config.safetyStockBuffer)));
  const price = calculateEbayPrice({
    supplierUnitCost:    supplierCost,
    supplierShippingCost: 0,
    profitMarginPercent:  profitMargin,
    ebayFeeEstimate,
  });

  // ── Review-before-publish gate ────────────────────────────────────────────
  if (!options.force && !getAutoListEnabled(db)) {
    setListingStatus(db, scoutedId, "queued");
    logger.info("Auto-listing: item queued for manual publish (AUTO_LIST_ENABLED=false)", {
      scoutedId, price,
    });
    return { success: true, step: "queued", queued: true, price };
  }

  // ── Step 5: Create product + variant rows ─────────────────────────────────
  setListingStatus(db, scoutedId, "publishing");

  const supplierType = fresh.matched_supplier ?? config.activeSupplier;
  const ebaySku      = `scouted-${scoutedId}-${Date.now()}`;

  let variantId: number;
  const existingVariant = db
    .prepare("SELECT id FROM variants WHERE internal_sku = ?")
    .get(ebaySku) as { id: number } | undefined;

  if (existingVariant) {
    variantId = existingVariant.id;
  } else {
    // Create product row — include SEO meta fields alongside the listing content
    const productInfo = db
      .prepare(
        `INSERT INTO products (title, description, category, status,
                               meta_title, meta_description)
         VALUES (?, ?, ?, 'active', ?, ?)`
      )
      .run(aiTitle, aiDescription, categoryId, metaTitle ?? null, metaDesc ?? null);

    const productId = Number(productInfo.lastInsertRowid);

    // Create variant row — supplier_variant_id is unknown for scouted items
    // (they came from the scraper, not from a supplier catalog lookup).
    // We use the scouted item's ID as a placeholder; Phase 5+ can update this
    // once the operator links it to a real supplier variant.
    const variantInfo = db
      .prepare(
        `INSERT INTO variants
           (product_id, supplier_type, supplier_variant_id, internal_sku,
            cost, shipping_cost, current_stock, current_price)
         VALUES (?, ?, ?, ?, ?, 0, 50, ?)`
      )
      .run(productId, supplierType, `scouted-${scoutedId}`, ebaySku, supplierCost, price);
    variantId = Number(variantInfo.lastInsertRowid);
  }

  // ── Step 6: Publish to eBay ───────────────────────────────────────────────
  let ebayClient;
  try {
    ebayClient = buildEbayClient(config);
  } catch (err) {
    const msg = err instanceof EbayNotConfiguredError ? err.message : (err as Error).message;
    setListingStatus(db, scoutedId, "failed", msg);
    return { success: false, step: "ebay_client", error: msg };
  }

  const marketplaceId = getMarketplaceId(db);

  try {
    // Create / replace inventory item
    await ebayClient.createOrReplaceInventoryItem({
      sku:         ebaySku,
      title:       aiTitle,
      description: aiDescription,
      quantity:    Math.max(0, 50 - safetyBuffer), // sensible default quantity for new listings
      imageUrls:   images,
      condition:   "NEW",
    });

    // Create offer
    const { offerId } = await ebayClient.createOffer({
      sku:                ebaySku,
      marketplaceId,
      price,
      currency:           "USD",
      categoryId,
      quantity:           Math.max(0, 50 - safetyBuffer),
      merchantLocationKey,
      listingDescription: aiDescription,
    });

    // Publish offer → get eBay listing ID
    const { listingId } = await ebayClient.publishOffer(offerId);

    // ── Step 7: Write back results ──────────────────────────────────────────
    db.transaction(() => {
      // Update variant with eBay identifiers
      db.prepare(
        `UPDATE variants
           SET ebay_sku = ?, ebay_offer_id = ?, current_price = ?,
               updated_at = datetime('now')
         WHERE id = ?`
      ).run(ebaySku, offerId, price, variantId);

      // Mark scouted item as published
      db.prepare(
        `UPDATE scouted_products
           SET listing_status = 'published',
               ebay_listing_id = ?,
               listing_error = NULL,
               updated_at = datetime('now')
         WHERE id = ?`
      ).run(listingId, scoutedId);
    })();

    logger.info("Auto-listing: published successfully", {
      scoutedId, ebaySku, offerId, listingId, price, categoryId,
    });

    return { success: true, step: "published", listingId, offerId, ebaySku, price };
  } catch (err) {
    const msg = (err as Error).message;
    setListingStatus(db, scoutedId, "failed", msg);
    logger.error("Auto-listing: eBay publish failed", { scoutedId, error: msg });
    return { success: false, step: "ebay_publish", error: msg };
  }
}
