/**
 * Scouted products routes.
 *
 * POST /api/scouted  — push from an external scraper, authenticated by Bearer key.
 * All other routes require a dashboard session token (handled by apiRouter in index.ts).
 *
 * Fixes applied:
 *  P2-001 — parseIntId guard on every :id route (NaN/float rejection)
 *  P2-003 — title validated as non-empty string on push
 *  P2-004 — approve/discard wrapped in try/catch
 *  P2-009 — optimistic lock on approve/discard via updated_at
 *  P2-013 — server-side {confirm:true} guard on bulk DELETE
 *  P2-016 — generate-ai distinguishes "no provider" vs "provider failed"
 *  P2-024 — POST /pull returns 502 on Scout failure instead of 200
 */
import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import { CoreConfig } from "../config";
import { pullFromScout } from "../services/scoutPullService";
import { generateListingContent, checkVeroOnMetaFields } from "./aiService";
import { findScraperByKey } from "./scrapers";
import {
  runListingPipeline,
  previewListing,
  getAutoListEnabled,
} from "../services/autoListingService";
import { logger } from "../logger";

// ── Shared helper ─────────────────────────────────────────────────────────────

/** Parse a route :id param. Returns null when the value is not a positive integer. */
function parseIntId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── Push router — Bearer-key auth ─────────────────────────────────────────────

