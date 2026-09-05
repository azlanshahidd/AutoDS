# Core Service — Operations Runbook

This document covers: rollback, staging setup, database backup/restore, and
the safety rules that protect live money-moving automation from bad deploys.

---

## 1. The Golden Rules

Before touching **anything** in this repo:

| Rule | Why |
|------|-----|
| All work happens on the `staging` branch, never directly on `master` | `master` = what's live |
| Every deploy to production requires a passing staging run first | Catch bugs before real orders |
| `AUTO_ORDER_ENABLED` stays `false` on staging — always | Prevents real supplier purchases |
| `EBAY_ENVIRONMENT=sandbox` on staging — always | Prevents real eBay listings |
| Back up `core.db` before any migration or schema change | SQLite has no point-in-time recovery |

---

## 2. Branch Strategy

```
master   ← production (Railway deploys this)
 └── staging  ← all development work lives here
      └── feature/xyz  ← optional short-lived branches off staging
```

**Workflow for every change:**

```bash
# 1. Make sure you're on staging
git checkout staging

# 2. Do your work, commit
git add <files>
git commit -m "feat: describe the change"

# 3. Test on the local staging stack (see Section 4)

# 4. When confident, merge to master
git checkout master
git merge --no-ff staging -m "release: describe what's going live"

# 5. Tag the release
git tag -a v<version> -m "Release description"

# 6. Push (Railway auto-deploys on push to master)
git push origin master --tags
```

---

## 3. Rolling Back a Bad Production Deploy (Railway)

### Option A — One-click redeploy via Railway dashboard (fastest)

1. Open [railway.app](https://railway.app) → your project → the **core-service** service.
2. Click the **Deployments** tab.
3. Find the last known-good deployment (the one before the bad one).
4. Click the **⋮ menu** on that row → **Redeploy**.
5. Railway tears down the current container and redeploys the old image — no
   code changes needed, usually live within ~60 seconds.

> The deployment history keeps the last ~20 builds. If the bad deploy
> corrupted `core.db`, also follow Section 5 (restore from backup) before
> the redeployed container starts writing to it.

### Option B — Git revert + push (auditable)

```bash
# Identify the last good commit on master
git log --oneline master

# Revert the bad commit (creates a new commit — history is preserved)
git revert <bad-commit-sha>
git push origin master

# Railway picks up the push and deploys the reverted code automatically.
```

### Option C — Hard reset to a tag (use only if Options A/B aren't possible)

```bash
# Reset master to the v0-baseline tag (or any other tag)
git checkout master
git reset --hard v0-baseline   # ← change to the target tag

# Force-push (requires explicit user decision — don't do this lightly)
git push origin master --force
```

> ⚠️ Option C rewrites history. Use A or B first.

---

## 4. Local Staging Stack

Mirrors production exactly, but on port 4001 with safety switches locked:

```bash
# One-time setup
cp .env.staging .env.staging.local
# Edit .env.staging.local: fill in DASHBOARD_AUTH_TOKEN, ENCRYPTION_KEY,
# and eBay SANDBOX credentials (never production credentials).

# Start
docker compose -f docker-compose.staging.yml --env-file .env.staging.local up --build

# Dashboard: http://localhost:4001
# Logs:      docker compose -f docker-compose.staging.yml logs -f
# Stop:      docker compose -f docker-compose.staging.yml down
# Wipe DB:   docker compose -f docker-compose.staging.yml down -v
```

**Hardcoded safety switches inside `docker-compose.staging.yml`:**
- `AUTO_ORDER_ENABLED=false` — logged but never sent to a supplier
- `EBAY_ENVIRONMENT=sandbox` — uses eBay sandbox API, never production

These are in the compose file's `environment:` block, not the env-file, so
they cannot be accidentally overridden by a misconfigured `.env.staging.local`.

### Railway staging service

If you prefer a Railway-hosted staging environment:

1. In your Railway project, click **+ New Service** → **GitHub Repo** →
   select this repo → set the deploy branch to `staging`.
2. Add all environment variables from `.env.staging` as Railway variables.
3. Set `AUTO_ORDER_ENABLED=false` and `EBAY_ENVIRONMENT=sandbox` as
   **locked** Railway variables so they can't be accidentally edited.
4. Mount a **separate** persistent volume at `/app/data` — never the same
   volume as production.
5. The service will auto-deploy on every push to `staging`.

---

## 5. Database Backup & Restore

### Taking a manual backup (before any migration or risky change)

**Linux/macOS:**
```bash
./scripts/backup-db.sh
# Backup lands in: data/backups/core.db-backup-<timestamp>.db
```

**Windows (PowerShell):**
```powershell
.\scripts\backup-db.ps1
# Backup lands in: data\backups\core.db-backup-<timestamp>.db
```

Both scripts use SQLite's online backup API — safe while the server is running.

### Scheduled backups

**Linux/macOS — cron (every 6 hours):**
```bash
crontab -e
# Add this line (adjust the path):
0 */6 * * * /path/to/core-service/scripts/backup-db.sh >> /path/to/core-service/logs/backup.log 2>&1
```

**Windows — Task Scheduler:**
1. Open Task Scheduler → **Create Basic Task**
2. Trigger: Daily, repeat every 6 hours
3. Action: Start a program
   - Program: `powershell.exe`
   - Arguments: `-NonInteractive -File "C:\path\to\core-service\scripts\backup-db.ps1"`
   - Start in: `C:\path\to\core-service`
4. Check "Run whether user is logged on or not"

**Railway — volume snapshot:**
Railway persistent volumes can be backed up by adding a second "Cron Job"
service in the same project. Set the schedule to `0 */6 * * *` and the
command to `node -e "..."` using the same Node backup logic in `backup-db.ps1`.
Alternatively, use Railway's upcoming Volume Snapshots feature (check the
Railway changelog — it may be available by the time you read this).

