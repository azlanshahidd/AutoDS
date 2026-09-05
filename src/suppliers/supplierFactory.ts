/**
 * Supplier factory/loader (Section 4a).
 *
 * This is the ONLY place in the Core Service that knows which supplier keys
 * map to which plugin classes. The sync loop, order routing loop, and
 * fulfillment loop must go through getSupplierProvider() / getActiveSupplierProvider()
 * — never import CJPlugin or any other concrete plugin directly.
 *
 * Two switching modes (Section 4a):
 *  - Global: getActiveSupplierProvider() uses config.activeSupplier (from
 *    .env ACTIVE_SUPPLIER, or the `config` DB table once the dashboard can
 *    edit it).
 *  - Per-item: getSupplierProvider(supplierType) is called with each
 *    variant's own supplier_type column, so orders route through the
 *    correct plugin even when multiple suppliers are active at once.
 *
 * Adding a new supplier later (EPROLO, AliExpress, ...) = write one new
 * Plugin class implementing SupplierProvider, add one line to `registry`
 * below, and add its credentials to .env / the suppliers table. Nothing
 * else in the codebase changes.
 */
import { SupplierProvider } from "./SupplierProvider";
import { CJPlugin } from "./CJPlugin";
import { TestPlugin } from "./TestPlugin";
import { CsvSupplierPlugin } from "./CsvSupplierPlugin";

export class UnknownSupplierError extends Error {
  constructor(supplierKey: string) {
    super(
      `No supplier plugin registered for supplier_type "${supplierKey}". ` +
        `Known suppliers: ${Array.from(registry.keys()).join(", ")}.`
    );
    this.name = "UnknownSupplierError";
  }
}

type PluginBuilder = () => SupplierProvider;

// Instances are created lazily and cached, so we don't construct a CJPlugin
// (which requires CJ_API_KEY to be set) unless it's actually requested —
// this matters for ACTIVE_SUPPLIER=TEST, where CJ credentials may be blank.
const instanceCache = new Map<string, SupplierProvider>();

const registry: Map<string, PluginBuilder> = new Map<string, PluginBuilder>([
  [
    "CJ",
    () => {
      const apiKey = process.env.CJ_API_KEY;
      if (!apiKey) {
        throw new Error(
          `Cannot construct CJPlugin: CJ_API_KEY is not set. Add it via the Suppliers dashboard page or .env.`
        );
      }
      return new CJPlugin({ apiKey });
    },
  ],
  ["TEST", () => new TestPlugin()],
  [
    "CSV",
    () => {
      // webhookUrl and apiKey are optional; when absent the plugin falls back
      // to writing orders to logs/manual-orders.jsonl (manual fulfilment mode).
      const webhookUrl = process.env.CSV_SUPPLIER_WEBHOOK_URL || undefined;
      const apiKey     = process.env.CSV_SUPPLIER_API_KEY     || undefined;
      return new CsvSupplierPlugin({ webhookUrl, apiKey });
    },
  ],
  // ["EPROLO", () => new EprploPlugin({...})],       <- future plugin, Section 4a
  // ["ALIEXPRESS", () => new AliExpressPlugin({...})], <- future plugin, Section 4a
]);

/**
 * Returns the SupplierProvider instance for a given supplier_type key
 * (e.g. a variant's own supplier_type, for per-item routing).
 */
export function getSupplierProvider(supplierKey: string): SupplierProvider {
  const cached = instanceCache.get(supplierKey);
  if (cached) return cached;

  const builder = registry.get(supplierKey.toUpperCase());
  if (!builder) {
    throw new UnknownSupplierError(supplierKey);
  }

  const instance = builder();
  instanceCache.set(supplierKey, instance);
  return instance;
}

/**
 * Returns the plugin for the globally active supplier (config.activeSupplier),
 * used when no per-item override applies.
 */
export function getActiveSupplierProvider(activeSupplierKey: string): SupplierProvider {
  return getSupplierProvider(activeSupplierKey);
}

/** For tests / dashboard "which suppliers exist" listing. */
export function listRegisteredSupplierKeys(): string[] {
  return Array.from(registry.keys());
}

/** Clears cached plugin instances — useful after credentials change (Phase 2b). */
export function clearSupplierInstanceCache(supplierKey?: string): void {
  if (supplierKey) {
    instanceCache.delete(supplierKey);
  } else {
    instanceCache.clear();
  }
}