export function scoutedPushRouter(db: Database.Database): Router {
  const router = Router();

  router.post("/", (req: Request, res: Response) => {
    const authHeader = req.headers["authorization"] ?? "";
    const rawKey = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (!rawKey) {
      return res.status(401).json({
        error: "Missing API key. Send:  Authorization: Bearer <connection_key>",
      });
    }

    const scraper = findScraperByKey(db, rawKey);
    if (!scraper) {
      return res.status(401).json({ error: "Invalid or revoked connection key." });
    }

    db.prepare(
      "UPDATE scrapers SET last_tested_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(scraper.id);

    const { title, sourceUrl, scrapedPrice, trendSignal } = req.body || {};

    // P2-003: title must be a non-empty string
    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title must be a non-empty string." });
    }

    // P1-013: only accept http/https source URLs
    if (sourceUrl !== undefined && sourceUrl !== null) {
      if (typeof sourceUrl !== "string" || !/^https?:\/\//i.test(sourceUrl)) {
        return res.status(400).json({ error: "sourceUrl must be a http or https URL." });
      }
    }

    try {
      const match = db
        .prepare(
          `SELECT variants.cost, variants.shipping_cost, variants.supplier_type
           FROM products JOIN variants ON variants.product_id = products.id
           WHERE lower(products.title) LIKE '%' || lower(?) || '%'
              OR lower(?) LIKE '%' || lower(products.title) || '%'
           LIMIT 1`
        )
        .get(title.trim(), title.trim()) as
        | { cost: number | null; shipping_cost: number | null; supplier_type: string }
        | undefined;

      const matchedCost =
        match?.cost != null ? match.cost + (match.shipping_cost ?? 0) : null;
      const estimatedMargin =
        matchedCost !== null && typeof scrapedPrice === "number"
          ? scrapedPrice - matchedCost
          : null;

      const info = db
        .prepare(
          `INSERT INTO scouted_products
             (title, source_url, scraped_price, matched_supplier, matched_cost,
              estimated_margin, trend_signal, status, scouted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_review', datetime('now'))`
        )
        .run(
          title.trim(),
          sourceUrl    ?? null,
          scrapedPrice ?? null,
          match?.supplier_type ?? null,
          matchedCost,
          estimatedMargin,
          trendSignal  ?? null
        );

      logger.info("Item pushed by scraper", {
        id: info.lastInsertRowid,
        scraper: scraper.name,
      });
      res.status(201).json({ id: Number(info.lastInsertRowid), status: "pending_review" });
    } catch (err) {
      logger.error("Failed to store pushed item", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to store item." });
    }
  });

  return router;
}

// ── Dashboard router — session auth via apiRouter in index.ts ─────────────────

export function scoutedRouter(db: Database.Database, config: CoreConfig): Router {
  const router = Router();

  // GET /api/scouted
  router.get("/", (_req: Request, res: Response) => {
    try {
      const rows = db
        .prepare(
          `SELECT id, title, source_url, scraped_price, matched_supplier, matched_cost,
                  estimated_margin, trend_signal, status, listing_status, ebay_listing_id,
                  ebay_category_id, image_urls, listing_error, scouted_at, created_at,
                  ai_title, ai_description,
                  meta_title, meta_description, meta_generated_at, meta_generation_source
           FROM scouted_products ORDER BY created_at DESC`
        )
        .all();
      res.json({ scoutedProducts: rows });
    } catch (err) {
      logger.error("Failed to load scouted products", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to load scouted products." });
    }
  });

  // POST /api/scouted/pull — P2-024: return 502 when Scout is unreachable
  router.post("/pull", async (_req: Request, res: Response) => {
    const summary = await pullFromScout(db, config);
    if (summary.result === "failure") {
      return res.status(502).json(summary);
    }
    res.json(summary);
  });

  // POST /api/scouted/:id/generate-ai — P2-016: distinguish error cases
  router.post("/:id/generate-ai", async (req: Request, res: Response) => {
    // P2-001
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    try {
      const product = db
        .prepare(
          `SELECT id, title, scraped_price, trend_signal
           FROM scouted_products WHERE id = ?`
        )
        .get(id) as
        | { id: number; title: string; scraped_price: number | null; trend_signal: string | null }
        | undefined;

      if (!product) {
        return res.status(404).json({ error: "Scouted item not found." });
      }

      const result = await generateListingContent(db, {
        title:        product.title,
        scrapedPrice: product.scraped_price,
        trendSignal:  product.trend_signal,
      });

      if (!result) {
        // P2-016: distinguish "no provider" from "provider call failed"
        const hasProvider = db
          .prepare("SELECT id FROM ai_providers WHERE enabled = 1 LIMIT 1")
          .get();
        return res.status(400).json({
          error: hasProvider
            ? "AI generation failed. Check the provider connection in AI Providers."
            : "No AI provider is configured or enabled. Add one in AI Providers.",
        });
      }

      // VeRO check on meta fields — same policy risk as the listing title
      const veroBlocklistPath = (
        db.prepare("SELECT value FROM config WHERE key = 'VERO_BLOCKLIST_PATH'").get() as
          | { value: string } | undefined
      )?.value ?? config.veroBlocklistPath;

      const metaVero = checkVeroOnMetaFields(
        result.metaTitle,
        result.metaDescription,
        veroBlocklistPath
      );
      if (metaVero.isBlocked) {
        logger.warn("SEO meta fields blocked by VeRO", {
          id,
          keywords: metaVero.matchedKeywords,
        });
        // Don't persist the blocked content — return the error so the UI can show it
        return res.status(422).json({
          error: `SEO meta fields blocked by VeRO: matched [${metaVero.matchedKeywords.join(", ")}]. Regenerate or edit manually.`,
          veroBlocked: true,
          matchedKeywords: metaVero.matchedKeywords,
        });
      }

      db.prepare(
        `UPDATE scouted_products
           SET ai_title            = ?,
               ai_description      = ?,
               meta_title          = ?,
               meta_description    = ?,
               meta_generated_at   = datetime('now'),
               meta_generation_source = ?,
               updated_at          = datetime('now')
         WHERE id = ?`
      ).run(
        result.aiTitle,
        result.aiDescription,
        result.metaTitle,
        result.metaDescription,
        result.generationSource,
        id
      );

      logger.info("AI listing + SEO content generated", { id, source: result.generationSource });
      res.json({
        id,
        aiTitle:          result.aiTitle,
        aiDescription:    result.aiDescription,
        metaTitle:        result.metaTitle,
        metaDescription:  result.metaDescription,
        metaGeneratedAt:  new Date().toISOString(),
        metaGenerationSource: result.generationSource,
      });
    } catch (err) {
      logger.error("Failed to generate AI listing", { error: (err as Error).message, id });
      res.status(500).json({ error: "Failed to generate AI listing content." });
    }
  });

  // PATCH /api/scouted/:id/seo — manual save of operator-edited SEO fields
  router.patch("/:id/seo", (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    const { metaTitle, metaDescription } = req.body || {};

    if (metaTitle !== undefined) {
      if (typeof metaTitle !== "string") {
        return res.status(400).json({ error: "metaTitle must be a string." });
      }
      if (metaTitle.trim().length > 60) {
        return res.status(400).json({ error: "metaTitle must be 60 characters or fewer." });
      }
    }
    if (metaDescription !== undefined) {
      if (typeof metaDescription !== "string") {
        return res.status(400).json({ error: "metaDescription must be a string." });
      }
      if (metaDescription.trim().length > 160) {
        return res.status(400).json({ error: "metaDescription must be 160 characters or fewer." });
      }
    }

    try {
      const exists = db.prepare("SELECT id FROM scouted_products WHERE id = ?").get(id);
      if (!exists) return res.status(404).json({ error: "Not found." });

      // Build dynamic SET clause for only the supplied fields
      const updates: string[] = ["updated_at = datetime('now')"];
      const params: unknown[] = [];
      if (metaTitle !== undefined)       { updates.push("meta_title = ?");       params.push(metaTitle.trim()); }
      if (metaDescription !== undefined) { updates.push("meta_description = ?"); params.push(metaDescription.trim()); }

      if (params.length === 0) {
        return res.status(400).json({ error: "Provide at least one of metaTitle or metaDescription." });
      }

      params.push(id);
      db.prepare(`UPDATE scouted_products SET ${updates.join(", ")} WHERE id = ?`).run(...params);

      logger.info("SEO fields manually updated", { id });
      res.json({ id, metaTitle: metaTitle?.trim(), metaDescription: metaDescription?.trim() });
    } catch (err) {
      logger.error("Failed to update SEO fields", { error: (err as Error).message, id });
      res.status(500).json({ error: "Failed to update SEO fields." });
    }
  });

  // POST /api/scouted/:id/approve — P2-001, P2-004, P2-009 (optimistic lock)
  router.post("/:id/approve", (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    // P2-009: optional optimistic lock — if caller supplies updatedAt, enforce it
    const { updatedAt } = req.body || {};

    try {
      let result;
      if (updatedAt && typeof updatedAt === "string") {
        result = db
          .prepare(
            "UPDATE scouted_products SET status = 'approved', updated_at = datetime('now') WHERE id = ? AND updated_at = ?"
          )
          .run(id, updatedAt);
        if (result.changes === 0) {
          // Check if the row exists at all
          const exists = db.prepare("SELECT id FROM scouted_products WHERE id = ?").get(id);
          if (!exists) return res.status(404).json({ error: "Not found." });
          return res.status(409).json({ error: "Item was modified by another request. Refresh and try again." });
        }
      } else {
        result = db
          .prepare("UPDATE scouted_products SET status = 'approved', updated_at = datetime('now') WHERE id = ?")
          .run(id);
        if (result.changes === 0) return res.status(404).json({ error: "Not found." });
      }

      const row = db.prepare("SELECT status, updated_at FROM scouted_products WHERE id = ?").get(id) as
        | { status: string; updated_at: string } | undefined;

      // Wire approve → listing pipeline when AUTO_LIST_ENABLED=true.
      // We do this after committing the status change so the item is marked
      // 'approved' even if the pipeline fails (it will show listing_error).
      if (getAutoListEnabled(db)) {
        // Fire-and-forget: don't block the HTTP response on the eBay call.
        // The frontend polls every 8s and will pick up listing_status changes.
        setImmediate(() => {
          runListingPipeline(db, config, id, { force: false }).catch((err: unknown) => {
            logger.error("Auto-listing pipeline error after approve", {
              id,
              error: (err as Error).message,
            });
          });
        });
      }

      res.json({ id, status: "approved", updatedAt: row?.updated_at, autoListTriggered: getAutoListEnabled(db) });
    } catch (err) {
      logger.error("Failed to approve scouted item", { error: (err as Error).message, id });
      res.status(500).json({ error: "Failed to approve item." });
    }
  });

  // POST /api/scouted/:id/discard — P2-001, P2-004, P2-009
  router.post("/:id/discard", (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    const { updatedAt } = req.body || {};

    try {
      let result;
      if (updatedAt && typeof updatedAt === "string") {
        result = db
          .prepare(
            "UPDATE scouted_products SET status = 'discarded', updated_at = datetime('now') WHERE id = ? AND updated_at = ?"
          )
          .run(id, updatedAt);
        if (result.changes === 0) {
          const exists = db.prepare("SELECT id FROM scouted_products WHERE id = ?").get(id);
          if (!exists) return res.status(404).json({ error: "Not found." });
          return res.status(409).json({ error: "Item was modified by another request. Refresh and try again." });
        }
      } else {
        result = db
          .prepare("UPDATE scouted_products SET status = 'discarded', updated_at = datetime('now') WHERE id = ?")
          .run(id);
        if (result.changes === 0) return res.status(404).json({ error: "Not found." });
      }

      const row = db.prepare("SELECT status, updated_at FROM scouted_products WHERE id = ?").get(id) as
        | { status: string; updated_at: string } | undefined;
      res.json({ id, status: "discarded", updatedAt: row?.updated_at });
    } catch (err) {
      logger.error("Failed to discard scouted item", { error: (err as Error).message, id });
      res.status(500).json({ error: "Failed to discard item." });
    }
  });

  // DELETE /api/scouted/:id — P2-001
  router.delete("/:id", (req: Request, res: Response) => {    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    try {
      const result = db.prepare("DELETE FROM scouted_products WHERE id = ?").run(id);
      if (result.changes === 0) return res.status(404).json({ error: "Not found." });
      logger.info("Scouted item deleted", { id });
      res.status(204).send();
    } catch (err) {
      logger.error("Failed to delete scouted item", { error: (err as Error).message, id });
      res.status(500).json({ error: "Failed to delete item." });
    }
  });

  // GET /api/scouted/:id/preview — returns what would be sent to eBay (no side effects)
  router.get("/:id/preview", async (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    try {
      const preview = await previewListing(db, config, id);
      if (!preview) return res.status(404).json({ error: "Scouted item not found." });
      res.json(preview);
    } catch (err) {
      logger.error("Failed to build listing preview", { error: (err as Error).message, id });
      res.status(500).json({ error: "Failed to build listing preview." });
    }
  });

  // POST /api/scouted/:id/publish — runs the pipeline with force:true (bypasses review queue)
  // Body (all optional): { categoryId?: string; imageUrls?: string[] }
  router.post("/:id/publish", async (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    const { categoryId, imageUrls } = req.body || {};

    if (categoryId !== undefined && (typeof categoryId !== "string" || !categoryId.trim())) {
      return res.status(400).json({ error: "categoryId must be a non-empty string." });
    }
    if (imageUrls !== undefined && !Array.isArray(imageUrls)) {
      return res.status(400).json({ error: "imageUrls must be an array of strings." });
    }

    try {
      const result = await runListingPipeline(db, config, id, {
        force:      true,
        categoryId: categoryId?.trim(),
        imageUrls:  imageUrls as string[] | undefined,
      });

      if (!result.success) {
        // Map pipeline step to a meaningful HTTP status
        const status =
          result.step === "load"            ? 404 :
          result.step === "guard"           ? 409 :
          result.step === "vero"            ? 422 :
          result.step === "vero_meta"       ? 422 :
          result.step === "quality_gate"    ? 422 :
          result.step === "ebay_not_configured" ? 503 :
                                              500;
        return res.status(status).json({ error: result.error, step: result.step });
      }

      logger.info("Listing published via dashboard", { id, listingId: result.listingId });
      res.json(result);
    } catch (err) {
      logger.error("Publish pipeline threw unexpectedly", { error: (err as Error).message, id });
      res.status(500).json({ error: "Publish pipeline failed." });
    }
  });

  // PATCH /api/scouted/:id/category — sets or updates the eBay category ID
  router.patch("/:id/category", (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    const { categoryId } = req.body || {};
    if (!categoryId || typeof categoryId !== "string" || !categoryId.trim()) {
      return res.status(400).json({ error: "categoryId must be a non-empty string." });
    }

    try {
      const result = db
        .prepare(
          "UPDATE scouted_products SET ebay_category_id = ?, updated_at = datetime('now') WHERE id = ?"
        )
        .run(categoryId.trim(), id);
      if (result.changes === 0) return res.status(404).json({ error: "Not found." });
      logger.info("eBay category set", { id, categoryId: categoryId.trim() });
      res.json({ id, ebay_category_id: categoryId.trim() });
    } catch (err) {
      logger.error("Failed to set category", { error: (err as Error).message, id });
      res.status(500).json({ error: "Failed to set category." });
    }
  });

  // PATCH /api/scouted/:id/images — sets the image URL array for a scouted item
  // Body: { imageUrls: string[] }  — replaces the existing list entirely
  router.patch("/:id/images", (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    const { imageUrls } = req.body || {};
    if (!Array.isArray(imageUrls)) {
      return res.status(400).json({ error: "imageUrls must be an array of strings." });
    }
    const invalid = (imageUrls as unknown[]).filter(
      (u) => typeof u !== "string" || !/^https?:\/\//i.test(u)
    );
    if (invalid.length > 0) {
      return res.status(400).json({
        error: `All imageUrls must be http/https URLs. Invalid: ${(invalid as string[]).slice(0, 3).join(", ")}`,
      });
    }
    if (imageUrls.length > 24) {
      return res.status(400).json({ error: "eBay allows a maximum of 24 images per listing." });
    }

    try {
      const result = db
        .prepare(
          "UPDATE scouted_products SET image_urls = ?, updated_at = datetime('now') WHERE id = ?"
        )
        .run(JSON.stringify(imageUrls), id);
      if (result.changes === 0) return res.status(404).json({ error: "Not found." });
      logger.info("Image URLs updated", { id, count: imageUrls.length });
      res.json({ id, image_urls: imageUrls });
    } catch (err) {
      logger.error("Failed to update image URLs", { error: (err as Error).message, id });
      res.status(500).json({ error: "Failed to update image URLs." });
    }
  });

  // DELETE /api/scouted — bulk — P2-015: require {confirm: true}
  router.delete("/", (req: Request, res: Response) => {    const { confirm } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({
        error: 'Pass {"confirm": true} in the request body to confirm bulk deletion.',
      });
    }

    try {
      const result = db.prepare("DELETE FROM scouted_products").run();
      logger.info("All scouted items cleared", { deleted: result.changes });
      res.json({ deleted: result.changes });
    } catch (err) {
      logger.error("Failed to clear scouted items", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to clear items." });
    }
  });

  return router;
}
