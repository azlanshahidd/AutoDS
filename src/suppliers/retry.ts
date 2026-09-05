/**
 * Retry with exponential backoff (Reliability Phase, Task 2).
 *
 * Extended from the original 429-only retry to also cover:
 *   - Transient network errors (ECONNRESET, ETIMEDOUT, fetch failures)
 *   - 5xx server errors from external services (transient availability)
 *
 * Non-retryable errors (4xx except 429, explicit isRetryable=false) are
 * still rethrown immediately.
 *
 * Backoff: 1s → 2s → 4s → 8s (capped at maxDelayMs) with ±20% jitter
 * so bursts of concurrent retries don't all fire at exactly the same time.
 */
import { logger } from "../logger";
import { SupplierApiError } from "./errors";

export interface RetryOptions {
  maxRetries?: number;   // default 4
  baseDelayMs?: number;  // default 1000
  maxDelayMs?: number;   // cap, default 16000
  context?: string;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  // ±20% random jitter to spread out concurrent retries
  return ms * (0.8 + Math.random() * 0.4);
}

function isTransientError(err: unknown): boolean {
  if (err instanceof SupplierApiError) {
    // Explicit non-retryable (4xx other than 429, invalid payload, etc.)
    if (err.isRetryable === false) return false;
    // 429 rate-limit: always retry
    if (err.httpStatus === 429) return true;
    // 5xx server error: retry (transient availability)
    if (err.httpStatus && err.httpStatus >= 500) return true;
    return false;
  }

  // Raw fetch/network errors (ECONNRESET, ETIMEDOUT, DNS failure, etc.)
  if (err instanceof TypeError && err.message.toLowerCase().includes("fetch")) return true;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" ||
        code === "ECONNREFUSED" || code === "EPIPE") {
      return true;
    }
  }

  return false;
}

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
      if (!isTransientError(err) || attempt >= maxRetries) {
        throw err;
      }

      const base  = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const delay = Math.round(jitter(base));
      attempt += 1;

      const reason =
        err instanceof SupplierApiError && err.httpStatus === 429
          ? "rate-limited (429)"
          : err instanceof SupplierApiError
            ? `HTTP ${err.httpStatus}`
            : `network error (${(err as Error).message?.slice(0, 80)})`;

      logger.warn(`${context}: transient error [${reason}], retry ${attempt}/${maxRetries} in ${delay}ms`);
      await sleep(delay);
    }
  }
}
