/// <reference types="vitest" />
/// <reference types="vitest/globals" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
        functions: 73.0,
        branches: 60.0,
        statements: 70,
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
