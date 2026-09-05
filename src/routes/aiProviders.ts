/**
 * AI Providers — CRUD + connectivity test.
 *
 * Fixes applied:
 *  P2-001 — parseIntId guard on every :id route
 *  P2-008 — PATCH validates `enabled` is a boolean (string "true" rejected)
 *  P2-009 — POST requires non-empty apiKey
 *  P2-017 — duplicate provider names rejected (409)
 *  P2-018 — empty name on PATCH rejected (400)
 */
import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import { logger } from "../logger";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseIntId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── DB row / view types ───────────────────────────────────────────────────────

interface AiProviderRow {
  id: number;
  name: string;
  provider_type: "openai_compatible" | "gemini" | "cohere";
  base_url: string;
  api_key: string;
  model: string;
  enabled: number;
  status: "untested" | "connected" | "failed";
  last_tested_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AiProviderView {
  id: number;
  name: string;
  providerType: "openai_compatible" | "gemini" | "cohere";
  baseUrl: string;
  model: string;
  hasKey: boolean;
  enabled: boolean;
  status: "untested" | "connected" | "failed";
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toView(row: AiProviderRow): AiProviderView {
  return {
    id:           row.id,
    name:         row.name,
    providerType: row.provider_type,
    baseUrl:      row.base_url,
    model:        row.model,
    hasKey:       row.api_key.length > 0,
    enabled:      row.enabled === 1,
    status:       row.status,
    lastTestedAt: row.last_tested_at,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
  };
}

// ── Provider ping ─────────────────────────────────────────────────────────────

interface PingResult {
  status: "connected" | "failed";
  reason?: string;
}

export async function pingAiProvider(
  baseUrl: string,
  apiKey: string,
  model: string,
  providerType: "openai_compatible" | "gemini" | "cohere"
): Promise<PingResult> {
  const base = baseUrl.replace(/\/$/, "");
  try {
    if (providerType === "openai_compatible") {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Say hello in 3 words." }],
          max_tokens: 20,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        const reason = (errBody as any)?.error?.message ?? `HTTP ${res.status}`;
        logger.warn("AI provider ping failed (openai_compatible)", { status: res.status, reason, model, baseUrl });
        return { status: "failed", reason };
      }
      const body = await res.json().catch(() => null);
      const text: unknown = body?.choices?.[0]?.message?.content;
      return typeof text === "string" && text.trim().length > 0
        ? { status: "connected" }
        : { status: "failed", reason: "No content in response" };
    }

    if (providerType === "gemini") {
      const res = await fetch(
        `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "Say hello in 3 words." }] }],
          }),
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        const reason = (errBody as any)?.error?.message ?? `HTTP ${res.status}`;
        logger.warn("AI provider ping failed (gemini)", { status: res.status, reason, model, baseUrl });
        return { status: "failed", reason };
      }
      const body = await res.json().catch(() => null);
      const text: unknown = body?.candidates?.[0]?.content?.parts?.[0]?.text;
      return typeof text === "string" && text.trim().length > 0
        ? { status: "connected" }
        : { status: "failed", reason: "No content in response" };
    }

    if (providerType === "cohere") {
      const res = await fetch(`${base}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, message: "Say hello in 3 words." }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        const reason = (errBody as any)?.message ?? `HTTP ${res.status}`;
        logger.warn("AI provider ping failed (cohere)", { status: res.status, reason, model, baseUrl });
        return { status: "failed", reason };
      }
      const body = await res.json().catch(() => null);
      const text: unknown = body?.text;
      return typeof text === "string" && text.trim().length > 0
        ? { status: "connected" }
        : { status: "failed", reason: "No content in response" };
    }

    return { status: "failed", reason: "Unknown provider type" };
  } catch (err) {
    const reason = (err as Error).message ?? "Network error";
    logger.warn("AI provider ping threw", { providerType, model, baseUrl, reason });
    return { status: "failed", reason };
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export function aiProvidersRouter(db: Database.Database): Router {
  const router = Router();

  // GET /api/ai-providers
  router.get("/", (_req: Request, res: Response) => {
    try {
      const rows = db
        .prepare("SELECT * FROM ai_providers ORDER BY created_at ASC")
        .all() as AiProviderRow[];
      res.json({ providers: rows.map(toView) });
    } catch (err) {
      logger.error("Failed to list AI providers", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to list AI providers." });
    }
  });

  // POST /api/ai-providers
  router.post("/", async (req: Request, res: Response) => {
    const { name, providerType, baseUrl, apiKey, model } = req.body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required." });
    }
    if (!["openai_compatible", "gemini", "cohere"].includes(providerType)) {
      return res.status(400).json({ error: "providerType must be openai_compatible, gemini, or cohere." });
    }
    if (!baseUrl || typeof baseUrl !== "string" || !baseUrl.trim()) {
      return res.status(400).json({ error: "baseUrl is required." });
    }
    if (!model || typeof model !== "string" || !model.trim()) {
      return res.status(400).json({ error: "model is required." });
    }
    // P2-009: apiKey is required and must be non-empty
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return res.status(400).json({ error: "apiKey is required." });
    }

    // P2-017: unique name check
    const duplicate = db
      .prepare("SELECT id FROM ai_providers WHERE name = ?")
      .get(name.trim());
    if (duplicate) {
      return res.status(409).json({ error: `An AI provider named "${name.trim()}" already exists.` });
    }

    try {
      const info = db
        .prepare(
          `INSERT INTO ai_providers (name, provider_type, base_url, api_key, model, enabled, status)
           VALUES (?, ?, ?, ?, ?, 1, 'untested')`
        )
        .run(name.trim(), providerType, baseUrl.trim(), apiKey.trim(), model.trim());

      const id = Number(info.lastInsertRowid);

      const { status, reason } = await pingAiProvider(
        baseUrl.trim(), apiKey.trim(), model.trim(), providerType
      );
      db.prepare(
        `UPDATE ai_providers SET status = ?, last_tested_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).run(status, id);

      const row = db.prepare("SELECT * FROM ai_providers WHERE id = ?").get(id) as AiProviderRow;
      logger.info("AI provider added", { id, name: row.name, providerType, status, reason });
      res.status(201).json({ provider: toView(row), reason });
    } catch (err) {
      logger.error("Failed to add AI provider", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to add AI provider." });
    }
  });

  // PATCH /api/ai-providers/:id
  router.patch("/:id", async (req: Request, res: Response) => {
    // P2-001
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    const row = db.prepare("SELECT * FROM ai_providers WHERE id = ?").get(id) as AiProviderRow | undefined;
    if (!row) return res.status(404).json({ error: "AI provider not found." });

    const { name, providerType, baseUrl, apiKey, model, enabled } = req.body || {};

    // P2-018: name must not be empty if provided
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "name cannot be empty." });
      }
      // P2-017: unique name check (exclude self)
      const dup = db
        .prepare("SELECT id FROM ai_providers WHERE name = ? AND id != ?")
        .get(name.trim(), id);
      if (dup) {
        return res.status(409).json({ error: `An AI provider named "${name.trim()}" already exists.` });
      }
    }

    // P2-008: enabled must be a boolean if provided
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean." });
    }

    const newName         = typeof name === "string" && name.trim() ? name.trim() : row.name;
    const newProviderType = (["openai_compatible", "gemini", "cohere"].includes(providerType))
                            ? (providerType as AiProviderRow["provider_type"]) : row.provider_type;
    const newBaseUrl      = typeof baseUrl === "string" ? baseUrl.trim() : row.base_url;
    const newApiKey       = typeof apiKey === "string" && apiKey.length > 0 ? apiKey : row.api_key;
    const newModel        = typeof model === "string" ? model.trim() : row.model;
    const newEnabled      = typeof enabled === "boolean" ? (enabled ? 1 : 0) : row.enabled;

    const credentialsChanged =
      newBaseUrl      !== row.base_url      ||
      newApiKey       !== row.api_key       ||
      newModel        !== row.model         ||
      newProviderType !== row.provider_type;

    try {
      db.prepare(
        `UPDATE ai_providers
           SET name = ?, provider_type = ?, base_url = ?, api_key = ?, model = ?,
               enabled = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(newName, newProviderType, newBaseUrl, newApiKey, newModel, newEnabled, id);

      let pingReason: string | undefined;
      if (credentialsChanged) {
        const { status, reason } = await pingAiProvider(newBaseUrl, newApiKey, newModel, newProviderType);
        pingReason = reason;
        db.prepare(
          `UPDATE ai_providers SET status = ?, last_tested_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
        ).run(status, id);
        logger.info("AI provider re-tested after update", { id, status, reason });
      }

      const updated = db.prepare("SELECT * FROM ai_providers WHERE id = ?").get(id) as AiProviderRow;
      logger.info("AI provider updated", { id, credentialsChanged });
      res.json({ provider: toView(updated), reason: pingReason });
    } catch (err) {
      logger.error("Failed to update AI provider", { error: (err as Error).message, id });
      res.status(500).json({ error: "Failed to update AI provider." });
    }
  });

  // POST /api/ai-providers/:id/test — P2-001
  router.post("/:id/test", async (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    const row = db.prepare("SELECT * FROM ai_providers WHERE id = ?").get(id) as AiProviderRow | undefined;
    if (!row) return res.status(404).json({ error: "AI provider not found." });

    const { status, reason } = await pingAiProvider(row.base_url, row.api_key, row.model, row.provider_type);
    db.prepare(
      `UPDATE ai_providers SET status = ?, last_tested_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(status, id);

    const updated = db.prepare("SELECT * FROM ai_providers WHERE id = ?").get(id) as AiProviderRow;
    logger.info("AI provider tested", { id, status, reason });
    res.json({ provider: toView(updated), reason });
  });

  // DELETE /api/ai-providers/:id — P2-001
  router.delete("/:id", (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    try {
      const result = db.prepare("DELETE FROM ai_providers WHERE id = ?").run(id);
      if (result.changes === 0)
        return res.status(404).json({ error: "AI provider not found." });
      logger.info("AI provider deleted", { id });
      res.status(204).send();
    } catch (err) {
      logger.error("Failed to delete AI provider", { error: (err as Error).message, id });
      res.status(500).json({ error: "Failed to delete AI provider." });
    }
  });

  return router;
}
