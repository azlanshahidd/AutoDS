/**
 * CJPlugin — SupplierProvider implementation for CJ Dropshipping (API 2.0).
 *
 * Endpoints used (verified against https://developers.cjdropshipping.cn/en/api/api2/
 * as of Aug 2026 — CJ does change these occasionally; if a call starts
 * returning 404/410, check the docs for a renamed endpoint):
 *
 *   Auth:            POST /api2.0/v1/authentication/getAccessToken
 *   Variant lookup:  GET  /api2.0/v1/product/variant/queryByVid?vid=...
 *   Create order:    POST /api2.0/v1/shopping/order/createOrderV2
 *   Order detail:    GET  /api2.0/v1/shopping/order/getOrderDetail?orderId=...
 *
 * CJ has no separate "get tracking" endpoint — trackNumber/trackingProvider
 * come back as part of the order detail response, so getTrackingInfo() below
 * calls the same endpoint as getOrderStatus().
 *
 * Auth model: getAccessToken returns an accessToken (used as the
 * "CJ-Access-Token" header on every subsequent call) plus a refreshToken and
 * an expiry. Per CJ's docs, calling getAccessToken again with the same
 * apiKey within 24h returns the same cached token, so we don't need a
 * separate refresh-token flow for v1 — we just re-request when our cached
 * token is close to expiring or a call comes back 401/1010 (invalid token).
 */
import { SupplierProvider, SupplierProductDetails, SupplierStockAndPrice, SupplierOrderPayload, SupplierOrderResult, SupplierOrderStatus, SupplierTrackingInfo } from "./SupplierProvider";
import { SupplierApiError } from "./errors";
import { withRetry } from "./retry";
import { logger } from "../logger";

const CJ_BASE_URL = "https://developers.cjdropshipping.com/api2.0/v1";

export interface CJPluginConfig {
  apiKey: string; // CJ's combined "apiKey" credential (obtained from My CJ > API tab)
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

export class CJPlugin implements SupplierProvider {
  readonly supplierKey = "CJ";
  private apiKey: string;
  private cachedToken: CachedToken | null = null;

  constructor(config: CJPluginConfig) {
    this.apiKey = config.apiKey;
  }

