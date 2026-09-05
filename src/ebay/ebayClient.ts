/**
 * eBay Sell API client — Inventory API (listings, price/quantity) and
 * Fulfillment API (orders, shipping tracking).
 *
 * Endpoints verified against developer.ebay.com (Aug 2026):
 *   PUT  /sell/inventory/v1/inventory_item/{sku}         createOrReplaceInventoryItem
 *   POST /sell/inventory/v1/offer                        createOffer
 *   POST /sell/inventory/v1/offer/{offerId}/publish/      publishOffer
 *   POST /sell/inventory/v1/bulk_update_price_quantity    bulkUpdatePriceQuantity
 *   GET  /sell/fulfillment/v1/order                       getOrders
 *   POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment  createShippingFulfillment
 *
 * Every call goes through withRetry (429 exponential backoff, Section 5)
 * and logs method/path/status/truncated-body — never the access token.
 */
import { EbayOAuthClient } from "./ebayAuth";
import { withRetry } from "../suppliers/retry";
import { SupplierApiError } from "../suppliers/errors"; // reusing the same retryable-error shape
import { logger } from "../logger";

export interface EbayInventoryItem {
  sku: string;
  title: string;
  description?: string;
  quantity: number;
  imageUrls?: string[];
  condition?: string; // e.g. "NEW"
}

export interface EbayOfferParams {
  sku: string;
  marketplaceId: string; // e.g. "EBAY_US"
  price: number;
  currency: string; // e.g. "USD"
  categoryId: string;
  quantity: number;
  merchantLocationKey: string;
  listingDescription: string;
}

export interface EbayPriceQuantityUpdate {
  sku: string;
  price?: number;
  currency?: string;
  quantity: number;
}

export interface EbayOrder {
  orderId: string;
  orderFulfillmentStatus: string;
  orderPaymentStatus: string;
  buyer: { username?: string };
  lineItems: Array<{ lineItemId: string; sku: string; quantity: number }>;
  shippingAddress: {
    fullName?: string;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    stateOrProvince?: string;
    postalCode?: string;
    countryCode?: string;
    phoneNumber?: string;
  };
  raw: any;
}

export class EbayApiError extends Error {
  httpStatus?: number;
  constructor(message: string, httpStatus?: number) {
    super(`[eBay] ${message}`);
    this.name = "EbayApiError";
    this.httpStatus = httpStatus;
  }
}

export class EbayClient {
  constructor(private auth: EbayOAuthClient, private environment: "production" | "sandbox") {}

  private get baseUrl(): string {
    return this.environment === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    opts: { body?: unknown; context: string; expectNoBody?: boolean }
  ): Promise<T> {
    const doFetch = async () => {
      const token = await this.auth.getAccessToken();
      const url = `${this.baseUrl}${path}`;

      let res: Response;
      try {
        // Task 3: 30-second timeout — a hung eBay connection would otherwise
        // block the entire job cycle indefinitely.
        res = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            "Content-Language": "en-US",
            Authorization: `Bearer ${token}`,
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (networkErr) {
        // Task 1/2: network errors (ECONNRESET, ETIMEDOUT, AbortError, etc.)
        // are transient — mark retryable so withRetry applies backoff.
        // Previously isRetryable:false prevented any retry on network failures.
        throw new SupplierApiError("EBAY", `Network error calling ${path}: ${(networkErr as Error).message}`, {
          isRetryable: true,
        });
      }

      if (res.status === 429) {
        throw new SupplierApiError("EBAY", `Rate limited on ${path}`, { httpStatus: 429 });
      }

      const bodyText = await res.text();
      const truncated = bodyText.slice(0, 500);

      logger.info("eBay API call", { method, path, httpStatus: res.status, bodyPreview: truncated });

      if (res.status === 401) {
        // Access token rejected mid-batch — force a refresh so the *next*
        // call in this batch (or the next scheduled run) gets a fresh one,
        // rather than looping on the same stale token.
        await this.auth.refreshAccessToken();
        throw new SupplierApiError("EBAY", `Auth token rejected on ${path}`, { httpStatus: 401, isRetryable: false });
      }

      if (!res.ok) {
        // Task 2: 5xx responses are transient server errors — mark retryable
        // so withRetry applies exponential backoff. Previously all non-429
        // errors used isRetryable:false, meaning a transient 503 from eBay
        // would immediately surface as a hard failure instead of retrying.
        const isServerError = res.status >= 500;
        throw new SupplierApiError("EBAY", `${path} failed (HTTP ${res.status}): ${truncated}`, {
          httpStatus: res.status,
          isRetryable: isServerError,
        });
      }

      if (opts.expectNoBody || !bodyText) {
        return undefined as T;
      }

      try {
        return JSON.parse(bodyText) as T;
      } catch {
        return undefined as T;
      }
    };

    return withRetry(doFetch, { context: `eBay ${opts.context}` });
  }

  /** PUT /sell/inventory/v1/inventory_item/{sku} */
  async createOrReplaceInventoryItem(item: EbayInventoryItem): Promise<void> {
    await this.request("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(item.sku)}`, {
      context: "createOrReplaceInventoryItem",
      expectNoBody: true,
      body: {
        product: {
          title: item.title,
          description: item.description,
          imageUrls: item.imageUrls || [],
        },
        condition: item.condition || "NEW",
        availability: {
          shipToLocationAvailability: { quantity: item.quantity },
        },
      },
    });
  }

