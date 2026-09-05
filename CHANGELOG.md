# Changelog

All notable changes to Core Service are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased] — staging branch

### Added
- OpenAPI 3.0 spec (`src/openapi.ts`) covering all ~50 routes
- Interactive Swagger UI at `/api-docs` (public, no auth required)
- `docs/` folder: architecture.md, setup.md, api-reference.md, runbook.md
- `CONTRIBUTING.md`: branch strategy, plugin extension guides, test conventions
- JSDoc on `pricing.ts`, `veroFilter.ts`, `retry.ts`
- Concise README.md pointing to docs/

---

## [0.12.0] — Business Protection & Safety

### Added
- **VeRO filter expansion** (3 layers): exact brand match, fuzzy/obfuscation
  detection (digit normalisation: 1→i, 0→o, 3→e), prohibited eBay keywords
  (weapons, drugs, counterfeit indicators — hardcoded in `veroFilter.ts`)
- `checkFullPolicy()` — unified pre-publish gate returning all three match types
- VeRO blocklist expanded from 31 → 90+ brands (apparel, luxury, electronics,
  entertainment, sports, automotive)
- **Emergency Stop**: `POST /api/emergency-stop` halts all 4 schedulers,
  persists `EMERGENCY_STOP=true` across restarts, `GET` reads state,
  `POST /resume` clears the flag
- Server startup: skips schedulers if `EMERGENCY_STOP=true` in DB
- `EmergencyStopBanner` in AppShell — full-width red banner when active
- Emergency Stop button + confirmation modal on OverviewPage
- **eBay seller health**: `EbayClient.getSellerStandards()` via Analytics API,
  `GET /api/seller-health` (1h cache, derives alertLevel ok/warning/critical)
- Seller health panel on OverviewPage with defect/lateship/cases metrics
- RUNBOOK.md sections 9–11: eBay account health, off-server backup strategy,
  single-point-of-failure map, second eBay account guidance

---

## [0.11.0] — UX/UI Polish

### Added
- **Bulk actions on Scouted Items**: checkbox column, select-all with
  indeterminate state, bulk Approve/Discard/Generate AI toolbar
- **Inline price editing on Products**: click price → `$` input → Enter/Esc;
  calls `PATCH /api/products/:sku/price` which sets `ebay_push_pending=1`
- Backend: `PATCH /api/products/:sku/price` + `GET /api/overview/setup-status`
- **Persistent notification center**: `NotificationProvider` (localStorage,
  max 50, 60s dedup); Bell icon with unread count badge; dropdown with Clear all
- OverviewPage polling pushes `danger` notifications on job failure increase
- **Keyboard navigation**: `useKeyboardNav` hook — `g+key` GitHub-style shortcuts,
  `?` help modal with `<kbd>` styling, suppressed inside inputs
- **Mobile-responsive layout**: AppShell sidebar → slide-in drawer on `<lg`,
  hamburger button, backdrop close; OrdersPage column hiding; responsive padding
- **Onboarding checklist** on OverviewPage: 3-step NavLink checklist, dismissible,
  auto-hides when all 3 complete; backend `GET /api/overview/setup-status`

---

## [0.10.0] — Multi-Supplier & Pricing Tiers

### Added
- **Pricing Tiers UI** in SettingsPage: inline add/remove cost-bracket rules,
  live formula preview, info banner explaining priority order
- `pricingTiersJson` field in `CoreSettings` + `runtimeConfigService`
- Fix: `setPricingOverrides` COALESCE bug — `null` now correctly clears overrides

---

## [0.9.0] — Analytics & Business Intelligence

### Added
- `GET /api/analytics/summary` — daily P&L time-series + totals (revenue, COGS, profit)
- `GET /api/analytics/products` — per-product profitability with margin %, days listed
- `GET /api/analytics/suppliers` — scorecards: variant count, avg margin, failure rate, ship time
- `GET /api/analytics/funnel` — scout → approve → list → order → ship drop-off counts
- `GET /api/analytics/margin-alerts` — variants below configurable margin floor
- AnalyticsPage: P&L chart (SVG), funnel bar chart, sortable products table,
  supplier scorecards, margin alerts table; CSV export on all tables
- Range selector: 7d / 30d / 90d / custom date range

---

## [0.8.0] — Auto-Listing Pipeline

### Added
- `autoListingService.ts` — full 7-step approve → publish pipeline:
  AI generation → VeRO → quality gate → pricing → product/variant creation → eBay publish
- `GET /api/scouted/:id/preview` — listing preview with no side effects
- `POST /api/scouted/:id/publish` — force-publish bypassing review queue
- `PATCH /api/scouted/:id/category` — set eBay category ID
- `PATCH /api/scouted/:id/images` — set image URL list (max 24)
- `POST /api/scouted/regenerate-seo` — bulk SEO field regeneration (fire-and-forget)
- Approve route wired to pipeline when `AUTO_LIST_ENABLED=true`
- **Listing Preview Modal** in ScoutedItemsPage: price/margin/title summary,
  VeRO + quality issues banner, image URL manager, category input, Publish button
- `listing_status` column and Live link to eBay listing in scouted table
- Settings: `autoListEnabled`, `ebayMerchantLocation`, `ebayMarketplaceId`

---

## [0.7.0] — SEO Layer

### Added
- `aiService.ts` extended: single AI call returns all 4 fields
  (listingTitle, htmlDescription, metaTitle, metaDescription)
- Server-side length enforcement (80/160 chars), plain-text sanitisation
  for meta fields, VeRO check on meta fields
