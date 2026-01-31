# Integration Logos

Place official SVG logos here for integrations shown in the Connections page.

## File Naming Convention

### Single Variant (works for both light and dark themes)
```
{type}.svg
```
Example: `stripe.svg`

### Themed Variants (separate files for light and dark)
```
{type}_light.svg   ← used on light backgrounds
{type}_dark.svg    ← used on dark backgrounds
```
Example: `aws_light.svg`, `aws_dark.svg`

## Adding a New Logo

1. **Save the SVG file(s)** in this directory using the naming convention above.
   The `{type}` must match the integration type in the registry (e.g., `postgres`, `aws`, `stripe`).

2. **Register it** in `src/lib/integration-icons.tsx`:
   ```ts
   const logoRegistry: Record<string, 'single' | 'themed'> = {
     aws: 'themed',      // has aws_light.svg and aws_dark.svg
     stripe: 'single',   // has stripe.svg
     // ... add your new entry here
   };
   ```

## Integration Types

These are the integration types from the registry that have logos:

| Type        | Display Name         | Notes                    |
|-------------|---------------------|--------------------------|
| `postgres`  | PostgreSQL          |                          |
| `mysql`     | MySQL               |                          |
| `stripe`    | Stripe              |                          |
| `notion`    | Notion              |                          |
| `slack`     | Slack               |                          |
| `openai`    | OpenAI              |                          |
| `anthropic` | Anthropic           |                          |
| `github`    | GitHub              | Likely needs themed      |
| `linear`    | Linear              |                          |
| `sendgrid`  | SendGrid            |                          |
| `twilio`    | Twilio              |                          |
| `salesforce`| Salesforce          |                          |
| `airtable`  | Airtable            |                          |
| `hubspot`   | HubSpot             |                          |
| `aws`       | Amazon Web Services | Likely needs themed      |
| `bigquery`  | Google BigQuery     |                          |
| `clickhouse`| ClickHouse          | Themed (dark = white)    |
| `databricks`| Databricks          |                          |
| `mailchimp` | Mailchimp           |                          |
| `mixpanel`  | Mixpanel            |                          |
| `neon`      | Neon                |                          |
| `openrouter`| OpenRouter          | Themed; dark variant TBD |
| `posthog`   | PostHog             |                          |
| `sentry`    | Sentry              |                          |
| `snowflake` | Snowflake           |                          |
| `supabase`  | Supabase            |                          |
| `typeform`  | Typeform            | Themed (dark = white)    |
| `x`         | X                   | Themed (dark = white)    |