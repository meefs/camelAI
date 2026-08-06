# Claude Opus 5 Upgrade Plan

## Objective

Replace Claude Opus 4.8 with Claude Opus 5 as camelAI's current selectable Opus model across the model catalog, persisted model normalization, chat runtime, virtual AI binding, Amazon Bedrock compatibility worker, admin APIs, pricing, and tests.

The upgrade must preserve compatibility with stored `opus`, `opus-4.7`, and `opus-4.8` values and with historical usage rows while ensuring every new Opus selection and smart-tier route resolves to Opus 5.

## Verified upstream facts

These facts are implementation inputs, not assumptions:

- Anthropic API model ID: `claude-opus-5`.
- OpenRouter model ID: `anthropic/claude-opus-5`.
- Amazon Bedrock model ID for the Claude-in-Bedrock Messages surface: `anthropic.claude-opus-5`.
- Standard pricing is unchanged from Opus 4.8: $5 per million input tokens, $25 per million output tokens, $0.50 per million cache-read tokens, and $6.25 per million 5-minute cache-write tokens.
- Context window remains 1,000,000 tokens and maximum synchronous output remains 128,000 tokens.
- Adaptive thinking is on by default. Opus 5 supports the full `low`, `medium`, `high`, `xhigh`, and `max` effort ladder.
- Non-default sampling parameters remain unsupported. Disabling thinking is valid only at effort `high` or below; disabling it at `xhigh` or `max` returns HTTP 400.
- Opus 5 is available on Amazon Bedrock through the newer Claude-in-Bedrock Messages endpoint. It deliberately does not appear in the legacy ARN/version-suffixed model table.

Primary references:

