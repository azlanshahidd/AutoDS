/**
 * Thrown by any SupplierProvider method on failure. The core engine's
 * retry/backoff wrapper (Section 5: rate-limit handling) inspects
 * `httpStatus` to decide whether to retry with exponential backoff (429) or
 * fail immediately (e.g. 401/404).
 */
export class SupplierApiError extends Error {
  supplierKey: string;
  httpStatus?: number;
  isRetryable: boolean;

  constructor(
    supplierKey: string,
    message: string,
    options: { httpStatus?: number; isRetryable?: boolean } = {}
  ) {
    super(`[${supplierKey}] ${message}`);
    this.name = "SupplierApiError";
    this.supplierKey = supplierKey;
    this.httpStatus = options.httpStatus;
    this.isRetryable = options.isRetryable ?? options.httpStatus === 429;
  }
}
