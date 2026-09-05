# Core Service

Handles CJ Dropshipping / eBay authentication, product sync, order routing, and
fulfillment. Runs independently from the Scout Service — this service must be
able to run 24/7 without depending on the Scout Service being up.

## Project layout

```
core-service/
├── src/            # backend (Express API, sync/order/fulfillment loops)
├── frontend/        # the Core Dashboard (React + Vite)
├── config/           # VeRO blocklist, etc.
└── package.json      # running `npm run dev` here starts BOTH
```

The frontend lives inside this folder — it's not a separate project you run
on its own. One `npm install` and one `npm run dev` at the root of
`core-service/` sets up and starts both the backend and its dashboard
together, in the same terminal, like a normal full-stack app.

## Quick start

```bash
npm install                       # installs backend deps, then (via postinstall) frontend deps too
cp .env.example .env               # backend config — set DASHBOARD_AUTH_TOKEN + ENCRYPTION_KEY
cp frontend/.env.example frontend/.env   # frontend config — VITE_API_BASE, defaults are fine
npm run migrate                    # creates the database
npm run dev                        # starts backend (port 4000) + dashboard (port 5173) together
```

You'll see interleaved, labeled output from both:

```
[backend]  info: Core Service listening on http://127.0.0.1:4000
[frontend]   VITE ready — Local: http://127.0.0.1:5173/
```

Open **http://127.0.0.1:5173** for the dashboard. `Ctrl+C` stops both at once.

Need just the backend, or just the frontend, on their own (e.g. for
debugging)? `npm run dev:backend` or `npm run dev:frontend` run only one.

## Status: Phase 9 (final hardening)

### Secret handling audit

Went through every `logger.*` call in both services. Confirmed: no request
body, header, API key, API secret, or dashboard auth token is ever logged —
only booleans (`hasAccessToken: true`), truncated *response* bodies from
CJ/eBay (their replies, never our outbound credentials), and error messages
that originate from the external API's own response. Supplier keys remain
AES-256-GCM encrypted in `core.db` at all times (verified in Phase 2b by
inspecting the raw file).

### 429 retry/backoff — closed a gap

Found that `CJPlugin.getAuthToken()` and `EbayOAuthClient.refreshAccessToken()`
were making their fetch calls *outside* the `withRetry` wrapper the rest of
each client uses — meaning a 429 during authentication specifically would
not have retried. Both are now wrapped the same way as every other call.
Verified with an isolated test: a call that returns 429 twice then succeeds
completes correctly with 100ms/200ms backoff delays, while a non-429 error
(e.g. 401) is correctly *not* retried.

### Alert on repeated failure

