/**
 * SupplierProvider (Section 4a).
 *
 * This is the ONE fixed contract the core engine (sync loop, order routing
 * loop, fulfillment loop) is allowed to talk to. The core engine must never
 * import a supplier-specific module or call a supplier-specific function
 * name directly — only these methods, on whatever plugin instance the
 * factory (supplierFactory.ts) hands it for a given supplier_type.
 *
 * Adding a new supplier (EPROLO, AliExpress, Zendrop, ...) means writing one
 * new file that implements this interface and registering it in the
 * factory's registry map — zero changes to sync.ts / orders.ts /
 * fulfillment.ts / the eBay integration / the database layer.
 */

export interface SupplierProductDetails {
  supplierProductId: string;
  title: string;
  description?: string;
  images?: string[];
}

export interface SupplierStockAndPrice {
  supplierVariantId: string;
  cost: number; // unit cost, in the supplier's currency (assume USD for v1)
  shippingCost: number;
  stock: number;
  currency?: string;
}

export interface SupplierOrderLineItem {
  supplierVariantId: string;
  quantity: number;
}

export interface SupplierShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  countryCode: string;
  phone?: string;
  email?: string;
}

export interface SupplierOrderPayload {
  /** Our own eBay Order ID — plugins should NOT use this for idempotency
   * themselves; the core engine's orders table is the single idempotency
   * source of truth (Section 5). Plugins just need it to tag the order for
   * traceability on the supplier's side, where supported. */
  referenceId: string;
  shippingAddress: SupplierShippingAddress;
  lineItems: SupplierOrderLineItem[];
}

export interface SupplierOrderResult {
  supplierOrderId: string;
  status: string;
}

export interface SupplierOrderStatus {
  supplierOrderId: string;
  status: string; // supplier's raw status string, core engine normalizes
  isShipped: boolean;
}

export interface SupplierTrackingInfo {
  supplierOrderId: string;
  carrier: string | null;
  trackingNumber: string | null;
  hasTracking: boolean;
}

/**
 * Every supplier plugin (CJPlugin, EprploPlugin, AliExpressPlugin, TestPlugin, ...)
 * must implement every method below. Methods should throw a SupplierApiError
 * (see errors.ts) on failure rather than returning null/undefined, so the
 * core engine has one consistent error shape to handle (Section 5: rate-limit
 * / retry handling wraps around these calls, not inside each plugin).
 */
export interface SupplierProvider {
  /** Human-readable key, e.g. 'CJ', 'EPROLO', 'TEST'. Must match variants.supplier_type. */
  readonly supplierKey: string;

  /**
   * Obtains/refreshes an auth token as needed and returns true if the
   * credentials are valid. Used by the dashboard's "Save & Test Connection"
   * flow (Phase 2b) as a lightweight ping/whoami check — must NOT create any
   * real orders or side effects.
   */
  getAuthToken(): Promise<string>;

  /** Fetch supplier-side product details for a given supplier product id. */
  getProductDetails(supplierProductId: string): Promise<SupplierProductDetails>;

  /** Fetch current cost + shipping + stock for one specific variant. */
  getStockAndPrice(supplierVariantId: string): Promise<SupplierStockAndPrice>;

  /** Create an order on the supplier's side. */
  createOrder(orderPayload: SupplierOrderPayload): Promise<SupplierOrderResult>;

  /** Poll the supplier for an existing order's status. */
  getOrderStatus(supplierOrderId: string): Promise<SupplierOrderStatus>;

  /** Fetch carrier + tracking number for a shipped order. */
  getTrackingInfo(supplierOrderId: string): Promise<SupplierTrackingInfo>;
}
