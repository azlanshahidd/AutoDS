// Empty string = same-origin relative requests (correct for production,
// where the backend serves this built frontend itself). Local dev sets
// VITE_API_BASE explicitly in frontend/.env to point at the dev backend
// running on a different port.
const API_BASE = import.meta.env.VITE_API_BASE || "";
const TOKEN_STORAGE_KEY = "core_dashboard_auth_token";

export function getStoredToken(): string | null {
  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setStoredToken(token: string) {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearStoredToken() {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Auth-Token": token } : {}),
      ...options.headers,
    },
  });

  // F24: dispatch auth:expired event when session is invalidated server-side
  if (res.status === 401) {
    clearStoredToken();
    window.dispatchEvent(new Event("auth:expired"));
    throw new ApiError("Unauthorized — check your dashboard auth token.", 401);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(body.error || `Request failed (${res.status})`, res.status);
  }

  return body as T;
}

export interface Supplier {
  id: number;
  supplierKey: string;
  displayName: string;
  maskedApiKey: string | null;
  maskedApiSecret: string | null;
  status: "unconfigured" | "connected" | "failed" | "disabled";
  lastTestedAt: string | null;
  marginOverride: number | null;
  feeOverride: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AvailablePlugin {
  key: string;
  displayName: string;
}

export interface OverviewStats {
  lastSyncRun: { runAt: string; result: string } | null;
  lastOrderRoutingRun: { runAt: string; result: string } | null;
  lastFulfillmentRun: { runAt: string; result: string } | null;
  productsTracked: number;
  /** All orders received today regardless of status. */
  ordersReceivedToday: number;
  /** Orders actually placed today (submitted/shipped/fulfilled). */
  ordersPlacedToday: number;
  /** Failed core jobs (price_stock, order_routing, fulfillment) in last 24h. */
  failedJobsLast24h: number;
  /** Failed scout_pull runs in last 24h (separate — external dependency). */
  scoutPullFailuresLast24h: number;
  autoOrderEnabled: boolean;
  activeAlerts: string[];
}

export interface ProductRow {
  internal_sku: string;
  supplier_type: string;
  supplier_variant_id: string;
  current_price: number | null;
  current_stock: number | null;
  last_synced_at: string | null;
  ebay_sku: string | null;
  product_title: string;
}

export interface OrderRow {
  ebay_order_id: string;
  supplier_type: string;
  supplier_order_id: string | null;
  status: string;
  tracking_number: string | null;
  carrier: string | null;
  created_at: string;
  updated_at: string;
}

export interface LogRow {
  id: number;
  run_at: string;
  type: string;
  result: string;
  error_message: string | null;
  details_json: string | null;
}

export interface ScoutedProduct {
  id: number;
  title: string;
  source_url: string | null;
  scraped_price: number | null;
  matched_supplier: string | null;
  matched_cost: number | null;
  estimated_margin: number | null;
  trend_signal: string | null;
  status: "pending_review" | "approved" | "discarded";
  /** Listing pipeline status — drives the Publish/Preview UI */
  listing_status: "none" | "queued" | "vero_blocked" | "quality_fail" | "publishing" | "published" | "failed";
  ebay_listing_id: string | null;
  ebay_category_id: string | null;
  /** JSON-encoded string array of image URLs */
  image_urls: string | null;
  listing_error: string | null;
  scouted_at: string;
  created_at: string;
  updated_at: string;
  ai_title: string | null;
  ai_description: string | null;
  meta_title: string | null;
  meta_description: string | null;
  meta_generated_at: string | null;
  meta_generation_source: string | null;
}

/** Returned by GET /api/scouted/:id/preview — no side effects */
export interface ListingPreview {
  scoutedId:           number;
  ebayTitle:           string;
  description:         string;
  price:               number;
  categoryId:          string;
  merchantLocationKey: string;
  marketplaceId:       string;
  images:              string[];
  supplierCost:        number;
  shippingCost:        number;
  profitMargin:        number;
  ebayFeeEstimate:     number;
  veroCheck:           { isBlocked: boolean; matchedKeywords: string[] };
  qualityIssues:       string[];
  canPublish:          boolean;
}

export interface AiProvider {
  id: number;
  name: string;
  providerType: "openai_compatible" | "gemini" | "cohere";
  baseUrl: string;
  model: string;
  hasKey: boolean;
  enabled: boolean;
  status: "untested" | "connected" | "failed";
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CoreSettings {
  profitMarginPercent: number;
  ebayFeeEstimate: number;
  autoOrderEnabled: boolean;
  safetyStockBuffer: number;
  syncIntervalMinutes: number;
  ebayClientId: string;
  ebayClientSecret: string;
  ebayRefreshToken: string;
  ebayEnvironment: "production" | "sandbox";
  /** "Review before publish" toggle — false = items queue for human click, true = fully automatic */
  autoListEnabled: boolean;
  /** eBay merchant location key (from createEbayLocation) — required for listing */
  ebayMerchantLocation: string;
  /** eBay marketplace, e.g. "EBAY_US" */
  ebayMarketplaceId: string;
  activeSupplier: string;
  cjApiKey: string;
  cjApiSecret: string;
  veroBlocklistPath: string;
  scoutPullTimeoutMs: number;
  alertWebhookUrl: string;
  alertTelegramBotToken: string;
  alertTelegramChatId: string;
  alertFailureThreshold: number;
  seoAutoRegenerate: boolean;
  marginFloorPercent: number;
  /**
   * JSON array of PricingTier objects stored as a string.
   * Each tier: { maxCost: number, marginPercent: number, flatMarkup?: number }
   * Empty array = no tier rules (use global/supplier margin).
   * Priority when tiers present: matching tier > supplier override > global.
   */
  pricingTiersJson: string;
}

export interface ServerInfo {
  port: number;
  host: string;
  databaseFile: string;
  logFile: string;
  encryptionKeySet: boolean;
}

// ── Analytics types ───────────────────────────────────────────────────────────

export interface AnalyticsDaySeries {
  date:        string;
  revenue:     number;
  cogs:        number;
  grossProfit: number;
  orders:      number;
}

export interface AnalyticsTotals {
  revenue:          number;
  cogs:             number;
  grossProfit:      number;
  marginPct:        number;  // as a percentage e.g. 28.5
  ordersTotal:      number;
  variantsListed:   number;
  ebayFeeEstimate:  number;
  marginFloor:      number;  // as whole-number % e.g. 10
}

export interface AnalyticsSummary {
  totals:  AnalyticsTotals;
  series:  AnalyticsDaySeries[];
  range:   { from: string; to: string };
  note:    string;
}

export interface AnalyticsProduct {
  productId:          number;
  productTitle:       string;
  internalSku:        string;
  ebaySku:            string | null;
  supplierType:       string;
  cost:               number;
  shippingCost:       number;
  ebayFee:            number;
  currentPrice:       number;
  currentStock:       number;
  grossProfitPerUnit: number;
  marginPct:          number;
  orderCount:         number;
  estimatedRevenue:   number;
  estimatedProfit:    number;
  lastSyncedAt:       string | null;
  daysListed:         number | null;
}

export interface SupplierScorecard {
  supplierType:  string;
  variantCount:  number;
  avgMarginPct:  number | null;
  totalOrders:   number;
  failedOrders:  number;
  failureRate:   number;
  placedOrders:  number;
  avgDaysToShip: number | null;
}

export interface FunnelStage {
  stage:   string;
  count:   number;
  dropOff: number;
}

export interface AnalyticsFunnel {
  stages: FunnelStage[];
  detail: {
    totalScouted:  number;
    pending:       number;
    approved:      number;
    discarded:     number;
    queued:        number;
    published:     number;
    veroBlocked:   number;
    qualityFailed: number;
    ordersPlaced:  number;
    ordersShipped: number;
  };
  range: { from: string; to: string };
}

export interface MarginAlert {
  productTitle: string;
  internalSku:  string;
  ebaySku:      string | null;
  supplierType: string;
  cost:         number;
  shippingCost: number;
  ebayFee:      number;
  currentPrice: number;
  grossProfit:  number;
  marginPct:    number;
  lastSyncedAt: string | null;
}

export interface MarginAlerts {
  alerts:   MarginAlert[];
  floorPct: number;
  count:    number;
}

function buildDateQS(from?: string, to?: string): string {
  const parts: string[] = [];
  if (from) parts.push(`from=${encodeURIComponent(from)}`);
  if (to)   parts.push(`to=${encodeURIComponent(to)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export interface Scraper {
  id: number;
  name: string;
  baseUrl: string;
  status: "untested" | "connected" | "failed";
  lastTestedAt: string | null;
  createdAt: string;
}

export const api = {
  health: () => request<{ status: string }>("/health"),

  // Auth
  login: (password: string) =>
    request<{ token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  logout: () =>
    request<{ success: boolean }>("/api/auth/logout", { method: "POST" }),

  listSuppliers: () => request<{ suppliers: Supplier[] }>("/api/suppliers"),

  availablePlugins: () => request<{ plugins: AvailablePlugin[] }>("/api/suppliers/available-plugins"),

  addSupplier: (params: { supplierKey: string; displayName?: string; apiKey: string; apiSecret?: string }) =>
    request<{ supplier: Supplier }>("/api/suppliers", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  editSupplier: (id: number, params: { displayName?: string; apiKey?: string; apiSecret?: string; marginOverride?: number | null; feeOverride?: number | null }) =>
    request<{ supplier: Supplier }>(`/api/suppliers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(params),
    }),

