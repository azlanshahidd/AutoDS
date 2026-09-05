/**
 * Scheduler for the Product Sync Loop (Section 5: default 15-30 min, never
 * faster than 5 min — already enforced at config-load time in config.ts).
 *
 * Uses node-cron rather than BullMQ/Redis, per the tech stack decision:
 * this is a single-user system, so a Redis-backed multi-worker queue is
 * unneeded complexity — node-cron's in-process scheduling is sufficient.
 *
 * node-cron only understands standard cron syntax, so an arbitrary N-minute
 * interval is expressed as a "step" cron expression meaning "every minute
 * whose number is divisible by N". That's exact for the common divisors of
 * 60 the dashboard will offer (5, 15, 20, 30) and is what "every 15
 * minutes" means in practice for a cron-based scheduler.
 */
import cron, { ScheduledTask } from "node-cron";
import Database from "better-sqlite3";
import { CoreConfig } from "../config";
import { runSyncOnce } from "./syncLoop";
import { runOrderRoutingOnce } from "./orderRoutingLoop";
import { runFulfillmentOnce } from "./fulfillmentLoop";
import { pullFromScout } from "../services/scoutPullService";
import { withLiveAutoOrderEnabled } from "../services/runtimeConfigService";
import { logger } from "../logger";

let syncTask:         ScheduledTask | null = null;
let orderRoutingTask: ScheduledTask | null = null;
let fulfillmentTask:  ScheduledTask | null = null;
let scoutPullTask:    ScheduledTask | null = null;

// In-memory concurrency guards — fast path to skip a tick without a DB round-trip.
// The DB-backed job_locks table provides the cross-restart safety net.
let syncRunning         = false;
let orderRoutingRunning = false;
let fulfillmentRunning  = false;
let scoutPullRunning    = false;

// Task 4 — Graceful shutdown: track the currently-running job promise for each
// scheduler so stopAllSchedulers() can await them before the process exits.
// Without this, db.close() could fire mid-transaction when SIGTERM arrives.
let syncInFlight:         Promise<unknown> | null = null;
let orderRoutingInFlight: Promise<unknown> | null = null;
let fulfillmentInFlight:  Promise<unknown> | null = null;
let scoutPullInFlight:    Promise<unknown> | null = null;

function intervalToCronExpression(minutes: number): string {
  const clamped = Math.max(1, Math.min(59, Math.round(minutes)));
  return `*/${clamped} * * * *`;
}

/** Starts the recurring sync job. Call once at server startup. */
export function startSyncScheduler(db: Database.Database, config: CoreConfig): void {
  if (syncTask) {
    logger.warn("Sync scheduler already running — ignoring duplicate start.");
    return;
  }

  const expression = intervalToCronExpression(config.syncIntervalMinutes);
  logger.info("Starting product sync scheduler", { intervalMinutes: config.syncIntervalMinutes, cronExpression: expression });

  syncTask = cron.schedule(expression, async () => {
    if (syncRunning) {
      logger.warn("Sync run: previous run still in progress, skipping this tick.");
      return;
    }
    syncRunning = true;
    const run = (async () => {
      try {
        // P2-002: read AUTO_ORDER_ENABLED live from DB so dashboard toggle takes
        // effect on the next tick without a service restart.
        const summary = await runSyncOnce(db, withLiveAutoOrderEnabled(db, config));
        logger.info("Sync run complete", summary as unknown as Record<string, unknown>);
      } catch (err) {
        // runSyncOnce already catches per-variant errors; this only fires on
        // something catastrophic (e.g. DB connection lost) — log it and let
        // the next scheduled tick try again rather than crashing the process.
        logger.error("Sync run threw unexpectedly — will retry next cycle", { error: (err as Error).message });
      } finally {
        syncRunning = false;
        syncInFlight = null;
      }
    })();
    syncInFlight = run;
    await run;
  });
}

/**
 * Starts the recurring order-routing job (Phase 5), on the same interval as
 * the sync loop — polling eBay for orders doesn't need a separate cadence
 * from checking prices for v1.
 */
export function startOrderRoutingScheduler(db: Database.Database, config: CoreConfig): void {
  if (orderRoutingTask) {
    logger.warn("Order routing scheduler already running — ignoring duplicate start.");
    return;
  }

  const expression = intervalToCronExpression(config.syncIntervalMinutes);
  logger.info("Starting order routing scheduler", { intervalMinutes: config.syncIntervalMinutes, cronExpression: expression });

  orderRoutingTask = cron.schedule(expression, async () => {
    if (orderRoutingRunning) {
      logger.warn("Order routing run: previous run still in progress, skipping this tick.");
      return;
    }
    orderRoutingRunning = true;
    const run = (async () => {
      try {
        // P2-002: live config read
        const summary = await runOrderRoutingOnce(db, withLiveAutoOrderEnabled(db, config));
        logger.info("Order routing run complete", summary as unknown as Record<string, unknown>);
      } catch (err) {
        logger.error("Order routing run threw unexpectedly — will retry next cycle", { error: (err as Error).message });
      } finally {
        orderRoutingRunning = false;
        orderRoutingInFlight = null;
      }
    })();
    orderRoutingInFlight = run;
    await run;
  });
}

