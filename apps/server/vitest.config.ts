/// <reference types="vitest" />
/// <reference types="vitest/globals" />
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// loadConfig() sources ENCRYPTION_KEY / JWT_SIGN_SECRET from the environment only, so the suite
// dies at validation unless something exports the root .env. Local dev relies on direnv for that,
// which is not always installed — read the file directly so the tests do not depend on it.
const rootEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));

const readRootEnv = (): Record<string, string> => {
  try {
    return dotenv.parse(readFileSync(rootEnvPath));
  } catch {
    // No .env (CI, fresh clone) — the real environment is expected to supply the keys.
    return {};
  }
};

// An already-set variable wins: CI secrets and direnv must not be clobbered by the checked-in file.
const dotenvFallback = Object.fromEntries(
  Object.entries(readRootEnv()).filter(([key]) => process.env[key] === undefined),
);

export default defineConfig({
  test: {
    env: dotenvFallback,
    environment: "node",
    globals: true,
    hookTimeout: 90000,
    testTimeout: 90000,
    fileParallelism: false, // Run test files sequentially to avoid resource conflicts
    coverage: {
      provider: "v8",
      enabled: true,
      clean: true,
      // all: true,
      include: ["src/**/*.ts"],
      exclude: ["**/test/**"],
      reporter: ["clover", "json", "json-summary", "lcov", "text"],
      reportsDirectory: "./coverage",
      thresholds: {
        lines: 70,
        functions: 60.0,
        branches: 60.0,
        statements: 60.0,
        // Optional flags
        perFile: false,
        autoUpdate: false, // true => will update config thresholds if current run is above configured values
      },
    },
    reporters: [
      "default",
      ["junit", { outputFile: `reports/report/test-report.xml` }],
      ["html", { outputFile: `reports/report/test-report.html` }],
    ],
  },
});