  testConnection: (id: number) =>
    request<{ supplier: Supplier }>(`/api/suppliers/${id}/test-connection`, { method: "POST" }),

  setSupplierEnabled: (id: number, enabled: boolean) =>
    request<{ supplier: Supplier }>(`/api/suppliers/${id}/enabled`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),

  removeSupplier: (id: number) => request<void>(`/api/suppliers/${id}`, { method: "DELETE" }),

  getOverview: () => request<OverviewStats>("/api/overview"),

  getAutoOrderEnabled: () => request<{ enabled: boolean }>("/api/config/auto-order-enabled"),

  setAutoOrderEnabled: (enabled: boolean) =>
    request<{ enabled: boolean }>("/api/config/auto-order-enabled", {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),

  listProducts: () => request<{ products: ProductRow[] }>("/api/products"),

  listOrders: () => request<{ orders: OrderRow[] }>("/api/orders"),

  listLogs: (type?: string) =>
    request<{ logs: LogRow[] }>(`/api/logs${type ? `?type=${encodeURIComponent(type)}` : ""}`),

  listScouted: () => request<{ scoutedProducts: ScoutedProduct[] }>("/api/scouted"),

  pullScoutedNow: () => request<{ fetched: number; stored: number; result: string; errorMessage: string | null }>(
    "/api/scouted/pull", { method: "POST" }
  ),

  approveScouted: (id: number) => request<{ id: number; status: string }>(`/api/scouted/${id}/approve`, { method: "POST" }),

  discardScouted: (id: number) => request<{ id: number; status: string }>(`/api/scouted/${id}/discard`, { method: "POST" }),

  deleteScouted: (id: number) => request<void>(`/api/scouted/${id}`, { method: "DELETE" }),

  clearScouted: () => request<{ deleted: number }>("/api/scouted", {
    method: "DELETE",
    body: JSON.stringify({ confirm: true }),
  }),

  /** Returns exactly what would be sent to eBay — no side effects. */
  previewListing: (id: number) =>
    request<ListingPreview>(`/api/scouted/${id}/preview`),

  /**
   * Runs the full listing pipeline with force:true — bypasses the review queue.
   * Call this from the "Publish to eBay" button after the operator has
   * confirmed the preview.
   */
  publishListing: (
    id: number,
    opts?: { categoryId?: string; imageUrls?: string[] }
  ) =>
    request<{ success: boolean; listingId?: string; offerId?: string; ebaySku?: string; price?: number }>(
      `/api/scouted/${id}/publish`,
      { method: "POST", body: JSON.stringify(opts ?? {}) }
    ),

  /** Sets or replaces the eBay category ID on a scouted item. */
  setCategoryId: (id: number, categoryId: string) =>
    request<{ id: number; ebay_category_id: string }>(
      `/api/scouted/${id}/category`,
      { method: "PATCH", body: JSON.stringify({ categoryId }) }
    ),

  /** Replaces the image URL list on a scouted item (max 24). */
  setImageUrls: (id: number, imageUrls: string[]) =>
    request<{ id: number; image_urls: string[] }>(
      `/api/scouted/${id}/images`,
      { method: "PATCH", body: JSON.stringify({ imageUrls }) }
    ),

  deleteLog: (id: number) => request<void>(`/api/logs/${id}`, { method: "DELETE" }),

  clearLogs: (type?: string) =>
    request<{ deleted: number }>(`/api/logs${type ? `?type=${encodeURIComponent(type)}` : ""}`, { method: "DELETE" }),

  getSettings: () => request<{ settings: CoreSettings; serverInfo: ServerInfo }>("/api/settings"),

  patchSettings: (patch: Partial<CoreSettings>) =>
    request<{ settings: CoreSettings; serverInfo: ServerInfo }>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ success: boolean }>("/api/settings/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // ── Scrapers ───────────────────────────────────────────────────────────────
  listScrapers: () =>
    request<{ scrapers: Scraper[] }>("/api/scrapers"),

  connectScraper: (connectionToken: string, name?: string) =>
    request<{ scraper: Scraper }>("/api/scrapers/connect", {
      method: "POST",
      body: JSON.stringify({ connectionToken, name }),
    }),

  testScraper: (id: number) =>
    request<{ scraper: Scraper }>(`/api/scrapers/${id}/test`, { method: "POST" }),

  disconnectScraper: (id: number) =>
    request<void>(`/api/scrapers/${id}`, { method: "DELETE" }),

  // ── AI Providers ───────────────────────────────────────────────────────────
  listAiProviders: () =>
    request<{ providers: AiProvider[] }>("/api/ai-providers"),

  addAiProvider: (params: {
    name: string;
    providerType: AiProvider["providerType"];
    baseUrl: string;
    apiKey: string;
    model: string;
  }) =>
    request<{ provider: AiProvider; reason?: string }>("/api/ai-providers", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  updateAiProvider: (
    id: number,
    params: {
      name?: string;
      providerType?: AiProvider["providerType"];
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      enabled?: boolean;
    }
  ) =>
    request<{ provider: AiProvider; reason?: string }>(`/api/ai-providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(params),
    }),

  testAiProvider: (id: number) =>
    request<{ provider: AiProvider; reason?: string }>(`/api/ai-providers/${id}/test`, { method: "POST" }),

  deleteAiProvider: (id: number) =>
    request<void>(`/api/ai-providers/${id}`, { method: "DELETE" }),

  generateAiListing: (id: number) =>
    request<{
      id: number;
      aiTitle: string;
      aiDescription: string;
      metaTitle: string;
      metaDescription: string;
      metaGeneratedAt: string;
      metaGenerationSource: string;
    }>(
      `/api/scouted/${id}/generate-ai`,
      { method: "POST" }
    ),

  /** Persist operator-edited SEO fields without re-running AI. */
  saveSeoFields: (id: number, fields: { metaTitle?: string; metaDescription?: string }) =>
    request<{ id: number; metaTitle?: string; metaDescription?: string }>(
      `/api/scouted/${id}/seo`,
      { method: "PATCH", body: JSON.stringify(fields) }
    ),

  /** Bulk regenerate SEO fields — calls the CLI-equivalent batch endpoint. */
  regenerateSeoAll: (filter?: { supplierId?: number; missingOnly?: boolean }) =>
    request<{ queued: number; message: string }>(
      "/api/scouted/regenerate-seo",
      { method: "POST", body: JSON.stringify(filter ?? {}) }
    ),

  // ── Analytics ─────────────────────────────────────────────────────────────

  getAnalyticsSummary: (from?: string, to?: string) =>
    request<AnalyticsSummary>(
      `/api/analytics/summary${buildDateQS(from, to)}`
    ),

  getAnalyticsProducts: () =>
    request<{ products: AnalyticsProduct[] }>("/api/analytics/products"),

  getAnalyticsSuppliers: () =>
    request<{ scorecards: SupplierScorecard[] }>("/api/analytics/suppliers"),

  getAnalyticsFunnel: (from?: string, to?: string) =>
    request<AnalyticsFunnel>(
      `/api/analytics/funnel${buildDateQS(from, to)}`
    ),

  getMarginAlerts: () =>
    request<MarginAlerts>("/api/analytics/margin-alerts"),
};
