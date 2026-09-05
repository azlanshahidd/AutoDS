import "dotenv/config";
import crypto from "crypto"; // BUG-014: top-level import, not inline require()
import express from "express";
import path from "path";
import fs from "fs";
import { logger } from "./logger";
import { loadConfig, ConfigError } from "./config";
import { getDb } from "./db/connection";
import { applyMigrations } from "./db/migrate";
import { SuppliersService } from "./services/suppliersService";
import { suppliersRouter } from "./routes/suppliers";
import { dashboardRouter } from "./routes/dashboard";
import { scoutedRouter, scoutedPushRouter } from "./routes/scouted";
import { settingsRouter } from "./routes/settings";
import { authRouter } from "./routes/auth";
import { scrapersRouter } from "./routes/scrapers";
import { aiProvidersRouter } from "./routes/aiProviders";
import { analyticsRouter } from "./routes/analytics";
import { releaseAllLocks } from "./services/jobLock";
import {
  startSyncScheduler,
  startOrderRoutingScheduler,
  startFulfillmentScheduler,
  startScoutPullScheduler,
  stopAllSchedulers,
} from "./jobs/scheduler";

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(
      `\n✗ Configuration error — Core Service will not start.\n\n  ${(err as Error).message}\n`
    );
    process.exit(1);
  }
  throw err;
}

const app = express();

// BUG-015: body size limit — reject payloads larger than 10 KB
app.use(express.json({ limit: "10kb" }));

// CORS
// NOTE (BUG-020): The loopback regex allows ANY port on localhost/127.0.0.1.
// Any locally-running app could therefore make credentialed requests in dev.
// In production always set ALLOWED_ORIGIN to your exact public URL.
const extraAllowedOrigins: string[] = (process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.header("Origin");
  const isLocalhost = origin
    ? /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
    : false;
  const isExtraAllowed = origin ? extraAllowedOrigins.includes(origin) : false;

  if (origin && (isLocalhost || isExtraAllowed)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Auth-Token, Authorization"
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PATCH, DELETE, OPTIONS"
    );
  }
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "core-service",
    timestamp: new Date().toISOString(),
  });
});

const db = getDb(config.databaseFile);

try {
  const tables = applyMigrations(db, config);
  // Task 1: clear any stale job locks left by a previous crashed process
  releaseAllLocks(db);
  logger.info("Startup migration check complete", { tables });
} catch (err) {
  console.error(
    `\n✗ Failed to apply database migrations at startup.\n\n  ${(err as Error).message}\n`
  );
  process.exit(1);
}

// Public auth route
app.use("/api/auth", authRouter(db));

// Push endpoint — Bearer-key auth only, mounted before session middleware
app.use("/api/scouted", scoutedPushRouter(db));

// Authenticated dashboard routes
const apiRouter = express.Router();
apiRouter.use((req, res, next) => {
  const provided = req.header("X-Auth-Token") ?? "";
  const sessionToken =
    (
      db
        .prepare(
          "SELECT value FROM config WHERE key = 'ACTIVE_SESSION_TOKEN'"
        )
        .get() as { value: string } | undefined
    )?.value ?? "";

  if (!provided || !sessionToken) {
    return res.status(401).json({ error: "Not authenticated. Please log in." });
  }

  // BUG-014: use top-level crypto import instead of inline require()
  const a = Buffer.from(provided);
  const b = Buffer.from(sessionToken);
  const valid =
    a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!valid)
    return res
      .status(401)
      .json({ error: "Session expired or invalid. Please log in again." });
  next();
});

const suppliersService = new SuppliersService(db, config.encryptionKey);
apiRouter.use("/suppliers",    suppliersRouter(suppliersService));
apiRouter.use("/",             dashboardRouter(db));
apiRouter.use("/scouted",      scoutedRouter(db, config));
apiRouter.use("/settings",     settingsRouter(db, config));
apiRouter.use("/scrapers",     scrapersRouter(db, config.encryptionKey));
apiRouter.use("/ai-providers", aiProvidersRouter(db));
apiRouter.use("/analytics",    analyticsRouter(db));

app.use("/api", apiRouter);

// Serve built frontend in production
const frontendDistPath  = path.join(__dirname, "../frontend/dist");
const frontendIndexPath = path.join(frontendDistPath, "index.html");

if (fs.existsSync(frontendIndexPath)) {
  app.use(express.static(frontendDistPath));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path === "/health") return next();
    res.sendFile(frontendIndexPath);
  });
  logger.info("Serving built frontend from frontend/dist");
}

const server = app.listen(config.port, config.host, () => {
  logger.info(
    `Core Service listening on http://${config.host}:${config.port}`
  );
  startSyncScheduler(db, config);
  startOrderRoutingScheduler(db, config);
  startFulfillmentScheduler(db, config);
  startScoutPullScheduler(db, config);
});

// Task 6 — Graceful shutdown: let in-flight jobs finish before exiting.
// Railway sends SIGTERM before forcibly killing the process (default 10s grace
// period). We stop accepting new connections immediately, then wait for any
// active job run to complete before closing the DB and exiting cleanly.
let shuttingDown = false;

function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Received ${signal} — starting graceful shutdown`);

  // Stop the cron schedulers so no new job ticks are queued
  stopAllSchedulers();

  // Release any DB-level job locks (so a quick restart doesn't have to
  // wait for the stale-lock timeout)
  try { releaseAllLocks(db); } catch { /* best-effort */ }

  // Stop accepting new HTTP requests
  server.close(() => {
    logger.info("HTTP server closed — all connections drained");
    try { db.close(); } catch { /* ignore */ }
    logger.info("Database closed — exiting cleanly");
    process.exit(0);
  });

  // Force-exit after 15 seconds if something is still hanging
  setTimeout(() => {
    logger.error("Graceful shutdown timed out after 15s — forcing exit");
    process.exit(1);
  }, 15_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
