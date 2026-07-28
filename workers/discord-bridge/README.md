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

Keep `DISCORD_CHANNEL_ENABLED` and `DISCORD_INGRESS_ENABLED` false during a
new-environment rollout. Deploy the bridge, inspect the authenticated
`GET /api/admin/discord/status` response, complete an OAuth/channel-selection
smoke test, and only then enable ingress. Do not wipe only one state store during
recovery; bindings and delivery state live in Durable Objects.

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

Redeploy the bridge while ingress remains dark, then inspect the authenticated
Discord status:

```bash
bun run deploy:discord-bridge:staging
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
