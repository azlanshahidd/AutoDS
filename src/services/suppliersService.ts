/**
 * Suppliers service (Phase 2b). Backs the Suppliers dashboard page: list,
 * add/edit credentials (encrypted at rest), test connection, enable/disable,
 * remove (without deleting historical order data — orders reference
 * supplier_type as a plain string, not a foreign key to this table).
 */
import Database from "better-sqlite3";
import { encryptSecret, decryptSecret, maskSecret } from "../crypto/encryption";
import { CJPlugin } from "../suppliers/CJPlugin";
import { TestPlugin } from "../suppliers/TestPlugin";
import { CsvSupplierPlugin } from "../suppliers/CsvSupplierPlugin";
import { SupplierProvider } from "../suppliers/SupplierProvider";
import { logger } from "../logger";

export interface SupplierRow {
  id: number;
  supplier_key: string;
  display_name: string;
  encrypted_api_key: string | null;
  encrypted_api_secret: string | null;
  status: "unconfigured" | "connected" | "failed" | "disabled";
  last_tested_at: string | null;
  margin_override: number | null;
  fee_override: number | null;
  created_at: string;
  updated_at: string;
}

export interface SupplierPublicView {
  id: number;
  supplierKey: string;
  displayName: string;
  maskedApiKey: string | null;
  maskedApiSecret: string | null;
  status: SupplierRow["status"];
  lastTestedAt: string | null;
  marginOverride: number | null;
  feeOverride: number | null;
  createdAt: string;
  updatedAt: string;
}

// Plugins that can be added through the dashboard's "Add Supplier" dropdown.
// TEST is intentionally excluded here — it's a dev/CI tool, not something to
// expose as a real supplier choice in the UI.
export const AVAILABLE_SUPPLIER_PLUGINS = [
  { key: "CJ",  displayName: "CJ Dropshipping" },
  { key: "CSV", displayName: "Manual / CSV Supplier" },
];

export class UnsupportedSupplierPluginError extends Error {
  constructor(key: string) {
    super(`"${key}" has no implemented plugin yet. Available: ${AVAILABLE_SUPPLIER_PLUGINS.map((p) => p.key).join(", ")}`);
    this.name = "UnsupportedSupplierPluginError";
  }
}

export class SupplierNotFoundError extends Error {
  constructor(id: number) {
    super(`No supplier found with id ${id}`);
    this.name = "SupplierNotFoundError";
  }
}

function buildPluginForTest(supplierKey: string, apiKey: string, apiSecret?: string | null): SupplierProvider {
  switch (supplierKey.toUpperCase()) {
    case "CJ":
      return new CJPlugin({ apiKey });
    case "TEST":
      return new TestPlugin();
    case "CSV":
      // For CSV supplier: apiKey is treated as the optional webhook URL,
      // apiSecret (if set) is the Bearer token sent on webhook calls.
      return new CsvSupplierPlugin({
        webhookUrl: apiKey || undefined,
        apiKey:     apiSecret || undefined,
      });
    default:
      throw new UnsupportedSupplierPluginError(supplierKey);
  }
}

export class SuppliersService {
  constructor(private db: Database.Database, private encryptionKey: string) {}

  private toPublicView(row: SupplierRow): SupplierPublicView {
    // BUG-012: catch decryption failures per-row so a rotated/wrong ENCRYPTION_KEY
    // doesn't crash the entire suppliers list — show a clear indicator instead.
    const decryptOrFallback = (encrypted: string | null): string | null => {
      if (!encrypted) return null;
      try {
        return decryptSecret(encrypted, this.encryptionKey);
      } catch {
        return "[decryption failed — re-enter credentials]";
      }
    };

    const apiKeyPlain    = decryptOrFallback(row.encrypted_api_key);
    const apiSecretPlain = decryptOrFallback(row.encrypted_api_secret);

    return {
      id:              row.id,
      supplierKey:     row.supplier_key,
      displayName:     row.display_name,
      maskedApiKey:    apiKeyPlain ? maskSecret(apiKeyPlain) : null,
      maskedApiSecret: apiSecretPlain ? maskSecret(apiSecretPlain) : null,
      status:          row.status,
      lastTestedAt:    row.last_tested_at,
      marginOverride:  row.margin_override ?? null,
      feeOverride:     row.fee_override    ?? null,
      createdAt:       row.created_at,
      updatedAt:       row.updated_at,
    };
  }

