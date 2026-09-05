# Core Service — Setup Guide

## Prerequisites

- Node.js 20+ (`node --version`)
- npm 9+ (`npm --version`)
- Git
- A Railway account (for production deployment)
- An eBay Developer account (for eBay API access)
- A CJ Dropshipping account (or use the CSV supplier for testing)

---

## Local development (first run)

### 1. Clone and install

```bash
git clone <your-repo-url> core-service
cd core-service
npm install          # installs backend deps + frontend deps (via postinstall)
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set these two **required** values (everything else has safe defaults):

```bash
# Any long random string — this is your dashboard login password
DASHBOARD_AUTH_TOKEN=change_me_to_something_long_and_random

# 64-character hex string for AES-256-GCM encryption of supplier API keys
# Generate one:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=<paste 64-char hex here>
```

### 3. Create the database

```bash
npm run migrate
```

This creates `./data/core.db` and seeds the `config` table with defaults.
Safe to re-run — never overwrites existing config values.

### 4. Start the development server

```bash
npm run dev
```

You'll see:
```
[backend]  info: Core Service listening on http://127.0.0.1:4000
[frontend]   VITE ready — Local: http://127.0.0.1:5173/
```

Open **http://127.0.0.1:5173** and log in with the value you set for
`DASHBOARD_AUTH_TOKEN`.

Interactive API docs are available at **http://127.0.0.1:4000/api-docs**
(no login required).

---

## eBay setup (required for listing/orders)

### 1. Create an eBay Developer account

1. Go to https://developer.ebay.com and sign in with your eBay account
2. Navigate to **My Account → Application Keys**
3. Click **Create a keyset** — start with **Sandbox** for testing

### 2. Get your API credentials

From the keyset page:
- `EBAY_CLIENT_ID` = App ID
- `EBAY_CLIENT_SECRET` = Cert ID

### 3. Get a refresh token (one-time, requires a browser)

1. In the developer portal, go to **My Account → User Tokens**
2. Under your application, click **Get a Token from eBay via Your Application**
3. Select the `sell.inventory` and `sell.fulfillment` scopes
4. Sign in with your eBay seller account (use a Sandbox Test User for sandbox)
5. Copy the **refresh token** displayed — this is `EBAY_REFRESH_TOKEN`

Add all three to `.env`:
```bash
EBAY_CLIENT_ID=<App ID>
EBAY_CLIENT_SECRET=<Cert ID>
EBAY_REFRESH_TOKEN=<long refresh token>
EBAY_ENVIRONMENT=sandbox  # change to 'production' when ready to go live
```

### 4. Create a merchant location (one-time)

eBay requires a "merchant location" for every listing:
```bash
npm run ebay-create-location -- \
  --key=my-warehouse \
  --line1="123 Main St" \
  --city=Austin \
  --state=TX \
  --postal=78701 \
  --country=US
```

Then set in `.env` (or Settings page):
```bash
EBAY_MERCHANT_LOCATION=my-warehouse
```

---

## Supplier setup

### Option A: CJ Dropshipping

1. Log in to CJ Dropshipping: https://app.cjdropshipping.com
2. Go to **My CJ → Authorization → API**
3. Click **Add API** and generate a key
4. Add to `.env`: `CJ_API_KEY=<your key>`
5. Or add via the dashboard: **Suppliers → Add Supplier → CJ Dropshipping**

### Option B: Manual / CSV supplier

1. Create `./config/csv-supplier-catalogue.json` (see `csv-supplier-catalogue.example.json`)
2. Add via the dashboard: **Suppliers → Add Supplier → Manual / CSV Supplier**
3. Leave the Webhook URL blank for manual mode (orders logged to `logs/manual-orders.jsonl`)

---

## AI provider setup (for SEO + listing content generation)

1. Go to **AI Providers** in the dashboard
2. Click **Add Provider**
3. For OpenAI: set Base URL to `https://api.openai.com/v1`, enter your API key, set model to `gpt-4o-mini`
4. Click **Test** — green means it's working

Without an AI provider, you can still publish listings manually with your own title/description.

---

## Production deployment on Railway

### 1. Create a Railway project

1. Go to https://railway.app → **New Project → Deploy from GitHub**
2. Select this repository
3. Railway detects the `Dockerfile` automatically

### 2. Configure environment variables

In **Railway → your service → Variables**, add:

| Variable | Value |
|----------|-------|
| `DASHBOARD_AUTH_TOKEN` | Strong random string |
| `ENCRYPTION_KEY` | 64-char hex string |
| `HOST` | `0.0.0.0` |
| `PORT` | `4000` |
| `EBAY_CLIENT_ID` | From eBay developer portal |
| `EBAY_CLIENT_SECRET` | From eBay developer portal |
| `EBAY_REFRESH_TOKEN` | From eBay OAuth flow |
| `EBAY_ENVIRONMENT` | `production` |
| `DATABASE_FILE` | `/app/data/core.db` |