`src/services/alertService.ts` tracks consecutive failures per job type
(`price_stock` / `order_routing` / `fulfillment_tracking`) in the `config`
table. Once a streak hits `ALERT_FAILURE_THRESHOLD` (default 3), it posts to
`ALERT_WEBHOOK_URL` (Slack-compatible `{"text": "..."}` payload — also works
for Discord's Slack-compatible webhooks, Mattermost, etc.) and/or a
Telegram bot (`ALERT_TELEGRAM_BOT_TOKEN` + `ALERT_TELEGRAM_CHAT_ID`), then
marks itself "fired" so it won't spam on every subsequent failure. A later
success clears both the streak count and the fired flag automatically. The
same state is surfaced on the dashboard's Overview page as a red banner via
`activeAlerts` in `GET /api/overview`.

**Verified with a real local webhook receiver** (a throwaway HTTP server,
since this environment can't reach real Slack/Telegram): forced 3
consecutive sync failures, confirmed the alert fired exactly once on the
3rd (not the 1st or 2nd), confirmed a 4th consecutive failure did *not*
re-fire it, then fixed the underlying issue and confirmed one success
cleared both the streak counter and the fired flag back to zero/false.

Set up your own alert destination:

```bash
# Slack: Settings → Apps → Incoming Webhooks → create one, paste the URL:
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/...

# Telegram: message @BotFather to create a bot, then message your new bot
# once and visit https://api.telegram.org/bot<TOKEN>/getUpdates to find your chat id:
ALERT_TELEGRAM_BOT_TOKEN=...
ALERT_TELEGRAM_CHAT_ID=...
```

### Localhost binding & auth — re-confirmed

Both services default to `HOST=127.0.0.1` in `.env.example`. Every
dashboard-facing route on both services requires `X-Auth-Token` (verified
across Phases 2b, 6b, 7b, 8 with real `401` responses on missing/wrong
tokens) — the one intentional exception is Scout's `/api/v1/scout-trends`,
which is the documented pull-model endpoint Core calls, and even that only
answers on localhost by default.

## Status: Phase 8 (connecting Scout to Core)

Adds `src/services/scoutPullService.ts` — pulls candidate items from the
Scout Service, matches them against products you already track, and stores
them in `scouted_products` for manual review. Also accepts items pushed
directly by the Scout Dashboard's "Send to Core Service for review" button.
**Never auto-publishes anything to eBay** — approval just marks status;
actually publishing is still the existing manual `publish-listing` flow.

### How matching works (and its limitation)

There's no "search a supplier's catalog by keyword" method on the
`SupplierProvider` interface (Section 4a only defines lookups by a known
ID), so this doesn't do a live CJ catalog search. Instead, each scraped
candidate's title is compared (case-insensitive substring match, either
direction) against products you already track locally. A match means "this
trending item looks like something we already sell" — useful for spotting
overlap, but not a real fuzzy-search engine. A `searchProducts(query)`
method on `SupplierProvider` would be the natural next step for true
catalog-wide matching.

### New endpoints (under `/api/scouted`, require `X-Auth-Token`)

| Method | Path              | Purpose                                    |
|--------|-------------------|----------------------------------------------|
| GET    | `/`               | List all scouted items                       |
| POST   | `/pull`           | Manually trigger a pull from Scout Service    |
| POST   | `/`               | Accept a single item pushed by Scout's "Send to Core" button |
| POST   | `/:id/approve`    | Mark approved (still requires manual publish) |
| POST   | `/:id/discard`    | Mark discarded                                |

### Resilience (the important part)

`pullFromScout()` has an 8-second timeout (`SCOUT_PULL_TIMEOUT_MS`) and
never throws — a Scout Service that's down, slow, or returns garbage is
caught, logged to `sync_logs` as a `scout_pull` failure, and everything
else keeps running. Proven by killing Scout Service entirely and confirming
the sync, order-routing, and fulfillment loops all completed their next
cycle completely normally, with only the scout pull itself failing cleanly.

### Try it yourself

```bash
# With scout-service running and migrated (see its own README):
npm run scout-pull-once
```

Or trigger it from the dashboard's Scouted Items page's "Pull now" button —
same underlying call. To test resilience: stop `scout-service` entirely,
run `npm run scout-pull-once` again, and confirm it fails gracefully with a
clear message rather than crashing.

## Status: Phase 6b (dashboard: Overview, Products, Orders, Logs)

Adds `src/routes/dashboard.ts` + `src/services/overviewService.ts` +
`src/services/runtimeConfigService.ts` — the REST endpoints behind the
remaining Core Dashboard pages, and the mechanism that lets
`AUTO_ORDER_ENABLED` be flipped from the UI **without restarting the
server**.

### How the live toggle works

`AUTO_ORDER_ENABLED` is normally set once in `.env` at boot. To make the
dashboard's toggle actually change behavior immediately, the sync,
order-routing loops now call `withLiveAutoOrderEnabled(db, config)` at the
**start of every run**, which overrides the boot-time value with whatever's
currently in the `config` DB table. `PATCH /api/config/auto-order-enabled`
writes to that same table. Net effect: flip the toggle in the browser, and
the very next scheduled cycle (or a manually-triggered `npm run sync-once` /
`order-routing-once`) picks it up — confirmed by testing that `.env` can
still say `false` while a toggled-on run actually submits a real order.

### New endpoints (all under `/api`, all require `X-Auth-Token`)

| Method | Path                          | Purpose                          |
|--------|-------------------------------|-----------------------------------|
| GET    | `/overview`                   | Last run per loop, counts, auto-order state |
| GET    | `/config/auto-order-enabled`  | Current live value                |
| PATCH  | `/config/auto-order-enabled`  | Flip it — takes effect next cycle |
| GET    | `/products`                   | All tracked variants (read-only)  |
| GET    | `/orders`                     | All orders (read-only)            |
| GET    | `/logs?type=&limit=`          | sync_logs, latest first, optional type filter |

## Status: Phase 6 (fulfillment & tracking loop)

Adds `src/jobs/fulfillmentLoop.ts` — polls every local order still in
`status='submitted'` for its supplier-side shipping status, and once the
supplier reports it shipped with a tracking number, pushes that tracking to
eBay via `createShippingFulfillment` and marks the local order `shipped`.
Scheduled alongside the other two loops.

### How the fulfillment loop works

For every order awaiting fulfillment:
1. Ask the supplier plugin for the order's current status
   (`getOrderStatus`). Not shipped yet → leave it alone, retry next cycle.
2. Shipped → ask for tracking info (`getTrackingInfo`). No tracking number
   yet (common lag between "shipped" and a tracking number being assigned)
   → also retry next cycle, rather than pushing an incomplete fulfillment.
3. Have both → re-fetch the eBay order's line items (not stored locally —
   see `orders` schema in Section 6) and call `createShippingFulfillment`
   for each, then mark the local row `shipped` with the tracking
   number/carrier saved.
