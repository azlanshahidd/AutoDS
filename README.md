# Core Service

Automated dropshipping engine: CJ Dropshipping ↔ eBay product sync,
order routing, fulfillment tracking, and scouted-item listing pipeline.
Built to run 24/7 unattended on Railway.

---

## Quick start

```bash
npm install
cp .env.example .env          # fill in DASHBOARD_AUTH_TOKEN + ENCRYPTION_KEY
npm run migrate               # create the database
npm run dev                   # backend (port 4000) + dashboard (port 5173)
```

Open **http://127.0.0.1:5173** — log in with `DASHBOARD_AUTH_TOKEN`.  
Interactive API docs: **http://127.0.0.1:4000/api-docs**

---

## Documentation

| Document | What it covers |
|----------|---------------|
| [docs/setup.md](docs/setup.md) | First-run guide, eBay/supplier setup, Railway deploy, env var reference |
| [docs/architecture.md](docs/architecture.md) | System overview, component map, data flow, key design decisions |
| [docs/api-reference.md](docs/api-reference.md) | Route summary, auth requirements, link to `/api-docs` |
| [docs/runbook.md](docs/runbook.md) | If-X-do-Y incident playbook: token expiry, supplier API changes, job failures |
| [RUNBOOK.md](RUNBOOK.md) | Operations runbook: rollback, staging, backup/restore, eBay account health, DR |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Branch strategy, adding suppliers/channels, test conventions, commit format |
| [CHANGELOG.md](CHANGELOG.md) | What changed between deploys |

---

## Key concepts

**Everything is in one process.** Four cron jobs (price sync, order routing,
fulfillment, scout pull) run alongside the Express API in the same Node.js
process, using a SQLite database. No Redis, no message queue, no separate
worker.

**Plugin abstractions.** Adding a new supplier = implement `SupplierProvider`
+ register in `supplierFactory.ts`. Adding a new sales channel = implement
`SalesChannel` + register in `channelFactory.ts`. The job loops never
reference CJ or eBay by name.

**Safety first.** `AUTO_ORDER_ENABLED=false` by default — sync runs and
logs what it *would* push but never touches eBay. The Emergency Stop button
on the Overview page halts all automation in one click. VeRO filter runs
3 layers (exact brand, fuzzy/obfuscation, prohibited keywords) before any
listing is published.

---

## npm scripts

```bash
npm run dev              # start backend + frontend together
npm run migrate          # create/update database
npm test                 # run test suite (70 tests)
npm run typecheck        # tsc --noEmit
npm run sync-once        # run one price/stock sync cycle
npm run order-routing-once  # run one order routing cycle
npm run fulfillment-once    # run one fulfillment cycle
npm run regenerate-seo   # bulk regenerate SEO meta fields
```

See [docs/setup.md](docs/setup.md) for the full script reference.

---

## Project structure

```
src/           Backend (Express API + cron jobs)
frontend/      React + Vite dashboard
config/        VeRO blocklist + supplier catalogue template
tests/         Vitest unit + integration tests
docs/          Focused documentation (setup, architecture, API, runbook)
scripts/       DB backup scripts (backup-db.sh, backup-db.ps1)
RUNBOOK.md     Operations playbook (rollback, backup, eBay account health)
CONTRIBUTING.md  Contributor guide
CHANGELOG.md   Release history
```

Full architecture detail: [docs/architecture.md](docs/architecture.md)
