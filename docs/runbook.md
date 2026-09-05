# Core Service — Operational Runbook

If something is broken, this document tells you exactly what to do.
Every scenario follows the same structure: **Symptom → Diagnosis → Fix**.

For the general emergency stop procedure, see **Section 9.3 of RUNBOOK.md**.

---

## 1. eBay refresh token expired

**Symptom:**
- Sync loop logs: `"Auth token rejected"` or `"Token refresh failed"`
- Alert fires: `"price_stock job failing repeatedly"`
- Dashboard circuit breaker shows EBAY as OPEN

**Diagnosis:**
eBay refresh tokens are valid for ~18 months. Once expired, every call that
needs an eBay access token fails with a 401/400 and the `withRetry` wrapper
does not retry 401s.

**Fix:**
1. Go to https://developer.ebay.com → **My Account → User Tokens**
2. Under your application, click **Get a Token from eBay via Your Application**
3. Sign in with your eBay seller account (same one that owns the listings)
4. Approve the `sell.inventory` and `sell.fulfillment` scopes
5. Copy the new refresh token
6. Update it in **Settings → eBay Credentials → Refresh Token**
7. Check **Overview** — the circuit breaker should clear on the next sync cycle

**Prevention:** Note the expiry date (18 months from minting) and set a
calendar reminder 1 month before it expires.

---

## 2. CJ Dropshipping API changes / stops working

**Symptom:**
- Sync logs show `CJ API call` with HTTP 404 or unexpected response shape
- Variant quarantine triggers for CJ variants
- Dashboard shows CJ circuit breaker OPEN

**Diagnosis:**
CJ occasionally renames or deprecates API endpoints. The error message in the
log will tell you which endpoint failed.

**Fix:**
1. Check `GET /api/logs?type=price_stock` for the specific error
2. Go to https://developers.cjdropshipping.cn/en/api/api2/ and verify the endpoint
3. Update the affected method in `src/suppliers/CJPlugin.ts`
4. Check the comment at the top of CJPlugin.ts for the endpoint list
5. Run `npm run sync-once -- --dry-run` to confirm it works without side effects
6. Deploy the fix

**If CJ is down (not broken, just temporarily unavailable):**
The circuit breaker automatically backs off for 5 minutes after 5 consecutive
failures. No action needed — it will resume automatically when CJ recovers.

**CJ API key expired:**
1. Log into CJ Dropshipping → **My CJ → Authorization → API**
2. Generate a new API key
3. Update in **Settings → Supplier → CJ API Key**
4. The supplier connection test will run automatically

---

## 3. Alert webhook stopped firing

**Symptom:**
- Job failures are visible in logs but no Slack/Telegram message arrives
- `ALERT_FIRED_*` config keys are `"true"` but you never saw the message

**Diagnosis — check in order:**

**A. Webhook URL changed or expired:**
1. Go to **Settings → Alerts → Webhook URL**
2. Test the webhook manually:
   ```bash
   curl -X POST "https://hooks.slack.com/services/YOUR/WEBHOOK/URL" \
     -H "Content-Type: application/json" \
     -d '{"text": "Core Service webhook test"}'
   ```
3. If that returns non-200, the webhook URL needs regenerating in Slack/Discord

**B. Alert already fired and wasn't reset:**
The alert fires **once per streak** and the `ALERT_FIRED_*` flag stays true
until the job succeeds. If the job kept failing after the initial alert, no
further alerts fire by design.
1. Fix the underlying job failure
2. A single success automatically resets the streak and fired flag
3. The next failure streak will fire a fresh alert

**C. Alert threshold too high:**
1. Go to **Settings → Alerts → Failure threshold**
2. Lower it to `1` temporarily to verify the webhook works, then restore

**D. Network blocking on Railway:**
Railway outbound requests are unrestricted. If the webhook is on an internal
network, it won't be reachable from Railway.

---

## 4. Supplier changed their API format

**Symptom:**
- All variants for a specific supplier fail with JSON parse errors or missing fields
- Log shows unexpected response shape

**Fix:**
1. Check `GET /api/logs?type=price_stock` — filter by the error message
2. Identify which method failed (getStockAndPrice, createOrder, etc.)
3. Test the endpoint directly with the supplier's API docs
4. Update the plugin in `src/suppliers/<SupplierName>Plugin.ts`
5. Add a test in `tests/integration/` if the change is significant
6. Run `npm run sync-once -- --dry-run` to verify
7. Deploy

