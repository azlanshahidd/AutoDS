/**
 * Circuit breaker service (Reliability Phase, Task 4).
 *
 * Tracks failure counts per external service key (e.g. 'CJ', 'EBAY',
 * 'SCOUT'). After FAILURE_THRESHOLD consecutive failures the circuit opens
 * and all calls to that service are rejected immediately for OPEN_WINDOW_MS
 * (no more hammering a down API every 15 minutes). After the window the
 * circuit transitions to half-open: the next call is allowed through as a
 * probe. A probe success closes the circuit; a probe failure re-opens it.
 *
 * State is persisted in the `circuit_breaker` table so it survives restarts.
 * The in-memory Map is a write-through cache to avoid a DB read on every
 * hot path (every variant loop iteration).
 */
import Database from "better-sqlite3";
import { logger } from "../logger";

export type CircuitState = "closed" | "open" | "half-open";

const FAILURE_THRESHOLD = 5;          // consecutive failures before opening
const OPEN_WINDOW_MS    = 5 * 60_000; // 5 minutes open before half-open probe

interface BreakerRow {
  service_key:     string;
  state:           CircuitState;
  failure_count:   number;
  last_failure_at: string | null;
  open_until:      string | null;
}

// In-memory write-through cache — key → BreakerRow
const cache = new Map<string, BreakerRow>();

function load(db: Database.Database, key: string): BreakerRow {
  if (cache.has(key)) return cache.get(key)!;
  const row = db
    .prepare("SELECT * FROM circuit_breaker WHERE service_key = ?")
    .get(key) as BreakerRow | undefined;
  const breaker: BreakerRow = row ?? {
    service_key:     key,
    state:           "closed",
    failure_count:   0,
    last_failure_at: null,
    open_until:      null,
  };
  cache.set(key, breaker);
  return breaker;
}

function save(db: Database.Database, b: BreakerRow): void {
  db.prepare(
    `INSERT INTO circuit_breaker (service_key, state, failure_count, last_failure_at, open_until, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(service_key) DO UPDATE SET
       state            = excluded.state,
       failure_count    = excluded.failure_count,
       last_failure_at  = excluded.last_failure_at,
       open_until       = excluded.open_until,
       updated_at       = datetime('now')`
  ).run(b.service_key, b.state, b.failure_count, b.last_failure_at, b.open_until);
  cache.set(b.service_key, b);
}

/**
 * Returns true when the circuit is OPEN (caller must skip the call).
 * Transitions open → half-open automatically when the recovery window passes.
 */
export function isOpen(db: Database.Database, key: string): boolean {
  const b = load(db, key);
  if (b.state === "closed") return false;
  if (b.state === "half-open") return false; // allow the probe through

  // open: check if recovery window has elapsed
  if (b.open_until && Date.now() >= new Date(b.open_until).getTime()) {
    b.state = "half-open";
    save(db, b);
    logger.info(`Circuit breaker [${key}]: open → half-open (probe allowed)`);
    return false;
  }
  return true; // still open
}

/**
 * Call this after a SUCCESSFUL call to a service.
 * Resets failure count and closes the circuit.
 */
export function recordSuccess(db: Database.Database, key: string): void {
  const b = load(db, key);
  if (b.state === "closed" && b.failure_count === 0) return; // nothing to do
  const prev = b.state;
  b.state         = "closed";
  b.failure_count = 0;
  b.open_until    = null;
  save(db, b);
  if (prev !== "closed") {
    logger.info(`Circuit breaker [${key}]: ${prev} → closed (success)`);
  }
}

/**
 * Call this after a FAILED call to a service.
 * Increments failure count and opens the circuit when threshold is reached.
 */
export function recordFailure(db: Database.Database, key: string, error: string): void {
  const b = load(db, key);
  b.failure_count += 1;
  b.last_failure_at = new Date().toISOString();

  if (b.state === "half-open" || b.failure_count >= FAILURE_THRESHOLD) {
    b.state      = "open";
    b.open_until = new Date(Date.now() + OPEN_WINDOW_MS).toISOString();
    logger.warn(`Circuit breaker [${key}]: OPENED — ${b.failure_count} consecutive failure(s). Pausing for ${OPEN_WINDOW_MS / 60000} min.`, { error });
  }

  save(db, b);
}

/** Returns the current state of a circuit (for dashboard / health checks). */
export function getState(db: Database.Database, key: string): CircuitState {
  return load(db, key).state;
}

/** Returns all breaker rows — used by the overview/health endpoint. */
export function getAllBreakers(db: Database.Database): BreakerRow[] {
  return db
    .prepare("SELECT * FROM circuit_breaker ORDER BY service_key")
    .all() as BreakerRow[];
}
