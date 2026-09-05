/**
 * TestPlugin — trivial mock SupplierProvider (Section 4a's required test
 * plugin). Returns hardcoded fake data for every method. Used only to prove
 * that the sync/order/fulfillment loops work against ANY plugin implementing
 * SupplierProvider with zero changes to core engine code — this is what
 * makes adding EPROLO/AliExpress/etc. later a "write one file" change
 * instead of a rewrite.
 *
 * Never used against real money/orders — createOrder here just returns a
 * fake id, it does not call any network.
 */
import {
  SupplierProvider,
  SupplierProductDetails,
  SupplierStockAndPrice,
  SupplierOrderPayload,
  SupplierOrderResult,
  SupplierOrderStatus,
  SupplierTrackingInfo,
} from "./SupplierProvider";

let fakeOrderCounter = 1000;

export class TestPlugin implements SupplierProvider {
  readonly supplierKey = "TEST";

  async getAuthToken(): Promise<string> {
    return "fake-test-token";
  }

  async getProductDetails(supplierProductId: string): Promise<SupplierProductDetails> {
    return {
      supplierProductId,
      title: `Fake Test Product ${supplierProductId}`,
      description: "This is fake data from TestPlugin, used only to validate the supplier abstraction layer.",
      images: [],
    };
  }

  async getStockAndPrice(supplierVariantId: string): Promise<SupplierStockAndPrice> {
    // Deterministic-ish fake values derived from the id, so repeated calls
    // for the same variant return the same numbers (useful for the Phase 4
    // "did the value change" comparison logic).
    const seed = [...supplierVariantId].reduce((sum, c) => sum + c.charCodeAt(0), 0);
    return {
      supplierVariantId,
      cost: 5 + (seed % 20), // $5 - $24.99
      shippingCost: 2.5,
      stock: seed % 50, // 0 - 49
      currency: "USD",
    };
  }

  async createOrder(orderPayload: SupplierOrderPayload): Promise<SupplierOrderResult> {
    fakeOrderCounter += 1;
    return {
      supplierOrderId: `TEST-ORDER-${fakeOrderCounter}`,
      status: "CREATED",
    };
  }

  async getOrderStatus(supplierOrderId: string): Promise<SupplierOrderStatus> {
    return {
      supplierOrderId,
      status: "SHIPPED",
      isShipped: true,
    };
  }

  async getTrackingInfo(supplierOrderId: string): Promise<SupplierTrackingInfo> {
    return {
      supplierOrderId,
      carrier: "FakeCarrier Express",
      trackingNumber: `FAKE-TRACK-${supplierOrderId}`,
      hasTracking: true,
    };
  }
}