**Interim:** Disable the broken supplier in **Suppliers → [supplier] → Disable**.
This prevents the circuit breaker from blocking other suppliers.

---

## 5. eBay listing publish fails

**Symptom:**
- `POST /api/scouted/:id/publish` returns 503 or 422
- Autolist pipeline shows `listing_status=failed`

**Check `listing_error` field on the scouted item for the specific reason.**

| listing_error | Fix |
|--------------|-----|
| `eBay is not configured: missing...` | Add eBay credentials in Settings |
| `VeRO blocked: [brand]` | Remove the brand from the title/description, re-generate AI content |
| `Obfuscated brand detected: [brand]` | Same as above — fuzzy match caught an obfuscation |
| `eBay prohibited keyword: [term]` | Remove the prohibited term from title/description |
| `Title must be at least 10 characters` | AI generation produced a short title — regenerate |
| `At least one product image is required` | Add images via the Preview modal |
| `An eBay category ID is required` | Set category in the Preview modal |
| `EBAY_MERCHANT_LOCATION is not configured` | Set in Settings → eBay Credentials |
| `Offer creation failed (HTTP 409)` | SKU already has an offer on eBay — use `bulkUpdatePriceQuantity` instead |

**If eBay returns an unexpected error shape:**
1. Check `GET /api/logs` for the full error
2. Verify at https://developer.ebay.com/my/apiconfiguration that the app has `sell.inventory` and `sell.fulfillment` scopes
3. Sandbox credentials don't work against production endpoints — check `EBAY_ENVIRONMENT`

---

## 6. eBay account health alert (defect rate / late shipment)

**Symptom:**
- Dashboard Overview shows BELOW STANDARD or WARNING on the Seller Health panel
- Email from eBay about seller performance

**Immediate actions:**
1. **Do NOT trigger emergency stop unless you suspect automation is the cause**
2. Log into eBay Seller Hub → **Performance → Seller Dashboard**
3. Identify which metric is elevated and which orders are causing it

**Defect rate too high:**
- Usually caused by items that couldn't be fulfilled (supplier out of stock after sale)
- Check `GET /api/orders` for orders with `status=failed`
- File for eBay "defect removal" if the defect was outside your control: https://www.ebay.com/help/selling/managing-returns-refunds/managing-disputes/defects-removal

**Late shipment rate too high:**
- Check `GET /api/orders` for orders with `status=submitted` that are old
- The fulfillment loop may not be receiving tracking from the supplier
- Manually update tracking via eBay Seller Hub for stuck orders
- Consider switching to a supplier with faster fulfillment

**If automation is causing the problem:**
1. Click **Emergency Stop** on the Overview page
2. Investigate which orders were affected
3. Fix the root cause (supplier delay, eBay credentials, etc.)
4. Resume after clearing emergency stop and restarting the service

---

## 7. Job lock stuck (job never runs)

**Symptom:**
- Logs show `"could not acquire lock — skipping tick"` on every cycle
- No sync/order/fulfillment activity for a long time

**Cause:**
A previous process crashed while holding the lock. The `stale_after_s` timeout
(600 seconds) should clear it automatically — but if the server clock drifted
or the lock was acquired with a future timestamp, it may persist.

**Fix:**
```bash
# Option A: restart the service (releaseAllLocks is called on startup)
# Railway: Dashboard → your service → Restart

# Option B: clear manually
sqlite3 ./data/core.db "DELETE FROM job_locks;"
```

**Prevention:** The `releaseAllLocks` call on server startup already handles this
for normal redeploys. This only affects cases where the DB was copied from a
running instance.

---

## 8. Variant keeps failing / enters quarantine

**Symptom:**
- Variant shows `quarantined=1` in the DB
- Sync loop logs `"Skipping quarantined variant"`
- `GET /api/analytics/products` shows the variant with no recent sync

**Fix:**
1. Check `GET /api/logs?type=price_stock` for the last error for this SKU
2. Fix the underlying issue (variant ID changed on supplier, product discontinued, etc.)
3. Clear the quarantine from the dashboard: **Products → [variant] → Clear quarantine**
   (or if no UI button is present, directly via DB):
   ```sql
   UPDATE variant_failures SET quarantined=0, consecutive_fails=0 WHERE variant_id = <id>;
   ```
4. Run `npm run sync-once` to confirm the variant syncs cleanly

