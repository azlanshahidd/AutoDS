/**
 * Emergency Stop routes.
 *
 * POST /api/emergency-stop
 *   - Immediately stops all four cron schedulers (sync, order routing,
 *     fulfillment, scout pull).
 *   - Sets AUTO_ORDER_ENABLED=false in the config table.
 *   - Sets EMERGENCY_STOP=true in the config table (persists across restarts).
 *   - Returns the new state so the frontend can update immediately.
 *
 * POST /api/emergency-stop/resume
 *   - Clears EMERGENCY_STOP (sets to false).
 *   - Does NOT automatically restart the schedulers — the service must be
 *     restarted to resume automation. This is intentional: a restart gives
 *     you a chance to inspect logs and confirm the issue is resolved before
 *     anything runs again.
 *   - Does NOT re-enable AUTO_ORDER_ENABLED — that requires an explicit
 *     decision from the operator.
 *
 * GET /api/emergency-stop
 *   - Returns the current EMERGENCY_STOP state and scheduler status.
 *   - Used by the frontend banner to decide whether to show the red alert.
 *
 * WHY NO AUTO-RESTART:
 *   The scheduler can't be restarted from inside the same process without
 *   re-calling the startXxxScheduler() functions. Exposing a resume-and-
 *   restart endpoint would require passing the scheduler-start functions
 *   here, which creates a dependency cycle. The safe pattern is:
 *     Emergency Stop → investigate → fix → redeploy/restart.
 *   The resume endpoint only clears the flag so the banner goes away after
 *   a fresh deploy confirms everything is OK.
 */
import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import { stopAllSchedulers } from "../jobs/scheduler";
import { logger } from "../logger";

function setConfig(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value);
}

function getConfig(db: Database.Database, key: string, fallback = ""): string {
  return (
    (db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
      | { value: string } | undefined)?.value ?? fallback
  );
}

export function emergencyStopRouter(db: Database.Database): Router {
  const router = Router();

  // GET /api/emergency-stop — current state
  router.get("/", (_req: Request, res: Response) => {
    const stopped  = getConfig(db, "EMERGENCY_STOP", "false").toLowerCase() === "true";
    const autoOrder = getConfig(db, "AUTO_ORDER_ENABLED", "false").toLowerCase() === "true";
    const stoppedAt = getConfig(db, "EMERGENCY_STOP_AT", "");
    const reason    = getConfig(db, "EMERGENCY_STOP_REASON", "");

    res.json({
      emergencyStopped: stopped,
      autoOrderEnabled:  autoOrder,
      stoppedAt:         stoppedAt || null,
      reason:            reason    || null,
      resumeNote:        stopped
        ? "Restart the service after resolving the issue to resume automation."
        : null,
    });
  });

  // POST /api/emergency-stop — halt everything
  router.post("/", async (req: Request, res: Response) => {
    const { reason } = req.body || {};

    logger.warn("EMERGENCY STOP triggered via dashboard", {
      reason: reason || "(no reason given)",
    });

    // 1. Stop all cron schedulers — waits for in-flight jobs to complete
    try {
      await stopAllSchedulers();
      logger.warn("Emergency stop: all schedulers stopped.");
    } catch (err) {
      logger.error("Emergency stop: error stopping schedulers", {
        error: (err as Error).message,
      });
    }

    // 2. Persist the stopped state so it survives restarts
    const now = new Date().toISOString();
    setConfig(db, "EMERGENCY_STOP",        "true");
    setConfig(db, "EMERGENCY_STOP_AT",     now);
    setConfig(db, "EMERGENCY_STOP_REASON", reason ? String(reason).slice(0, 500) : "");
    setConfig(db, "AUTO_ORDER_ENABLED",    "false");

    logger.warn("Emergency stop: config persisted.", {
      stoppedAt: now,
      reason: reason || "",
    });

    res.json({
      emergencyStopped: true,
      autoOrderEnabled:  false,
      stoppedAt:         now,
      reason:            reason || null,
      message:           "All schedulers stopped. Restart the service to resume automation.",
    });
  });

  // POST /api/emergency-stop/resume — clear the flag (does not restart schedulers)
  router.post("/resume", (req: Request, res: Response) => {
    const { reason } = req.body || {};

    logger.info("Emergency stop cleared via dashboard", {
      reason: reason || "(no reason given)",
    });

    setConfig(db, "EMERGENCY_STOP",        "false");
    setConfig(db, "EMERGENCY_STOP_AT",     "");
    setConfig(db, "EMERGENCY_STOP_REASON", "");

    logger.info("Emergency stop: flag cleared. Service restart required to resume schedulers.");

    res.json({
      emergencyStopped:  false,
      autoOrderEnabled:  getConfig(db, "AUTO_ORDER_ENABLED", "false") === "true",
      message:           "Emergency stop cleared. Restart the service to resume automation.",
    });
  });

  return router;
}
