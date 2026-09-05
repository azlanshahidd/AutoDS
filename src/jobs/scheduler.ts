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
    }
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
    try {
      // P2-002: live config read
      const summary = await runOrderRoutingOnce(db, withLiveAutoOrderEnabled(db, config));
      logger.info("Order routing run complete", summary as unknown as Record<string, unknown>);
    } catch (err) {
      logger.error("Order routing run threw unexpectedly — will retry next cycle", { error: (err as Error).message });
    } finally {
      orderRoutingRunning = false;
    }
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
    try {
      // P2-002: live config read
      const summary = await runFulfillmentOnce(db, withLiveAutoOrderEnabled(db, config));
      logger.info("Fulfillment run complete", summary as unknown as Record<string, unknown>);
    } catch (err) {
      logger.error("Fulfillment run threw unexpectedly — will retry next cycle", { error: (err as Error).message });
    } finally {
      fulfillmentRunning = false;
    }
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
    try {
      const summary = await pullFromScout(db, config);
      logger.info("Scheduled scout pull complete", summary as unknown as Record<string, unknown>);
    } catch (err) {
      // pullFromScout is designed to never throw, but this is a final
      // safety net so a truly unexpected error still can't crash the process.
      logger.error("Scout pull threw unexpectedly — will retry next cycle", { error: (err as Error).message });
    } finally {
      scoutPullRunning = false;
    }
  });
}

/** Stops all four recurring jobs — used in tests and graceful shutdown. */
export function stopAllSchedulers(): void {
  syncTask?.stop();
  syncTask = null;
  orderRoutingTask?.stop();
  orderRoutingTask = null;
  fulfillmentTask?.stop();
  fulfillmentTask = null;
  scoutPullTask?.stop();
  scoutPullTask = null;
}
