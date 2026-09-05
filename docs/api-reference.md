# Core Service — API Reference

## Interactive documentation

The full interactive API reference is served at **`/api-docs`** (Swagger UI).

- **Local dev:** http://127.0.0.1:4000/api-docs
- **Production:** https://your-service.railway.app/api-docs

The raw OpenAPI 3.0 JSON spec is at `/api-docs/spec.json`.

To try endpoints in the browser:
1. Call `POST /api/auth/login` with your password
2. Copy the returned `token`
3. Click **Authorize** in Swagger UI and enter the token
4. All authenticated endpoints will include the `X-Auth-Token` header automatically

---

## Authentication

All routes except `/health`, `/api/auth/login`, and the scraper push endpoint
(`POST /api/scouted` with `Authorization: Bearer <key>`) require:

```
X-Auth-Token: <session token from POST /api/auth/login>
```

Tokens are session-scoped (stored in the `config` table as `ACTIVE_SESSION_TOKEN`).
A new login invalidates the previous token.

---

## Route groups

### System
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Service health check |
| GET | `/api-docs` | None | Swagger UI |
| GET | `/api-docs/spec.json` | None | Raw OpenAPI 3.0 spec |

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | None | Get session token |
| POST | `/api/auth/logout` | Session | Invalidate session |

### Overview
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/overview` | Session | Dashboard stats (job health, order counts) |
| GET | `/api/overview/setup-status` | Session | Onboarding checklist state |
| GET | `/api/config/auto-order-enabled` | Session | Read AUTO_ORDER_ENABLED |
| PATCH | `/api/config/auto-order-enabled` | Session | Toggle AUTO_ORDER_ENABLED live |
| GET | `/api/seller-health` | Session | eBay seller performance metrics (1h cache) |

### Products
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/products` | Session | All tracked variants |
| PATCH | `/api/products/:sku/price` | Session | Override variant price (sets ebay_push_pending) |

### Orders
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/orders` | Session | All eBay orders + fulfillment status |

### Logs
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/logs` | Session | Sync logs (`?type=price_stock&limit=100`) |
| DELETE | `/api/logs` | Session | Clear all logs (or filtered by type) |
| DELETE | `/api/logs/:id` | Session | Delete a single log entry |

### Suppliers
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/suppliers/available-plugins` | Session | Plugins you can add |
| GET | `/api/suppliers` | Session | Configured suppliers (keys masked) |
| POST | `/api/suppliers` | Session | Add supplier + immediate connection test |
| PATCH | `/api/suppliers/:id` | Session | Edit credentials or pricing overrides |
| DELETE | `/api/suppliers/:id` | Session | Remove supplier (blocks if variants exist) |
| POST | `/api/suppliers/:id/test-connection` | Session | Re-test credentials |
| PATCH | `/api/suppliers/:id/enabled` | Session | Enable/disable supplier |

### Scouted Items
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/scouted` | Session | All scouted items |
| POST | `/api/scouted` | Bearer key | Push item from scraper |
| DELETE | `/api/scouted` | Session | Bulk delete (requires `{"confirm":true}`) |
| POST | `/api/scouted/pull` | Session | Trigger Scout Service pull |
| POST | `/api/scouted/regenerate-seo` | Session | Bulk SEO regeneration (fire-and-forget) |
| DELETE | `/api/scouted/:id` | Session | Delete one item |
| POST | `/api/scouted/:id/approve` | Session | Approve (triggers pipeline if AUTO_LIST_ENABLED) |
| POST | `/api/scouted/:id/discard` | Session | Discard |
| POST | `/api/scouted/:id/generate-ai` | Session | Generate AI listing + SEO content |
| PATCH | `/api/scouted/:id/seo` | Session | Save edited meta title/description |
| GET | `/api/scouted/:id/preview` | Session | Preview what would be sent to eBay |
| POST | `/api/scouted/:id/publish` | Session | Publish listing to eBay (force:true) |
| PATCH | `/api/scouted/:id/category` | Session | Set eBay category ID |
| PATCH | `/api/scouted/:id/images` | Session | Set image URL list (max 24) |

### Settings
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/settings` | Session | All settings (sensitive fields masked) |
| PATCH | `/api/settings` | Session | Partial update — any CoreSettings fields |
| POST | `/api/settings/change-password` | Session | Change dashboard password |

### Analytics
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/analytics/summary` | Session | P&L totals + daily time-series (`?from=&to=`) |
| GET | `/api/analytics/products` | Session | Per-product profitability table |
| GET | `/api/analytics/suppliers` | Session | Supplier scorecards |
| GET | `/api/analytics/funnel` | Session | Scout → approve → list → sell funnel |
| GET | `/api/analytics/margin-alerts` | Session | Variants below margin floor |

### AI Providers
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/ai-providers` | Session | List providers |
| POST | `/api/ai-providers` | Session | Add provider + test connection |
| PATCH | `/api/ai-providers/:id` | Session | Edit provider |
| DELETE | `/api/ai-providers/:id` | Session | Delete provider |
| POST | `/api/ai-providers/:id/test` | Session | Test provider connection |

### Scrapers
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/scrapers` | Session | List connected scrapers |
| POST | `/api/scrapers/connect` | Session | Connect scraper by token |
| POST | `/api/scrapers/:id/test` | Session | Test scraper |
| DELETE | `/api/scrapers/:id` | Session | Disconnect scraper |

### Emergency Stop
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/emergency-stop` | Session | Current stop state |
| POST | `/api/emergency-stop` | Session | Halt all schedulers immediately |
| POST | `/api/emergency-stop/resume` | Session | Clear stop flag (restart required) |

---

## Common response patterns

**Success with data:**
```json
{ "products": [...] }
```

**Error:**
```json
{ "error": "Human-readable error message." }
```

**HTTP status codes used:**
| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 204 | Deleted (no body) |
| 400 | Bad request / validation error |
| 401 | Not authenticated |
| 404 | Resource not found |
| 409 | Conflict (concurrent edit / variants still referenced) |
| 422 | Unprocessable (VeRO blocked / quality gate failure) |
| 429 | Rate limited |
| 500 | Internal server error |
| 502 | External dependency unavailable (Scout Service) |
| 503 | eBay not configured |

---

## Rate limits

- Login: max 10 failed attempts per IP per 15 minutes
- No other rate limits on authenticated routes (single-operator tool)
- The underlying eBay and CJ APIs have their own rate limits, handled by
  the `withRetry` exponential backoff in `src/suppliers/retry.ts`
