/**
 * Vitest global setup — runs once before every test file.
 *
 * Silences Winston console output during tests so passing suites don't
 * produce walls of JSON log lines. File transport is also suppressed since
 * tests use an in-memory DB and there's no meaningful log path.
 *
 * We do NOT mock the logger module — we just set its level to 'silent'
 * so the real code paths execute unchanged (important for coverage).
 */
import { logger } from "../src/logger";

logger.transports.forEach((t) => {
  t.silent = true;
});
