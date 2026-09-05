/**
 * Alert service (Phase 9). Tracks consecutive failures per job type
 * (price_stock / order_routing / fulfillment_tracking) and fires a webhook
 * once a streak reaches the configured threshold — so failures never go
 * silently unnoticed. Fires once per streak (not on every failure after the
 * threshold), and clears automatically once the job succeeds again.
 *
 * State is stored in the `config` key/value table, under
 * `ALERT_CONSEC_<type>` (current streak length) and `ALERT_FIRED_<type>`
 * ("true" once an alert has been sent for the current streak).
 */
import Database from "better-sqlite3";
import { CoreConfig } from "../config";
import { logger } from "../logger";

type JobType = "price_stock" | "order_routing" | "fulfillment_tracking";

const JOB_LABELS: Record<JobType, string> = {
  price_stock: "Product sync",
  order_routing: "Order routing",
  fulfillment_tracking: "Fulfillment & tracking",
};

function getConfigValue(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setConfigValue(db: Database.Database, key: string, value: string) {
  db.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value);
}

async function sendAlert(config: CoreConfig, message: string): Promise<void> {
  const attempts: Promise<void>[] = [];

  if (config.alertWebhookUrl) {
    attempts.push(
      fetch(config.alertWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message }),
        signal: AbortSignal.timeout(5000),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}`);
        })
        .catch((err) => {
          // Alerting must never crash a job loop — log and move on.
          logger.error("Failed to send alert via webhook", { error: (err as Error).message });
        })
    );
  }

  if (config.alertTelegramBotToken && config.alertTelegramChatId) {
    const url = `https://api.telegram.org/bot${config.alertTelegramBotToken}/sendMessage`;
    attempts.push(
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.alertTelegramChatId, text: message }),
        signal: AbortSignal.timeout(5000),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`Telegram API returned HTTP ${res.status}`);
        })
        .catch((err) => {
          logger.error("Failed to send alert via Telegram", { error: (err as Error).message });
        })
    );
  }

  if (attempts.length === 0) return;
  await Promise.all(attempts);
}

/**
 * Call this once per job run, right after logging to sync_logs, with the
 * run's overall result. Handles the consecutive-failure counting and fires
 * an alert (at most once per streak) when the threshold is crossed.
 */
export async function recordJobOutcome(
  db: Database.Database,
  config: CoreConfig,
  jobType: JobType,
  result: "success" | "partial_failure" | "failure"
): Promise<void> {
  const consecKey = `ALERT_CONSEC_${jobType}`;
  const firedKey = `ALERT_FIRED_${jobType}`;

  if (result === "success") {
    setConfigValue(db, consecKey, "0");
    setConfigValue(db, firedKey, "false");
    return;
  }

  const currentCount = Number(getConfigValue(db, consecKey) ?? "0") + 1;
  setConfigValue(db, consecKey, String(currentCount));

  const alreadyFired = getConfigValue(db, firedKey) === "true";

  if (currentCount >= config.alertFailureThreshold && !alreadyFired) {
    const message =
      `⚠️ ${JOB_LABELS[jobType]} has failed ${currentCount} times in a row on your Core Service. ` +
      `Check the Logs page or sync_logs table for details.`;

    logger.warn("Alert threshold reached, sending alert", { jobType, currentCount });
    await sendAlert(config, message);
    setConfigValue(db, firedKey, "true");
  }
}

/** Returns job types currently in an active (already-fired) alert state — for the dashboard. */
export function getActiveAlerts(db: Database.Database): string[] {
  const jobTypes: JobType[] = ["price_stock", "order_routing", "fulfillment_tracking"];
  return jobTypes.filter((type) => getConfigValue(db, `ALERT_FIRED_${type}`) === "true");
}
