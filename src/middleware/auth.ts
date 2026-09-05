/**
 * Static-token auth middleware (Section 4b — non-negotiable). Every
 * dashboard-facing API route must be behind this. Compares using a
 * timing-safe equality check so response timing can't leak the token.
 */
import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

export function requireAuthToken(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const provided = req.header("X-Auth-Token") || "";

    const expectedBuf = Buffer.from(expectedToken);
    const providedBuf = Buffer.from(provided);

    const isValid =
      expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf);

    if (!isValid) {
      return res.status(401).json({ error: "Unauthorized. Missing or invalid X-Auth-Token header." });
    }

    next();
  };
}
