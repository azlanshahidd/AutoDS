/**
 * Password hashing and verification using Node's built-in crypto.scrypt.
 * No external dependencies required.
 *
 * Hash format stored in DB:  scrypt:<salt_hex>:<hash_hex>
 */
import crypto from "crypto";

const KEYLEN = 64;
const PARAMS = { N: 16384, r: 8, p: 1 };

/** Maximum password length accepted before hashing — prevents synchronous scrypt DoS. */
const MAX_PASSWORD_LENGTH = 1024;

export function hashPassword(password: string): string {
  if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error("Password must be a string of 1024 characters or fewer.");
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEYLEN, PARAMS).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) return false;
    const [, salt, expectedHash] = stored.split(":");
    if (!salt || !expectedHash) return false;
    const actualHash = crypto.scryptSync(password, salt, KEYLEN, PARAMS).toString("hex");
    // timing-safe comparison
    const a = Buffer.from(actualHash, "hex");
    const b = Buffer.from(expectedHash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Generate a random session token. */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}
