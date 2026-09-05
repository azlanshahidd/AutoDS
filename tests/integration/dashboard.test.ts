/**
 * Integration tests for the Core Service dashboard API routes.
 *
 * Uses a real in-memory SQLite DB (via makeTestDb) and the actual Express
 * application wired together — no mocks. Covers the routes most likely to
 * regress silently:
 *
 *  - GET  /api/overview               — stats aggregation
 *  - GET  /api/orders                 — order list
 *  - GET  /api/logs                   — sync log list + type filter
 *  - GET  /api/logs?type=invalid      — 400 validation
 *  - DELETE /api/logs/:id             — delete a log entry
 *  - DELETE /api/logs/:id (bad id)    — 400 guard
 *  - PATCH /api/config/auto-order-enabled — toggle + validation
 *  - Auth: missing token → 401, wrong token → 401
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { makeTestDb, TEST_SESSION_TOKEN, seedOrder } from "../helpers/makeTestDb";
import { dashboardRouter } from "../../src/routes/dashboard";
import type { TestDb } from "../helpers/makeTestDb";
import Database from "better-sqlite3";

// ── Minimal Express app wired the same way as index.ts ────────────────────────

function buildApp(db: Database.Database) {
  const app = express();
  app.use(express.json());

  // Auth middleware — mirrors index.ts
  app.use("/api", (req, res, next) => {
    const provided = req.header("X-Auth-Token") ?? "";
    const stored = (
      db.prepare("SELECT value FROM config WHERE key = 'ACTIVE_SESSION_TOKEN'").get() as
        | { value: string }
        | undefined
    )?.value ?? "";
    if (!provided || provided !== stored) {
      return res.status(401).json({ error: "Not authenticated." });
    }
    next();
  });

  app.use("/api", dashboardRouter(db));
  return app;
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

let fixture: TestDb;
let app: ReturnType<typeof express>;

beforeEach(() => {
  fixture = makeTestDb();
  app = buildApp(fixture.db);
});

afterEach(() => {
  fixture.db.close();
});

const auth = { "X-Auth-Token": TEST_SESSION_TOKEN };

// ── Auth guard ────────────────────────────────────────────────────────────────

describe("auth guard", () => {
  it("returns 401 with no token", async () => {
    const res = await request(app).get("/api/overview");
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    const res = await request(app)
      .get("/api/overview")
      .set("X-Auth-Token", "wrong-token");
    expect(res.status).toBe(401);
  });
});

// ── GET /api/overview ─────────────────────────────────────────────────────────

describe("GET /api/overview", () => {
  it("returns 200 with expected shape", async () => {
    const res = await request(app).get("/api/overview").set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("autoOrderEnabled");
    expect(res.body).toHaveProperty("productsTracked");
    expect(typeof res.body.productsTracked).toBe("number");
  });

  it("reflects the seeded variant count", async () => {
    const res = await request(app).get("/api/overview").set(auth);
    // makeTestDb seeds 1 variant
    expect(res.body.productsTracked).toBe(1);
  });
});

// ── GET /api/orders ───────────────────────────────────────────────────────────

describe("GET /api/orders", () => {
  it("returns empty orders array initially", async () => {
    const res = await request(app).get("/api/orders").set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.orders)).toBe(true);
    expect(res.body.orders).toHaveLength(0);
  });

  it("returns seeded orders", async () => {
    seedOrder(fixture.db, { ebayOrderId: "EBAY-TEST-001" });
    const res = await request(app).get("/api/orders").set(auth);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].ebay_order_id).toBe("EBAY-TEST-001");
  });
});

// ── GET /api/logs ─────────────────────────────────────────────────────────────

describe("GET /api/logs", () => {
  beforeEach(() => {
    // Insert two log rows of different types
    fixture.db.prepare(
      `INSERT INTO sync_logs (type, result) VALUES ('price_stock', 'success')`
    ).run();
    fixture.db.prepare(
      `INSERT INTO sync_logs (type, result) VALUES ('order_routing', 'failure')`
    ).run();
  });

  it("returns all logs without type filter", async () => {
    const res = await request(app).get("/api/logs").set(auth);
    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(2);
  });

  it("filters by valid type", async () => {
    const res = await request(app)
      .get("/api/logs?type=price_stock")
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].type).toBe("price_stock");
  });

  it("returns 400 for invalid type", async () => {
    const res = await request(app)
      .get("/api/logs?type=hacking")
      .set(auth);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid log type/i);
  });

  it("respects the limit param", async () => {
    // Insert 5 more logs (7 total)
    for (let i = 0; i < 5; i++) {
      fixture.db.prepare(
        `INSERT INTO sync_logs (type, result) VALUES ('fulfillment_tracking', 'success')`
      ).run();
    }
    const res = await request(app)
      .get("/api/logs?limit=3")
      .set(auth);
    expect(res.body.logs).toHaveLength(3);
  });
});

// ── DELETE /api/logs/:id ──────────────────────────────────────────────────────

describe("DELETE /api/logs/:id", () => {
  it("deletes an existing log entry and returns 204", async () => {
    const insert = fixture.db.prepare(
      `INSERT INTO sync_logs (type, result) VALUES ('price_stock', 'success')`
    ).run();
    const id = insert.lastInsertRowid;

    const res = await request(app)
      .delete(`/api/logs/${id}`)
      .set(auth);
    expect(res.status).toBe(204);

    const remaining = fixture.db
      .prepare("SELECT COUNT(*) as n FROM sync_logs")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("returns 404 for a non-existent log id", async () => {
    const res = await request(app).delete("/api/logs/9999").set(auth);
    expect(res.status).toBe(404);
  });

  it("returns 400 for a non-integer id", async () => {
    const res = await request(app).delete("/api/logs/abc").set(auth);
    expect(res.status).toBe(400);
  });

  it("returns 400 for id=0", async () => {
    const res = await request(app).delete("/api/logs/0").set(auth);
    expect(res.status).toBe(400);
  });
});

// ── PATCH /api/config/auto-order-enabled ─────────────────────────────────────

describe("PATCH /api/config/auto-order-enabled", () => {
  it("enables auto-order and reflects in GET", async () => {
    const patch = await request(app)
      .patch("/api/config/auto-order-enabled")
      .set(auth)
      .send({ enabled: true });
    expect(patch.status).toBe(200);
    expect(patch.body.enabled).toBe(true);

    const get = await request(app)
      .get("/api/config/auto-order-enabled")
      .set(auth);
    expect(get.body.enabled).toBe(true);
  });

  it("disables auto-order", async () => {
    // Enable first
    await request(app)
      .patch("/api/config/auto-order-enabled")
      .set(auth)
      .send({ enabled: true });

    const patch = await request(app)
      .patch("/api/config/auto-order-enabled")
      .set(auth)
      .send({ enabled: false });
    expect(patch.status).toBe(200);
    expect(patch.body.enabled).toBe(false);
  });

  it("returns 400 when body is missing enabled field", async () => {
    const res = await request(app)
      .patch("/api/config/auto-order-enabled")
      .set(auth)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when enabled is a string instead of boolean", async () => {
    const res = await request(app)
      .patch("/api/config/auto-order-enabled")
      .set(auth)
      .send({ enabled: "true" });
    expect(res.status).toBe(400);
  });
});
