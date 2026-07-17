import { defineConfig, devices } from "@playwright/test";

const port = 3011;
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "auth-signup.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `bun run dev -- --port ${port}`,
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      LOCAL_AUTH_BYPASS: "0",
      TOKEN_SIGNING_SECRET: "signup-e2e-token-signing-secret-32",
      WORKER_BASE_URL: baseURL,
    },
  },
});
