import { CoreConfig } from "../config";
import { EbayOAuthClient } from "./ebayAuth";
import { EbayClient } from "./ebayClient";

export class EbayNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(
      `eBay is not configured: missing ${missing.join(", ")}. ` +
        `Set these in .env — see README for how to obtain them.`
    );
    this.name = "EbayNotConfiguredError";
  }
}

/**
 * Builds a ready-to-use EbayClient from config, or throws a clear
 * EbayNotConfiguredError listing exactly which .env values are missing.
 * Called lazily (not at server startup) so the Core Service can still run
 * Phases 0-2 functionality without eBay credentials set.
 */
export function buildEbayClient(config: CoreConfig): EbayClient {
  const missing: string[] = [];
  if (!config.ebayClientId) missing.push("EBAY_CLIENT_ID");
  if (!config.ebayClientSecret) missing.push("EBAY_CLIENT_SECRET");
  if (!config.ebayRefreshToken) missing.push("EBAY_REFRESH_TOKEN");

  if (missing.length > 0) {
    throw new EbayNotConfiguredError(missing);
  }

  const auth = new EbayOAuthClient({
    clientId: config.ebayClientId!,
    clientSecret: config.ebayClientSecret!,
    refreshToken: config.ebayRefreshToken!,
    environment: config.ebayEnvironment,
  });

  return new EbayClient(auth, config.ebayEnvironment);
}
