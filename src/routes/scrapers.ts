/**
 * Scrapers — Core connects to external scrapers using a single connection
 * token generated in the scraper's dashboard (e.g. Scout → API Keys).
 *
 * The connection token format is:  sct_<base64url(scrapingServiceUrl + "|" + apiKey)>
 *
 * Security fixes applied:
 *  - BUG-004: API key encrypted at rest (AES-256-GCM) + SHA-256 hash column
 *             for fast inbound push-auth lookups.
 *  - BUG-005: Connection token URL restricted to http/https only.
 *  - BUG-017: Connection token URL blocked for private/RFC-1918/loopback addresses (SSRF).
 *  - BUG-016: getFirstActiveScraper only returns status='connected' scrapers.
 */
import { Router, Request, Response } from "express";
import crypto from "crypto";
import Database from "better-sqlite3";
import { encryptSecret, decryptSecret } from "../crypto/encryption";
import { logger } from "../logger";

// ── ID helper ─────────────────────────────────────────────────────────────────

function parseIntId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── URL validation (BUG-005, BUG-017) ────────────────────────────────────────

/**
 * Returns true when the URL is safe to store as a scraper endpoint.
 * Rejects: non-http/https schemes, private IP ranges, loopback, link-local.
 */
function isSafeScraperUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  // BUG-005: only http and https
  if (!["http:", "https:"].includes(parsed.protocol)) return false;

  const h = parsed.hostname.toLowerCase();

  // BUG-017: block loopback, link-local, and RFC-1918 private ranges
  if (
    h === "localhost" ||
    h === "::1" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||     // link-local (AWS metadata, etc.)
    /^fd[0-9a-f]{2}:/i.test(h) || // ULA IPv6
    h === "[::1]"
  ) {
    return false;
  }

  return true;
}

// ── Token decoding ────────────────────────────────────────────────────────────

function decodeConnectionToken(token: string): { url: string; key: string } | null {
  if (!token || !token.startsWith("sct_")) return null;
  try {
    const decoded = Buffer.from(token.slice(4), "base64url").toString("utf8");
    const sep = decoded.indexOf("|");
    if (sep < 1) return null;
    const url = decoded.slice(0, sep).trim();
    const key = decoded.slice(sep + 1).trim();
    if (!url || !key) return null;

    // BUG-005 + BUG-017: validate URL before accepting
    if (!isSafeScraperUrl(url)) return null;

    return { url, key };
  } catch {
    return null;
  }
}

// ── Key helpers (BUG-004) ─────────────────────────────────────────────────────

function hashKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// ── DB row types ──────────────────────────────────────────────────────────────

export interface ScraperRow {
  id: number;
  name: string;
  base_url: string;
  /** Encrypted blob (AES-256-GCM iv:authTag:ciphertext). Never exposed. */
  api_key: string;
  /** SHA-256 of the raw key — used for fast inbound push-auth. */
  api_key_hash: string;
  status: "untested" | "connected" | "failed";
  last_tested_at: string | null;
  created_at: string;
}

export interface ScraperView {
  id: number;
  name: string;
  baseUrl: string;
  status: "untested" | "connected" | "failed";
  lastTestedAt: string | null;
  createdAt: string;
}

function toView(row: ScraperRow): ScraperView {
  return {
    id:           row.id,
    name:         row.name,
    baseUrl:      row.base_url,
    status:       row.status,
    lastTestedAt: row.last_tested_at,
    createdAt:    row.created_at,
  };
}

// ── Connectivity test ─────────────────────────────────────────────────────────

