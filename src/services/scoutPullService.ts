/**
 * Scout pull service (Phase 8) — Reliability Edition.
 *
 * Reliability additions:
 *   Task 1 — DB job lock (acquires before pull, releases in finally).
 *   Task 8 — Batch insert already wrapped in a transaction (unchanged).
 */
import Database from "better-sqlite3";
import { CoreConfig } from "../config";
import { logger } from "../logger";
import { getFirstActiveScraper } from "../routes/scrapers";
import { acquireLock, releaseLock } from "./jobLock";

export interface ScoutCandidate {
  id: number;
  title: string;
  source_url: string | null;
  scraped_price: number | null;
  trend_signal: string | null;
  category: string | null;
  status: string;
  scraped_at: string;
}

export interface ScoutPullSummary {
  fetched:          number;
  stored:           number;
  skippedDuplicate: number;
  matched:          number;
  result:           "success" | "failure";
  errorMessage:     string | null;
}

interface MatchedVariant {
  cost:         number;
  shippingCost: number;
  supplierType: string;
}

function findLocalMatch(db: Database.Database, title: string): MatchedVariant | null {
  const row = db
    .prepare(
      `SELECT variants.cost, variants.shipping_cost, variants.supplier_type
       FROM products JOIN variants ON variants.product_id = products.id
       WHERE lower(products.title) LIKE '%' || lower(?) || '%'
          OR lower(?) LIKE '%' || lower(products.title) || '%'
       LIMIT 1`
    )
    .get(title, title) as { cost: number | null; shipping_cost: number | null; supplier_type: string } | undefined;

  if (!row || row.cost === null) return null;
  return { cost: row.cost, shippingCost: row.shipping_cost ?? 0, supplierType: row.supplier_type };
}

export async function pullFromScout(
  db: Database.Database,
  config: CoreConfig
): Promise<ScoutPullSummary> {
  const scraper = getFirstActiveScraper(db, config.encryptionKey);
  const scoutUrl = scraper?.baseUrl ?? config.scoutServiceUrl;
  const apiKey   = scraper?.apiKey  ?? "";

  const liveTimeoutMs =
    Number(
      (
        db
          .prepare("SELECT value FROM config WHERE key = 'SCOUT_PULL_TIMEOUT_MS'")
          .get() as { value: string } | undefined
      )?.value
    ) || config.scoutPullTimeoutMs;

  const summary: ScoutPullSummary = {
    fetched:          0,
    stored:           0,
    skippedDuplicate: 0,
    matched:          0,
    result:           "success",
    errorMessage:     null,
  };

  // Task 1: acquire DB job lock — skip if another pull is in progress
  if (!acquireLock(db, "scout_pull")) {
    logger.warn("Scout pull: could not acquire lock — skipping tick.");
    return summary;
  }

  try {
    let candidates: ScoutCandidate[];
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const res = await fetch(`${scoutUrl}/api/v1/scout-trends`, {
        headers,
        signal: AbortSignal.timeout(liveTimeoutMs),
      });
      if (!res.ok) throw new Error(`Scout Service returned HTTP ${res.status}`);

      candidates = await res.json();
      if (!Array.isArray(candidates)) {
        throw new Error("Scout Service response was not a JSON array.");
      }
    } catch (err) {
      const message =
        err instanceof Error && err.name === "TimeoutError"
          ? `Scout Service did not respond within ${liveTimeoutMs}ms (timeout).`
          : (err as Error).message;

      logger.warn("Scout pull failed — Core Service continuing normally", { error: message });
      summary.result       = "failure";
      summary.errorMessage = message;
      recordLog(db, "failure", message, summary);
      return summary;
    }

    summary.fetched = candidates.length;

    const insertScouted = db.prepare(
      `INSERT INTO scouted_products
         (title, source_url, scraped_price, matched_supplier, matched_cost,
          estimated_margin, trend_signal, status, scouted_at)
       VALUES
         (@title, @source_url, @scraped_price, @matched_supplier, @matched_cost,
          @estimated_margin, @trend_signal, 'pending_review', @scouted_at)`
    );

    const alreadyStored = db.prepare(
      `SELECT id FROM scouted_products WHERE source_url = ? AND status = 'pending_review'`
    );

    // Task 8: entire batch insert is in a single transaction (unchanged from original)
    const storeAll = db.transaction((items: ScoutCandidate[]) => {
      for (const item of items) {
        if (item.source_url && alreadyStored.get(item.source_url)) {
          summary.skippedDuplicate += 1;
          continue;
        }

        const match = findLocalMatch(db, item.title);
        const estimatedMargin =
          match && item.scraped_price !== null
            ? item.scraped_price - (match.cost + match.shippingCost)
            : null;

        if (match) summary.matched += 1;

        insertScouted.run({
          title:            item.title,
          source_url:       item.source_url,
          scraped_price:    item.scraped_price,
          matched_supplier: match?.supplierType ?? null,
          matched_cost:     match ? match.cost + match.shippingCost : null,
          estimated_margin: estimatedMargin,
          trend_signal:     item.trend_signal,
          scouted_at:       item.scraped_at,
        });
        summary.stored += 1;
      }
    });

    storeAll(candidates);

    logger.info("Scout pull complete", summary as unknown as Record<string, unknown>);
    recordLog(db, "success", null, summary);
    return summary;
  } finally {
    // Task 1: always release the lock
    releaseLock(db, "scout_pull");
  }
}

function recordLog(
  db: Database.Database,
  result: string,
  errorMessage: string | null,
  summary: ScoutPullSummary
) {
  db.prepare(
    `INSERT INTO sync_logs (type, result, error_message, details_json)
     VALUES ('scout_pull', ?, ?, ?)`
  ).run(result, errorMessage, JSON.stringify(summary));
}