  list(): SupplierPublicView[] {
    const rows = this.db.prepare("SELECT * FROM suppliers ORDER BY created_at ASC").all() as SupplierRow[];
    return rows.map((r) => this.toPublicView(r));
  }

  private getRow(id: number): SupplierRow {
    const row = this.db.prepare("SELECT * FROM suppliers WHERE id = ?").get(id) as SupplierRow | undefined;
    if (!row) throw new SupplierNotFoundError(id);
    return row;
  }

  /**
   * Adds a new supplier, encrypts+stores its credentials, then immediately
   * tests the connection (Section 4b: "never silently saves a bad key").
   */
  async addSupplier(params: {
    supplierKey: string;
    displayName?: string;
    apiKey: string;
    apiSecret?: string;
  }): Promise<SupplierPublicView> {
    const known = AVAILABLE_SUPPLIER_PLUGINS.find((p) => p.key === params.supplierKey.toUpperCase());
    if (!known) throw new UnsupportedSupplierPluginError(params.supplierKey);

    const encryptedApiKey = encryptSecret(params.apiKey, this.encryptionKey);
    const encryptedApiSecret = params.apiSecret ? encryptSecret(params.apiSecret, this.encryptionKey) : null;

    const info = this.db
      .prepare(
        `INSERT INTO suppliers (supplier_key, display_name, encrypted_api_key, encrypted_api_secret, status)
         VALUES (?, ?, ?, ?, 'unconfigured')`
      )
      .run(known.key, params.displayName || known.displayName, encryptedApiKey, encryptedApiSecret);

    const id = Number(info.lastInsertRowid);
    await this.testConnection(id);
    return this.toPublicView(this.getRow(id));
  }

