import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    // Use 'forks' pool so each test file runs in its own child process.
    // Required for better-sqlite3 (native addon) which cannot be shared
    // across Vitest worker threads without crashing.
    pool: "forks",

    // Resolve @ alias to src/ so tests can import exactly as source files do.
    globals: false,
    environment: "node",

    // Coverage — tracked per file so CI can enforce thresholds on the
    // money-handling modules specifically.
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      // Thresholds are enforced on the whole src/ tree but the per-file
      // numbers for pricing/jobs matter most — see CI workflow comments.
      thresholds: {
        lines:     10,
        functions: 28,
        branches:  30,
        statements: 10,
      },
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",          // Express wiring — tested via supertest
        "src/db/migrate.ts",     // run as CLI; covered by makeTestDb fixture
        "src/**/*.d.ts",
      ],
    },

    // Resolve TypeScript path aliases (mirrors tsconfig paths if any are added later)
    alias: {
      "@": path.resolve(__dirname, "src"),
    },

    // Test file discovery
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],

    // Silence noisy Winston logs during tests
    setupFiles: ["tests/setup.ts"],

    // Per-test timeout — jobs make synchronous SQLite calls, no network
    testTimeout: 10_000,
  },
});
