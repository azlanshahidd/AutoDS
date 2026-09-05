# Contributing to Core Service

This document is for anyone working on Core Service — contractor, VA, or
future-you returning after months away.

---

## Branch strategy

```
master   ← production (auto-deploys to Railway on push)
 └── staging  ← all development work
      └── feature/xyz  ← optional short-lived branches off staging
```

**Never commit directly to `master`.**

Workflow:
```bash
# Start work
git checkout staging
git pull origin staging

# Do your work
git add <files>
git commit -m "feat: describe what you built"

# Test on staging stack (see docs/setup.md)
docker compose -f docker-compose.staging.yml up --build

# When ready for production
git checkout master
git merge --no-ff staging -m "release: what's going live"
git tag -a v<version> -m "Release description"
git push origin master --tags
```

---

## Commit conventions

Format: `type(scope): description`

| Type | When to use |
|------|------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `fix(reliability)` | Reliability/correctness fix |
| `refactor` | Code change with no behaviour change |
| `docs` | Documentation only |
| `test` | Test additions or fixes |
| `chore` | Build/config/tooling changes |

Examples:
```
feat(scouted): add bulk approve/discard actions
fix: migrate.ts — apply indexes after ALTER TABLE columns
docs: add architecture.md and setup.md
```

---

## Pre-commit hooks

Husky runs two checks on every commit:
1. `npm run typecheck` — must pass with zero errors
2. `npm test` — all 70 tests must pass

These can't be skipped in normal flow. If you absolutely must bypass them
(genuine emergency only):
```bash
git commit --no-verify -m "emergency: ..."
```

---

## Testing

### Running tests
```bash
npm test                    # run all tests once
npm run test:watch          # watch mode for development
npm run test:coverage       # with coverage report
```

### Test structure
```
tests/
├── unit/           # Pure function tests — no DB, no network
│   ├── pricing.test.ts       # calculateEbayPrice, parsePricingTiers
│   ├── veroFilter.test.ts    # checkVero, word-boundary behaviour
│   └── supplierErrors.test.ts # isRetryable classification
│
└── integration/    # Full pipeline tests with in-memory SQLite
    ├── dashboard.test.ts     # API route tests via supertest
    ├── orderRouting.test.ts  # Order routing smoke tests
    └── fulfillment.test.ts   # Fulfillment loop + quarantine tests
```

### Writing new tests
- Use `makeTestDb()` from `tests/helpers/makeTestDb.ts` for any test that
  needs a database — it creates a fresh in-memory SQLite DB with full schema
- Integration tests should use `supertest` to call routes through the real
  Express app, not call service functions directly
- Target 70%+ line coverage for any new business logic module
- Run `npm run test:coverage` and check `coverage/lcov-report/index.html`

---

## Adding a new supplier plugin

1. **Create the plugin file:**
   ```
   src/suppliers/MySupplierPlugin.ts
   ```
   Implement the `SupplierProvider` interface from `src/suppliers/SupplierProvider.ts`.
   All 6 methods are required: `getAuthToken`, `getProductDetails`, `getStockAndPrice`,
   `createOrder`, `getOrderStatus`, `getTrackingInfo`.

2. **Register in the factory:**
   ```typescript
   // src/suppliers/supplierFactory.ts
   import { MySupplierPlugin } from "./MySupplierPlugin";

   // Add to the registry Map:
   ["MYSUPPLIER", () => new MySupplierPlugin({ apiKey: process.env.MYSUPPLIER_API_KEY! })],
   ```

3. **Add to the test list:**
   ```typescript
   // src/services/suppliersService.ts — buildPluginForTest()
   case "MYSUPPLIER":
     return new MySupplierPlugin({ apiKey });
   ```

4. **Add to available plugins:**
   ```typescript
   // src/services/suppliersService.ts — AVAILABLE_SUPPLIER_PLUGINS
   { key: "MYSUPPLIER", displayName: "My Supplier Name" },
   ```

5. **Add env vars** to `.env.example` and `.env.staging`

6. **Write tests** in `tests/integration/` — use TestPlugin as a template

7. **Update `docs/setup.md`** with setup instructions

Nothing else changes. The sync loop, order routing, and fulfillment loops
all route per `variant.supplier_type` — they need no modification.

---

## Adding a new sales channel

The `SalesChannel` interface in `src/channels/SalesChannel.ts` defines the
contract. `EbayChannel.ts` is the reference implementation.

1. **Create the channel file:**
   ```
   src/channels/ShopifyChannel.ts
   ```
   Implement: `createOrUpdateListing`, `bulkUpdatePriceStock`, `getPaidOrders`,
   `markShipped`, `testConnection`.

2. **Register in the factory:**
   ```typescript
   // src/channels/channelFactory.ts
   import { ShopifyChannel } from "./ShopifyChannel";

   ["SHOPIFY", (config) => new ShopifyChannel({ shopDomain: ..., accessToken: ... })],
   ```

3. **Update the OpenAPI spec** (`src/openapi.ts`) if you add new routes for the channel

The job loops still call `EbayClient` directly (acknowledged migration debt from
the reliability phase). Migrating them to `getChannelProvider()` is the next
step toward full channel abstraction.

---

## Adding a new API route

1. Choose the right router file in `src/routes/`
2. Add the route with `parseIntId` guard on `:id` params
3. Add request body validation (type checks + bounds)
4. Add error handling with typed responses
5. **Update `src/openapi.ts`** with the new path entry
6. Add a test in `tests/integration/dashboard.test.ts` (or a new file)
7. Update `docs/api-reference.md`

---

## Modifying the database schema

1. Add the column/table to `src/db/schema.sql` (using `IF NOT EXISTS` / nullable defaults)
2. Add an `ALTER TABLE ADD COLUMN` migration in `src/db/migrate.ts` with a
   `PRAGMA table_info` guard so it's idempotent
3. Update `scripts/apply-missing-columns.js` for the emergency manual migration path
4. Run `npm run migrate` locally to verify
5. Update types in the relevant route/service files
6. Update `src/openapi.ts` if the new column appears in API responses
7. Add/update tests in `tests/helpers/makeTestDb.ts` if the schema change
   affects test fixtures

---

## Code style

- TypeScript strict mode is enforced (`"strict": true` in tsconfig.json)
- No `any` types without an explicit comment explaining why
- All exported functions should have a JSDoc comment explaining purpose,
  not implementation (the code shows how; the comment explains why)
- Keep route handlers thin — business logic belongs in `src/services/`
- Never log secrets: API keys, tokens, passwords. Log booleans instead
  (`hasApiKey: true`) or truncated response bodies (not request bodies)
- SQLite transactions: wrap multi-step writes in `db.transaction()()` so
  a crash mid-operation can't leave inconsistent state

---

## Environment for development

See `docs/setup.md` for the full first-run guide.

For a quick staging environment with Docker:
```bash
cp .env.staging .env.staging.local
# Fill in DASHBOARD_AUTH_TOKEN and ENCRYPTION_KEY in .env.staging.local
docker compose -f docker-compose.staging.yml --env-file .env.staging.local up --build
# Dashboard: http://localhost:4001
```