  /** Edits an existing supplier's credentials and/or display name, then re-tests. */
  async editSupplier(
    id: number,
    params: { displayName?: string; apiKey?: string; apiSecret?: string; marginOverride?: number | null; feeOverride?: number | null }
  ): Promise<SupplierPublicView> {
    const row = this.getRow(id);

    const displayName = params.displayName ?? row.display_name;
    const encryptedApiKey = params.apiKey ? encryptSecret(params.apiKey, this.encryptionKey) : row.encrypted_api_key;
    const encryptedApiSecret = params.apiSecret
      ? encryptSecret(params.apiSecret, this.encryptionKey)
      : row.encrypted_api_secret;

    // Pricing overrides: undefined = don't touch, null = clear override (use global), number = set override
    const marginOverride = params.marginOverride !== undefined ? params.marginOverride : row.margin_override;
    const feeOverride    = params.feeOverride    !== undefined ? params.feeOverride    : row.fee_override;

    this.db
      .prepare(
        `UPDATE suppliers
           SET display_name = ?, encrypted_api_key = ?, encrypted_api_secret = ?,
               margin_override = ?, fee_override = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(displayName, encryptedApiKey, encryptedApiSecret, marginOverride, feeOverride, id);

    // Only re-test if credentials actually changed — editing just the display
    // name or pricing overrides shouldn't spend an API call or flip a working
    // "connected" status.
    if (params.apiKey || params.apiSecret) {
      await this.testConnection(id);
    }

    return this.toPublicView(this.getRow(id));
  }

  /**
   * Calls the plugin's lightweight auth-check (getAuthToken) and updates
   * status to 'connected' or 'failed' accordingly. Never places an order or
   * causes any other side effect.
   */
  async testConnection(id: number): Promise<SupplierPublicView> {
    const row = this.getRow(id);

    if (!row.encrypted_api_key) {
      this.db
        .prepare("UPDATE suppliers SET status = 'unconfigured', last_tested_at = datetime('now') WHERE id = ?")
        .run(id);
      return this.toPublicView(this.getRow(id));
    }

    let apiKey: string;
    try {
      apiKey = decryptSecret(row.encrypted_api_key, this.encryptionKey);
    } catch {
      // BUG-012: encryption key was rotated — mark as failed with a clear message
      logger.error("Supplier credential decryption failed — ENCRYPTION_KEY may have changed", {
        supplierKey: row.supplier_key, id,
      });
      this.db
        .prepare("UPDATE suppliers SET status = 'failed', last_tested_at = datetime('now') WHERE id = ?")
        .run(id);
      return this.toPublicView(this.getRow(id));
    }

    let apiSecret: string | null = null;
    try {
      if (row.encrypted_api_secret) {
        apiSecret = decryptSecret(row.encrypted_api_secret, this.encryptionKey);
      }
    } catch {
      // Non-fatal: apiSecret decryption failure only matters for plugins that use it
      logger.warn("Supplier apiSecret decryption failed — continuing without it", {
        supplierKey: row.supplier_key, id,
      });
    }

    let status: SupplierRow["status"] = "failed";
    try {
      const plugin = buildPluginForTest(row.supplier_key, apiKey, apiSecret);
      await plugin.getAuthToken();
      status = "connected";
      logger.info("Supplier connection test succeeded", { supplierKey: row.supplier_key, id });
    } catch (err) {
      status = "failed";
      logger.warn("Supplier connection test failed", {
        supplierKey: row.supplier_key,
        id,
        error: (err as Error).message,
      });
    }

    this.db
      .prepare("UPDATE suppliers SET status = ?, last_tested_at = datetime('now') WHERE id = ?")
      .run(status, id);

    return this.toPublicView(this.getRow(id));
  }

  /** Enable/disable — disabled suppliers are skipped by the sync loop (Phase 4+). */
  setEnabled(id: number, enabled: boolean): SupplierPublicView {
    const row = this.getRow(id);
    const newStatus = enabled ? (row.status === "disabled" ? "unconfigured" : row.status) : "disabled";
    this.db.prepare("UPDATE suppliers SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, id);
    return this.toPublicView(this.getRow(id));
  }

  /**
   * Updates only the pricing override fields, without re-testing credentials.
   * Accepts null to clear an override (revert to global config value).
   *
   * Bug fix: previously used COALESCE(?, existing) which meant null never
   * cleared the column. Direct assignment handles null correctly in SQLite.
   */
  setPricingOverrides(
    id: number,
    overrides: { marginOverride?: number | null; feeOverride?: number | null }
  ): SupplierPublicView {
    this.getRow(id); // throws SupplierNotFoundError if missing
    this.db.prepare(
      `UPDATE suppliers
         SET margin_override = ?,
             fee_override    = ?,
             updated_at      = datetime('now')
       WHERE id = ?`
    ).run(
      overrides.marginOverride !== undefined ? overrides.marginOverride : null,
      overrides.feeOverride    !== undefined ? overrides.feeOverride    : null,
      id
    );
    return this.toPublicView(this.getRow(id));
  }

  /**
   * Removes a supplier's credentials from the suppliers table.
   *
   * P2-023: blocks deletion when variants still reference this supplier_key.
   * Historical orders reference supplier_type as a plain string (not a FK),
   * so removing a supplier never deletes order history.
   */
  remove(id: number): void {
    const row = this.getRow(id); // throws SupplierNotFoundError if missing

    // P2-023: check for active variants before allowing delete
    const variantCount = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM variants WHERE supplier_type = ?")
        .get(row.supplier_key) as { c: number }
    ).c;

    if (variantCount > 0) {
      throw new Error(
        `Cannot delete "${row.display_name}": ${variantCount} variant(s) still reference this supplier. ` +
        `Remove or re-assign those variants first.`
      );
    }

    this.db.prepare("DELETE FROM suppliers WHERE id = ?").run(id);
  }
}

// ── Pricing override helper for job loops ─────────────────────────────────────

export interface SupplierPricingOverrides {
  marginOverride: number | null;
  feeOverride:    number | null;
}

/**
 * Returns per-supplier pricing overrides for a given supplier_key.
 * Called by the sync loop per-variant before invoking calculateEbayPrice.
 * Returns { marginOverride: null, feeOverride: null } when no row exists or
 * both columns are NULL — callers fall back to global config in that case.
 */
export function getPricingOverridesForSupplier(
  db: import("better-sqlite3").Database,
  supplierKey: string
): SupplierPricingOverrides {
  const row = db
    .prepare("SELECT margin_override, fee_override FROM suppliers WHERE supplier_key = ?")
    .get(supplierKey) as { margin_override: number | null; fee_override: number | null } | undefined;

  return {
    marginOverride: row?.margin_override ?? null,
    feeOverride:    row?.fee_override    ?? null,
  };
}
