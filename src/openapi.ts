/**
 * OpenAPI 3.0 specification for the Core Service REST API.
 *
 * Served at GET /api-docs (Swagger UI) and GET /api-docs/spec.json (raw JSON).
 * All authenticated routes require the X-Auth-Token header obtained from
 * POST /api/auth/login.
 *
 * To regenerate after adding routes: update this file and redeploy.
 * The spec is intentionally hand-maintained (not auto-generated from code)
 * so it stays accurate and readable — auto-generation from Express routes
 * produces noisy output that's harder to keep accurate than a curated spec.
 */

const spec = {
  openapi: "3.0.3",
  info: {
    title: "Core Service API",
    version: "1.0.0",
    description: `
REST API for the Core Service — CJ Dropshipping ↔ eBay automation engine.

**Authentication:** All routes except \`/health\`, \`/api/auth/login\`, and the
scraper push endpoint require an \`X-Auth-Token\` header. Obtain a token by
calling \`POST /api/auth/login\`.

**Base URL (local dev):** \`http://127.0.0.1:4000\`

**Interactive docs:** You are here. The Swagger UI lets you try every endpoint
directly — use the Authorize button to enter your session token first.
    `.trim(),
    contact: { name: "Core Service", url: "https://github.com" },
  },
  servers: [
    { url: "http://127.0.0.1:4000", description: "Local development" },
    { url: "https://your-service.railway.app", description: "Production (Railway)" },
  ],
  components: {
    securitySchemes: {
      sessionToken: {
        type: "apiKey" as const,
        in: "header",
        name: "X-Auth-Token",
        description: "Session token from POST /api/auth/login",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: { error: { type: "string" } },
        required: ["error"],
      },
      Supplier: {
        type: "object",
        properties: {
          id:              { type: "integer" },
          supplierKey:     { type: "string", example: "CJ" },
          displayName:     { type: "string" },
          maskedApiKey:    { type: "string", nullable: true },
          maskedApiSecret: { type: "string", nullable: true },
          status:          { type: "string", enum: ["unconfigured","connected","failed","disabled"] },
          lastTestedAt:    { type: "string", format: "date-time", nullable: true },
          marginOverride:  { type: "number", nullable: true },
          feeOverride:     { type: "number", nullable: true },
          createdAt:       { type: "string", format: "date-time" },
          updatedAt:       { type: "string", format: "date-time" },
        },
      },
      ProductRow: {
        type: "object",
        properties: {
          internal_sku:        { type: "string" },
          product_title:       { type: "string" },
          supplier_type:       { type: "string" },
          supplier_variant_id: { type: "string" },
          current_price:       { type: "number", nullable: true },
          current_stock:       { type: "integer", nullable: true },
          last_synced_at:      { type: "string", format: "date-time", nullable: true },
          ebay_sku:            { type: "string", nullable: true },
        },
      },
      OrderRow: {
        type: "object",
        properties: {
          id:                       { type: "integer" },
          ebay_order_id:            { type: "string" },
          supplier_type:            { type: "string" },
          supplier_order_id:        { type: "string", nullable: true },
          status:                   { type: "string", enum: ["pending","submitted","shipped","fulfilled","failed","skipped_auto_order_disabled"] },
          tracking_number:          { type: "string", nullable: true },
          carrier:                  { type: "string", nullable: true },
          fulfillment_failure_count:{ type: "integer" },
          quarantined:              { type: "integer", enum: [0,1] },
          created_at:               { type: "string", format: "date-time" },
          updated_at:               { type: "string", format: "date-time" },
        },
      },
      ScoutedProduct: {
        type: "object",
        properties: {
          id:                    { type: "integer" },
          title:                 { type: "string" },
          source_url:            { type: "string", nullable: true },
          scraped_price:         { type: "number", nullable: true },
          matched_supplier:      { type: "string", nullable: true },
          matched_cost:          { type: "number", nullable: true },
          estimated_margin:      { type: "number", nullable: true },
          trend_signal:          { type: "string", nullable: true },
          status:                { type: "string", enum: ["pending_review","approved","discarded"] },
          listing_status:        { type: "string", enum: ["none","queued","vero_blocked","quality_fail","publishing","published","failed"] },
          ebay_listing_id:       { type: "string", nullable: true },
          ebay_category_id:      { type: "string", nullable: true },
          image_urls:            { type: "string", nullable: true, description: "JSON-encoded array of image URLs" },
          listing_error:         { type: "string", nullable: true },
          ai_title:              { type: "string", nullable: true },
          ai_description:        { type: "string", nullable: true },
          meta_title:            { type: "string", nullable: true },
          meta_description:      { type: "string", nullable: true },
          meta_generated_at:     { type: "string", format: "date-time", nullable: true },
          meta_generation_source:{ type: "string", nullable: true },
          scouted_at:            { type: "string", format: "date-time" },
          created_at:            { type: "string", format: "date-time" },
          updated_at:            { type: "string", format: "date-time" },
        },
      },
      LogRow: {
        type: "object",
        properties: {
          id:            { type: "integer" },
          run_at:        { type: "string", format: "date-time" },
          type:          { type: "string", enum: ["price_stock","order_routing","fulfillment_tracking","scout_pull"] },
          result:        { type: "string", enum: ["success","partial_failure","failure"] },
          error_message: { type: "string", nullable: true },
          details_json:  { type: "string", nullable: true },
        },
      },
      OverviewStats: {
        type: "object",
        properties: {
          lastSyncRun:              { type: "object", nullable: true, properties: { runAt: { type: "string" }, result: { type: "string" } } },
          lastOrderRoutingRun:      { type: "object", nullable: true },
          lastFulfillmentRun:       { type: "object", nullable: true },
          productsTracked:          { type: "integer" },
          ordersReceivedToday:      { type: "integer" },
          ordersPlacedToday:        { type: "integer" },
          failedJobsLast24h:        { type: "integer" },
          scoutPullFailuresLast24h: { type: "integer" },
          autoOrderEnabled:         { type: "boolean" },
          activeAlerts:             { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  security: [{ sessionToken: [] }],
  paths: {
    // ── Health ──────────────────────────────────────────────────────────────
    "/health": {
      get: {
        tags: ["System"],
        summary: "Health check",
        description: "Returns OK. No authentication required. Used by Railway healthcheck.",
        security: [],
        responses: {
          "200": { description: "Service is up", content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", example: "ok" }, service: { type: "string" }, timestamp: { type: "string", format: "date-time" } } } } } },
        },
      },
    },

    // ── Auth ─────────────────────────────────────────────────────────────────
    "/api/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Log in",
        description: "Authenticates with the dashboard password. Returns a session token to use as X-Auth-Token.",
        security: [],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["password"], properties: { password: { type: "string" } } } } } },
        responses: {
          "200": { description: "Token issued", content: { "application/json": { schema: { type: "object", properties: { token: { type: "string" } } } } } },
          "400": { description: "Missing password" },
          "401": { description: "Wrong password" },
          "429": { description: "Rate limited (10 failed attempts / 15 min)" },
        },
      },
    },
    "/api/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Log out",
        description: "Invalidates the current session token.",
        responses: {
          "200": { description: "Logged out", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" } } } } } },
          "401": { description: "Not authenticated" },
        },
      },
    },

    // ── Overview ─────────────────────────────────────────────────────────────
    "/api/overview": {
      get: {
        tags: ["Overview"],
        summary: "Dashboard stats",
        description: "Returns job health, order counts, and active alert list for the Overview page.",
        responses: {
          "200": { description: "Stats", content: { "application/json": { schema: { "$ref": "#/components/schemas/OverviewStats" } } } },
        },
      },
    },
    "/api/overview/setup-status": {
      get: {
        tags: ["Overview"],
        summary: "Setup checklist status",
        description: "Returns which onboarding steps are complete (eBay configured, supplier connected, AI provider connected).",
        responses: {
          "200": { description: "Status flags", content: { "application/json": { schema: { type: "object", properties: { ebayConfigured: { type: "boolean" }, supplierConnected: { type: "boolean" }, aiProviderConfigured: { type: "boolean" } } } } } },
        },
      },
    },
    "/api/config/auto-order-enabled": {
      get: {
        tags: ["Overview"],
        summary: "Get auto-order state",
        responses: { "200": { description: "Current state", content: { "application/json": { schema: { type: "object", properties: { enabled: { type: "boolean" } } } } } } },
      },
      patch: {
        tags: ["Overview"],
        summary: "Toggle auto-order",
        description: "Flips AUTO_ORDER_ENABLED. Takes effect on the next scheduler tick without a restart.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } } } } },
        responses: {
          "200": { description: "New state" },
          "400": { description: "enabled must be boolean" },
        },
      },
    },
    "/api/seller-health": {
      get: {
        tags: ["Overview"],
        summary: "eBay seller performance metrics",
        description: "Calls /sell/analytics/v1/seller_standards_profile and derives an alertLevel. Response is cached for 1 hour. Returns null profile gracefully when eBay not configured or sandbox.",
        responses: {
          "200": {
            description: "Seller health",
            content: { "application/json": { schema: { type: "object", properties: {
              profile:          { type: "object", nullable: true },
              alertLevel:       { type: "string", enum: ["ok","warning","critical"] },
              alerts:           { type: "array", items: { type: "string" } },
              fetchedAt:        { type: "string", format: "date-time" },
              unavailableReason:{ type: "string" },
            } } } },
          },
        },
      },
    },

    // ── Products ─────────────────────────────────────────────────────────────
    "/api/products": {
      get: {
        tags: ["Products"],
        summary: "List all tracked variants",
        responses: {
          "200": { description: "Products", content: { "application/json": { schema: { type: "object", properties: { products: { type: "array", items: { "$ref": "#/components/schemas/ProductRow" } } } } } } },
        },
      },
    },
    "/api/products/{sku}/price": {
      patch: {
        tags: ["Products"],
        summary: "Override variant price inline",
        description: "Sets current_price and ebay_push_pending=1 so the next sync cycle pushes the change to eBay.",
        parameters: [{ in: "path", name: "sku", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["price"], properties: { price: { type: "number", minimum: 0, maximum: 100000 } } } } } },
        responses: {
          "200": { description: "Updated", content: { "application/json": { schema: { type: "object", properties: { internalSku: { type: "string" }, currentPrice: { type: "number" } } } } } },
          "400": { description: "Invalid price" },
          "404": { description: "SKU not found" },
        },
      },
    },

    // ── Orders ────────────────────────────────────────────────────────────────
    "/api/orders": {
      get: {
        tags: ["Orders"],
        summary: "List all orders",
        responses: {
          "200": { description: "Orders", content: { "application/json": { schema: { type: "object", properties: { orders: { type: "array", items: { "$ref": "#/components/schemas/OrderRow" } } } } } } },
        },
      },
    },

    // ── Logs ──────────────────────────────────────────────────────────────────
    "/api/logs": {
      get: {
        tags: ["Logs"],
        summary: "List sync logs",
        parameters: [
          { in: "query", name: "type", schema: { type: "string", enum: ["price_stock","order_routing","fulfillment_tracking","scout_pull"] }, description: "Filter by job type" },
          { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
        ],
        responses: { "200": { description: "Logs", content: { "application/json": { schema: { type: "object", properties: { logs: { type: "array", items: { "$ref": "#/components/schemas/LogRow" } } } } } } }, "400": { description: "Invalid type" } },
      },
      delete: {
        tags: ["Logs"],
        summary: "Clear logs",
        parameters: [{ in: "query", name: "type", schema: { type: "string", enum: ["price_stock","order_routing","fulfillment_tracking","scout_pull"] }, description: "Filter by job type (omit to clear all)" }],
        responses: { "200": { description: "Deleted count", content: { "application/json": { schema: { type: "object", properties: { deleted: { type: "integer" } } } } } } },
      },
    },
    "/api/logs/{id}": {
      delete: {
        tags: ["Logs"],
        summary: "Delete a single log entry",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        responses: { "204": { description: "Deleted" }, "400": { description: "Invalid id" }, "404": { description: "Not found" } },
      },
    },

    // ── Suppliers ─────────────────────────────────────────────────────────────
    "/api/suppliers/available-plugins": {
      get: {
        tags: ["Suppliers"],
        summary: "List available supplier plugins",
        description: "Returns the plugins that can be added via the dashboard. TEST is excluded.",
        responses: { "200": { description: "Plugins", content: { "application/json": { schema: { type: "object", properties: { plugins: { type: "array", items: { type: "object", properties: { key: { type: "string" }, displayName: { type: "string" } } } } } } } } },
        },
      },
    },
    "/api/suppliers": {
      get: {
        tags: ["Suppliers"],
        summary: "List configured suppliers",
        description: "Returns all supplier rows with API keys masked (last 4 chars only).",
        responses: { "200": { description: "Suppliers", content: { "application/json": { schema: { type: "object", properties: { suppliers: { type: "array", items: { "$ref": "#/components/schemas/Supplier" } } } } } } } },
      },
      post: {
        tags: ["Suppliers"],
        summary: "Add a supplier",
        description: "Encrypts credentials, inserts the row, and immediately tests the connection.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["supplierKey","apiKey"], properties: { supplierKey: { type: "string", example: "CJ" }, displayName: { type: "string" }, apiKey: { type: "string" }, apiSecret: { type: "string" } } } } } },
        responses: { "201": { description: "Created", content: { "application/json": { schema: { type: "object", properties: { supplier: { "$ref": "#/components/schemas/Supplier" } } } } } }, "400": { description: "Missing required field or unsupported plugin" } },
      },
    },
    "/api/suppliers/{id}": {
      patch: {
        tags: ["Suppliers"],
        summary: "Edit supplier credentials or pricing overrides",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { displayName: { type: "string" }, apiKey: { type: "string" }, apiSecret: { type: "string" }, marginOverride: { type: "number", nullable: true }, feeOverride: { type: "number", nullable: true } } } } } },
        responses: { "200": { description: "Updated supplier" }, "404": { description: "Not found" } },
      },
      delete: {
        tags: ["Suppliers"],
        summary: "Remove a supplier",
        description: "Blocked if variants still reference this supplier_key (409).",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        responses: { "204": { description: "Deleted" }, "404": { description: "Not found" }, "409": { description: "Variants still reference this supplier" } },
      },
    },
    "/api/suppliers/{id}/test-connection": {
      post: {
        tags: ["Suppliers"],
        summary: "Test supplier connection",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "Updated supplier with new status" } },
      },
    },
    "/api/suppliers/{id}/enabled": {
      patch: {
        tags: ["Suppliers"],
        summary: "Enable or disable a supplier",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } } } } },
        responses: { "200": { description: "Updated supplier" } },
      },
    },

    // ── Scouted ───────────────────────────────────────────────────────────────
    "/api/scouted": {
      get: {
        tags: ["Scouted"],
        summary: "List all scouted items",
        responses: { "200": { description: "Items", content: { "application/json": { schema: { type: "object", properties: { scoutedProducts: { type: "array", items: { "$ref": "#/components/schemas/ScoutedProduct" } } } } } } } },
      },
      post: {
        tags: ["Scouted"],
        summary: "Push a new scouted item (scraper endpoint)",
        description: "Authenticated by Bearer key (not session token). Used by external scrapers.",
        security: [{ "bearerAuth": [] }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title"], properties: { title: { type: "string" }, sourceUrl: { type: "string" }, scrapedPrice: { type: "number" }, trendSignal: { type: "string" } } } } } },
        responses: { "201": { description: "Created" }, "400": { description: "Invalid payload" }, "401": { description: "Invalid API key" } },
      },
      delete: {
        tags: ["Scouted"],
        summary: "Bulk delete all scouted items",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["confirm"], properties: { confirm: { type: "boolean", enum: [true] } } } } } },
        responses: { "200": { description: "Deleted count" }, "400": { description: "confirm:true not supplied" } },
      },
    },
    "/api/scouted/pull": {
      post: {
        tags: ["Scouted"],
        summary: "Trigger a pull from Scout Service",
        description: "Manually triggers the Scout pull job. Returns 502 if Scout Service is unreachable.",
        responses: { "200": { description: "Pull summary" }, "502": { description: "Scout Service unreachable" } },
      },
    },
    "/api/scouted/regenerate-seo": {
      post: {
        tags: ["Scouted"],
        summary: "Bulk regenerate SEO fields",
        description: "Processes up to 100 items in a background fire-and-forget loop. Returns immediately.",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { missingOnly: { type: "boolean", default: true }, status: { type: "string", enum: ["pending_review","approved","discarded"] } } } } } },
        responses: { "200": { description: "Queued count and message" } },
      },
    },
    "/api/scouted/{id}": {
      delete: {
        tags: ["Scouted"],
        summary: "Delete a scouted item",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        responses: { "204": { description: "Deleted" }, "404": { description: "Not found" } },
      },
    },
    "/api/scouted/{id}/approve": {
      post: {
        tags: ["Scouted"],
        summary: "Approve a scouted item",
        description: "Sets status=approved. If AUTO_LIST_ENABLED=true, triggers the listing pipeline asynchronously.",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { updatedAt: { type: "string", description: "Optimistic lock — supply to detect concurrent edits" } } } } } },
        responses: { "200": { description: "Approved" }, "409": { description: "Concurrent edit detected" } },
      },
    },
    "/api/scouted/{id}/discard": {
      post: {
        tags: ["Scouted"],
        summary: "Discard a scouted item",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { updatedAt: { type: "string" } } } } } },
        responses: { "200": { description: "Discarded" }, "409": { description: "Concurrent edit detected" } },
      },
    },
    "/api/scouted/{id}/generate-ai": {
      post: {
        tags: ["Scouted"],
        summary: "Generate AI listing + SEO content",
        description: "Single AI call returning listingTitle, htmlDescription, metaTitle, metaDescription. Runs VeRO check on meta fields.",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "Generated fields" }, "400": { description: "No AI provider configured" }, "422": { description: "Meta fields blocked by VeRO" } },
      },
    },
    "/api/scouted/{id}/seo": {
      patch: {
        tags: ["Scouted"],
        summary: "Save operator-edited SEO fields",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { metaTitle: { type: "string", maxLength: 60 }, metaDescription: { type: "string", maxLength: 160 } } } } } },
        responses: { "200": { description: "Saved" }, "400": { description: "Validation error" } },
      },
    },
    "/api/scouted/{id}/preview": {
      get: {
        tags: ["Scouted"],
        summary: "Preview listing (no side effects)",
        description: "Returns exactly what would be sent to eBay including VeRO check result and quality gate issues. Never writes to DB or eBay.",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "Listing preview with canPublish flag" }, "404": { description: "Not found" } },
      },
    },
    "/api/scouted/{id}/publish": {
      post: {
        tags: ["Scouted"],
        summary: "Publish listing to eBay",
        description: "Runs the full pipeline: AI → VeRO → quality gate → pricing → product/variant rows → eBay Inventory API. Bypasses review queue (force=true).",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { categoryId: { type: "string" }, imageUrls: { type: "array", items: { type: "string" } } } } } } },
        responses: { "200": { description: "Published" }, "404": { description: "Not found" }, "409": { description: "Already published or in-progress" }, "422": { description: "VeRO blocked or quality gate failure" }, "503": { description: "eBay not configured" } },
      },
    },
    "/api/scouted/{id}/category": {
      patch: {
        tags: ["Scouted"],
        summary: "Set eBay category ID",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["categoryId"], properties: { categoryId: { type: "string" } } } } } },
        responses: { "200": { description: "Saved" }, "404": { description: "Not found" } },
      },
    },
    "/api/scouted/{id}/images": {
      patch: {
        tags: ["Scouted"],
        summary: "Set image URLs",
        description: "Replaces the entire image list. Maximum 24 images. All URLs must be http/https.",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["imageUrls"], properties: { imageUrls: { type: "array", items: { type: "string", format: "uri" }, maxItems: 24 } } } } } },
        responses: { "200": { description: "Saved" }, "400": { description: "Validation error" } },
      },
    },

    // ── Settings ─────────────────────────────────────────────────────────────
    "/api/settings": {
      get: {
        tags: ["Settings"],
        summary: "Get all settings",
        description: "Returns all config values. Sensitive fields (API secrets, tokens) are masked to last 4 chars.",
        responses: { "200": { description: "Settings + server info" } },
      },
      patch: {
        tags: ["Settings"],
        summary: "Update settings",
        description: "Partial update — only supply fields you want to change. Empty string for a secret field is ignored (prevents accidental clearing).",
        requestBody: { content: { "application/json": { schema: { type: "object", description: "Any subset of CoreSettings fields" } } } },
        responses: { "200": { description: "Updated settings" }, "400": { description: "Validation error" } },
      },
    },
    "/api/settings/change-password": {
      post: {
        tags: ["Settings"],
        summary: "Change dashboard password",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["currentPassword","newPassword"], properties: { currentPassword: { type: "string" }, newPassword: { type: "string", minLength: 8 } } } } } },
        responses: { "200": { description: "Changed (session invalidated)" }, "400": { description: "Validation error" }, "401": { description: "Wrong current password" } },
      },
    },

    // ── Analytics ─────────────────────────────────────────────────────────────
    "/api/analytics/summary": {
      get: {
        tags: ["Analytics"],
        summary: "P&L summary + daily time-series",
        parameters: [
          { in: "query", name: "from", schema: { type: "string", format: "date" }, example: "2026-08-01" },
          { in: "query", name: "to",   schema: { type: "string", format: "date" }, example: "2026-08-31" },
        ],
        responses: { "200": { description: "Totals, daily series, date range, disclaimer note" } },
      },
    },
    "/api/analytics/products": {
      get: {
        tags: ["Analytics"],
        summary: "Per-product profitability table",
        responses: { "200": { description: "Array of product profitability rows" } },
      },
    },
    "/api/analytics/suppliers": {
      get: {
        tags: ["Analytics"],
        summary: "Supplier scorecards",
        responses: { "200": { description: "Per-supplier scorecard array" } },
      },
    },
    "/api/analytics/funnel": {
      get: {
        tags: ["Analytics"],
        summary: "Scout → approve → list → sell funnel",
        parameters: [
          { in: "query", name: "from", schema: { type: "string", format: "date" } },
          { in: "query", name: "to",   schema: { type: "string", format: "date" } },
        ],
        responses: { "200": { description: "Stage counts and drop-off rates" } },
      },
    },
    "/api/analytics/margin-alerts": {
      get: {
        tags: ["Analytics"],
        summary: "Variants below margin floor",
        description: "Returns variants whose estimated gross margin % is below MARGIN_FLOOR_PERCENT (default 10%).",
        responses: { "200": { description: "Alert list + floor percentage" } },
      },
    },

    // ── AI Providers ──────────────────────────────────────────────────────────
    "/api/ai-providers": {
      get:  { tags: ["AI Providers"], summary: "List AI providers",        responses: { "200": { description: "Provider list" } } },
      post: { tags: ["AI Providers"], summary: "Add AI provider",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name","providerType","baseUrl","apiKey","model"], properties: { name: { type: "string" }, providerType: { type: "string", enum: ["openai_compatible","gemini","cohere"] }, baseUrl: { type: "string" }, apiKey: { type: "string" }, model: { type: "string" } } } } } },
        responses: { "201": { description: "Created" } } },
    },
    "/api/ai-providers/{id}": {
      patch:  { tags: ["AI Providers"], summary: "Edit AI provider",  parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }], responses: { "200": { description: "Updated" } } },
      delete: { tags: ["AI Providers"], summary: "Delete AI provider", parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }], responses: { "204": { description: "Deleted" } } },
    },
    "/api/ai-providers/{id}/test": {
      post: { tags: ["AI Providers"], summary: "Test AI provider connectivity", parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }], responses: { "200": { description: "Test result with status and reason" } } },
    },

    // ── Scrapers ──────────────────────────────────────────────────────────────
    "/api/scrapers": {
      get: { tags: ["Scrapers"], summary: "List connected scrapers", responses: { "200": { description: "Scraper list" } } },
    },
    "/api/scrapers/connect": {
      post: {
        tags: ["Scrapers"],
        summary: "Connect a new scraper",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["connectionToken"], properties: { connectionToken: { type: "string" }, name: { type: "string" } } } } } },
        responses: { "201": { description: "Connected" } },
      },
    },
    "/api/scrapers/{id}/test": {
      post: { tags: ["Scrapers"], summary: "Test scraper connection", parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }], responses: { "200": { description: "Test result" } } },
    },
    "/api/scrapers/{id}": {
      delete: { tags: ["Scrapers"], summary: "Disconnect scraper", parameters: [{ in: "path", name: "id", required: true, schema: { type: "integer" } }], responses: { "204": { description: "Disconnected" } } },
    },

    // ── Emergency Stop ────────────────────────────────────────────────────────
    "/api/emergency-stop": {
      get: {
        tags: ["Emergency Stop"],
        summary: "Get emergency stop state",
        responses: { "200": { description: "State: emergencyStopped, autoOrderEnabled, stoppedAt, reason" } },
      },
      post: {
        tags: ["Emergency Stop"],
        summary: "Trigger emergency stop",
        description: "Immediately halts all four schedulers, sets EMERGENCY_STOP=true and AUTO_ORDER_ENABLED=false in DB. Service must be restarted to resume.",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string", maxLength: 500 } } } } } },
        responses: { "200": { description: "Confirmed stopped with stoppedAt and message" } },
      },
    },
    "/api/emergency-stop/resume": {
      post: {
        tags: ["Emergency Stop"],
        summary: "Clear emergency stop flag",
        description: "Clears EMERGENCY_STOP. Does NOT restart schedulers — a service restart is required.",
        responses: { "200": { description: "Confirmed cleared with message" } },
      },
    },
  },
} as const;

export default spec;
