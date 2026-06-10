/// <reference types="vitest" />
/// <reference types="vitest/globals" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    bail: 1,
    include: ["src/smoke/*spec.ts"],
    exclude: ["src/e2e/**"],
    reporters: [
      "default",
      ["junit", { outputFile: `reports/report/test-report.xml` }],
      ["html", { outputFile: `reports/report/test-report.html` }],
    ],
  },
});
