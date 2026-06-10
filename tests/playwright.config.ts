import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./src/e2e/tests",
  testMatch: "*.spec.ts",
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ["html", { outputFolder: "./src/e2e/reports/playwright-report" }],
    ["junit", { outputFile: "./src/e2e/reports/junit-results.xml" }],
  ],
  outputDir: "./src/e2e/reports/playwrightResults",
  timeout: 600_000,
  expect: { timeout: 10000 },
  use: {
    screenshot: "only-on-failure",
  },
  globalSetup: "./setup-playwright",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  workers: 1,
});
