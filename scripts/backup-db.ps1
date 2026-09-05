# =============================================================================
# scripts/backup-db.ps1 — SQLite backup for core.db (Windows / PowerShell)
# =============================================================================
#
# Creates a timestamped copy of core.db using Node.js (no sqlite3 CLI needed).
# Safe to run while the server is running — copies via a read of the WAL-
# checkpointed state using better-sqlite3's backup() API.
#
# Usage (run from repo root in PowerShell):
#   .\scripts\backup-db.ps1
#   .\scripts\backup-db.ps1 -DbFile .\data\core.db -BackupDir .\data\backups -KeepDays 30
#
# Scheduling with Windows Task Scheduler:
#   1. Open Task Scheduler → Create Basic Task
#   2. Trigger: Daily, repeat every 6 hours
#   3. Action: Start a program
#      Program: powershell.exe
#      Arguments: -NonInteractive -File "C:\path\to\core-service\scripts\backup-db.ps1"
#      Start in: C:\path\to\core-service
#   4. Check "Run whether user is logged on or not"
#
# Exit codes:
#   0 — success
#   1 — source DB not found or backup failed
# =============================================================================

param(
    [string]$DbFile    = "",
    [string]$BackupDir = "",
    [int]   $KeepDays  = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir

# ── Resolve paths from .env if not overridden ─────────────────────────────────
if ($DbFile -eq "") {
    $EnvFile = Join-Path $RootDir ".env"
    if (Test-Path $EnvFile) {
        $Line = Select-String -Path $EnvFile -Pattern "^DATABASE_FILE=" | Select-Object -First 1
        if ($Line) {
            $DbFile = ($Line.Line -split "=", 2)[1].Trim().Trim('"').Trim("'")
        }
    }
    if ($DbFile -eq "") { $DbFile = Join-Path $RootDir "data\core.db" }
}

if ($BackupDir -eq "") {
    $BackupDir = Join-Path $RootDir "data\backups"
}

# Resolve relative paths against repo root
if (-not [System.IO.Path]::IsPathRooted($DbFile)) {
    $DbFile = Join-Path $RootDir $DbFile
}

$Timestamp  = (Get-Date -Format "yyyyMMddTHHmmssZ")
$BackupFile = Join-Path $BackupDir "core.db-backup-$Timestamp.db"

# ── Validate ──────────────────────────────────────────────────────────────────
if (-not (Test-Path $DbFile)) {
    Write-Error "[backup-db] ERROR: Source database not found: $DbFile"
    exit 1
}

# ── Backup via Node + better-sqlite3 ─────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

Write-Host "[backup-db] Starting backup: $DbFile -> $BackupFile"

# Inline Node script — uses the same better-sqlite3 already in node_modules.
$NodeScript = @"
const Database = require('better-sqlite3');
const db = new Database(process.argv[2], { readonly: true });
db.backup(process.argv[3])
  .then(() => { console.log('[backup-db] Backup written.'); process.exit(0); })
  .catch(err => { console.error('[backup-db] Backup failed:', err.message); process.exit(1); });
"@

$TempScript = [System.IO.Path]::GetTempFileName() + ".js"
try {
    Set-Content -Path $TempScript -Value $NodeScript -Encoding UTF8
    & node $TempScript $DbFile $BackupFile
    if ($LASTEXITCODE -ne 0) { exit 1 }
} finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $TempScript
}

$Size = (Get-Item $BackupFile).Length / 1KB
Write-Host ("[backup-db] Backup complete: $BackupFile ({0:N1} KB)" -f $Size)

# ── Retention ─────────────────────────────────────────────────────────────────
if ($KeepDays -gt 0) {
    $Cutoff = (Get-Date).AddDays(-$KeepDays)
    $Old = Get-ChildItem -Path $BackupDir -Filter "core.db-backup-*.db" |
           Where-Object { $_.LastWriteTime -lt $Cutoff }
    foreach ($f in $Old) {
        Remove-Item $f.FullName -Force
        Write-Host "[backup-db] Pruned: $($f.Name)"
    }
    if ($Old.Count -gt 0) {
        Write-Host "[backup-db] Pruned $($Old.Count) backup(s) older than $KeepDays days."
    }
}

Write-Host "[backup-db] Done. Backups in: $BackupDir"
exit 0
