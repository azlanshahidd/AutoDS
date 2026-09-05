/**
 * SalesChannel — the single contract for every sales marketplace plugin.
 *
 * The design mirrors SupplierProvider: one interface file, one concrete
 * implementation per channel (EbayChannel, ShopifyChannel, EtsyChannel, …),
 * one factory that resolves a channel key to an instance.
 *
 * Goals:
 *   1. Decouple the sync loop, order routing loop, and fulfillment loop from
 *      eBay-specific API shapes — they should speak only `SalesChannel`.
 *   2. Let a second channel (Amazon, Shopify, Etsy, Walmart) be added by
 *      writing one new file and registering it in channelFactory.ts, with
 *      zero changes to the job loops.
 *   3. Keep the interface minimal — only operations the core engine actually
 *      needs. Channel-specific extras (eBay offers, Shopify metafields, etc.)
 *      stay inside the concrete implementation.
 *
 * ## What each method does
 *
 * `createOrUpdateListing`   — Create a new listing or fully replace an
 *   existing one. Returns a channel-specific listing ID. Idempotent: calling
 *   it twice with the same channelSku should produce one listing, not two.
 *
 * `bulkUpdatePriceStock`    — Update price and/or quantity for up to N SKUs
 *   in one call (channel may impose its own batch limit; implementations must
 *   chunk internally if needed). This is the hot path called every sync cycle.
 *
 * `getPaidOrders`           — Fetch orders that have been paid but not yet
 *   fulfilled. Returns a normalised `ChannelOrder[]` regardless of the
 *   channel's native order shape.
 *
 * `markShipped`             — Upload a tracking number + carrier for a
 *   specific order line. Called by the fulfillment loop once the supplier
 *   confirms shipment.
 *
 * `testConnection`          — Lightweight ping used by "Test Connection" in
 *   the dashboard. Must NOT create real orders or listings.
 */

// ── Shared data shapes ────────────────────────────────────────────────────────

export interface ChannelListingParams {
  /** Channel-level SKU (unique within this channel). */
  channelSku:     string;
  title:          string;
  description:    string;
  price:          number;
  currency:       string;   // e.g. "USD"
  quantity:       number;
  categoryId:     string;
  imageUrls:      string[];
  condition:      string;   // e.g. "NEW", "USED_EXCELLENT"
  /** Channel-specific extra fields (e.g. eBay merchantLocationKey). */
  extra?:         Record<string, unknown>;
}

export interface ChannelListingResult {
  /** Channel-assigned listing/offer identifier — store in variants.ebay_sku
   *  or the equivalent channel-sku column. */
  channelListingId: string;
  channelSku:       string;
}

export interface ChannelPriceStockUpdate {
  channelSku: string;
  price?:     number;
  currency?:  string;
  quantity:   number;
}

export interface ChannelOrderLineItem {
  lineItemId: string;
  channelSku: string;
  quantity:   number;
}

export interface ChannelShippingAddress {
  fullName?:    string;
  line1?:       string;
  line2?:       string;
  city?:        string;
  state?:       string;
  postalCode?:  string;
  countryCode?: string;
  phone?:       string;
}

export interface ChannelOrder {
  /** Channel-native order ID. Used as idempotency key in the orders table. */
  channelOrderId:  string;
  fulfillmentStatus: string;
  paymentStatus:    string;
  buyer?:           { username?: string };
  lineItems:        ChannelOrderLineItem[];
  shippingAddress:  ChannelShippingAddress;
  /** Raw channel response — retained for debugging; never logged in full. */
  raw:              unknown;
}

export interface ChannelShipmentParams {
  channelOrderId:  string;
  lineItemId:      string;
  quantity:        number;
  trackingNumber:  string;
  carrierCode:     string;
  shippedDate?:    string; // ISO-8601; defaults to now
}

// ── Interface ─────────────────────────────────────────────────────────────────

/**
 * Every sales channel plugin must implement all methods below. Methods should
 * throw a plain `Error` (or a typed subclass) on unrecoverable failures; the
 * job loops treat all errors as failures and update the circuit breaker.
 *
 * Adding a new channel: write one class that implements SalesChannel, register
 * it in src/channels/channelFactory.ts, add credentials to .env / the config
 * table — nothing else changes.
 */
export interface SalesChannel {
  /** Human-readable key, e.g. 'EBAY', 'SHOPIFY', 'ETSY'. */
  readonly channelKey: string;

  /**
   * Create or fully replace a listing. Idempotent — safe to call multiple
   * times for the same channelSku.
   */
  createOrUpdateListing(params: ChannelListingParams): Promise<ChannelListingResult>;

  /**
   * Batch-update price and/or quantity. Implementations must chunk internally
   * if the channel imposes a per-call item limit.
   */
  bulkUpdatePriceStock(updates: ChannelPriceStockUpdate[]): Promise<void>;

  /**
   * Return paid orders that have not yet been fulfilled.
   * @param sinceIso  Optional ISO-8601 timestamp; fetch only orders created
   *                  after this point to bound the response size.
   */
  getPaidOrders(sinceIso?: string): Promise<ChannelOrder[]>;

  /** Upload tracking information for a shipped order line. */
  markShipped(params: ChannelShipmentParams): Promise<void>;

  /**
   * Lightweight connectivity test. Must not create listings, place orders,
   * or have any other side effects. Returns true on success; throws on failure.
   */
  testConnection(): Promise<true>;
}
