import { defineConfig, devices } from '@playwright/test';

// E2E_LOCAL=1 boots the worker locally (webServer below) so LOCAL_AUTH_BYPASS
// can activate — it is hard-gated to localhost/127.0.0.1 in
// workers/main/src/helpers/auth.ts, so this is the only way to run the suite
// without real credentials. A local miniflare run is also ephemeral per-run,
// which keeps test state from polluting a shared environment.
const useLocalServer = process.env.E2E_LOCAL === '1';
const localBaseURL = 'http://localhost:3001';
const FAKE_LLM_PORT = 8788;

// PW_VIDEO toggles recording: default keeps a video only for failing tests
// (cheap, and exactly when you want one); set PW_VIDEO=on to record every test
// (useful while chasing a flake, ~10-20% slower + larger artifacts).
const video = (process.env.PW_VIDEO || 'retain-on-failure') as
  | 'off'
  | 'on'
  | 'retain-on-failure'
  | 'on-first-retry';

export default defineConfig({
  testDir: './e2e',
  // Under LOCAL_AUTH_BYPASS the app auto-authenticates and the _auth layout
  // redirects away from /login and /signup, so the form-based auth specs can't
  // run — skip them on the local-bypass path.
  testIgnore: useLocalServer ? ['**/auth.spec.ts'] : [],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  // In CI each shard emits a self-contained "blob" report (which bundles its
  // videos/traces); a final merge job stitches the shards into one HTML report.
  // Locally we want the browsable HTML report directly.
  reporter: process.env.CI ? 'blob' : 'html',
  use: {
    baseURL:
      process.env.BASE_URL ||
      (useLocalServer
        ? localBaseURL
        : 'https://chiridion-app.miguel-85b.workers.dev'),
    trace: 'on-first-retry',
    video,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  timeout: 120000, // 2 minutes per test for LLM responses
  ...(useLocalServer
    ? {
        webServer: [
          {
            // Deterministic fake LLM (scripts/fake-llm.mjs): the worker routes
            // every model call here when its env carries TEST_LLM_REPLAY_URL, so
            // chat turns run offline with canned responses — no model, no creds.
            command: 'node scripts/fake-llm.mjs',
            url: `http://localhost:${FAKE_LLM_PORT}/`,
            timeout: 30_000,
            reuseExistingServer: !process.env.CI,
            env: { FAKE_LLM_PORT: String(FAKE_LLM_PORT) },
          },
          {
            // Boots the app with LOCAL_AUTH_BYPASS=1 so every request is
            // auto-authenticated as local-dev-user — no credentials/secrets in CI.
            // TEST_LLM_REPLAY_URL is forwarded into the worker config by
            // vite.config.ts's withLocalDevVars, so resolvePiModel sees it.
            command: 'bun run dev:local-auth',
            url: localBaseURL,
            timeout: 180_000,
            reuseExistingServer: !process.env.CI,
            env: { TEST_LLM_REPLAY_URL: `http://localhost:${FAKE_LLM_PORT}` },
          },
        ],
      }
    : {}),
});