/**
 * Starts the recurring fulfillment/tracking job (Phase 6), on the same
 * interval as the other two loops.
 */
export function startFulfillmentScheduler(db: Database.Database, config: CoreConfig): void {
  if (fulfillmentTask) {
    logger.warn("Fulfillment scheduler already running — ignoring duplicate start.");
    return;
  }

  const expression = intervalToCronExpression(config.syncIntervalMinutes);
  logger.info("Starting fulfillment/tracking scheduler", { intervalMinutes: config.syncIntervalMinutes, cronExpression: expression });

  fulfillmentTask = cron.schedule(expression, async () => {
    if (fulfillmentRunning) {
      logger.warn("Fulfillment run: previous run still in progress, skipping this tick.");
      return;
    }
    fulfillmentRunning = true;
    const run = (async () => {
      try {
        // P2-002: live config read
        const summary = await runFulfillmentOnce(db, withLiveAutoOrderEnabled(db, config));
        logger.info("Fulfillment run complete", summary as unknown as Record<string, unknown>);
      } catch (err) {
        logger.error("Fulfillment run threw unexpectedly — will retry next cycle", { error: (err as Error).message });
      } finally {
        fulfillmentRunning = false;
        fulfillmentInFlight = null;
      }
    })();
    fulfillmentInFlight = run;
    await run;
  });
}

/**
 * Starts the recurring Scout pull job (Phase 8), on the same interval as
 * the other loops. A Scout Service that's down or slow never blocks this —
 * pullFromScout() catches its own errors and always resolves cleanly.
 */
export function startScoutPullScheduler(db: Database.Database, config: CoreConfig): void {
  if (scoutPullTask) {
    logger.warn("Scout pull scheduler already running — ignoring duplicate start.");
    return;
  }

  const expression = intervalToCronExpression(config.syncIntervalMinutes);
  logger.info("Starting scout pull scheduler", { intervalMinutes: config.syncIntervalMinutes, cronExpression: expression });

  scoutPullTask = cron.schedule(expression, async () => {
    if (scoutPullRunning) {
      logger.warn("Scout pull run: previous run still in progress, skipping this tick.");
      return;
    }
    scoutPullRunning = true;
    const run = (async () => {
      try {
        const summary = await pullFromScout(db, config);
        logger.info("Scheduled scout pull complete", summary as unknown as Record<string, unknown>);
      } catch (err) {
        // pullFromScout is designed to never throw, but this is a final
        // safety net so a truly unexpected error still can't crash the process.
        logger.error("Scout pull threw unexpectedly — will retry next cycle", { error: (err as Error).message });
      } finally {
        scoutPullRunning = false;
        scoutPullInFlight = null;
      }
    })();
    scoutPullInFlight = run;
    await run;
  });
}

/**
 * Stops all four recurring jobs and returns a Promise that resolves once
 * any currently in-flight job run completes.
 *
 * Task 4 — Graceful shutdown: the caller (index.ts gracefulShutdown) must
 * await this before closing the DB. Without the await, db.close() could
 * fire while a job is mid-transaction, causing SQLITE_MISUSE errors or
 * leaving the WAL file in an inconsistent state.
 */
export async function stopAllSchedulers(): Promise<void> {
  // Stop future ticks immediately
  syncTask?.stop();
  syncTask = null;
  orderRoutingTask?.stop();
  orderRoutingTask = null;
  fulfillmentTask?.stop();
  fulfillmentTask = null;
  scoutPullTask?.stop();
  scoutPullTask = null;

  // Await any job that fired before stop() was called.
  // Promise.allSettled so one job hanging doesn't block the others.
  const inflight = [syncInFlight, orderRoutingInFlight, fulfillmentInFlight, scoutPullInFlight]
    .filter((p): p is Promise<unknown> => p !== null);

  if (inflight.length > 0) {
    logger.info(`Graceful shutdown: waiting for ${inflight.length} in-flight job(s) to complete...`);
    await Promise.allSettled(inflight);
    logger.info("Graceful shutdown: all in-flight jobs finished.");
  }
}
