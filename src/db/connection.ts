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
  // Task 7: busy_timeout — SQLite's default is 0ms, meaning any concurrent
  // write attempt throws SQLITE_BUSY immediately. With WAL mode a reader never
  // blocks a writer, but two writers (e.g. a cron job tick and a dashboard
  // PATCH request arriving at the same instant) still serialise. 5 seconds is
  // enough to let the first writer finish without surfacing spurious errors to
  // the caller.
  dbInstance.pragma("busy_timeout = 5000");
  return dbInstance;
}
