# Discord bridge Worker

This Worker owns the shared Camel Discord bot's Gateway connection, bot REST
rate limits, channel binding registry, and ordered ingress outbox. It has no
public route (`workers_dev` is disabled) and is called by the main Worker through
the `DISCORD_BRIDGE` service binding.

## Secrets and rollout

Set `DISCORD_BOT_TOKEN` only on this Worker. Set the environment-specific
`DISCORD_APPLICATION_ID` in `wrangler.jsonc`; staging and production must use
different Discord applications. The main Worker separately holds the OAuth
client secret and never receives the bot token.

Provision the normal and dead-letter queues once per environment before the
first deploy:

```bash
bunx wrangler queues create chiridion-app-discord-events-staging
bunx wrangler queues create chiridion-app-discord-events-dlq-staging
bunx wrangler queues create chiridion-app-discord-events
bunx wrangler queues create chiridion-app-discord-events-dlq
```

For the private `dev-illiana` canary, use the checked workflow rather than
copying the staging commands. Do not wipe D1 for this test: D1 is not the only
state store, and a partial reset can leave Durable Objects, KV, and R2
inconsistent.

First set the same real application ID in `wrangler.dev-illiana.jsonc` and the
bridge's `env.dev-illiana.vars`. Configure the Discord application for Guild
Install, OAuth code grant, and this exact callback:

```text
https://dev-illiana.camelai.dev/api/integrations/discord/callback
```

The bootstrap deliberately requires an operator attestation for that
portal-only setting. Keep both `DISCORD_CHANNEL_ENABLED` and
`DISCORD_INGRESS_ENABLED` false, then run:

```bash
export DISCORD_CANARY_CALLBACK_URI_CONFIRMED=https://dev-illiana.camelai.dev/api/integrations/discord/callback
bun run discord:canary:preflight -- --phase config
bun run discord:canary:bootstrap
```

On a brand-new environment, the first bootstrap creates or verifies both
queues, deploys the bridge dark without a bot token, and then pauses with the
exact next command. Store the requested secret without placing its value on the
command line:

```bash
bunx wrangler secret put DISCORD_BOT_TOKEN -c workers/discord-bridge/wrangler.jsonc --env dev-illiana
bun run discord:canary:bootstrap
```

If the main Worker does not exist, that rerun deploys it dark so Cloudflare can
attach secrets, then pauses. Store both main-Worker secrets and rerun:

```bash
bunx wrangler secret put DISCORD_CLIENT_SECRET -c wrangler.dev-illiana.jsonc
bunx wrangler secret put ADMIN_API_KEY -c wrangler.dev-illiana.jsonc
bun run discord:canary:bootstrap
```

The successful rerun redeploys both Workers from the current checkout while
both feature flags remain dark. It is safe to rerun: existing queues and first
deployments are detected, secret values are never read or printed, and the
final redeploy cannot enable Discord while the checked flags remain false.

Check each remaining dark-launch boundary in order:

```bash
# 1. Main and ingress are still disabled. Gateway and heartbeat must be healthy.
export DISCORD_CANARY_ADMIN_API_KEY="$ADMIN_API_KEY"
bun run discord:canary:preflight -- --phase bridge

# 2. Set DISCORD_CHANNEL_ENABLED=true, redeploy main, leave ingress false.
bun run deploy:main:dev-illiana
DISCORD_CANARY_ADMIN_API_KEY="$ADMIN_API_KEY" bun run discord:canary:preflight -- --phase main

# 3. After OAuth/channel-selection smoke, set bridge ingress true and redeploy.
bun run deploy:discord-bridge:dev-illiana
DISCORD_CANARY_ADMIN_API_KEY="$ADMIN_API_KEY" bun run discord:canary:preflight -- --phase ingress
```

Do not enable bridge ingress before OAuth installation, delegated-workspace
acknowledgement, parent-channel selection, the one-time binding confirmation,
and **Verify** all succeed.

If Cloudflare Access protects the environment, also export
`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`; the preflight forwards
them only as request headers. It fails on placeholders, missing/mismatched IDs,
missing queues or secrets, absent deployments, the wrong bot identity, a
disconnected Gateway, or a stale heartbeat ACK. The authenticated status proxy
is `GET /api/admin/discord/status` and uses the existing `ADMIN_API_KEY` bearer
authorization.

### Recovering fatal Gateway configuration

The Gateway persists fatal state so a bad credential does not burn reconnect or
session-start limits. If the bridge reports `gateway_close_4004`,
`application_identity_mismatch`, `gateway_close_4013`, or
`gateway_close_4014`, correct the owning configuration:

- Replace `DISCORD_BOT_TOKEN` on the bridge for authentication failures.
- Make the bridge `DISCORD_APPLICATION_ID` match both the bot user and the main
  Worker's `DISCORD_CLIENT_ID`.
- Make `DISCORD_MESSAGE_CONTENT_MODE` match the intents enabled in the Discord
  developer portal.

Redeploy the bridge while ingress remains dark, then rerun the bridge preflight:

```bash
bun run deploy:discord-bridge:dev-illiana
bun run discord:canary:preflight -- --phase bridge
```

The Gateway stores a SHA-256 configuration fingerprint, never the token value.
Its next watchdog pass detects the corrected token, application ID, or content
mode, discards only the stale Gateway session/fatal marker, and reconnects
without deleting the Durable Object or its unrelated state. If the fingerprint
did not change, the fatal state intentionally remains; inspect the authenticated
Discord status and developer-portal settings rather than deleting storage.

Store secrets against their owning Worker (never in a Wrangler vars block):

```bash
bunx wrangler secret put DISCORD_BOT_TOKEN -c workers/discord-bridge/wrangler.jsonc --env staging
bunx wrangler secret put DISCORD_CLIENT_SECRET -c wrangler.staging.jsonc
```

Repeat with the production configs when promoting. Configure each Discord app
for Guild Install with bot scope, the exact permission mask `309237763072`, and
Gateway intents matching `DISCORD_MESSAGE_CONTENT_MODE` (`33281` for `full`,
`513` for `mention_only`).

Deploy the bridge before the main Worker:

```bash
bun run deploy:discord-bridge:staging
bun run deploy:main:staging
```

Ingress is dark by default. Enable `DISCORD_INGRESS_ENABLED` only after the
staging protocol matrix and 24-hour Gateway soak in
`docs/discord-channel-integration-plan.md` pass. A real local Gateway requires a
dedicated test application; never put production credentials in local vars.
Keep the main Worker's `DISCORD_CHANNEL_ENABLED` false until the bridge status,
queue/DLQ bindings, OAuth callback, and permission matrix have all been checked.

## Development

```bash
bun run typecheck:discord-bridge
bun run test:discord-bridge
```

The internal surface is intentionally operation-specific. Do not add an
arbitrary Discord REST proxy or any endpoint that accepts a bot token.
