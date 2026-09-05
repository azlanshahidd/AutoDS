# Core Frontend

The Core Service's local dashboard (Section 4b). React + Vite + TypeScript +
Tailwind, talking to `core-service`'s REST API only — never touches its
database directly.

## Status: Phase 8 (Scouted Items page)

Adds the **Scouted Items** page — candidates pulled from the Scout Service,
with a "Pull now" button, estimated margin (when matched against a product
you already track), and Approve/Discard actions. Approving just marks
status; actually publishing to eBay is still the existing manual flow.

## Status: Phase 6b (all core pages)

All five Core Dashboard pages now exist: **Overview**, **Suppliers**,
**Products**, **Orders**, **Logs**.

### Overview page

- Live stats: last sync/order-routing/fulfillment run (time + result badge),
  products tracked, orders processed today, failed jobs in the last 24h.
- The **auto-order toggle** — flips `AUTO_ORDER_ENABLED` live. Turning it
  **on** requires confirming in a modal first; turning it off doesn't.
  This takes effect on the very next job cycle — **no server restart
  needed** (the backend reads this one setting from the database at the
  start of every run rather than from `.env`).
- Polls every 8 seconds.

### Products / Orders / Logs pages

All three are read-only tables, each polling every 8 seconds, each with
proper empty-state messaging, status badges (never plain text for
status), and a loading spinner on first load. Logs has a type filter
(All / Sync / Orders / Fulfillment).

## Setup & run

This folder is nested inside `core-service/` and is normally started
together with the backend — see `../README.md`'s "Quick start":

```bash
cd ..                  # core-service/
npm install             # installs this frontend's deps too, via postinstall
cp frontend/.env.example frontend/.env
npm run dev              # starts backend + this frontend together
```

If you want to run just this frontend on its own (backend already running
separately), you can still do that from here directly:

```bash
npm install
cp .env.example .env
npm run dev
```

Open **http://127.0.0.1:5173**. On first load you'll be asked for the
dashboard auth token — this is the `DASHBOARD_AUTH_TOKEN` value from
`core-service/.env`. It's stored only in that browser tab's session storage,
never persisted to disk.

## What to check visually (Section 4d design standard)

- Dark theme throughout — no default white/browser-styled elements.
- The Suppliers table shows a colored status badge per row (green pulsing
  dot = Connected, red = Failed, gray = Not tested/Disabled) — never just
  plain text.
- Clicking **Add Supplier** opens a styled modal (not a browser `alert`),
  with inline validation if you submit without an API key.
- After saving, the key shown in the table is always masked
  (e.g. `ep_live_••••8877`), never the full value.
- An empty supplier list shows a friendly empty-state message with an icon,
  not a blank table.
- Every action (test connection, enable/disable, remove) shows a toast
  notification in the bottom-right — not a browser alert.

## Try the full flow

1. Open the dashboard, enter your token.
2. Click **Add Supplier**, pick **CJ Dropshipping**, paste your real
   `CJ_API_KEY` (see `../README.md` for how to get one), leave
   API Secret blank, click **Save & Test Connection**.
3. Confirm the badge goes green ("Connected") if the key is valid, or red
   ("Failed") if not — either way it's saved and masked immediately.
4. Try **Test** again to re-run the check, **Disable** to turn it off, and
   **Remove** to delete it (existing order history, once Phase 5+ exists,
   would not be affected by this).