### 3. Add a persistent volume

In **Railway → your service → Settings → Volumes**:
- Mount path: `/app/data`
- Without this, `core.db` is lost on every deploy

### 4. Set up healthcheck

Already configured in `railway.json`:
```json
{ "deploy": { "healthcheckPath": "/health", "healthcheckTimeout": 60 } }
```

### 5. Deploy

Push to `master` — Railway auto-deploys. Watch the deploy log for:
```
✓ Migration complete
Core Service listening on http://0.0.0.0:4000
```

### 6. First login

Open your Railway service URL and log in with `DASHBOARD_AUTH_TOKEN`.
Then change the password from **Settings → Security → Change password**.

---

## Environment variable reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DASHBOARD_AUTH_TOKEN` | ✅ | — | Initial login password |
| `ENCRYPTION_KEY` | ✅ | — | 64-char hex, AES-256-GCM for supplier keys |
| `PORT` | | `4000` | HTTP listen port |
| `HOST` | | `127.0.0.1` | Bind address (`0.0.0.0` on Railway) |
| `DATABASE_FILE` | | `./data/core.db` | SQLite file path |
| `LOG_FILE` | | `./logs/core.log` | Winston log file path |
| `EBAY_CLIENT_ID` | | null | eBay App ID |
| `EBAY_CLIENT_SECRET` | | null | eBay Cert ID |
| `EBAY_REFRESH_TOKEN` | | null | eBay OAuth refresh token (~18 months) |
| `EBAY_ENVIRONMENT` | | `production` | `sandbox` or `production` |
| `EBAY_MERCHANT_LOCATION` | | `""` | eBay merchant location key (required for listings) |
| `EBAY_MARKETPLACE_ID` | | `EBAY_US` | eBay marketplace |
| `AUTO_ORDER_ENABLED` | | `false` | Master kill switch for order placement |
| `AUTO_LIST_ENABLED` | | `false` | Auto-publish approved scouted items |
| `ACTIVE_SUPPLIER` | | `CJ` | Default supplier plugin key |
| `CJ_API_KEY` | | `""` | CJ Dropshipping API key |
| `CSV_SUPPLIER_WEBHOOK_URL` | | `""` | Webhook URL for CSV supplier orders |
| `CSV_SUPPLIER_API_KEY` | | `""` | Bearer token for CSV webhook calls |
| `PROFIT_MARGIN_PERCENT` | | `0.30` | Global margin (30%) |
| `EBAY_FEE_ESTIMATE` | | `2.50` | Flat eBay fee added to every price |
| `SAFETY_STOCK_BUFFER` | | `5` | List as 0 when stock ≤ this |
| `SYNC_INTERVAL_MINUTES` | | `15` | How often sync loops run (min: 5) |
| `VERO_BLOCKLIST_PATH` | | `./config/vero-blocklist.txt` | VeRO brand blocklist |
| `SCOUT_SERVICE_URL` | | `http://127.0.0.1:4100` | Scout Service base URL |
| `SCOUT_PULL_TIMEOUT_MS` | | `8000` | Timeout for Scout pull calls |
| `ALERT_WEBHOOK_URL` | | `""` | Slack/Discord webhook for job failure alerts |
| `ALERT_TELEGRAM_BOT_TOKEN` | | `""` | Telegram bot token |
| `ALERT_TELEGRAM_CHAT_ID` | | `""` | Telegram chat ID |
| `ALERT_FAILURE_THRESHOLD` | | `3` | Consecutive failures before alert fires |
| `ALLOWED_ORIGIN` | | `""` | Extra CORS origin (beyond localhost) |

All settings can also be changed at runtime from **Settings** in the dashboard
(except `ENCRYPTION_KEY` and `PORT`/`HOST` which require a restart).

---

## npm scripts reference

| Script | What it does |
|--------|-------------|
| `npm run dev` | Start backend (port 4000) + frontend (port 5173) together |
| `npm run dev:backend` | Backend only |
| `npm run dev:frontend` | Frontend only |
| `npm run migrate` | Apply schema + seed config defaults |
| `npm run build` | Compile TypeScript |
| `npm run build:frontend` | Build React dashboard |
| `npm start` | Run compiled `dist/index.js` (production) |
| `npm test` | Run Vitest test suite |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run sync-once` | Run one sync cycle immediately |
| `npm run order-routing-once` | Run one order routing cycle |
| `npm run fulfillment-once` | Run one fulfillment cycle |
| `npm run regenerate-seo` | Bulk regenerate SEO meta fields |
| `npm run fetch-variant -- <id>` | Fetch a supplier variant into the DB |
| `npm run publish-listing -- --sku=<sku>` | Publish a variant to eBay |
| `npm run test-pricing-vero` | Verify pricing formula + VeRO filter |