4. A failure on one order (supplier API error, eBay API error, an
   unregistered `supplier_type`) is caught, logged, and leaves that order's
   status untouched so it's automatically retried next cycle — it never
   aborts the rest of the batch.

Carrier names from the supplier are free text; eBay expects one of a fixed
set of carrier codes. `normalizeCarrierCode()` maps the common ones
(USPS/FedEx/UPS/DHL) and falls back to `OTHER` — the real carrier name is
still preserved in our own `orders.carrier` column either way.

### Try it yourself (fulfillment) — no real eBay orders needed

```bash
# Fake an order that's already been "submitted" to TestPlugin (which always
# reports shipped + a tracking number), and simulate the eBay side too:
npm run fulfillment-once -- --fake-ebay
```

Since `TestPlugin.getOrderStatus()` and `.getTrackingInfo()` always report a
shipped order with a fake tracking number, this proves the entire local
decision logic — the real integration point once you have live CJ + eBay
credentials is only the two eBay calls (`getOrderById`,
`createShippingFulfillment`), which `--fake-ebay` stands in for.

To see the real supplier calls too (once you have CJ credentials but are
still waiting on eBay), drop `--fake-ebay` — this exercises `CJPlugin`'s
`getOrderStatus`/`getTrackingInfo` against a real CJ order, and will fail
gracefully with a clear "eBay is not configured" message at the point
tracking would be pushed.

## Status: Phase 5 (order routing loop)

Adds `src/jobs/orderRoutingLoop.ts` — polls eBay for new paid orders, maps
each to the correct supplier's order payload, and submits it (only when
`AUTO_ORDER_ENABLED=true`). Scheduled alongside the other loops via
`startOrderRoutingScheduler()` in `src/jobs/scheduler.ts`.

### Idempotency (the part that protects your CJ account from duplicate charges)

The `orders` table, keyed on `ebay_order_id`, is the single source of truth
for "has this eBay order already resulted in a real supplier order". A row
only counts as "already submitted" once it has a `supplier_order_id` set:

- Same eBay order polled while `AUTO_ORDER_ENABLED=false` → logged once
  (`status='skipped_auto_order_disabled'`, `supplier_order_id=NULL`), never
  re-logged identically on every poll.
- Flip the flag on → that same row is still eligible (no `supplier_order_id`
  yet) → gets its one real submission.
- Any further poll of the same order, ever, for any reason (retry, crash,
  duplicate webhook) → skipped, because `supplier_order_id` is now set.

**Known v1 limitation:** if a single eBay order's line items span more than
one supplier (rare, since a listing only ever sources from one supplier),
it's flagged for manual review instead of guessing how to split it — the
`orders` table has one `supplier_type` per row by design.

### Try it yourself (order routing) — no real eBay orders needed

