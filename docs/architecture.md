# Core Service — Architecture

## 1. What this system does

Core Service is a fully-automated dropshipping engine: it pulls product
candidates from Scout Service, lets you approve and publish them to eBay,
keeps prices and stock in sync with your supplier (CJ Dropshipping or a
manual/CSV supplier), routes paid eBay orders to the supplier, and tracks
fulfillment until the order is marked shipped.

Everything runs in a single Node.js process. There is no message queue,
no separate worker, no Redis. Complexity is kept low intentionally — this
is a single-operator business tool, not a multi-tenant platform.

---

## 2. Process map

```
┌─────────────────────────────────────────────────────────┐
│                    Core Service process                  │
│                                                         │
│  ┌──────────────┐    ┌─────────────────────────────┐   │
│  │  Express API │    │     Cron Schedulers (×4)     │   │
│  │  (port 4000) │    │                             │   │
│  │              │    │  price_stock      (15 min)  │   │
│  │  /api/*      │    │  order_routing    (15 min)  │   │
│  │  /api-docs   │    │  fulfillment      (15 min)  │   │
│  │  /health     │    │  scout_pull       (15 min)  │   │
│  └──────┬───────┘    └────────────┬────────────────┘   │
│         │                         │                     │
│         └──────────┬──────────────┘                     │
│                    │                                     │
│              ┌─────▼──────┐                             │
│              │  SQLite DB  │  (better-sqlite3, WAL)      │
│              │  core.db    │                             │
│              └─────────────┘                             │
└─────────────────────────────────────────────────────────┘
         │                        │
         ▼                        ▼
   eBay Sell API           CJ Dropshipping API
   (Inventory +            (Products, Orders,
    Fulfillment)            Tracking)
```

The React dashboard (`frontend/`) is built and served as static files from
the same Express process in production. In development, Vite runs on port
5173 and proxies API calls to port 4000.

---

## 3. Directory structure