### Restoring from a backup

> Do this BEFORE starting a rollback deploy if the DB may be corrupted.

**Stop the service first** (Railway → service → Settings → Suspend, or
`docker compose -f docker-compose.staging.yml stop` locally).

```bash
# 1. Keep a copy of the potentially-corrupt file
cp data/core.db data/core.db-pre-restore-$(date +%Y%m%dT%H%M%SZ)

# 2. Restore from backup
cp data/backups/core.db-backup-<timestamp>.db data/core.db

# 3. Restart the service
```

On Railway with a persistent volume: use the Railway CLI or dashboard to
replace the file on the volume, then redeploy.

---

## 6. Pre-Deploy Checklist

Run through this before merging `staging` → `master`:

- [ ] Staging stack started and healthy (`/health` returns `{"status":"ok"}`)
- [ ] `AUTO_ORDER_ENABLED` toggle works in the dashboard without server restart
- [ ] Sync loop runs at least one full cycle without errors (`npm run sync-once` on staging)
- [ ] No new `.env` variables introduced without updating `.env.example` and `.env.staging`
- [ ] No schema changes without a corresponding migration in `src/db/migrate.ts`
- [ ] `core.db` backed up on production before deploying if the migration touches existing tables
- [ ] New git tag created for the release

---

## 7. Key Environment Variables — Quick Reference

| Variable | Production | Staging | Notes |
|----------|-----------|---------|-------|
| `AUTO_ORDER_ENABLED` | `true` when ready | **always `false`** | Flip only in prod, only deliberately |
| `EBAY_ENVIRONMENT` | `production` | **always `sandbox`** | Wrong value = real eBay API calls |
| `DATABASE_FILE` | `./data/core.db` | `./data/core-staging.db` | Never share a DB file between envs |
| `ENCRYPTION_KEY` | prod key | different staging key | Rotating this breaks all stored supplier creds |
| `DASHBOARD_AUTH_TOKEN` | prod token | different staging token | Leaked staging token must not work on prod |

---

## 8. Contacts & Resources

| Resource | Link |
|----------|------|
| Railway dashboard | https://railway.app |
| Railway deployment docs | https://docs.railway.app/deploy/deployments |
| eBay Developer Portal | https://developer.ebay.com |
| eBay Sandbox | https://sandbox.ebay.com |
| SQLite backup API docs | https://www.sqlite.org/backup.html |

---

## 9. eBay Account Health & Business Continuity

### 9.1 The single biggest risk

