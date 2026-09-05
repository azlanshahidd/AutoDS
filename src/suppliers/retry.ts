/**
 * Exponential backoff retry wrapper used by every outbound API call
 * in the Core Service (CJ Dropshipping, eBay, and eBay OAuth).
 *
 * ## What gets retried
 *
 * | Error type | Retried? | Reason |
 * |-----------|----------|--------|
 * | HTTP 429 (rate limit) | ✅ | Standard backoff — the API is telling us to slow down |
 * | HTTP 5xx (server error) | ✅ | Transient availability — the API will likely recover |
 * | Network error (ECONNRESET, ETIMEDOUT, ENOTFOUND, EPIPE) | ✅ | Connection-layer issue, not a logic error |
 * | fetch() TypeError | ✅ | Node/undici network-layer error |
 * | HTTP 4xx (except 429) | ❌ | Client error — retrying won't help |
 * | `SupplierApiError(isRetryable: false)` | ❌ | Caller explicitly marked it non-retryable |
 * | Unknown errors | ❌ | Unknown errors are rethrown immediately |
 *
 * ## Backoff schedule (defaults)
 *
 * ```
 * Attempt 1: 1000ms ± 20% jitter  →  800–1200ms
 * Attempt 2: 2000ms ± 20% jitter  →  1600–2400ms
 * Attempt 3: 4000ms ± 20% jitter  →  3200–4800ms
 * Attempt 4: 8000ms ± 20% jitter  →  6400–9600ms
 * (capped at maxDelayMs = 16000ms)
 * ```
 *
 * ## Why ±20% jitter?
 * Without jitter, all concurrent retries from the same process fire at
 * exactly the same time, creating a thundering herd that hits the rate
 * limit again immediately. Jitter spreads them out so the probability
 * of hitting the rate limit on retry is dramatically lower.
 *
 * ## Usage
 * ```typescript
 * const result = await withRetry(
 *   () => fetch("https://api.example.com/products"),
 *   { context: "CJ getStockAndPrice", maxRetries: 4 }
 * );
 * ```
 */
import { logger } from "../logger";
import { SupplierApiError } from "./errors";

export interface RetryOptions {
  /** Maximum number of retry attempts. Default: 4. Total calls = maxRetries + 1. */
  maxRetries?: number;
  /** Base delay in ms for the first retry. Doubles each attempt. Default: 1000. */
  baseDelayMs?: number;
  /** Maximum delay in ms (caps exponential growth). Default: 16000. */
  maxDelayMs?: number;
  /** Human-readable context string for log messages (e.g. "CJ getStockAndPrice"). */
  context?: string;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Applies ±20% random jitter to a delay value.
 *
 * Formula: `ms × (0.8 + random × 0.4)`
 * Result range: [0.8×ms, 1.2×ms]
 */
function jitter(ms: number): number {
  return ms * (0.8 + Math.random() * 0.4);
}

/**
 * Returns true if the error is likely transient (worth retrying).
 *
 * The decision tree:
 * 1. If it's a SupplierApiError with `isRetryable === false` → NOT transient.
 *    Callers set this explicitly for 4xx errors, auth failures, etc. that
 *    won't be helped by retrying.
 * 2. If it's a SupplierApiError with HTTP 429 → transient (rate limit).
 * 3. If it's a SupplierApiError with HTTP 5xx → transient (server error).
 * 4. If it's a fetch TypeError (Node/undici network error) → transient.
 * 5. If it has a known network error code → transient.
 * 6. Everything else → NOT transient (rethrow immediately).
 *
 * Note: AbortError from AbortSignal.timeout() is a TypeError in Node 22,
 * so it is correctly classified as transient and will be retried. This is
 * intentional — a timeout suggests the API is slow, not broken.
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof SupplierApiError) {
    // Explicit non-retryable (4xx other than 429, invalid payload, auth error, etc.)
    if (err.isRetryable === false) return false;
    // 429 rate-limit: always retry with backoff
    if (err.httpStatus === 429) return true;
    // 5xx server error: retry (transient availability)
    if (err.httpStatus && err.httpStatus >= 500) return true;
    return false;
  }

  // Raw fetch/network errors — the TypeErrors thrown by Node's fetch API
  // when the connection fails at the network layer (before any HTTP status).
  if (err instanceof TypeError && err.message.toLowerCase().includes("fetch")) return true;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "ECONNRESET"  ||  // connection reset by peer
      code === "ETIMEDOUT"   ||  // connection timed out
      code === "ENOTFOUND"   ||  // DNS resolution failure
      code === "ECONNREFUSED"||  // server refusing connections
      code === "EPIPE"           // broken pipe (write to closed socket)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Calls `fn()` and retries on transient errors with exponential backoff + jitter.
 *
 * @param fn       The async operation to execute. Called up to `maxRetries + 1` times.
 * @param opts     Backoff configuration (defaults are appropriate for CJ + eBay).
 * @returns        The resolved value of `fn()` on the first successful call.
 * @throws         The last error if all retries are exhausted, or the error
 *                 immediately if `isTransientError` returns false.
 *
 * @example
 * // Retries a CJ API call up to 4 times on rate limits and network errors
 * const data = await withRetry(
 *   () => fetch(`${CJ_BASE}/product/variant/queryByVid?vid=${vid}`, { signal: AbortSignal.timeout(30_000) }),
 *   { context: "CJ getStockAndPrice", maxRetries: 4 }
 * );
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxRetries  = opts.maxRetries  ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs  = opts.maxDelayMs  ?? 16000;
  const context     = opts.context     ?? "API call";

  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      // Non-transient or out of retries → rethrow immediately
      if (!isTransientError(err) || attempt >= maxRetries) {
        throw err;
      }

      // Exponential backoff with jitter:
      // base = min(1000 × 2^attempt, maxDelayMs)
      // delay = base × [0.8, 1.2) random
      const base  = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const delay = Math.round(jitter(base));
      attempt += 1;

      const reason =
        err instanceof SupplierApiError && err.httpStatus === 429
          ? "rate-limited (429)"
          : err instanceof SupplierApiError
            ? `HTTP ${err.httpStatus}`
            : `network error (${(err as Error).message?.slice(0, 80)})`;

      logger.warn(
        `${context}: transient error [${reason}], retry ${attempt}/${maxRetries} in ${delay}ms`
      );
      await sleep(delay);
    }
  }
}