- `meta_title`, `meta_description`, `meta_generated_at`, `meta_generation_source`
  columns on `scouted_products` and `products`
- `regenerateSeo.ts` CLI bulk backfill script
- Google SERP preview mockup in `AiContentModal`
- `seoAutoRegenerate` setting: auto-regenerates SEO on price change > 5%

---

## [0.6.0] — Testing & CI/CD

### Added
- Vitest test suite (70 tests): unit (pricing, VeRO, errors) + integration
  (dashboard API, order routing smoke, fulfillment + quarantine smoke)
- `makeTestDb()` helper: in-memory SQLite with full migrations and fixtures
- GitHub Actions CI workflow: typecheck → test:coverage on every push/PR
- GitHub Actions CD workflow: staging auto-deploy on master push;
  production requires manual approval via GitHub Environment + reviewer gate
- Husky pre-commit hooks: typecheck + full test suite before every commit
- Vitest coverage thresholds: 70% lines/functions/branches

---

## [0.5.0] — Reliability Phase

### Added
- CJPlugin, EbayClient: network errors now `isRetryable:true`; eBay 5xx retried;
  `AbortSignal.timeout(30s)` on all fetch calls
- Graceful shutdown: `stopAllSchedulers()` awaits in-flight jobs before `db.close()`
- Order quarantine: `fulfillment_failure_count`, `quarantined` on orders table;
  after 5 failures an order is excluded until manually cleared
- Sync idempotency: `ebay_push_pending` flag — set on DB update, cleared only
  after successful eBay push; next run recovers pending pushes automatically
- DB indexes: `idx_orders_status`, `idx_orders_quarantined`, `idx_variant_failures_quarantined`
- SQLite `busy_timeout=5000` pragma
- Log rotation: Winston file transport 10MB/5 files, `tailable:true`
- Schema fix: partial indexes split to second pass in `applyMigrations`

---

## [0.4.0] — Safety Net (Git Baseline)

### Added
- Git repository initialized, v0-baseline tag
- `.gitignore` refined: `data/*.db`, `logs/*.log`, `node_modules/`, `dist/`
- `.gitattributes` for LF normalization
- `docker-compose.staging.yml`: mirrors production with `AUTO_ORDER_ENABLED=false`
  and `EBAY_ENVIRONMENT=sandbox` hardcoded, separate named volumes, port 4001
- `scripts/backup-db.sh` + `scripts/backup-db.ps1`: hot SQLite backup with retention
- `RUNBOOK.md`: rollback procedure, staging setup, backup/restore, pre-deploy checklist

---

## [0.3.0] — Scout Integration (Phase 8)

### Added
- `scoutPullService.ts`: pulls trending candidates from Scout Service
- `scouted_products` table with listing pipeline fields
- `/api/scouted` routes: push (Bearer auth), list, pull, approve, discard, delete, bulk delete
- Scout pull resilience: 8-second timeout, never blocks Core if Scout is down
- ScoutedItemsPage: review table, approve/discard/delete actions

---

## [0.2.0] — Dashboard & Job Loops (Phases 4–7)

### Added
- Sync loop: polls supplier per variant, updates price/stock, pushes to eBay
- Order routing loop: polls eBay for paid orders, routes to supplier
- Fulfillment loop: polls supplier for tracking, pushes to eBay
- Job scheduler: cron-based, all 4 loops
- Dashboard API: `/api/overview`, `/api/products`, `/api/orders`, `/api/logs`
- `AUTO_ORDER_ENABLED` live toggle (no restart required)
- Circuit breaker: per-service open/half-open/closed, 5-failure threshold
- Variant quarantine: per-variant failure counter, 5-failure auto-quarantine
- Job locks: DB-backed mutex, stale-lock timeout, `releaseAllLocks` on startup
- Alert service: consecutive-failure webhook + Telegram alerts
- Per-supplier pricing overrides (`margin_override`, `fee_override`)
- Per-tier pricing rules (`PRICING_TIERS` JSON config)
- VeRO filter + pricing formula with per-supplier and per-tier rules
- CoreDash React frontend: Overview, Products, Orders, Logs, Suppliers, Settings pages

---

## [0.1.0] — Supplier Abstraction + eBay API (Phases 2–3)

### Added
- `SupplierProvider` interface
- `CJPlugin`: CJ Dropshipping API 2.0 (getStockAndPrice, createOrder, getOrderStatus, getTrackingInfo)
- `TestPlugin`: deterministic fake data for testing
- `CsvSupplierPlugin`: manual/webhook supplier with JSON catalogue file
- `supplierFactory.ts`: lazy registry + instance cache
- `withRetry`: exponential backoff (429, 5xx, ECONNRESET, ETIMEDOUT)
- eBay OAuth client: refresh-token flow, 5-min expiry buffer
- `EbayClient`: Inventory + Fulfillment API (createOrReplaceInventoryItem, createOffer, publishOffer, bulkUpdatePriceQuantity, getOrders, createShippingFulfillment)
- `EbayChannel` + `channelFactory`: SalesChannel abstraction layer
- AES-256-GCM encryption for supplier API keys
- Auth middleware: static token + scrypt password + rate limiter
- Suppliers API: CRUD + connection test + encrypted credential storage

---

## [0.0.1] — Foundation (Phase 1)

### Added
- Express server with health endpoint
- SQLite schema (variants, products, orders, sync_logs, config, suppliers)
- `applyMigrations`: idempotent schema + config seeding
- `loadConfig`: env validation, required field checks
- Winston logger (file + console, dual transport)
- `CoreConfig` type — single source of truth for all config values
