# Staging onboarding and billing E2E

This is a manual-only Playwright suite for the real staging UI, hosted models,
Stripe test mode, and webhook projections. It is intentionally not part of CI
or a scheduled workflow. Each run creates synthetic accounts, records video and
trace for every test, takes named checkpoint screenshots, and deletes the test
actors and Stripe test customers in global teardown.

The suite has no fixture HTTP endpoints. Setup, billing mutation, assertions,
and cleanup all go through `admin-staging.admin_js_exec` over MCP OAuth. The
browser uses the normal login, onboarding, chat, billing, Stripe Checkout, and
Stripe Portal surfaces.

## Prerequisites

- Authenticate the `admin-staging` mcporter server as described in
  [admin-js-exec.md](./admin-js-exec.md). Cloudflare Access and Admin MCP OAuth
  credentials are expected and mcporter calls are kept serial.
- Authenticate `cloudflared` for `https://staging.camelai.dev`, or provide a
  current browser token in `STAGING_CF_ACCESS_TOKEN`.
- Deploy the application and the matching `IDENTITY` / `BILLING`
  `admin_js_exec` facades to staging.
- Staging must report `STRIPE_MODE=test` and have subscription prices and at
  least one credit pack configured.
- Install Chromium once with `bunx playwright install chromium`.

The preflight refuses any target whose runtime URL does not contain `staging`
or whose Stripe mode is not `test`.

## Run

```bash
bun run test:e2e:staging-billing
```

Useful optional environment variables:

```bash
STAGING_ADMIN_MCP=admin-staging
STAGING_BASE_URL=https://staging.camelai.dev
STAGING_E2E_PREMIUM_MODEL="Gemini 3 Flash Preview"
STAGING_BILLING_EMAIL_DOMAIN=e2e.camelai.dev
MCPORTER_BIN=/absolute/path/to/mcporter
CLOUDFLARED_BIN=/absolute/path/to/cloudflared
STAGING_CF_ACCESS_TOKEN=eyJ...
```

`MCPORTER_BIN` is optional; by default the client invokes `bunx mcporter`.
When set, it must be a direct executable path, not a shell command.
`STAGING_CF_ACCESS_TOKEN` is also optional; when omitted, the suite runs
`cloudflared access token -app=$STAGING_BASE_URL`. The resulting
`CF_Authorization` cookie is scoped to the staging origin. The suite does not
use global request headers, so Access credentials are never forwarded during
navigation to Stripe.

The serial suite covers:

1. A verified new account completes onboarding with no payment, lands in chat
   on camelCode, and completes a real agent turn.
2. The same open chat receives credits, completes a premium turn, has its
   credits remotely drained to zero, falls back on the next turn, shows the
   fallback notice, and persists camelCode across reload.
3. The account purchases Starter through Stripe Checkout and waits for the
   webhook-projected OrgDO state.
4. Starter upgrades to Pro, handling either direct trial updates or Stripe's
   focused portal confirmation.
5. A second account activates Pay as you go, buys a credit pack through Stripe
   Checkout, and waits for its credit ledger projection.

The generated report is in `playwright-report-staging-billing/`. Temporary
credentials are stored with mode `0600` under the ignored `test-results/`
directory and removed during teardown. They are never attached to the report.
Billing snapshots are produced by the sanitized console facade.

## Publish the visual report

Publishing is also manual:

```bash
E2E_REPORT_UPLOAD_TOKEN=... bun run publish:e2e:staging-billing
```

Set `E2E_REPORT_RUN_ID` to choose a stable report id; otherwise the uploader
uses `staging-billing-<timestamp>`. It prints the final
`https://e2e-reports.camelai.dev/r/<run-id>/` URL. The report viewer is public,
so do not add unsanitized console output, cookies, credentials, or payment
identifiers as attachments.

If a process is killed before global teardown, rerun cleanup through
`admin_js_exec` using the ids in
`test-results/staging-billing/fixture-state.json`, then remove that file. Do not
publish a report until cleanup and attachment sanitization have been checked.
