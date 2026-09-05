/**
 * Auth routes — password-based login / logout.
 *
 * POST /api/auth/login
 *   Body: { password: string }
 *   Returns: { token: string }
 *
 * POST /api/auth/logout
 *   Requires: X-Auth-Token header matching the active session.
 *   Invalidates the session server-side.
 *
 * Security:
 *   - In-memory rate limiter: max 10 failed attempts per IP per 15 min.
 *   - Password length capped at 1024 chars before scrypt (DoS prevention).
 *   - Logout requires a valid session token (BUG-003 fix).
 */
import { Router, Request, Response } from "express";
import crypto from "crypto";
import Database from "better-sqlite3";
import { verifyPassword, generateSessionToken } from "../auth/password";
import { isLockedOut, recordFailure, clearFailures, retryAfterSeconds } from "../auth/rateLimit";
import { logger } from "../logger";

function getConfigValue(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setConfigValue(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value);
}

/** Timing-safe session token comparison. Returns false on any mismatch. */
function sessionTokensMatch(provided: string, stored: string): boolean {
  if (!provided || !stored) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function authRouter(db: Database.Database): Router {
  const router = Router();

  // POST /api/auth/login
  router.post("/login", (req: Request, res: Response) => {
    const ip = req.ip ?? "unknown";

    // BUG-002: rate-limit check before touching the password
    if (isLockedOut(ip)) {
      const wait = retryAfterSeconds(ip);
      logger.warn("Login blocked — rate limit exceeded", { ip });
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${wait} seconds.`,
      });
    }

    const { password } = req.body || {};

    // BUG-008: length cap enforced in verifyPassword, but also reject here early
    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "password is required." });
    }
    if (password.length > 1024) {
      return res.status(400).json({ error: "Password too long." });
    }

    const storedHash = getConfigValue(db, "DASHBOARD_PASSWORD_HASH");
    if (!storedHash) {
      return res.status(500).json({
        error: "No password configured. Set DASHBOARD_AUTH_TOKEN in .env to set the initial password.",
      });
    }

    if (!verifyPassword(password, storedHash)) {
      recordFailure(ip);
      logger.warn("Failed login attempt", { ip });
      return res.status(401).json({ error: "Incorrect password." });
    }

    // Successful login — clear failure counter and issue token
    clearFailures(ip);
    const token = generateSessionToken();
    setConfigValue(db, "ACTIVE_SESSION_TOKEN", token);

    logger.info("Dashboard login successful", { ip });
    res.json({ token });
  });

  // POST /api/auth/logout — BUG-003 fix: requires valid session token
  router.post("/logout", (req: Request, res: Response) => {
    const provided     = req.header("X-Auth-Token") ?? "";
    const sessionToken = getConfigValue(db, "ACTIVE_SESSION_TOKEN") ?? "";

    if (!sessionTokensMatch(provided, sessionToken)) {
      return res.status(401).json({ error: "Not authenticated." });
    }

    setConfigValue(db, "ACTIVE_SESSION_TOKEN", "");
    logger.info("Dashboard logout");
    res.json({ success: true });
  });

  return router;
}