  private async requestJson<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; query?: Record<string, string>; auth?: boolean; context: string }
  ): Promise<T> {
    let url = `${CJ_BASE_URL}${path}`;
    if (opts.query) {
      const qs = new URLSearchParams(opts.query).toString();
      url += `?${qs}`;
    }

    const doFetch = async () => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (opts.auth !== false) {
        headers["CJ-Access-Token"] = await this.getAuthToken();
      }

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
      } catch (networkErr) {
        throw new SupplierApiError("CJ", `Network error calling ${path}: ${(networkErr as Error).message}`, {
          isRetryable: false,
        });
      }

      if (res.status === 429) {
        throw new SupplierApiError("CJ", `Rate limited on ${path}`, { httpStatus: 429 });
      }

      let json: any;
      try {
        json = await res.json();
      } catch {
        throw new SupplierApiError("CJ", `Non-JSON response from ${path} (HTTP ${res.status})`, {
          httpStatus: res.status,
          isRetryable: false,
        });
      }

      // Structured logging of every outbound request/response (Section 5),
      // truncated and never containing the raw token.
      logger.info("CJ API call", {
        method,
        path,
        httpStatus: res.status,
        code: json.code,
        success: json.result ?? json.success,
        requestId: json.requestId,
      });

      if (json.code === 1010 || json.message === "Token has expired" || res.status === 401) {
        // Invalid/expired token — clear cache so the next call re-authenticates,
        // and surface as retryable-once (not a 429, so withRetry won't loop on
        // it, but the caller's next attempt will get a fresh token).
        this.cachedToken = null;
        throw new SupplierApiError("CJ", `Auth token rejected on ${path}: ${json.message}`, {
          httpStatus: 401,
          isRetryable: false,
        });
      }

      if (json.result === false || json.success === false) {
        throw new SupplierApiError("CJ", `${json.message || "Unknown error"} (code ${json.code})`, {
          httpStatus: res.status,
          isRetryable: false,
        });
      }

      return json.data as T;
    };

    return withRetry(doFetch, { context: `CJ ${opts.context}` });
  }

  async getAuthToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60_000) {
      return this.cachedToken.accessToken;
    }

    const doAuth = async () => {
      let res: Response;
      try {
        res = await fetch(`${CJ_BASE_URL}/authentication/getAccessToken`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: this.apiKey }),
        });
      } catch (networkErr) {
        throw new SupplierApiError("CJ", `Network error during authentication: ${(networkErr as Error).message}`, {
          isRetryable: false,
        });
      }

      if (res.status === 429) {
        throw new SupplierApiError("CJ", "Rate limited during authentication", { httpStatus: 429 });
      }

      const json: any = await res.json().catch(() => null);

      logger.info("CJ auth call", { httpStatus: res.status, code: json?.code, success: json?.result });

      if (!json || json.result === false || !json.data?.accessToken) {
        throw new SupplierApiError("CJ", `Authentication failed: ${json?.message || "no accessToken in response"}`, {
          httpStatus: res.status,
          isRetryable: false,
        });
      }

      return json.data.accessToken as string;
    };

    // Section 5: every CJ call (including auth) must retry on 429 with backoff.
    const accessToken = await withRetry(doAuth, { context: "CJ authentication" });

    // CJ tokens are valid for a fixed window (commonly ~15 days); we don't
    // rely on an exact figure — cache for 12h and re-request beyond that, or
    // immediately on any 401 from a real call (see requestJson above).
    this.cachedToken = {
      accessToken,
      expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    };
    return this.cachedToken.accessToken;
  }

  async getProductDetails(supplierProductId: string): Promise<SupplierProductDetails> {
    const data = await this.requestJson<any>("GET", "/product/query", {
      query: { pid: supplierProductId },
      context: "getProductDetails",
    });
    return {
      supplierProductId,
      title: data.productNameEn || data.productName || "(untitled)",
      description: data.description,
      images: data.productImageSet || [],
    };
  }

  async getStockAndPrice(supplierVariantId: string): Promise<SupplierStockAndPrice> {
    const data = await this.requestJson<any>("GET", "/product/variant/queryByVid", {
      query: { vid: supplierVariantId },
      context: "getStockAndPrice",
    });
    // CJ's variant query returns an array (see docs) even for a single vid.
    const variant = Array.isArray(data) ? data[0] : data;
    if (!variant) {
      throw new SupplierApiError("CJ", `No variant found for vid ${supplierVariantId}`, { isRetryable: false });
    }
    return {
      supplierVariantId,
      cost: Number(variant.variantSellPrice ?? 0),
      shippingCost: 0, // CJ shipping cost is quote-based (see Logistic API); Phase 3+ integration will fetch a real freight quote per-order.
      stock: Number(variant.variantStandardStorageNum ?? variant.inventory ?? 0),
      currency: "USD",
    };
  }

  async createOrder(orderPayload: SupplierOrderPayload): Promise<SupplierOrderResult> {
    const body = {
      orderNumber: orderPayload.referenceId,
      shippingCustomerName: orderPayload.shippingAddress.name,
      shippingAddress: orderPayload.shippingAddress.line1,
      shippingAddress2: orderPayload.shippingAddress.line2 || "",
      shippingCity: orderPayload.shippingAddress.city,
      shippingProvince: orderPayload.shippingAddress.state || "",
      shippingZip: orderPayload.shippingAddress.postalCode,
      shippingCountryCode: orderPayload.shippingAddress.countryCode,
      shippingCountry: orderPayload.shippingAddress.countryCode,
      shippingPhone: orderPayload.shippingAddress.phone || "",
      email: orderPayload.shippingAddress.email || "",
      fromCountryCode: "CN",
      logisticName: "CJPacket Ordinary", // TODO Phase 3: fetch cheapest/appropriate option via Logistic API instead of hardcoding.
      platform: "Api",
      payType: 2, // balance payment — requires CJ account balance; see README for funding notes.
      products: orderPayload.lineItems.map((item) => ({
        vid: item.supplierVariantId,
        quantity: item.quantity,
        storeLineItemId: orderPayload.referenceId,
      })),
    };

    const data = await this.requestJson<any>("POST", "/shopping/order/createOrderV2", {
      body,
      context: "createOrder",
    });

    return {
      supplierOrderId: data.orderId,
      status: data.orderStatus || "CREATED",
    };
  }

  async getOrderStatus(supplierOrderId: string): Promise<SupplierOrderStatus> {
    const data = await this.requestJson<any>("GET", "/shopping/order/getOrderDetail", {
      query: { orderId: supplierOrderId },
      context: "getOrderStatus",
    });
    return {
      supplierOrderId,
      status: data.orderStatus,
      isShipped: data.orderStatus === "SHIPPED" || data.orderStatus === "DELIVERED",
    };
  }

  async getTrackingInfo(supplierOrderId: string): Promise<SupplierTrackingInfo> {
    // CJ returns tracking as part of order detail, not a separate endpoint.
    const data = await this.requestJson<any>("GET", "/shopping/order/getOrderDetail", {
      query: { orderId: supplierOrderId },
      context: "getTrackingInfo",
    });
    const hasTracking = Boolean(data.trackNumber);
    return {
      supplierOrderId,
      carrier: data.trackingProvider || null,
      trackingNumber: data.trackNumber || null,
      hasTracking,
    };
  }
}
