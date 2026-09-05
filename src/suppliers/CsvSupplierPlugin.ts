/**
 * CsvSupplierPlugin — generic "manual / webhook" supplier plugin.
 *
 * Designed for suppliers that don't have a programmatic API: small
 * wholesalers, private-label factories, local distributors, or any source
 * where you manage fulfilment yourself.
 *
 * ## How it works
 *
 * ### Catalogue (stock & price data)
 * Place a JSON file at the path configured in `cataloguePath` (default:
 * `./config/csv-supplier-catalogue.json`). Each entry describes one variant:
 *
 *   [
 *     {
 *       "variantId": "SKU-001",       // must match variants.supplier_variant_id
 *       "title":     "Widget Blue",
 *       "cost":      8.50,            // your unit cost in USD
 *       "shippingCost": 2.00,
 *       "stock":     100,
 *       "images":    ["https://…"],   // optional
 *       "description": "…"           // optional
 *     }
 *   ]
 *
 * Re-sync picks up changes to this file on the next sync cycle — no restart
 * needed. You can generate/overwrite this file from a spreadsheet export,
 * a simple cron that hits your own warehouse system, or any other tooling.
 *
 * ### Order fulfilment
 * Two modes, controlled by the `webhookUrl` credential field:
 *
 *   - **Webhook mode** (`webhookUrl` is set): on createOrder, the plugin POSTs
 *     the order payload as JSON to your URL (e.g. a Zapier/Make webhook, your
 *     own fulfilment endpoint, or a simple email-to-webhook service). The
 *     webhook must return `{ "orderId": "…" }` or the plugin assigns a local
 *     `MANUAL-<timestamp>` id and logs a warning.
 *
 *   - **Manual mode** (`webhookUrl` is empty/null): on createOrder, the plugin
 *     writes the order to `./logs/manual-orders.jsonl` (one JSON object per
 *     line, append-only). It assigns a `MANUAL-<timestamp>` id. You process
 *     that log however you like (email it to yourself, import into a
 *     spreadsheet, etc.).
 *
 * ### Tracking / order status
 * No automatic tracking is available without an API. Both `getOrderStatus`
 * and `getTrackingInfo` return stub responses that never block the
 * fulfilment loop. Add tracking manually via the eBay seller hub, or wire
 * a real webhook if your warehouse system can push tracking back.
 *
 * ### Authentication
 * The `apiKey` credential (stored encrypted in the suppliers table) is sent
 * as `Authorization: Bearer <apiKey>` on webhook calls if set. For manual
 * mode it is unused. `getAuthToken()` does a lightweight self-check (verifies
 * the catalogue file is readable) and returns a static token — sufficient
 * for the dashboard's "Test Connection" ping.
 */
import fs from "fs";
import path from "path";
import {
  SupplierProvider,
  SupplierProductDetails,
  SupplierStockAndPrice,
  SupplierOrderPayload,
  SupplierOrderResult,
  SupplierOrderStatus,
  SupplierTrackingInfo,
} from "./SupplierProvider";
import { SupplierApiError } from "./errors";
import { logger } from "../logger";

// ── Catalogue entry shape ─────────────────────────────────────────────────────

export interface CsvCatalogueEntry {
  variantId:    string;
  title:        string;
  cost:         number;
  shippingCost: number;
  stock:        number;
  images?:      string[];
  description?: string;
}

// ── Plugin config ─────────────────────────────────────────────────────────────

export interface CsvSupplierConfig {
  /** Path to the JSON catalogue file. Defaults to ./config/csv-supplier-catalogue.json */
  cataloguePath?: string;
  /**
   * Optional webhook URL. When set, createOrder POSTs the payload to this URL.
   * When absent, orders are appended to ./logs/manual-orders.jsonl.
   */
  webhookUrl?: string;
  /**
   * Optional Bearer token sent as `Authorization: Bearer <apiKey>` on webhook
   * calls. Stored encrypted in the suppliers table; pass the decrypted value here.
   */
  apiKey?: string;
}

// ── Catalogue cache ───────────────────────────────────────────────────────────

interface CatalogueCache {
  entries:    Map<string, CsvCatalogueEntry>; // keyed by variantId
  loadedAt:   number;                         // epoch ms
  fileMtime:  number;                         // file mtime at load time
}

