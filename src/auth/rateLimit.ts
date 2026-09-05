/**
 * Lightweight in-memory login rate limiter — no external dependencies.
 *
 * Tracks failed attempts per IP (keyed on req.ip) within a sliding window.
 * After MAX_ATTEMPTS failures within WINDOW_MS, the next attempt returns 429.
 * A successful login clears the counter for that IP.
 *
 * Suitable for a single-process Railway / local deployment.
 * For multi-process deployments, replace with a Redis-backed solution.
 */

const WINDOW_MS    = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10;              // max failed attempts before lock-out

interface Bucket {
  count:     number;
  resetAt:   number; // epoch ms when the window expires
}

const buckets = new Map<string, Bucket>();

/** Clean up expired buckets to prevent unbounded memory growth. */
function gc() {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(key);
  }
}

/** Call on every failed login attempt. Returns true when the IP is now locked. */
export function recordFailure(ip: string): boolean {
  gc();
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + WINDOW_MS };
  }
  b.count += 1;
  buckets.set(ip, b);
  return b.count >= MAX_ATTEMPTS;
}

/** Returns true when the IP is currently locked out. */
export function isLockedOut(ip: string): boolean {
  gc();
  const b = buckets.get(ip);
  if (!b) return false;
  if (Date.now() >= b.resetAt) { buckets.delete(ip); return false; }
  return b.count >= MAX_ATTEMPTS;
}

/** Call on a successful login to clear the failure counter for this IP. */
export function clearFailures(ip: string): void {
  buckets.delete(ip);
}

/** Seconds remaining in the current lock-out window (0 if not locked). */
export function retryAfterSeconds(ip: string): number {
  const b = buckets.get(ip);
  if (!b || Date.now() >= b.resetAt) return 0;
  return Math.ceil((b.resetAt - Date.now()) / 1000);
}