```bash
# 1. Publish or fetch a variant so it has an ebay_sku (see Phase 2/3 sections below).

# 2. Simulate a paid eBay order for it, with the kill switch off (default):
npm run order-routing-once -- --fake-order
# → logs the intended CJ order, submits nothing (supplier_order_id stays NULL)

# 3. Flip AUTO_ORDER_ENABLED=true in .env, run the SAME fake order again
#    (pass --order-id to reuse the same id, or it generates a new one each time):
npm run order-routing-once -- --fake-order --order-id=TEST-ORDER-001
# → creates exactly one real (TestPlugin) supplier order

# 4. Run it a third time with the same --order-id:
npm run order-routing-once -- --fake-order --order-id=TEST-ORDER-001
# → "already submitted, skipping" — confirm no duplicate in the orders table
```

Once you have real eBay + CJ credentials, `npm run order-routing-once`
(without `--fake-order`) polls your actual eBay account.

## Status: Phase 4 (product sync loop)

Adds `src/jobs/syncLoop.ts` (the logic) + the sync half of
`src/jobs/scheduler.ts` — keeps eBay listings in sync with supplier
cost/stock on a cron schedule (`SYNC_INTERVAL_MINUTES`), started at server boot.

### How the sync loop works

Every cycle, for every tracked variant:
1. Re-fetch cost/shipping/stock from its supplier plugin.
2. Apply the safety stock buffer — list quantity 0 if stock is below
   `SAFETY_STOCK_BUFFER`, rather than mirroring the exact count.
3. Recompute the eBay price via the pricing formula.
4. If nothing changed, do nothing further. If something changed, update the
   local `variants` row, and — **only if the variant has already been
   published to eBay** (has an `ebay_sku`) **and `AUTO_ORDER_ENABLED=true`**
   — batch it into a `bulkUpdatePriceQuantity` call.
5. Every run is logged to `sync_logs`, whether it succeeded, partially
   failed, or failed outright.

**Kill switch:** with `AUTO_ORDER_ENABLED=false` (the default), the loop
still runs and updates its local records, and logs exactly what it *would*
have pushed to eBay — it just never makes the real call. Flip it on once
you're confident.

**Resilience:** one variant failing (bad supplier data, an unregistered
`supplier_type`, a network blip) is caught and logged individually — it
never aborts the rest of the run or crashes the process. A failed eBay push
still leaves the local DB updated with fresh values, so the next cycle
retries the push with current data rather than stale data.

### Try it yourself (sync loop)

```bash
# Run one cycle on demand, without waiting for the schedule:
npm run sync-once
```

To see it detect a real change, fetch a variant, then manually edit its
`current_price`/`current_stock` in the SQLite file to something else, then
run `npm run sync-once` again — it will detect the drift and correct it
back to the freshly-fetched value. Or just wait — with the server running
(`npm run dev`), the scheduler fires automatically every
`SYNC_INTERVAL_MINUTES` (visible in the startup log as a cron expression).

Every sync run's summary (changed/unchanged/failed/pushed counts) is both
logged to the console/log file and written to the `sync_logs` table — the
Logs dashboard page (Phase 6b) will surface this without needing a terminal.

## Status: Phase 3 (eBay API integration)

Adds OAuth token refresh automation, the eBay Inventory + Fulfillment API
client, the pricing formula, and the VeRO/keyword filter. **This phase
needs a one-time manual step in your browser before any of it can be
tested live — see below.**

### Getting your eBay API credentials

1. Sign up for an eBay Developer account: https://developer.ebay.com
2. Create an application under **My Account → Application Keys**. Start
   with a **Sandbox** keyset (free, no real listings/orders) — you can add
   the production keyset later once you're confident everything works.
   You'll get an `EBAY_CLIENT_ID` (App ID) and `EBAY_CLIENT_SECRET` (Cert ID).
3. **Getting your initial refresh token (one-time, manual, requires a browser):**
   eBay's Sell APIs require a *User* access token, which can only be minted
   after you personally grant your app permission in a browser — there's no
   way to automate this first step. eBay's developer portal has a built-in
   tool for it:
   - Go to **My Account → User Tokens** in the developer portal.
   - Under your application, click **Sign in to Production** (or **Sandbox**
     — use the "Sandbox Test User" sign-in for sandbox).
   - Approve the requested scopes (`sell.inventory`, `sell.fulfillment`).
   - eBay redirects you and shows an authorization code; the portal's "Get
     a Token from eBay via Your Application" page will already exchange
     this for you and display a **refresh token** — copy it.
   - This refresh token is valid for ~18 months. Put it in `.env` as
     `EBAY_REFRESH_TOKEN`. Everything after this point (getting/refreshing
     2-hour access tokens) is fully automatic — see `src/ebay/ebayAuth.ts`.