  /** POST /sell/inventory/v1/offer — returns the new offerId. */
  async createOffer(params: EbayOfferParams): Promise<{ offerId: string }> {
    const data = await this.request<{ offerId: string }>("POST", "/sell/inventory/v1/offer", {
      context: "createOffer",
      body: {
        sku: params.sku,
        marketplaceId: params.marketplaceId,
        format: "FIXED_PRICE",
        availableQuantity: params.quantity,
        categoryId: params.categoryId,
        listingDescription: params.listingDescription,
        listingPolicies: {}, // TODO: wire real fulfillment/payment/return policy IDs from the eBay account before first publish.
        pricingSummary: { price: { value: params.price.toFixed(2), currency: params.currency } },
        merchantLocationKey: params.merchantLocationKey,
      },
    });
    return data;
  }

  /** POST /sell/inventory/v1/offer/{offerId}/publish/ */
  async publishOffer(offerId: string): Promise<{ listingId: string }> {
    return this.request<{ listingId: string }>("POST", `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish/`, {
      context: "publishOffer",
    });
  }

  /**
   * POST /sell/inventory/v1/bulk_update_price_quantity — updates up to 25
   * SKUs' price/quantity in one call. Used by the Phase 4 sync loop.
   */
  async bulkUpdatePriceQuantity(updates: EbayPriceQuantityUpdate[]): Promise<any> {
    if (updates.length === 0) return { responses: [] };
    if (updates.length > 25) {
      throw new EbayApiError("bulkUpdatePriceQuantity accepts at most 25 SKUs per call.");
    }
    return this.request("POST", "/sell/inventory/v1/bulk_update_price_quantity", {
      context: "bulkUpdatePriceQuantity",
      body: {
        requests: updates.map((u) => ({
          sku: u.sku,
          shipToLocationAvailability: { quantity: u.quantity },
          ...(u.price !== undefined
            ? { offers: [{ price: { value: u.price.toFixed(2), currency: u.currency || "USD" } }] }
            : {}),
        })),
      },
    });
  }

  /**
   * GET /sell/fulfillment/v1/order — polls for orders. Filters to paid,
   * not-yet-fulfilled orders by default (what the Phase 5 order routing
   * loop needs).
   */
  async getNewPaidOrders(sinceIso?: string): Promise<EbayOrder[]> {
    const filters = ["orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}"];
    if (sinceIso) filters.push(`creationdate:[${sinceIso}..]`);

    const data = await this.request<any>(
      "GET",
      `/sell/fulfillment/v1/order?filter=${encodeURIComponent(filters.join(","))}&limit=50`,
      { context: "getOrders" }
    );

    return (data.orders || [])
      .filter((o: any) => o.orderPaymentStatus === "PAID")
      .map((o: any) => ({
        orderId: o.orderId,
        orderFulfillmentStatus: o.orderFulfillmentStatus,
        orderPaymentStatus: o.orderPaymentStatus,
        buyer: { username: o.buyer?.username },
        lineItems: (o.lineItems || []).map((li: any) => ({
          lineItemId: li.lineItemId,
          sku: li.sku,
          quantity: li.quantity,
        })),
        shippingAddress: o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress || {},
        raw: o,
      }));
  }

  /**
   * GET /sell/fulfillment/v1/order/{orderId} — fetches a single order,
   * used by the fulfillment loop to get line item IDs right before calling
   * createShippingFulfillment (the orders table only stores the eBay Order
   * ID and supplier order ID, not line item details, so this is re-fetched
   * rather than duplicated in local storage).
   */
  async getOrderById(orderId: string): Promise<EbayOrder> {
    const o = await this.request<any>("GET", `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`, {
      context: "getOrderById",
    });
    return {
      orderId: o.orderId,
      orderFulfillmentStatus: o.orderFulfillmentStatus,
      orderPaymentStatus: o.orderPaymentStatus,
      buyer: { username: o.buyer?.username },
      lineItems: (o.lineItems || []).map((li: any) => ({
        lineItemId: li.lineItemId,
        sku: li.sku,
        quantity: li.quantity,
      })),
      shippingAddress: o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress || {},
      raw: o,
    };
  }

  /** POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment */
  async createShippingFulfillment(params: {
    orderId: string;
    lineItemId: string;
    quantity: number;
    trackingNumber: string;
    shippingCarrierCode: string;
    shippedDate?: string;
  }): Promise<void> {
    await this.request("POST", `/sell/fulfillment/v1/order/${encodeURIComponent(params.orderId)}/shipping_fulfillment`, {
      context: "createShippingFulfillment",
      expectNoBody: true,
      body: {
        lineItems: [{ lineItemId: params.lineItemId, quantity: params.quantity }],
        shippedDate: params.shippedDate || new Date().toISOString(),
        shippingCarrierCode: params.shippingCarrierCode,
        trackingNumber: params.trackingNumber,
      },
    });
  }
}
