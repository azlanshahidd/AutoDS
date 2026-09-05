/**
 * Quarantine / dead-letter mechanism (Reliability Phase, Task 5).
 *
 * After QUARANTINE_THRESHOLD consecutive failures on the same variant,
 * that variant is flagged as quarantined=1 and skipped by the sync loop
 * until a human reviews it and clears it. This prevents one bad variant
 * (deleted from supplier catalog, invalid SKU, etc.) from polluting the
 * logs with hundreds of identical failures every sync cycle.
 *
 * State is stored in the `variant_failures` table, persisted across restarts.
 */
import Database from "better-sqlite3";
import { logger } from "../logger";

const QUARANTINE_THRESHOLD = 5; // consecutive failures before quarantine

interface FailureRow {
  variant_id:        number;
  consecutive_fails: number;
  last_error:        string | null;
  quarantined:       0 | 1;
  quarantined_at:    string | null;
}

/** Returns true if this variant is currently quarantined (skip it). */
export function isQuarantined(db: Database.Database, variantId: number): boolean {
  const row = db
    .prepare("SELECT quarantined FROM variant_failures WHERE variant_id = ?")
    .get(variantId) as Pick<FailureRow, "quarantined"> | undefined;
  return row?.quarantined === 1;
}

/** Call this when a sync/fulfillment step SUCCEEDS for a variant. */
export function recordVariantSuccess(db: Database.Database, variantId: number): void {
  db.prepare(
    `INSERT INTO variant_failures (variant_id, consecutive_fails, quarantined)
     VALUES (?, 0, 0)
     ON CONFLICT(variant_id) DO UPDATE SET
       consecutive_fails = 0,
       quarantined       = 0,
       quarantined_at    = NULL,
       updated_at        = datetime('now')`
  ).run(variantId);
}

/**
 * Call this when a sync/fulfillment step FAILS for a variant.
 * Returns true if the variant just crossed the quarantine threshold.
 */
export function recordVariantFailure(
  db: Database.Database,
  variantId: number,
  error: string
): boolean {
  const existing = db
    .prepare("SELECT consecutive_fails, quarantined FROM variant_failures WHERE variant_id = ?")
    .get(variantId) as Pick<FailureRow, "consecutive_fails" | "quarantined"> | undefined;

  const prevFails    = existing?.consecutive_fails ?? 0;
  const newFails     = prevFails + 1;
  const nowQuarantine = newFails >= QUARANTINE_THRESHOLD;

  db.prepare(
    `INSERT INTO variant_failures (variant_id, consecutive_fails, last_error, quarantined, quarantined_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(variant_id) DO UPDATE SET
       consecutive_fails = excluded.consecutive_fails,
       last_error        = excluded.last_error,
       quarantined       = excluded.quarantined,
       quarantined_at    = COALESCE(quarantined_at, excluded.quarantined_at),
       updated_at        = datetime('now')`
  ).run(
    variantId,
    newFails,
    error.slice(0, 500), // cap stored error length
    nowQuarantine ? 1 : 0,
    nowQuarantine ? new Date().toISOString() : null
  );

  if (nowQuarantine && !(existing?.quarantined)) {
    logger.warn(
      `Variant ${variantId} quarantined after ${newFails} consecutive failures — ` +
        `skipping in future sync runs until manually cleared. Last error: ${error.slice(0, 200)}`
    );
  }

  return nowQuarantine;
}

/**
 * Returns all currently quarantined variants.
 * Used by the dashboard overview / health endpoint.
 */
export function getQuarantinedVariants(db: Database.Database): Array<{
  variantId: number;
  sku: string;
  consecutiveFails: number;
  lastError: string | null;
  quarantinedAt: string | null;
}> {
  return (
    db
      .prepare(
        `SELECT vf.variant_id, v.internal_sku, vf.consecutive_fails, vf.last_error, vf.quarantined_at
         FROM variant_failures vf
         JOIN variants v ON v.id = vf.variant_id
         WHERE vf.quarantined = 1
         ORDER BY vf.quarantined_at DESC`
      )
      .all() as Array<{
        variant_id:        number;
        internal_sku:      string;
        consecutive_fails: number;
        last_error:        string | null;
        quarantined_at:    string | null;
      }>
  ).map((r) => ({
    variantId:        r.variant_id,
    sku:              r.internal_sku,
    consecutiveFails: r.consecutive_fails,
    lastError:        r.last_error,
    quarantinedAt:    r.quarantined_at,
  }));
}

/**
 * Manually clears a variant from quarantine.
 * Called from the dashboard "Clear quarantine" action.
 */
export function clearQuarantine(db: Database.Database, variantId: number): void {
  db.prepare(
    `UPDATE variant_failures
     SET quarantined = 0, consecutive_fails = 0, quarantined_at = NULL, updated_at = datetime('now')
     WHERE variant_id = ?`
  ).run(variantId);
  logger.info(`Variant ${variantId} cleared from quarantine.`);
}
