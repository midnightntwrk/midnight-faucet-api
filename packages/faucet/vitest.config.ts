/// <reference types="vitest" />
/// <reference types="vitest/globals" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Must exceed the compose environment's withStartupTimeout(240_000) in faucet.spec.ts —
    // the indexer only reports /ready once the node produces blocks and its storage migrates.
    hookTimeout: 300_000,
    testTimeout: 90_000,
    coverage: {
      provider: "v8",
      enabled: true,
      clean: true,
      include: ["src/**/*.ts"],
      exclude: ["**/test/**"],
      reporter: ["clover", "json", "json-summary", "lcov", "text"],
      reportsDirectory: "./coverage",
    },
    reporters: [
      "default",
      ["junit", { outputFile: `reports/report/test-report.xml` }],
      ["html", { outputFile: `reports/report/test-report.html` }],
    ],
  },
});