4. Set `EBAY_ENVIRONMENT=sandbox` (or `production`) in `.env` to match
   whichever keyset you used above.

### One-time: create an eBay inventory location

Every offer needs a "merchant location" on file. Create one:

```bash
npm run ebay-create-location -- --key=my-warehouse --line1="123 Main St" --city=Austin --state=TX --postal=78701 --country=US
```

### Try it — the parts that need NO eBay credentials

```bash
npm run test-pricing-vero
```

Verifies the pricing formula (`eBayPrice = (cost + shipping) * (1 + margin) + feeEstimate`)
against hand-computed expected values, and confirms the VeRO filter
correctly blocks a test product titled "Nike Air Max Sneakers" while
letting an unbranded one through — including a word-boundary check so
"Unikey" doesn't false-positive on "nike".

### Try it — full end-to-end listing (needs eBay credentials)

```bash
# 1. Get a variant into the DB (TestPlugin works fine for a dry run):
npm run fetch-variant -- TEST-1 --supplier=TEST --sku=my-test-sku --product-title="Wireless Earbuds"

# 2. Publish it:
npm run publish-listing -- --sku=my-test-sku --category=15052 --location=my-warehouse
```

This computes the real price, runs the VeRO check, then calls
`createOrReplaceInventoryItem` → `createOffer` → `publishOffer` against
whichever `EBAY_ENVIRONMENT` you configured. On success it prints the
listing ID and stores `ebay_sku`/`ebay_offer_id`/`current_price` back onto
the variant. Try it once with a title containing "Nike" to confirm the
VeRO filter blocks it before anything reaches eBay.