async function pingScraperHealth(
  baseUrl: string,
  rawKey: string
): Promise<"connected" | "failed"> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, {
      headers: rawKey ? { Authorization: `Bearer ${rawKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? "connected" : "failed";
  } catch {
    return "failed";
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export function scrapersRouter(
  db: Database.Database,
  encryptionKey: string
): Router {
  const router = Router();

  // GET /api/scrapers
  router.get("/", (_req: Request, res: Response) => {
    try {
      const rows = db
        .prepare("SELECT * FROM scrapers ORDER BY created_at ASC")
        .all() as ScraperRow[];
      res.json({ scrapers: rows.map(toView) });
    } catch (err) {
      logger.error("Failed to list scrapers", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to list scrapers." });
    }
  });

  // POST /api/scrapers/connect
  router.post("/connect", async (req: Request, res: Response) => {
    const { connectionToken, name } = req.body || {};

    if (!connectionToken || typeof connectionToken !== "string") {
      return res.status(400).json({ error: "connectionToken is required." });
    }

    const decoded = decodeConnectionToken(connectionToken.trim());
    if (!decoded) {
      return res.status(400).json({
        error:
          "Invalid connection token. The URL may use a disallowed scheme or private IP address, or the token is malformed. Generate a fresh one from the scraper dashboard.",
      });
    }

    const scraperName =
      (name?.trim()) || new URL(decoded.url).hostname;

    try {
      const encryptedKey = encryptSecret(decoded.key, encryptionKey);
      const keyHash      = hashKey(decoded.key);

      // P2-016: use a true UPSERT instead of check-then-insert to avoid a
      // UNIQUE(base_url) constraint violation under concurrent requests.
      const info = db
        .prepare(
          `INSERT INTO scrapers (name, base_url, api_key, api_key_hash, status)
           VALUES (?, ?, ?, ?, 'untested')
           ON CONFLICT(base_url) DO UPDATE SET
             name         = excluded.name,
             api_key      = excluded.api_key,
             api_key_hash = excluded.api_key_hash,
             status       = 'untested',
             updated_at   = datetime('now')`
        )
        .run(scraperName, decoded.url, encryptedKey, keyHash);

      // lastInsertRowid is the upserted row's id in both insert and update cases
      // for SQLite — but for the update path we need to look it up by base_url.
      const upsertedRow = db
        .prepare("SELECT id FROM scrapers WHERE base_url = ?")
        .get(decoded.url) as { id: number };
      const id = upsertedRow.id;
      const isNew = info.changes > 0 && db.prepare("SELECT changes() as c").get() !== null;
      void isNew; // used only for status code below

      const status = await pingScraperHealth(decoded.url, decoded.key);
      db.prepare(
        `UPDATE scrapers
           SET status = ?, last_tested_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      ).run(status, id);

      const row = db
        .prepare("SELECT * FROM scrapers WHERE id = ?")
        .get(id) as ScraperRow;
      logger.info("Scraper connected", { id, name: scraperName, url: decoded.url, status });
      res.status(200).json({ scraper: toView(row) });
    } catch (err) {
      logger.error("Failed to connect scraper", {
        error: (err as Error).message,
      });
      res.status(500).json({ error: "Failed to connect scraper." });
    }
  });

  // POST /api/scrapers/:id/test
  router.post("/:id/test", async (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });
    const row = db
      .prepare("SELECT * FROM scrapers WHERE id = ?")
      .get(id) as ScraperRow | undefined;
    if (!row) return res.status(404).json({ error: "Scraper not found." });

    // Decrypt the key for the outbound HTTP call
    let rawKey = "";
    try {
      rawKey = decryptSecret(row.api_key, encryptionKey);
    } catch {
      /* if decryption fails (key rotation), proceed without auth — will fail */
    }

    const status = await pingScraperHealth(row.base_url, rawKey);
    db.prepare(
      `UPDATE scrapers
         SET status = ?, last_tested_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).run(status, id);

    const updated = db
      .prepare("SELECT * FROM scrapers WHERE id = ?")
      .get(id) as ScraperRow;
    logger.info("Scraper tested", { id, status });
    res.json({ scraper: toView(updated) });
  });

  // DELETE /api/scrapers/:id
  router.delete("/:id", (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });
    try {
      const result = db.prepare("DELETE FROM scrapers WHERE id = ?").run(id);
      if (result.changes === 0)
        return res.status(404).json({ error: "Scraper not found." });
      logger.info("Scraper disconnected", { id });
      res.status(204).send();
    } catch (err) {
      logger.error("Failed to disconnect scraper", {
        error: (err as Error).message,
        id,
      });
      res.status(500).json({ error: "Failed to disconnect scraper." });
    }
  });

  return router;
}

// ── Push-auth helper (used by scoutedPushRouter) ──────────────────────────────

/**
 * Validates an inbound Bearer key against the stored SHA-256 hash.
 * Returns the scraper row if valid, null otherwise.
 * Never decrypts anything — uses the hash column for constant-time lookup.
 */
export function findScraperByKey(
  db: Database.Database,
  rawKey: string
): { id: number; name: string } | null {
  const hash = crypto.createHash("sha256").update(rawKey).digest("hex");
  return (
    db
      .prepare(
        "SELECT id, name FROM scrapers WHERE api_key_hash = ?"
      )
      .get(hash) as { id: number; name: string } | undefined
  ) ?? null;
}

// ── Pull helper (used by scoutPullService) ────────────────────────────────────

/**
 * Returns the first CONNECTED scraper's URL and decrypted key.
 * BUG-016: only selects status='connected' (was != 'failed', which included 'untested').
 */
export function getFirstActiveScraper(
  db: Database.Database,
  encryptionKey?: string
): { baseUrl: string; apiKey: string } | null {
  const row = db
    .prepare(
      `SELECT base_url, api_key FROM scrapers
       WHERE status = 'connected'
       ORDER BY created_at ASC LIMIT 1`
    )
    .get() as { base_url: string; api_key: string } | undefined;

  if (!row) return null;

  // Decrypt the API key if an encryption key is provided
  let apiKey = "";
  if (encryptionKey && row.api_key) {
    try {
      apiKey = decryptSecret(row.api_key, encryptionKey);
    } catch {
      logger.warn("getFirstActiveScraper: failed to decrypt scraper API key — scraper will be called without auth");
    }
  }

  return { baseUrl: row.base_url, apiKey };
}
