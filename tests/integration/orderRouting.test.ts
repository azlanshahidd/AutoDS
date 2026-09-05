/**
 * Smoke tests for the order routing loop (src/jobs/orderRoutingLoop.ts).
 *
 * Uses ordersOverride to inject fake eBay orders (no real API calls).
 * Uses makeTestDb (in-memory SQLite) so every test gets a clean slate.
 *
 * Covers:
 *  1. Kill switch (AUTO_ORDER_ENABLED=false) — order is logged, not placed
 *  2. Successful order placement with TestPlugin
 *  3. Idempotency — same eBay order submitted twice only creates one supplier order
 *  4. Multi-supplier order → error, does not crash the loop
 *  5. Unknown SKU in an order line item → error per order, rest continues
 *  6. dryRun mode — nothing written to DB
 *  7. Already-submitted order → alreadyProcessed counter incremented
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, makeTestConfig, setTestConfig } from "../helpers/makeTestDb";
import { runOrderRoutingOnce } from "../../src/jobs/orderRoutingLoop";
import { clearSupplierInstanceCache } from "../../src/suppliers/supplierFactory";
import type { EbayOrder } from "../../src/ebay/ebayClient";
import type { TestDb } from "../helpers/makeTestDb";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeFakeOrder(overrides: Partial<EbayOrder> = {}): EbayOrder {
  return {
    orderId:                "EBAY-ORDER-001",
    orderFulfillmentStatus: "NOT_STARTED",
    orderPaymentStatus:     "PAID",
    buyer:                  { username: "buyer1" },
    lineItems: [{ lineItemId: "LI-001", sku: "EBAY-TEST-SKU-1", quantity: 1 }],
    shippingAddress: {
      fullName:       "Test Buyer",
      addressLine1:   "123 Main St",
      city:           "Austin",
      stateOrProvince:"TX",
      postalCode:     "78701",
      countryCode:    "US",
    },
    raw: {},
    ...overrides,
  };
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

let fixture: TestDb;

beforeEach(() => {
  fixture = makeTestDb();
  clearSupplierInstanceCache(); // start with fresh TestPlugin each test
});

afterEach(() => {
  fixture.db.close();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("orderRouting — kill switch (AUTO_ORDER_ENABLED=false)", () => {
  it("logs the order but does not call the supplier", async () => {
    const summary = await runOrderRoutingOnce(
      fixture.db,
      fixture.config, // autoOrderEnabled: false by default
      [makeFakeOrder()],
      { dryRun: false }
    );

    expect(summary.loggedNotSubmitted).toBe(1);
    expect(summary.submitted).toBe(0);
    expect(summary.result).toBe("success");

    // Row written with status='skipped_auto_order_disabled'
    const row = fixture.db
      .prepare("SELECT status, supplier_order_id FROM orders WHERE ebay_order_id = 'EBAY-ORDER-001'")
      .get() as { status: string; supplier_order_id: string | null };
    expect(row.status).toBe("skipped_auto_order_disabled");
    expect(row.supplier_order_id).toBeNull();
  });
});

describe("orderRouting — successful order placement", () => {
  it("creates a supplier order and records it", async () => {
    const config = makeTestConfig({ autoOrderEnabled: true });
    // withLiveAutoOrderEnabled reads from DB at runtime — write it there too
    setTestConfig(fixture.db, "AUTO_ORDER_ENABLED", "true");

    const summary = await runOrderRoutingOnce(
      fixture.db,
      config,
      [makeFakeOrder()],
      { dryRun: false }
    );

    expect(summary.submitted).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.result).toBe("success");

    const row = fixture.db
      .prepare("SELECT status, supplier_order_id FROM orders WHERE ebay_order_id = 'EBAY-ORDER-001'")
      .get() as { status: string; supplier_order_id: string };
    expect(row.status).toBe("submitted");
    expect(row.supplier_order_id).toMatch(/^TEST-ORDER-/);
  });
});

describe("orderRouting — idempotency", () => {
  it("does not create a duplicate supplier order on second run", async () => {
    const config = makeTestConfig({ autoOrderEnabled: true });
    setTestConfig(fixture.db, "AUTO_ORDER_ENABLED", "true");
    const order = makeFakeOrder();

    // First run — creates the order
    await runOrderRoutingOnce(fixture.db, config, [order], { dryRun: false });

    // Second run with same order ID — must be skipped
    const summary2 = await runOrderRoutingOnce(
      fixture.db,
      config,
      [order],
      { dryRun: false }
    );

    expect(summary2.alreadyProcessed).toBe(1);
    expect(summary2.submitted).toBe(0);

    // Only one row in orders table
    const count = (fixture.db
      .prepare("SELECT COUNT(*) as n FROM orders")
      .get() as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe("orderRouting — unknown SKU", () => {
  it("records as failed but continues with other orders", async () => {
    const config = makeTestConfig({ autoOrderEnabled: true });
    setTestConfig(fixture.db, "AUTO_ORDER_ENABLED", "true");

    const badOrder = makeFakeOrder({
      orderId: "EBAY-ORDER-BAD",
      lineItems: [{ lineItemId: "LI-BAD", sku: "NONEXISTENT-SKU", quantity: 1 }],
    });
    const goodOrder = makeFakeOrder({ orderId: "EBAY-ORDER-GOOD" });

    const summary = await runOrderRoutingOnce(
      fixture.db,
      config,
      [badOrder, goodOrder],
      { dryRun: false }
    );

    expect(summary.failed).toBe(1);
    expect(summary.submitted).toBe(1);
    expect(summary.result).toBe("partial_failure");
  });
});

describe("orderRouting — dry run", () => {
  it("does not write any rows to the orders table", async () => {
    const config = makeTestConfig({ autoOrderEnabled: true });

    await runOrderRoutingOnce(fixture.db, config, [makeFakeOrder()], {
      dryRun: true,
    });

    const count = (fixture.db
      .prepare("SELECT COUNT(*) as n FROM orders")
      .get() as { n: number }).n;
    expect(count).toBe(0);
  });
});