The eBay category ID (`--category`) can be found via eBay's
[Taxonomy API](https://developer.ebay.com/api-docs/commerce/taxonomy/overview.html)
or by browsing eBay and noting the category of a similar live listing.

### What's guaranteed even without real credentials

- `npm run publish-listing` fails with a clear, specific error
  (`eBay is not configured: missing EBAY_CLIENT_ID, ...`) rather than
  crashing, if you haven't set eBay credentials yet.
- The VeRO filter and safety-stock-buffer logic run and are enforced
  *before* the eBay-not-configured check — confirmed by testing both paths.

Adds encrypted credential storage, the Suppliers REST API, and static-token
auth enforcement on all `/api/*` routes. Pairs with `./frontend`'s
Suppliers page.

### Suppliers API (all under `/api/suppliers`, all require `X-Auth-Token`)

| Method | Path                          | Purpose                                    |
|--------|-------------------------------|---------------------------------------------|
| GET    | `/available-plugins`          | Supplier plugins that can be added (dropdown) |
| GET    | `/`                            | List configured suppliers (masked keys)     |
| POST   | `/`                            | Add a supplier — encrypts + saves, then immediately tests the connection |
| PATCH  | `/:id`                        | Edit display name and/or credentials (re-tests only if credentials changed) |
| POST   | `/:id/test-connection`        | Re-run the connection test on demand        |
| PATCH  | `/:id/enabled`                | Enable/disable a supplier                   |
| DELETE | `/:id`                        | Remove a supplier (order history is preserved) |

Credentials are encrypted with AES-256-GCM (`src/crypto/encryption.ts`)
before being written to SQLite, and only ever returned to the frontend in
masked form (e.g. `ep_live_••••8877`).

CORS is enabled for `http://127.0.0.1:*` and `http://localhost:*` origins
only, so the local dashboard frontend can call this API from the browser.

## Status: Phase 2 (supplier abstraction layer + CJ plugin)

Adds the `SupplierProvider` interface (Section 4a), a `CJPlugin` implementing
it against CJ Dropshipping's real API 2.0, and a `TestPlugin` used to prove
the abstraction holds.

### Supplier abstraction layer

- `src/suppliers/SupplierProvider.ts` — the fixed interface every plugin implements.
- `src/suppliers/CJPlugin.ts` — real CJ Dropshipping implementation (auth, product/variant lookup, order creation, order status, tracking).
- `src/suppliers/TestPlugin.ts` — hardcoded fake-data plugin, used only to prove the sync flow works against any plugin with zero core-engine changes.
- `src/suppliers/supplierFactory.ts` — the ONLY place that maps a `supplier_type` string to a plugin instance. To add a new supplier later (EPROLO, AliExpress, ...): write one new file implementing `SupplierProvider`, add one line to the `registry` map here, done.
- `src/suppliers/retry.ts` — exponential backoff (1s/2s/4s/8s) on HTTP 429, per the Section 5 rate-limit guardrail.

### Try it yourself

```bash
npm run migrate
```

**Against the TestPlugin (no credentials needed):**

```bash
npm run fetch-variant -- TEST-VARIANT-1 --supplier=TEST --sku=my-sku-1
npm run fetch-variant -- TEST-VARIANT-2 --supplier=TEST --sku=my-sku-2
npm run fetch-variant -- TEST-VARIANT-3 --supplier=TEST --sku=my-sku-3
```

Each prints the fetched (fake) cost/stock and confirms what landed in `variants`.

**Against real CJ Dropshipping (you'll need this):**

1. Get your CJ API key: log into CJ, go to **My CJ > Authorization > API**, click **Add API**, and generate a key.
2. Add it to `.env`: `CJ_API_KEY=your_key_here`.
3. Set `ACTIVE_SUPPLIER=CJ` in `.env` (or pass `--supplier=CJ` on the command).
4. Get a real CJ variant ID (`vid`) — visible on any product page in the CJ product browser, or via CJ's product search API.
5. Run:
   ```bash
   npm run fetch-variant -- <real-cj-vid> --supplier=CJ --sku=my-real-sku
   ```
6. Confirm the printed cost/shipping/stock matches what you see in your CJ dashboard for that variant.

If the CJ API key is invalid/expired, `CJPlugin` clears its cached token and
surfaces a clear `SupplierApiError` rather than crashing — check the log line
for the CJ error message and code.

### What "the abstraction holds" means here

The exact same `fetchVariant.ts` script, with zero code changes, works
against either supplier — only the `--supplier` flag (or `.env`'s
`ACTIVE_SUPPLIER`) changes. That's the proof required by Phase 2: the core
engine (this script stands in for the future sync loop) never mentions "CJ"
by name — it only calls `getSupplierProvider(key)` and then the fixed
`SupplierProvider` interface methods.

## Setup

```bash
npm install
cp .env.example .env
```

Then edit `.env` and set two **required** values (the app refuses to start
without them — everything else has a safe default):

- `DASHBOARD_AUTH_TOKEN` — any long random string.
- `ENCRYPTION_KEY` — a 64-char hex string (32 bytes) for AES-256-GCM. Generate one with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

## Create the database

```bash
npm run migrate
```

This creates `./data/core.db` (path configurable via `DATABASE_FILE`) with
all tables from the schema (`suppliers`, `products`, `variants`, `orders`,
`sync_logs`, `config`, plus `scouted_products` used starting Phase 8), and
seeds the `config` table with defaults (`AUTO_ORDER_ENABLED=false`,
15-minute sync interval, 5-unit safety stock buffer). Safe to re-run —
it will not overwrite config values you've since changed from the dashboard.

If a required `.env` value is missing or invalid, `npm run migrate` prints a
clear error and exits with a non-zero code instead of creating a
partially-configured database.

## Run

```bash
npm run dev
```

Then in another terminal:

```bash
curl http://127.0.0.1:4000/health
```

Expected response:

```json
{"status":"ok","service":"core-service","timestamp":"..."}
```

The server also validates config at startup and will refuse to start (with
the same clear error message) if required `.env` values are missing.

## Notes

- Binds to `127.0.0.1` by default (see `.env`'s `HOST`). Do not change this to
  `0.0.0.0` unless you deliberately want to expose it on your network.
- This service is completely independent from `scout-service/`. Stopping,
  crashing, or never starting the Scout Service has no effect here.
