# Slack Staging App

Staging should use a separate Slack app from production so the Events API can
point at staging without stealing event delivery from prod.

## Create the app

1. In the Slack app dashboard, create a new app from the manifest in
   `slack-app-manifest.staging.yaml` or `slack-app-manifest.staging.json`.
2. Confirm the OAuth redirect URL is:
   `https://staging.camelai.dev/api/integrations/slack/callback`
3. Confirm the Events API request URL is:
   `https://staging.camelai.dev/api/integrations/slack/events`
4. Install the app into the test Slack workspace.

## Configure staging secrets

Set these from the new staging Slack app's Basic Information page:

```bash
bunx wrangler secret put SLACK_CLIENT_ID -c wrangler.staging.jsonc
bunx wrangler secret put SLACK_CLIENT_SECRET -c wrangler.staging.jsonc
bunx wrangler secret put SLACK_SIGNING_SECRET -c wrangler.staging.jsonc
```

After updating secrets, deploy staging:

```bash
bun run build
wrangler deploy -c wrangler.staging.jsonc
```

The staging worker already has the required `SESSIONS`, `SLACK_EVENTS_QUEUE`,
and `SLACK_TEAM_REGISTRY` bindings in `wrangler.staging.jsonc`.
