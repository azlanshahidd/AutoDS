/**
 * eBay OAuth token management (Section 5: "OAuth token refresh automation").
 *
 * eBay's Sell APIs (Inventory, Fulfillment) require a User access token,
 * obtained via the three-legged authorization-code OAuth flow. That initial
 * consent step requires a real browser redirect and can't be automated
 * headlessly — it's a ONE-TIME manual step (see README: "Getting your
 * initial eBay refresh token"). Once you have a refresh token (valid ~18
 * months), this module handles everything after that automatically:
 * exchanging it for a short-lived (2h) access token before each batch of
 * API calls, and re-exchanging when the cached one is close to expiry.
 *
 * Endpoint reference (verified against developer.ebay.com, Aug 2026):
 *   Token endpoint: POST https://api.ebay.com/identity/v1/oauth2/token
 *                   (https://api.sandbox.ebay.com/... for sandbox)
 *   Auth header:    Basic base64(clientId:clientSecret)
 *   Refresh body:   grant_type=refresh_token&refresh_token=<token>&scope=<scopes>
 */
import { logger } from "../logger";
import { withRetry } from "../suppliers/retry";
import { SupplierApiError } from "../suppliers/errors";

export interface EbayOAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  environment: "production" | "sandbox";
}

export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
].join(" ");

interface CachedAccessToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

export class EbayAuthError extends Error {
  httpStatus?: number;
  constructor(message: string, httpStatus?: number) {
    super(`[eBay OAuth] ${message}`);
    this.name = "EbayAuthError";
    this.httpStatus = httpStatus;
  }
}

export class EbayOAuthClient {
  private cached: CachedAccessToken | null = null;

  constructor(private config: EbayOAuthConfig) {}

  private get tokenUrl(): string {
    return this.config.environment === "sandbox"
      ? "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
      : "https://api.ebay.com/identity/v1/oauth2/token";
  }

  private get basicAuthHeader(): string {
    const raw = `${this.config.clientId}:${this.config.clientSecret}`;
    return `Basic ${Buffer.from(raw).toString("base64")}`;
  }

  /**
   * Returns a valid access token, refreshing it first if the cached one is
   * missing or within 5 minutes of expiry. This is the "scheduled worker"
   * requirement from Section 5 — called before every batch of eBay API
   * calls rather than running on its own timer, since eBay tokens are only
   * valid 2 hours and every sync/order/fulfillment cycle needs a fresh one
   * anyway.
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now + 5 * 60 * 1000) {
      return this.cached.accessToken;
    }
    return this.refreshAccessToken();
  }

  /** Forces a refresh regardless of cache state — used after an auth failure mid-batch. */
  async refreshAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.config.refreshToken,
      scope: EBAY_SCOPES,
    });

    const doRefresh = async () => {
      let res: Response;
      try {
        res = await fetch(this.tokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: this.basicAuthHeader,
          },
          body: body.toString(),
        });
      } catch (networkErr) {
        throw new EbayAuthError(`Network error refreshing token: ${(networkErr as Error).message}`);
      }

      if (res.status === 429) {
        // Section 5: every eBay call, including auth, must retry on 429 with backoff.
        throw new SupplierApiError("EBAY", "Rate limited during token refresh", { httpStatus: 429 });
      }

      const json: any = await res.json().catch(() => null);

      // Never log the token itself (Section 5: "never log full OAuth tokens").
      logger.info("eBay token refresh", { httpStatus: res.status, hasAccessToken: Boolean(json?.access_token) });

      if (!res.ok || !json?.access_token) {
        throw new EbayAuthError(
          `Token refresh failed: ${json?.error_description || json?.error || res.statusText}. ` +
            `If this persists, your EBAY_REFRESH_TOKEN may have expired (~18 months) and needs to be re-minted — see README.`,
          res.status
        );
      }

      return json as { access_token: string; expires_in?: number };
    };

    const tokenData = await withRetry(doRefresh, { context: "eBay token refresh" });

    this.cached = {
      accessToken: tokenData.access_token,
      expiresAt: Date.now() + (Number(tokenData.expires_in) || 7200) * 1000,
    };

    return this.cached.accessToken;
  }
}
