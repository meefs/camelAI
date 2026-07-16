import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/staging-billing",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results/staging-billing/artifacts",
  globalSetup: "./e2e/staging-billing/global-setup.ts",
  globalTeardown: "./e2e/staging-billing/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 5 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [["html", { open: "never", outputFolder: "playwright-report-staging-billing" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.STAGING_BASE_URL || "https://staging.camelai.dev",
    trace: "on",
    video: "on",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: "staging-billing-chromium", use: { ...devices["Desktop Chrome"] } }],
});

