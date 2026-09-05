/**
 * Channel factory — mirrors supplierFactory.ts for sales channels.
 *
 * The factory is the only place that knows which channel key maps to which
 * concrete SalesChannel class. Job loops must call `getChannelProvider(key)`
 * rather than importing EbayChannel (or any future channel) directly.
 *
 * Adding a new channel:
 *   1. Write a class implementing SalesChannel (e.g. ShopifyChannel.ts).
 *   2. Add one entry to `channelRegistry` below.
 *   3. Add the channel's credentials to .env / the config table.
 *   Nothing else changes.
 */
import { SalesChannel } from "./SalesChannel";
import { EbayChannel } from "./EbayChannel";
import { buildEbayClient, EbayNotConfiguredError } from "../ebay/ebayFactory";
import { CoreConfig } from "../config";

export class UnknownChannelError extends Error {
  constructor(channelKey: string) {
    super(
      `No channel plugin registered for channel key "${channelKey}". ` +
        `Known channels: ${Array.from(channelRegistry.keys()).join(", ")}.`
    );
    this.name = "UnknownChannelError";
  }
}

type ChannelBuilder = (config: CoreConfig) => SalesChannel;

// Instances are created lazily and cached per config reference.
const instanceCache = new Map<string, SalesChannel>();

const channelRegistry: Map<string, ChannelBuilder> = new Map<string, ChannelBuilder>([
  [
    "EBAY",
    (config) => new EbayChannel(buildEbayClient(config)),
  ],
  // ["SHOPIFY",  (config) => new ShopifyChannel({ shopDomain: ..., accessToken: ... })],
  // ["ETSY",     (config) => new EtsyChannel({ apiKey: ... })],
  // ["AMAZON",   (config) => new AmazonChannel({ sellerId: ..., mwsToken: ... })],
  // ["WALMART",  (config) => new WalmartChannel({ clientId: ..., clientSecret: ... })],
]);

/**
 * Returns the SalesChannel instance for the given channel key.
 * Throws EbayNotConfiguredError (from buildEbayClient) when credentials
 * are missing — the same behaviour as the existing direct EbayClient usage.
 */
export function getChannelProvider(channelKey: string, config: CoreConfig): SalesChannel {
  const key = channelKey.toUpperCase();
  const cached = instanceCache.get(key);
  if (cached) return cached;

  const builder = channelRegistry.get(key);
  if (!builder) throw new UnknownChannelError(key);

  const instance = builder(config);
  instanceCache.set(key, instance);
  return instance;
}

/** For tests / dashboard "which channels are available" listing. */
export function listRegisteredChannelKeys(): string[] {
  return Array.from(channelRegistry.keys());
}

/** Clears cached channel instances — useful after credential changes. */
export function clearChannelInstanceCache(channelKey?: string): void {
  if (channelKey) {
    instanceCache.delete(channelKey.toUpperCase());
  } else {
    instanceCache.clear();
  }
}
