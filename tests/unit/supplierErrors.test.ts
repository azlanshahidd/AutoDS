/**
 * Unit tests for SupplierApiError retry classification.
 *
 * withRetry() depends on isRetryable to decide whether to back off or
 * immediately rethrow. A wrong value here means either:
 *   - 429s crash jobs instantly (false negative → revenue loss)
 *   - 401s loop forever (false positive → duplicate orders)
 */
import { describe, it, expect } from "vitest";
import { SupplierApiError } from "../../src/suppliers/errors";

describe("SupplierApiError — isRetryable defaults", () => {
  it("defaults isRetryable to true for httpStatus 429", () => {
    const err = new SupplierApiError("CJ", "rate limited", { httpStatus: 429 });
    expect(err.isRetryable).toBe(true);
  });

  it("defaults isRetryable to false for httpStatus 401", () => {
    const err = new SupplierApiError("CJ", "unauthorized", { httpStatus: 401 });
    expect(err.isRetryable).toBe(false);
  });

  it("defaults isRetryable to false when no httpStatus given", () => {
    const err = new SupplierApiError("CJ", "something went wrong");
    expect(err.isRetryable).toBe(false);
  });

  it("explicit isRetryable:true overrides the httpStatus default", () => {
    // Network errors (ECONNRESET etc.) are retryable even without httpStatus
    const err = new SupplierApiError("EBAY", "network error", { isRetryable: true });
    expect(err.isRetryable).toBe(true);
  });

  it("explicit isRetryable:false overrides a 429 httpStatus", () => {
    // Unusual but must be honoured — e.g. a permanent rate-limit ban
    const err = new SupplierApiError("CJ", "banned", { httpStatus: 429, isRetryable: false });
    expect(err.isRetryable).toBe(false);
  });

  it("sets the error name to SupplierApiError", () => {
    const err = new SupplierApiError("TEST", "msg");
    expect(err.name).toBe("SupplierApiError");
  });

  it("includes supplierKey in the message", () => {
    const err = new SupplierApiError("CJ", "bad request");
    expect(err.message).toContain("CJ");
    expect(err.message).toContain("bad request");
  });

  it("stores httpStatus correctly", () => {
    const err = new SupplierApiError("EBAY", "not found", { httpStatus: 404 });
    expect(err.httpStatus).toBe(404);
  });
});