```
core-service/
├── src/
│   ├── index.ts            # Express app entry point, server startup
│   ├── config.ts           # Env validation → CoreConfig object
│   ├── logger.ts           # Winston (file + console, log rotation)
│   ├── openapi.ts          # OpenAPI 3.0 spec (served at /api-docs)
│   │
│   ├── db/
│   │   ├── schema.sql      # SQLite schema (CREATE TABLE IF NOT EXISTS)
│   │   ├── migrate.ts      # Idempotent schema + seed migrations
│   │   └── connection.ts   # Singleton DB connection (WAL, busy_timeout)
│   │
│   ├── routes/             # Express routers (one file per resource group)
│   │   ├── auth.ts         # POST /api/auth/login|logout
│   │   ├── dashboard.ts    # GET /api/overview, /api/products, /api/orders, /api/logs
│   │   ├── scouted.ts      # /api/scouted/* (approve, publish, AI, SEO)
│   │   ├── suppliers.ts    # /api/suppliers/*
│   │   ├── settings.ts     # /api/settings
│   │   ├── analytics.ts    # /api/analytics/*
│   │   ├── aiProviders.ts  # /api/ai-providers/*
│   │   ├── scrapers.ts     # /api/scrapers/*
│   │   └── emergencyStop.ts# /api/emergency-stop
│   │
│   ├── jobs/               # Cron job logic (one file per job type)
│   │   ├── scheduler.ts    # Start/stop cron tasks, in-flight drain
│   │   ├── syncLoop.ts     # Price/stock sync per variant
│   │   ├── orderRoutingLoop.ts  # eBay → supplier order routing
│   │   ├── fulfillmentLoop.ts   # Supplier tracking → eBay fulfillment
│   │   └── scoutPullOnce.ts     # Manual scout pull CLI
│   │
│   ├── ebay/               # eBay API wrappers
│   │   ├── ebayAuth.ts     # OAuth2 refresh-token flow
│   │   ├── ebayClient.ts   # Inventory + Fulfillment + Analytics API
│   │   ├── ebayFactory.ts  # Builds EbayClient from CoreConfig
│   │   └── veroFilter.ts   # 3-layer VeRO/policy check
│   │
│   ├── suppliers/          # Supplier plugin system
│   │   ├── SupplierProvider.ts   # Interface every plugin must implement
│   │   ├── supplierFactory.ts    # Registry + lazy instance cache
│   │   ├── CJPlugin.ts           # CJ Dropshipping API 2.0
│   │   ├── CsvSupplierPlugin.ts  # Manual/webhook supplier
│   │   ├── TestPlugin.ts         # Deterministic fake data for tests
│   │   ├── retry.ts              # Exponential backoff (429, 5xx, network)
│   │   └── errors.ts             # SupplierApiError with isRetryable
│   │
│   ├── channels/           # Sales channel plugin system
│   │   ├── SalesChannel.ts  # Interface (createOrUpdateListing, getPaidOrders…)
│   │   ├── EbayChannel.ts   # Adapts EbayClient → SalesChannel interface
│   │   └── channelFactory.ts# Registry (EBAY registered; Shopify/Etsy commented)
│   │
│   ├── services/           # Business logic services
│   │   ├── alertService.ts         # Consecutive-failure streak + webhook/Telegram
│   │   ├── autoListingService.ts   # Approve → VeRO → quality → price → eBay publish
│   │   ├── circuitBreaker.ts       # Per-service open/half-open/closed state
│   │   ├── jobLock.ts              # DB-backed mutex (job_locks table)
│   │   ├── orderQuarantine.ts      # Per-order failure counter + quarantine
│   │   ├── overviewService.ts      # Stats for GET /api/overview
│   │   ├── quarantine.ts           # Per-variant failure counter + quarantine
│   │   ├── runtimeConfigService.ts # config table read/write (CoreSettings)
│   │   ├── scoutPullService.ts     # HTTP pull from Scout Service
│   │   └── suppliersService.ts     # Supplier CRUD + encrypted credential storage
│   │
│   ├── auth/               # Authentication helpers
│   │   ├── password.ts     # scrypt hash/verify + session token generation
│   │   └── rateLimit.ts    # In-memory IP rate limiter (10 fails / 15 min)
│   │
│   ├── crypto/
│   │   └── encryption.ts   # AES-256-GCM encrypt/decrypt for supplier keys
│   │
│   └── pricing.ts          # Pricing formula with per-supplier + per-tier rules
│
├── frontend/               # React + Vite dashboard
│   └── src/
│       ├── pages/          # One component per page
│       ├── components/     # AppShell, modals, UI primitives
│       └── lib/            # api.ts, searchContext, notificationContext, etc.
│
├── config/
│   └── vero-blocklist.txt  # Brand VeRO blocklist (one keyword per line)
│
├── tests/
│   ├── unit/               # Pricing, VeRO, SupplierApiError unit tests
│   ├── integration/        # Dashboard routes, order routing, fulfillment
│   └── helpers/            # makeTestDb, seedOrder, setTestConfig
│
├── scripts/
│   ├── backup-db.sh        # Linux/macOS hot backup via sqlite3 .backup
│   ├── backup-db.ps1       # Windows backup via better-sqlite3 Node API
│   └── apply-missing-columns.js  # One-shot migration for pre-phase DBs
│
└── docs/                   # This folder
    ├── architecture.md     # This file
    ├── setup.md            # First-run + Railway deploy guide
    ├── api-reference.md    # Route summary + link to /api-docs
    └── runbook.md          # If-X-do-Y incident playbook
```

---

## 4. Data flow — price/stock sync cycle

