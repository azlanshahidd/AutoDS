/**
 * AES-256-GCM encryption for supplier API keys/secrets at rest (Section 2 /
 * Section 4b). Uses Node's built-in `crypto` — no third-party crypto lib.
 *
 * Stored format: "<ivHex>:<authTagHex>:<ciphertextHex>" — a single string
 * so it fits cleanly in one SQLite TEXT column per field.
 */
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM

export function encryptSecret(plaintext: string, encryptionKeyHex: string): string {
  const key = Buffer.from(encryptionKeyHex, "hex");
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(stored: string, encryptionKeyHex: string): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted value — expected iv:authTag:ciphertext hex format.");
  }

  const key = Buffer.from(encryptionKeyHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Returns a masked display version of a secret, e.g. "ep_live_••••1823"
 * (Section 4b) — never the full value. Shows only the last 4 characters.
 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 4) return "••••";
  const prefix = plaintext.slice(0, Math.min(4, Math.max(0, plaintext.length - 4)));
  const suffix = plaintext.slice(-4);
  // Keep a short recognizable prefix if the value looks like a namespaced key
  // (e.g. "ep_live_...") — otherwise just mask everything but the last 4.
  const looksNamespaced = /^[a-zA-Z0-9]+_[a-zA-Z0-9]+_/.test(plaintext);
  if (looksNamespaced) {
    const namespaceMatch = plaintext.match(/^([a-zA-Z0-9]+_[a-zA-Z0-9]+_)/);
    const namespace = namespaceMatch ? namespaceMatch[1] : "";
    return `${namespace}••••${suffix}`;
  }
  return `••••${suffix}`;
}
