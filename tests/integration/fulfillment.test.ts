/**
 * Smoke tests for the fulfillment loop (src/jobs/fulfillmentLoop.ts).
 *
 * Uses the ebayClientOverride parameter to inject a fake eBay client,
 * and TestPlugin (via makeTestDb fixture) so no real network calls are made.
 *
 * Covers:
 *  1. Happy path — submitted order with TestPlugin (always reports shipped)
 *     gets tracking pushed and status updated to 'shipped'
 *  2. No-op when there are no submitted orders
 *  3. Quarantine trigger — after ORDER_QUARANTINE_THRESHOLD consecutive
 *     failures, the order is flagged and excluded from the next run
 *  4. dryRun mode — nothing written to DB
 *  5. eBay client override (fake) — verifies the tracking push path
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, seedOrder } from "../helpers/makeTestDb";
import { runFulfillmentOnce } from "../../src/jobs/fulfillmentLoop";
import { ORDER_QUARANTINE_THRESHOLD } from "../../src/services/orderQuarantine";
import { clearSupplierInstanceCache } from "../../src/suppliers/supplierFactory";
import type { EbayClient } from "../../src/ebay/ebayClient";
import type { TestDb } from "../helpers/makeTestDb";

// ── Fake eBay client ──────────────────────────────────────────────────────────

type FakeEbayClient = Pick<EbayClient, "getOrderById" | "createShippingFulfillment">;

function makeFakeEbayClient(orderId: string): FakeEbayClient {
  return {
    async getOrderById(id: string) {
      return {
        orderId: id,
        orderFulfillmentStatus: "NOT_STARTED",
        orderPaymentStatus: "PAID",
        buyer: {},
        lineItems: [{ lineItemId: "LI-001", sku: "EBAY-TEST-SKU-1", quantity: 1 }],
        shippingAddress: {},
        raw: {},
      };
    },
    async createShippingFulfillment(_params) {
      // no-op — just confirm it doesn't throw
    },
  };
}

/** A fake eBay client that always throws on createShippingFulfillment */
function makeBrokenEbayClient(): FakeEbayClient {
  return {
    async getOrderById(id: string) {
      return {
        orderId: id,
        orderFulfillmentStatus: "NOT_STARTED",
        orderPaymentStatus: "PAID",
        buyer: {},
        lineItems: [{ lineItemId: "LI-001", sku: "EBAY-TEST-SKU-1", quantity: 1 }],
        shippingAddress: {},
        raw: {},
      };
    },
    async createShippingFulfillment(_params) {
      throw new Error("Simulated eBay fulfillment error");
    },
  };
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

let fixture: TestDb;

beforeEach(() => {
  fixture = makeTestDb();
  clearSupplierInstanceCache();
});

afterEach(() => {
  fixture.db.close();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fulfillment — no submitted orders", () => {
  it("returns success with zero candidates", async () => {
    const summary = await runFulfillmentOnce(
      fixture.db,
      fixture.config,
      makeFakeEbayClient("EBAY-ORDER-001"),
      { dryRun: false }
    );
    expect(summary.candidatesChecked).toBe(0);
    expect(summary.result).toBe("success");
  });
});

describe("fulfillment — happy path", () => {
  it("marks a submitted order as shipped after pushing tracking", async () => {
    const ebayOrderId = "EBAY-ORDER-001";
    seedOrder(fixture.db, { ebayOrderId, status: "submitted" });

    const summary = await runFulfillmentOnce(
      fixture.db,
      fixture.config,
      makeFakeEbayClient(ebayOrderId),
      { dryRun: false }
    );

    expect(summary.fulfilled).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.result).toBe("success");

    const row = fixture.db
      .prepare("SELECT status, tracking_number FROM orders WHERE ebay_order_id = ?")
      .get(ebayOrderId) as { status: string; tracking_number: string };
    expect(row.status).toBe("shipped");
    expect(row.tracking_number).toMatch(/^FAKE-TRACK-/);
  });
});

describe("fulfillment — dry run", () => {
  it("does not update order status in DB", async () => {
    const ebayOrderId = "EBAY-ORDER-001";
    seedOrder(fixture.db, { ebayOrderId, status: "submitted" });

    await runFulfillmentOnce(
      fixture.db,
      fixture.config,
      makeFakeEbayClient(ebayOrderId),
      { dryRun: true }
    );

    const row = fixture.db
      .prepare("SELECT status FROM orders WHERE ebay_order_id = ?")
      .get(ebayOrderId) as { status: string };
    // Should still be 'submitted' — dry run must not write
    expect(row.status).toBe("submitted");
  });
});

describe("fulfillment — quarantine trigger", () => {
  it("quarantines an order after consecutive failures and skips it on the next run", async () => {
    const ebayOrderId = "EBAY-ORDER-001";
    seedOrder(fixture.db, { ebayOrderId, status: "submitted" });

    // Run the loop ORDER_QUARANTINE_THRESHOLD times with a broken eBay client
    for (let i = 0; i < ORDER_QUARANTINE_THRESHOLD; i++) {
      await runFulfillmentOnce(
        fixture.db,
        fixture.config,
        makeBrokenEbayClient(),
        { dryRun: false }
      );
    }

    // Verify the order is now quarantined in the DB
    const row = fixture.db
      .prepare("SELECT quarantined, fulfillment_failure_count FROM orders WHERE ebay_order_id = ?")
      .get(ebayOrderId) as { quarantined: number; fulfillment_failure_count: number };
    expect(row.quarantined).toBe(1);
    expect(row.fulfillment_failure_count).toBe(ORDER_QUARANTINE_THRESHOLD);

    // Next run — the quarantined order must be excluded from candidates
    const summary = await runFulfillmentOnce(
      fixture.db,
      fixture.config,
      makeBrokenEbayClient(),
      { dryRun: false }
    );
    expect(summary.candidatesChecked).toBe(0);
  });

  it("does not quarantine an order until the threshold is reached", async () => {
    const ebayOrderId = "EBAY-ORDER-001";
    seedOrder(fixture.db, { ebayOrderId, status: "submitted" });

    // One fewer than threshold
    for (let i = 0; i < ORDER_QUARANTINE_THRESHOLD - 1; i++) {
      await runFulfillmentOnce(
        fixture.db,
        fixture.config,
        makeBrokenEbayClient(),
        { dryRun: false }
      );
    }

    const row = fixture.db
      .prepare("SELECT quarantined FROM orders WHERE ebay_order_id = ?")
      .get(ebayOrderId) as { quarantined: number };
    expect(row.quarantined).toBe(0);
  });
});

describe("fulfillment — failure counter resets on success", () => {
  it("resets fulfillment_failure_count to 0 after a successful fulfillment", async () => {
    const ebayOrderId = "EBAY-ORDER-001";
    seedOrder(fixture.db, { ebayOrderId, status: "submitted" });

    // Fail once
    await runFulfillmentOnce(
      fixture.db,
      fixture.config,
      makeBrokenEbayClient(),
      { dryRun: false }
    );

    // Now succeed
    await runFulfillmentOnce(
      fixture.db,
      fixture.config,
      makeFakeEbayClient(ebayOrderId),
      { dryRun: false }
    );

    const row = fixture.db
      .prepare("SELECT fulfillment_failure_count, status FROM orders WHERE ebay_order_id = ?")
      .get(ebayOrderId) as { fulfillment_failure_count: number; status: string };
    expect(row.fulfillment_failure_count).toBe(0);
    expect(row.status).toBe("shipped");
  });
});