A code bug is recoverable in minutes. An **eBay account suspension** stops
the entire business immediately and may take weeks to reverse — if it's
reversible at all. Treat eBay account health as a higher-priority alert
than any job failure.

### 9.2 eBay Seller Standards — thresholds to watch

| Metric | Above Standard | Top Rated | CoreDash alert fires at |
|--------|---------------|-----------|------------------------|
| Transaction Defect Rate | < 2% | < 0.5% | ≥ 0.5% (warning), ≥ 2% (critical) |
| Late Shipment Rate | < 10% | < 3% | ≥ 3% (warning), ≥ 10% (critical) |
| Cases Closed Without Resolution | < 0.3% | < 0.3% | ≥ 0.3% (critical) |

Check `GET /api/seller-health` or the Overview page Seller Health panel
after every deploy. If the panel shows BELOW STANDARD — stop everything
(use the Emergency Stop button), investigate, and fix before resuming.

### 9.3 Emergency Stop procedure

**When to use it:**
- You receive a VeRO notice from eBay
- You notice an unusual spike in orders or listings
- A supplier places charges you didn't expect
- Any situation where you need to freeze the system to investigate

**How to use it:**
1. Click **Emergency Stop** on the Overview page (top-right), or:
   ```
   curl -X POST https://your-domain/api/emergency-stop \
     -H "X-Auth-Token: <your-token>" \
     -H "Content-Type: application/json" \
     -d '{"reason": "VeRO notice received — order 12345"}'
   ```
2. The system immediately stops all four schedulers. A red banner appears
   in the dashboard confirming the stop.
3. The `EMERGENCY_STOP=true` flag is persisted in the DB — the service
   will NOT restart schedulers even after a Railway redeploy.
4. Investigate the issue. Check `GET /api/logs` and eBay Seller Hub.
5. When resolved: click **Clear & restart service** in the banner, OR:
   ```
   curl -X POST https://your-domain/api/emergency-stop/resume \
     -H "X-Auth-Token: <your-token>" \
     -H "Content-Type: application/json"
   ```
6. **Redeploy/restart the service.** The schedulers only resume on a fresh
   startup after the flag is cleared.

### 9.4 VeRO / IP compliance

The VeRO filter runs **three layers** before any listing is published:

1. **Exact brand blocklist** (`config/vero-blocklist.txt`) — word-boundary match
2. **Fuzzy / obfuscation detection** — normalises digits (1→i, 0→o, 3→e) before matching
3. **Prohibited keywords** (hardcoded in `src/ebay/veroFilter.ts`) — weapons, drugs, counterfeit indicators

**Maintaining the blocklist:**
- Add any brand you're not licensed to resell to `config/vero-blocklist.txt`
- One brand per line; `#` lines are comments
- The list is cached in memory — restart the server after edits, or it reloads on the next sync cycle
- When in doubt, add the brand — a false-positive means manual review; a false-negative means potential account suspension

**If you receive a VeRO notice:**
1. Immediately end the listing on eBay Seller Hub
2. Add the brand to the blocklist
3. Run `npm run sync-once -- --dry-run` to confirm no other listings would match
4. Document the incident in your own records

---

## 10. Off-Server Database Backup Strategy

### 10.1 Why this matters

Railway's persistent volumes are reliable but are single-region. If Railway
loses the volume (rare but documented cases exist), or if you accidentally
delete the service, `core.db` is gone. A 6-hour-old backup means at most
6 hours of orders/data lost.

### 10.2 Automated off-server backups (recommended setup)

**Option A — Rclone to S3/R2/Backblaze (production-grade)**

1. Install `rclone` in a Railway Cron Job service:
   ```yaml
   # railway.json for the backup service
   { "build": { "builder": "NIXPACKS" },
     "deploy": { "startCommand": "rclone copy /app/data/core.db r2:your-bucket/backups/core-$(date +%Y%m%dT%H%M%SZ).db" } }
   ```
2. Mount the same `/app/data` volume as your core-service
3. Set the cron schedule: `0 */6 * * *` (every 6 hours)
4. Configure `RCLONE_CONFIG` as a Railway secret

**Option B — Railway Volume Snapshots (simpler)**

