import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let dbInstance: Database.Database | null = null;

/**
 * Returns a singleton better-sqlite3 connection to the Core Service's
 * database file, creating the containing directory if needed. Does NOT
 * create tables — run `npm run migrate` (src/db/migrate.ts) for that.
 */
export function getDb(databaseFile: string): Database.Database {
  if (dbInstance) return dbInstance;

  const dir = path.dirname(databaseFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  dbInstance = new Database(databaseFile);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");
  return dbInstance;
}