---

## 9. Order stuck in 'submitted' status (not fulfilling)

**Symptom:**
- Order has `status=submitted` with a `supplier_order_id` but never moves to `shipped`
- Fulfillment loop runs but skips this order

**Check 1 — Quarantined:**
```sql
SELECT ebay_order_id, fulfillment_failure_count, quarantined, last_fulfillment_error
FROM orders WHERE status = 'submitted';
```
If `quarantined=1`, clear it:
```sql
UPDATE orders SET quarantined=0, fulfillment_failure_count=0 WHERE id = <id>;
```

**Check 2 — Supplier order status:**
The supplier may not have marked the order as shipped yet. Check the order
directly in your supplier dashboard (CJ Order Management).

**Check 3 — TestPlugin:**
If the variant has `supplier_type=TEST`, `getOrderStatus` always returns
`isShipped=false` (by design — TestPlugin never auto-ships).

**Check 4 — eBay circuit open:**
```sql
SELECT * FROM circuit_breaker WHERE service_key = 'EBAY';
```
If `state=open`, wait for `open_until` to pass, or reset:
```sql
UPDATE circuit_breaker SET state='closed', failure_count=0 WHERE service_key='EBAY';
```

---

## 10. Database corruption / won't open

**Symptom:**
- Server fails to start with `SQLite error: database disk image is malformed`
- Or: WAL file is present but DB appears empty

**Fix — WAL recovery:**
```bash
sqlite3 ./data/core.db "PRAGMA integrity_check;"
sqlite3 ./data/core.db "PRAGMA wal_checkpoint(FULL);"
```

**Fix — restore from backup:**
```bash
# 1. Stop the service
# 2. Identify the most recent good backup
ls ./data/backups/

# 3. Restore
cp ./data/core.db ./data/core.db.corrupted-$(date +%Y%m%d)
cp ./data/backups/core.db-backup-<timestamp>.db ./data/core.db

# 4. Restart the service
```

If no backup is available, see `docs/setup.md` for rebuilding from scratch.
Orders and products can be partially reconstructed from eBay Seller Hub and
your supplier dashboard.

---

## 11. EMERGENCY_STOP is active after a restart

**Symptom:**
- Server starts but logs: `"EMERGENCY STOP is active — schedulers will NOT start"`
- Dashboard shows the red emergency stop banner

**This is intentional.** The flag persists across restarts so a crash during
automation doesn't silently resume problematic behavior.

**Fix:**
1. Investigate what triggered the stop (check `EMERGENCY_STOP_REASON` and logs)
2. Confirm the issue is resolved
3. Clear the flag:
   - Dashboard: click **Clear & restart service** in the red banner
   - Or: `POST /api/emergency-stop/resume` with your session token
4. **Restart the service** — schedulers only start on a fresh startup after the flag is cleared

---

## 12. Scout Service connection fails

**Symptom:**
- `POST /api/scouted/pull` returns 502
- Scout pull logs show `"Scout Service unreachable"`

**This is non-fatal by design.** Core Service continues all other automation
when Scout is down.

**Fix:**
1. Check if Scout Service is running: `curl http://127.0.0.1:4100/health`
2. If Scout is on a different host, verify `SCOUT_SERVICE_URL` in Settings
3. Increase `SCOUT_PULL_TIMEOUT_MS` if the Scout response is slow but reachable

Scout pull failures never affect sync, order routing, or fulfillment.

---

## Quick diagnostic SQL queries

```sql
-- Last 5 job results per type
SELECT type, result, error_message, run_at
FROM sync_logs ORDER BY id DESC LIMIT 20;

-- Quarantined variants
SELECT v.internal_sku, vf.consecutive_fails, vf.last_error, vf.quarantined_at
FROM variant_failures vf JOIN variants v ON v.id = vf.variant_id
WHERE vf.quarantined = 1;

-- Quarantined orders
SELECT ebay_order_id, fulfillment_failure_count, last_fulfillment_error, quarantined_at
FROM orders WHERE quarantined = 1;

-- Circuit breaker states
SELECT * FROM circuit_breaker;

-- Current job locks
SELECT * FROM job_locks;

-- Emergency stop state
SELECT key, value FROM config WHERE key LIKE 'EMERGENCY%';

-- Recent config changes
SELECT key, value, updated_at FROM config ORDER BY updated_at DESC LIMIT 20;
```