Railway supports volume snapshots via the CLI:
```bash
railway volume snapshot create --volume <volume-id>
```
Add this to a Railway Cron Job running `0 */6 * * *`. Snapshots are
stored within Railway's infrastructure — still single-provider, but
protects against accidental deletion.

**Option C — scripts/backup-db.sh on a self-hosted cron**

If you run a VPS alongside Railway:
```cron
# On your VPS — pulls the DB via Railway's private networking or rsync
0 */6 * * * rsync -az core-service:/app/data/core.db /backups/core-$(date +%Y%m%dT%H%M%SZ).db
```

### 10.3 "Railway loses my volume" — recovery procedure

1. **Before it happens:** verify you have a recent off-server backup by
   checking backup timestamps weekly.

2. **When it happens:**
   a. Create a new Railway persistent volume, mount at `/app/data`
   b. Download your most recent backup from S3/R2/Backblaze
   c. Use Railway CLI to upload:
      ```bash
      railway run --service core-service cp /path/to/backup.db /app/data/core.db
      ```
   d. Set `EMERGENCY_STOP=false` in Railway Variables (the DB will have the
      flag from whenever the backup was taken)
   e. Redeploy the service

3. **What you lose:** all orders and sync data between the backup timestamp
   and the volume loss. Check eBay Seller Hub for orders placed in that
   window and manually process them.

4. **Time to recover:** ~15 minutes if a backup is available. ~days if
   starting from scratch with no backup.

### 10.4 Tested restore procedure

Run this drill quarterly:

```bash
# 1. Take a fresh backup
node scripts/apply-missing-columns.js   # ensure schema is up to date
node -e "
  const db = require('better-sqlite3')('./data/core.db');
  db.backup('./data/backups/test-restore-$(date +%Y%m%d).db');
  db.close();
"

# 2. Simulate restore to a temporary path
cp ./data/backups/test-restore-$(date +%Y%m%d).db /tmp/core-test-restore.db

# 3. Verify it's readable and has the right tables
sqlite3 /tmp/core-test-restore.db ".tables"
sqlite3 /tmp/core-test-restore.db "SELECT COUNT(*) FROM orders; SELECT COUNT(*) FROM variants;"

# 4. Clean up
rm /tmp/core-test-restore.db
```

If step 3 returns expected table names and row counts, your backup is valid.

---

## 11. Diversification & Single Points of Failure

### 11.1 Current risk map

| Dependency | Failure mode | Impact | Mitigation |
|-----------|-------------|--------|------------|
| eBay account | Suspension / restriction | 100% revenue stop | Emergency stop, VeRO filter, seller health monitoring |
| CJ Dropshipping | API down / account banned | 100% fulfillment stop | CSV supplier fallback, circuit breaker |
| Railway | Platform outage / volume loss | Service unavailable | Off-server DB backup, multi-region alternative |
| Single `core.db` | Corruption / accidental delete | All data lost | Automated backups + tested restore procedure |

### 11.2 Second eBay account — when to add it

A second eBay seller account is the single highest-leverage risk reduction
once you have volume. eBay's Terms of Service **allow multiple seller
accounts** as long as you're not using them to circumvent a suspension.
Practical setup:

1. Register a second eBay account under a different legal entity (or a
   separate email if allowed in your jurisdiction)
2. Add a second set of `EBAY_CLIENT_ID/SECRET/REFRESH_TOKEN` to the config
3. The `EbayChannel` abstraction is already in place — a `channelFactory`
   entry for `"EBAY_2"` pointing at the second credential set is a 5-line
   change
4. Split your catalog: high-volume products on Account 1, new/experimental
   products on Account 2, so a suspension on one doesn't affect the other

**Trigger point:** implement this when monthly revenue exceeds the point
where a 2-week suspension would be a material financial loss to you.

### 11.3 Second sales channel

The `SalesChannel` interface (`src/channels/SalesChannel.ts`) and
`channelFactory.ts` are already designed for this. Adding Shopify, Etsy,
or Walmart Marketplace:

1. Write `ShopifyChannel.ts` implementing `SalesChannel`
2. Add one entry to `channelRegistry` in `channelFactory.ts`
3. Add credentials to `.env` / the config table

**Trigger point:** after your first eBay suspension scare, or when you want
to reach customers outside eBay's search algorithm.