const CACHE_TTL_MS  = 60_000;   // re-read the file at most once per minute
const SUPPLIER_KEY  = "CSV";

export class CsvSupplierPlugin implements SupplierProvider {
  readonly supplierKey = SUPPLIER_KEY;

  private cataloguePath: string;
  private webhookUrl:    string | null;
  private apiKey:        string | null;
  private cache:         CatalogueCache | null = null;

  constructor(config: CsvSupplierConfig = {}) {
    this.cataloguePath = config.cataloguePath
      ?? path.join(process.cwd(), "config", "csv-supplier-catalogue.json");
    this.webhookUrl = config.webhookUrl ?? null;
    this.apiKey     = config.apiKey     ?? null;
  }

  // ── Catalogue loading ────────────────────────────────────────────────────

  private loadCatalogue(): Map<string, CsvCatalogueEntry> {
    const now = Date.now();

    // Check file mtime to invalidate cache when file changes, even within TTL
    let mtime = 0;
    try {
      mtime = fs.statSync(this.cataloguePath).mtimeMs;
    } catch {
      // File missing — handled below
    }

    if (
      this.cache &&
      now - this.cache.loadedAt < CACHE_TTL_MS &&
      mtime === this.cache.fileMtime
    ) {
      return this.cache.entries;
    }

    if (!fs.existsSync(this.cataloguePath)) {
      // Return empty map — not a hard error; operator may not have uploaded it yet
      logger.warn("CsvSupplierPlugin: catalogue file not found", { path: this.cataloguePath });
      const empty = new Map<string, CsvCatalogueEntry>();
      this.cache = { entries: empty, loadedAt: now, fileMtime: 0 };
      return empty;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.cataloguePath, "utf-8"));
    } catch (err) {
      throw new SupplierApiError(SUPPLIER_KEY,
        `Catalogue file is not valid JSON: ${(err as Error).message}`,
        { isRetryable: false }
      );
    }

    if (!Array.isArray(raw)) {
      throw new SupplierApiError(SUPPLIER_KEY,
        "Catalogue file must be a JSON array of variant objects.",
        { isRetryable: false }
      );
    }

    const map = new Map<string, CsvCatalogueEntry>();
    for (const entry of raw as Record<string, unknown>[]) {
      const variantId = String(entry.variantId ?? entry.sku ?? "");
      if (!variantId) continue;
      map.set(variantId, {
        variantId,
        title:        String(entry.title ?? "(untitled)"),
        cost:         Number(entry.cost ?? 0),
        shippingCost: Number(entry.shippingCost ?? entry.shipping_cost ?? 0),
        stock:        Number(entry.stock ?? entry.inventory ?? 0),
        images:       Array.isArray(entry.images) ? (entry.images as string[]) : [],
        description:  entry.description ? String(entry.description) : undefined,
      });
    }

    logger.info("CsvSupplierPlugin: catalogue loaded", {
      path: this.cataloguePath,
      entries: map.size,
    });

    this.cache = { entries: map, loadedAt: now, fileMtime: mtime };
    return map;
  }

  // ── SupplierProvider implementation ─────────────────────────────────────

  /**
   * Auth ping: verifies the catalogue file is readable and returns a static
   * token so the dashboard "Test Connection" button gets a green tick.
   */
  async getAuthToken(): Promise<string> {
    // Try to load the catalogue — throws SupplierApiError if JSON is malformed
    this.loadCatalogue();
    return "csv-supplier-ok";
  }

  async getProductDetails(supplierProductId: string): Promise<SupplierProductDetails> {
    const catalogue = this.loadCatalogue();
    const entry = catalogue.get(supplierProductId);
    if (!entry) {
      throw new SupplierApiError(SUPPLIER_KEY,
        `Variant "${supplierProductId}" not found in catalogue. ` +
        `Add it to ${this.cataloguePath}`,
        { isRetryable: false }
      );
    }
    return {
      supplierProductId,
      title:       entry.title,
      description: entry.description,
      images:      entry.images,
    };
  }

  async getStockAndPrice(supplierVariantId: string): Promise<SupplierStockAndPrice> {
    const catalogue = this.loadCatalogue();
    const entry = catalogue.get(supplierVariantId);
    if (!entry) {
      throw new SupplierApiError(SUPPLIER_KEY,
        `Variant "${supplierVariantId}" not found in catalogue at ${this.cataloguePath}. ` +
        `Ensure variantId in the file matches variants.supplier_variant_id in the DB.`,
        { isRetryable: false }
      );
    }
    return {
      supplierVariantId,
      cost:         entry.cost,
      shippingCost: entry.shippingCost,
      stock:        entry.stock,
      currency:     "USD",
    };
  }

  async createOrder(orderPayload: SupplierOrderPayload): Promise<SupplierOrderResult> {
    const orderId = `MANUAL-${Date.now()}`;

    if (this.webhookUrl) {
      return this.createOrderViaWebhook(orderPayload, orderId);
    }
    return this.createOrderManual(orderPayload, orderId);
  }

  private async createOrderViaWebhook(
    orderPayload: SupplierOrderPayload,
    fallbackId: string
  ): Promise<SupplierOrderResult> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await fetch(this.webhookUrl!, {
        method: "POST",
        headers,
        body: JSON.stringify({
          supplier: SUPPLIER_KEY,
          referenceId: orderPayload.referenceId,
          shippingAddress: orderPayload.shippingAddress,
          lineItems: orderPayload.lineItems,
          createdAt: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (networkErr) {
      throw new SupplierApiError(SUPPLIER_KEY,
        `Webhook call failed: ${(networkErr as Error).message}`,
        { isRetryable: true }
      );
    }

    if (res.status === 429) {
      throw new SupplierApiError(SUPPLIER_KEY, "Webhook rate-limited (429)", { httpStatus: 429 });
    }
    if (!res.ok) {
      throw new SupplierApiError(SUPPLIER_KEY,
        `Webhook returned HTTP ${res.status}`,
        { httpStatus: res.status, isRetryable: res.status >= 500 }
      );
    }

    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // Webhook doesn't return JSON — that's fine, use fallback id
    }

    const supplierOrderId = typeof json.orderId === "string" ? json.orderId : fallbackId;

    logger.info("CsvSupplierPlugin: order dispatched via webhook", {
      referenceId: orderPayload.referenceId,
      supplierOrderId,
      webhookUrl: this.webhookUrl,
    });

    return { supplierOrderId, status: "SUBMITTED" };
  }

  private createOrderManual(
    orderPayload: SupplierOrderPayload,
    orderId: string
  ): SupplierOrderResult {
    const logDir  = path.join(process.cwd(), "logs");
    const logFile = path.join(logDir, "manual-orders.jsonl");

    try {
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const record = JSON.stringify({
        orderId,
        referenceId:     orderPayload.referenceId,
        createdAt:       new Date().toISOString(),
        shippingAddress: orderPayload.shippingAddress,
        lineItems:       orderPayload.lineItems,
      });
      fs.appendFileSync(logFile, record + "\n", "utf-8");
    } catch (err) {
      // Writing the log failed — surface as a retryable error so the
      // order routing loop will retry on the next cycle rather than silently
      // dropping the order.
      throw new SupplierApiError(SUPPLIER_KEY,
        `Failed to write manual order log: ${(err as Error).message}`,
        { isRetryable: true }
      );
    }

    logger.info("CsvSupplierPlugin: order written to manual log", {
      orderId,
      referenceId: orderPayload.referenceId,
      logFile,
    });

    return { supplierOrderId: orderId, status: "MANUAL_PENDING" };
  }

  /**
   * No automatic status tracking for manual/webhook orders without an API.
   * Returns a stub "MANUAL_PENDING" status so the fulfilment loop doesn't
   * crash — operators should update tracking via the eBay seller hub directly.
   */
  async getOrderStatus(supplierOrderId: string): Promise<SupplierOrderStatus> {
    return {
      supplierOrderId,
      status:    "MANUAL_PENDING",
      isShipped: false,
    };
  }

  /**
   * No automatic tracking for manual/webhook suppliers.
   * Returns hasTracking=false so the fulfilment loop skips this order.
   */
  async getTrackingInfo(supplierOrderId: string): Promise<SupplierTrackingInfo> {
    return {
      supplierOrderId,
      carrier:        null,
      trackingNumber: null,
      hasTracking:    false,
    };
  }
}
