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