```
scheduler.ts  →  syncLoop.ts
                    │
                    ├─ isQuarantined(variant)?  → skip
                    ├─ circuitBreaker.isOpen(supplier)?  → skip
                    │
                    ├─ plugin.getStockAndPrice(variantId)
                    │   └─ CJPlugin / CsvSupplierPlugin / TestPlugin
                    │
                    ├─ calculateEbayPrice(cost, shipping, margin, fee, tiers)
                    │
                    ├─ UPDATE variants SET current_price, ebay_push_pending=1
                    │
                    └─ (if autoOrderEnabled && ebay_push_pending)
                        └─ ebayClient.bulkUpdatePriceQuantity(batch)
                            └─ UPDATE variants SET ebay_push_pending=0  ← idempotency flag
```

## 5. Data flow — order routing cycle

```
scheduler.ts  →  orderRoutingLoop.ts
                    │
                    ├─ circuitBreaker.isOpen(EBAY)?  → skip
                    ├─ ebayClient.getNewPaidOrders()
                    │
                    └─ for each order:
                        ├─ orders.ebay_order_id UNIQUE → idempotency guard
                        ├─ resolveOrderSupplierType(order, variants)
                        ├─ autoOrderEnabled?  → log only / submit
                        └─ plugin.createOrder(payload)
                            └─ INSERT orders (ebay_order_id, supplier_order_id, status)
```

## 6. Data flow — approve → publish listing pipeline

```
POST /api/scouted/:id/approve
    │
    └─ (if AUTO_LIST_ENABLED=true) → setImmediate(runListingPipeline)
                                              │
    POST /api/scouted/:id/publish  ───────────┤
                                              │
                                    autoListingService.ts
                                              │
                                    Step 1: generateListingContent (AI)
                                    Step 2: checkVero (exact + fuzzy + prohibited)
                                    Step 3: quality gate (title, desc, images, category)
                                    Step 4: calculateEbayPrice
                                    Step 5: INSERT products + variants
                                    Step 6: EbayClient (createOrReplaceInventoryItem
                                                        → createOffer → publishOffer)
                                    Step 7: UPDATE scouted_products (listing_status=published)
```

---

## 7. Key design decisions

### Why SQLite instead of Postgres?
Single-operator tool running on a single Railway service. SQLite in WAL
mode handles all the concurrency the sync loops produce (one writer at a
time, readers never block writers). No separate database service to manage,
no connection pooling, no network hop on every query. The DB file is a
single portable artifact — trivially backed up and restored.

### Why no message queue?
Same reasoning. Four in-process cron jobs + a DB mutex (`job_locks` table)
cover all the concurrency requirements without Redis/BullMQ/RabbitMQ. The
job_locks table provides cross-restart safety; in-memory flags provide the
fast-path skip for the same-process case.

### Why the plugin abstraction for suppliers?
`SupplierProvider` makes `syncLoop.ts`, `orderRoutingLoop.ts`, and
`fulfillmentLoop.ts` completely supplier-agnostic. Adding a new supplier =
write one file + one line in `supplierFactory.ts`. The same applies to
sales channels via `SalesChannel` and `channelFactory.ts`.

### Why per-variant `supplier_type` instead of a global setting?
Allows mixed-supplier catalogs: some variants from CJ, some from a CSV
supplier, routed correctly by the same job loops with no code changes.

### Why hand-maintained OpenAPI spec instead of auto-generation?
Auto-generation from Express routes (tsoa, swagger-jsdoc) adds significant
build complexity and produces noisy output. A curated spec is more readable,
stays accurate with explicit ownership, and doesn't require decorators or
comment syntax on every route.

### Why `setImmediate` for the auto-listing pipeline on approve?
The approve HTTP request must return immediately (< 100ms). The pipeline
makes multiple eBay API calls (each 200–2000ms). `setImmediate` fires after
the current event loop tick, letting the response go out before the pipeline
starts. The frontend polls listing_status every 8 seconds to pick up the result.

### Graceful shutdown strategy
On SIGTERM, `stopAllSchedulers()` stops future ticks and awaits
`Promise.allSettled` on all in-flight job promises. Only then does
`db.close()` run. This prevents SQLITE_MISUSE errors from a mid-transaction
close on Railway deploy/restart (which sends SIGTERM with a 10s grace period).