- [Anthropic: What's new in Claude Opus 5](https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5)
- [Anthropic: Model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)
- [Anthropic: Claude in Amazon Bedrock (Opus 4.7 and later)](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock)
- [Anthropic: Opus 5 migration guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide#migrating-to-claude-opus-5)
- [OpenRouter: Claude Opus 5](https://openrouter.ai/anthropic/claude-opus-5)

## Compatibility decisions

### Canonical product ID

`opus-5` becomes the only current camelAI `LlmModel` value for the Opus family. New thread settings, picker configuration, admin writes, recent-model storage, and runtime state should all expose or persist `opus-5`.

### Stored legacy values

Treat `opus`, `opus-4.7`, and `opus-4.8` as read-time aliases of `opus-5`. This avoids a database migration and upgrades existing threads, org/workspace picker configurations, and browser recent-model state through the repository's existing normalization paths.

Runtime mapping helpers should also accept older provider spellings where they already serve as compatibility boundaries, but those spellings must resolve to Opus 5 rather than keeping active traffic on Opus 4.8.

### Historical pricing

Keep the Opus 4.8 pricing entries and lookup fallback. Usage records may contain provider-reported or previously persisted 4.8 IDs after the selectable model has been removed. Removing those entries would make historical or delayed usage fall through to the default Sonnet price.

Add separate Opus 5 pricing keys for the first-party, OpenRouter, and Bedrock spellings. The current catalog entry should point to the Opus 5 pricing key.

### No database migration

No eager Durable Object or SQL rewrite is planned. Existing normalization already provides a safer lazy migration boundary and avoids a fleet-wide destructive data operation.

### No fast-mode enablement

This change uses standard Opus 5. Anthropic/OpenRouter fast mode has distinct pricing and availability and is outside the requested 4.8-to-5 replacement.

## Bedrock-specific design

Bedrock needs explicit treatment because camelAI has two conceptually different integrations:

1. The active Claude-in-Bedrock path uses `https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages`, bearer-token or SigV4-style AWS authentication, standard SSE, and the unversioned model ID `anthropic.claude-opus-5`.
2. The legacy Bedrock `InvokeModel`/`Converse` catalog uses date/version/ARN-oriented IDs and cross-region inference profiles. Opus 5 is not published through that legacy catalog even though `InvokeModel` can reach the new serving infrastructure. camelAI must not invent `-v1`, `:0`, `global.`, `us.`, or date suffixes for Opus 5.

Implementation consequences:

- Continue using the existing Mantle base URL; change only the model ID.
- Teach both the chat BYOK mapper and the standalone Bedrock provider worker to emit `anthropic.claude-opus-5`.
- Normalize any incoming `global.anthropic.claude-opus-5` compatibility spelling to the Mantle ID without the `global.` prefix, matching the existing Mantle behavior.
- Give the Pi fallback model `forceAdaptiveThinking: true` and `supportsTemperature: false`. Without these flags, a lagging Pi catalog can produce the obsolete budget-based thinking body or forward an unsupported temperature.
- At the standalone Bedrock proxy boundary, migrate request bodies that arrive under a legacy Opus alias: convert manual budget thinking to adaptive thinking, remove unsupported sampling fields, and re-enable adaptive thinking when disabled thinking is combined with `xhigh` or `max`. Preserve valid disabled thinking at `high` or below.
- Advertise the complete Opus 5 effort map, including `xhigh` and `max`. Standard levels can use Pi's native `low`/`medium`/`high` mapping.
- Keep `off` available for the OpenAI-compatible virtual binding path, which intentionally requests no reasoning when the caller does not ask for it. With no `xhigh`/`max` effort in that path, `thinking: { type: "disabled" }` remains valid.
- Preserve `supportsEagerToolInputStreaming: false` on Mantle, as the existing Bedrock integration already requires.
- Add assertions for the exact Mantle base URL and exact suffix-free model ID so a future refactor cannot silently fall back to the legacy Bedrock naming scheme.

## Implementation steps

### 1. Product model contract and picker

Files:

- `src/types.ts`
- `src/lib/llm-provider-config.ts`
- `src/lib/model-catalog.ts`

Changes:

- Replace the `opus-4.8` `LlmModel` member with `opus-5`.
- Add `opus-4.8 -> opus-5` to stored-value replacements and retarget the older `opus`/`opus-4.7` aliases.
- Replace the picker option value/label with `opus-5` / `Opus 5`.
- Replace the model catalog key, ID, label, and pricing key.
- Keep the current provider/model ordering and `$$$$` cost bucket because standard pricing is unchanged.
- Re-evaluate the qualitative intelligence/speed ratings. Use a modest intelligence increase only if it remains consistent with the catalog's relative scale; avoid changing unrelated model ratings.

Expected outcome: newly created configuration uses `opus-5`, while previously stored Opus values normalize to it.

### 2. Pricing and metering

File:

- `src/lib/usage-pricing.ts`

Changes:

- Add standard Opus 5 pricing entries for `claude-opus-5`, `anthropic/claude-opus-5`, and `anthropic.claude-opus-5`/normalized prefixed forms as required by the lookup function.
- Add an Opus 5 family fallback before the legacy 4.8 fallback.
- Retain all existing 4.8, 4.7, and 4.6 entries for historical usage compatibility.
- Verify catalog pricing resolves to Opus 5 and that delayed Opus 4.8 usage still resolves to the old (currently identical) rate.

Expected outcome: live Opus 5 traffic and historical Opus traffic are both priced correctly, without relying on the Sonnet fallback.

### 3. Chat runtime and provider routing

Files:

- `workers/main/src/pi-model-resolution.ts`
- `workers/main/src/chat-thread/pi-model-config.ts`

Changes:

- Route canonical `opus-5` to first-party `claude-opus-5`.
- Route hosted/OpenRouter traffic to `anthropic/claude-opus-5`.
- Preserve compatibility aliases for prior Opus camelAI and provider IDs, but point them at Opus 5.
- Ensure the OpenRouter nitro helper preserves the current Opus routing policy instead of accidentally changing it merely because the major version no longer matches the old `opus-4.*` predicate.
- Change the Pi catalog fallback to Opus 5 with correct name, price, context, output cap, adaptive-thinking compatibility flags, and `xhigh`/`max` effort mappings.

Expected outcome: first-party Anthropic BYOK, OpenRouter BYOK, and camelAI-hosted traffic all request Opus 5, even when the installed Pi model catalog has not yet learned the new ID.

### 4. Amazon Bedrock runtime and compatibility worker

Files:

- `workers/main/src/bedrock-pi-model.ts`
- `workers/bedrock-provider/src/index.ts`

Changes:

- Recognize canonical and provider-style Opus 5 inputs and emit `anthropic.claude-opus-5`.
- Make old 4.7/4.8 aliases upgrade to Opus 5 at compatibility boundaries instead of retaining live 4.8 traffic.
- Add Opus 5 metadata with adaptive thinking, unsupported-temperature, effort, price, context, and output-cap details.
- Replace the model exposed by the Bedrock provider's `/v1/models` response.
- Update direct and compatibility map entries, including slash, dotted, and optional `global.` spellings, while always forwarding the suffix-free Mantle ID.
- Keep endpoint/authentication/streaming behavior unchanged.

Expected outcome: both chat turns and virtual `env.AI.run` calls use the newer Bedrock Messages surface correctly; nothing constructs a legacy versioned Opus 5 ID.

### 5. Virtual AI tiers and public compatibility aliases

File:

- `workers/main/src/ai-virtual-binding.ts`

Changes:

- Move the Anthropic BYOK `smart` tier to `claude-opus-5`.
- Move the Bedrock BYOK `smart` tier to `anthropic.claude-opus-5`.
- Retarget public `opus`, `opus-4.7`, and `opus-4.8` compatibility aliases to `anthropic/claude-opus-5`.
- Add `opus-5` as a friendly current alias if required by the pass-through behavior.

Expected outcome: already deployed user apps that call old friendly Opus names are upgraded transparently, while tier calls choose the provider-correct Opus 5 ID.

### 6. Admin API contracts

Files:

- `workers/main/src/routes/admin/schemas.ts`
- `workers/main/src/routes/admin-mcp.ts`

Changes:

- Replace `opus-4.8` with `opus-5` in the Zod model schema and MCP JSON schema.
- Keep schema behavior aligned with the canonical `LlmModel` contract; do not accept 4.8 for new admin writes.

Expected outcome: admin mutation surfaces write the same canonical ID as the UI and runtime.

### 7. Tests and fixtures

Update affected tests under `tests/` and `workers/main/tests/` to use `opus-5` for current behavior:

- Model catalog completeness, label, ordering, logo, and pricing tests.
- Picker visibility, configuration, settings actions, keyboard/tooltip behavior, and recent-model tests.
- Chat loader/fork/state tests and admin thread update tests.
- Provider normalization tests, including an explicit legacy `opus-4.8 -> opus-5` assertion.
- Pi resolution and fallback metadata tests.
- Anthropic/OpenRouter/Bedrock routing tests.
- Virtual AI smart-tier tests.
- Usage pricing tests for both current Opus 5 and retained historical Opus 4.8 IDs.

Add or strengthen focused Bedrock assertions:

- Pi lookup requests `claude-opus-5`.
- Mantle request model is exactly `anthropic.claude-opus-5`.
- Mantle base URL remains `https://bedrock-mantle.us-east-1.api.aws/anthropic` for the default region.
- Fallback metadata uses adaptive thinking, rejects temperature forwarding, supports `xhigh` and `max`, and keeps the 1M/128k limits.
- Virtual AI Bedrock `smart` resolves to the suffix-free Mantle ID.
- Legacy 4.8 aliases no longer produce live 4.8 routing.

## Validation sequence

Run the smallest focused suites first so mapping mistakes are easy to localize:

1. `bun run test:run -- tests/model-catalog.test.ts tests/model-logo-and-pricing.test.ts tests/usage-pricing.test.ts tests/model-picker-config.test.ts tests/recent-model.test.ts`
2. `bun run test:workers -- workers/main/tests/llm-provider-config.test.ts workers/main/tests/ai-virtual-binding.test.ts workers/main/tests/chat-thread-pi-turn.test.ts workers/main/tests/admin-api-thread-update.test.ts`
3. Run any additional affected UI tests reported by the exact-reference search.
4. `bun run typecheck`
5. `bun run lint` if the focused suites and typecheck pass.
6. Re-run an exact repository search for `opus-4.8`, `claude-opus-4-8`, and `Opus 4.8`; classify every remaining result as an intentional compatibility alias, historical pricing entry, or explicit migration test.
7. Review `git diff --check` and the final diff for accidental changes to unrelated models.

## Rollout and risk checks

- No schema migration or destructive write is needed.
- The main rollout risk is provider-ID drift. Tests must pin the three exact forms: Anthropic `claude-opus-5`, OpenRouter `anthropic/claude-opus-5`, and Bedrock Mantle `anthropic.claude-opus-5`.
- The second risk is Pi catalog lag. The local fallback must remain complete enough to work before a dependency upgrade.
- The third risk is thinking-mode incompatibility. `forceAdaptiveThinking` and `supportsTemperature: false` must be present on both first-party and Mantle fallback metadata.
- The fourth risk is silently repricing historical records. Retaining 4.8 lookup entries prevents this.
- The fifth risk is persisted configuration becoming invalid. Read-time replacement of 4.8 with 5 prevents existing picker/default/recent values from disappearing.
- A live staging smoke test should eventually cover one hosted turn and one Bedrock BYOK turn, but it requires deployed credentials and is not part of local verification.

## Completion criteria

- Opus 5 is the only current selectable/persistable Opus model.
- All new hosted, Anthropic BYOK, OpenRouter BYOK, Bedrock BYOK, virtual tier, and admin routes target Opus 5.
- Existing stored/friendly Opus aliases transparently normalize to Opus 5.
- Bedrock uses the Mantle Messages endpoint and exact suffix-free `anthropic.claude-opus-5` ID.
- Pi fallback metadata sends adaptive thinking rather than legacy budget-based thinking and does not forward unsupported sampling parameters.
- Current Opus 5 and historical Opus 4.8 usage are priced correctly.
- Focused tests, typecheck, and lint pass, or any unrelated pre-existing failures are documented with evidence.
