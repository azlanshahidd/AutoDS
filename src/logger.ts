import winston from "winston";
import path from "path";
import fs from "fs";

const logFile = process.env.LOG_FILE || "./logs/core.log";
const logDir = path.dirname(logFile);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

export const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    // Task 9: log rotation — cap each file at 10 MB, keep 5 rotated copies.
    // tailable:true means the active log is always at the configured path
    // (core.log), and older files are core.log1, core.log2, … so external
    // tools (Railway log viewer, the dashboard /api/logs endpoint) always
    // read from a stable filename.
    new winston.transports.File({
      filename: logFile,
      maxsize:  10 * 1024 * 1024, // 10 MB per file
      maxFiles: 5,                 // 5 rotated files = up to 50 MB total
      tailable: true,
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});
