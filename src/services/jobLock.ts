/**
 * DB-backed job lock (Reliability Phase, Task 1).
 *
 * Uses the `job_locks` SQLite table as a distributed mutex so that:
 *   - Two in-process schedulers (shouldn't happen, but defensive)
 *   - OR a process crash leaving a stale lock (happens on deploys)
 *   - OR a future multi-process setup
 * ...never cause the same job type to run concurrently.
 *
 * Acquire returns false immediately if the lock is held (non-blocking).
 * Locks older than `stale_after_s` seconds are considered abandoned
 * (crashed process) and may be forcibly re-acquired.
 *
 * Usage:
 *   const acquired = acquireLock(db, "price_stock");
 *   if (!acquired) { logger.warn("already running"); return; }
 *   try { ... job ... } finally { releaseLock(db, "price_stock"); }
 */
import Database from "better-sqlite3";
import { logger } from "../logger";

export type JobType = "price_stock" | "order_routing" | "fulfillment_tracking" | "scout_pull";

const STALE_AFTER_S = 600; // 10 minutes — if a job runs longer than this something is very wrong

/**
 * Attempts to acquire an exclusive lock for `jobType`.
 * Returns true on success, false if the lock is already held (non-stale).
 * Stale locks (older than STALE_AFTER_S) are forcibly released and re-acquired.
 */
export function acquireLock(db: Database.Database, jobType: JobType): boolean {
  // Use a transaction so the read + conditional write is atomic.
  const acquire = db.transaction((): boolean => {
    const existing = db
      .prepare("SELECT locked_at, stale_after_s FROM job_locks WHERE job_type = ?")
      .get(jobType) as { locked_at: string; stale_after_s: number } | undefined;

    if (existing) {
      const lockedMs   = new Date(existing.locked_at + "Z").getTime();
      const ageSeconds = (Date.now() - lockedMs) / 1000;

      if (ageSeconds < existing.stale_after_s) {
        // Lock is valid and held by another run
        return false;
      }

      // Stale lock — forcibly take it over
      logger.warn(`Job lock [${jobType}]: stale lock detected (age ${Math.round(ageSeconds)}s), force-acquiring.`);
    }

    db.prepare(
      `INSERT INTO job_locks (job_type, locked_at, stale_after_s)
       VALUES (?, datetime('now'), ?)
       ON CONFLICT(job_type) DO UPDATE SET
         locked_at     = datetime('now'),
         stale_after_s = excluded.stale_after_s`
    ).run(jobType, STALE_AFTER_S);

    return true;
  });

  const acquired = acquire();
  if (!acquired) {
    logger.warn(`Job lock [${jobType}]: lock held by another run, skipping this tick.`);
  }
  return acquired;
}

/**
 * Releases the lock. Always call this in a finally block.
 */
export function releaseLock(db: Database.Database, jobType: JobType): void {
  db.prepare("DELETE FROM job_locks WHERE job_type = ?").run(jobType);
}

/**
 * Releases ALL locks — call on startup to clean up any stale locks
 * left by a previous crashed process.
 */
export function releaseAllLocks(db: Database.Database): void {
  const count = db.prepare("DELETE FROM job_locks").run().changes;
  if (count > 0) {
    logger.info(`Job locks: cleared ${count} stale lock(s) from previous process.`);
  }
}
