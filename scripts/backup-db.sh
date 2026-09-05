#!/usr/bin/env bash
# =============================================================================
# scripts/backup-db.sh — SQLite hot-backup for core.db
# =============================================================================
#
# Creates a timestamped, consistent copy of core.db using SQLite's built-in
# .backup command (safe while the server is running — no need to stop it).
#
# Usage:
#   ./scripts/backup-db.sh                      # uses defaults from .env
#   DB_FILE=./data/core.db BACKUP_DIR=./backups ./scripts/backup-db.sh
#
# Scheduling options (pick one):
#
#   A) Cron (Linux/macOS — run `crontab -e` and add):
#      0 */6 * * * /path/to/core-service/scripts/backup-db.sh >> /path/to/core-service/logs/backup.log 2>&1
#      (backs up every 6 hours; adjust the schedule as needed)
#
#   B) Railway volume snapshot:
#      Railway doesn't run cron jobs natively. Instead, add a second Railway
#      service using the "Cron Job" template, point it at this script, and
#      mount the same persistent volume. See RUNBOOK.md for details.
#
#   C) Windows Task Scheduler (for local dev on Windows):
#      Use the companion scripts/backup-db.ps1 script instead.
#
# Retention:
#   Backups older than KEEP_DAYS (default: 30) are automatically deleted.
#   Set KEEP_DAYS=0 to disable automatic pruning.
#
# Exit codes:
#   0 — success
#   1 — source DB not found or backup failed
# =============================================================================

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
# Load .env if present so DATABASE_FILE is respected automatically.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -f "$ROOT_DIR/.env" ]]; then
  # Export only DATABASE_FILE from .env — don't clobber the whole environment.
  DB_FROM_ENV=$(grep -E '^DATABASE_FILE=' "$ROOT_DIR/.env" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
fi

DB_FILE="${DB_FILE:-${DB_FROM_ENV:-$ROOT_DIR/data/core.db}}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/data/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
BACKUP_FILE="$BACKUP_DIR/core.db-backup-$TIMESTAMP.db"

# ── Validate ──────────────────────────────────────────────────────────────────
if [[ ! -f "$DB_FILE" ]]; then
  echo "[backup-db] ERROR: Source database not found: $DB_FILE" >&2
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  echo "[backup-db] ERROR: sqlite3 not found in PATH. Install it (apt install sqlite3 / brew install sqlite3)." >&2
  exit 1
fi

# ── Backup ────────────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"

echo "[backup-db] Starting backup: $DB_FILE → $BACKUP_FILE"

# sqlite3 .backup is a hot, consistent copy — safe while the server writes.
# It uses SQLite's online backup API (no WAL checkpointing needed beforehand).
sqlite3 "$DB_FILE" ".backup '$BACKUP_FILE'"

BACKUP_SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
echo "[backup-db] Backup complete: $BACKUP_FILE ($BACKUP_SIZE)"

# ── Retention ─────────────────────────────────────────────────────────────────
if [[ "$KEEP_DAYS" -gt 0 ]]; then
  PRUNED=$(find "$BACKUP_DIR" -name 'core.db-backup-*.db' -mtime +"$KEEP_DAYS" -print -delete 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$PRUNED" -gt 0 ]]; then
    echo "[backup-db] Pruned $PRUNED backup(s) older than $KEEP_DAYS days."
  fi
fi

echo "[backup-db] Done. Backups in: $BACKUP_DIR"
