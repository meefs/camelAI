# Model Additions Implementation Feedback

Review date: 2026-05-07

This feedback covers the current Gemini/DeepSeek implementation diff plus the newly requested GPT-5.5 and Claude Opus 4.7 additions. GPT-5.5 and Opus 4.7 are additive model support requests: keep GPT-5.4, GPT-5.4 Mini, and Opus 4.6 available. Treat the items below as required before shipping; the tests are not optional because this path controls model access and billing.

## Sources Checked

- OpenAI GPT-5.5 docs: `gpt-5.5`, 1,050,000 context, 128,000 max output, $5 input / $0.50 cached input / $30 output per MTok, and a long-context pricing rule for prompts over 272K input tokens. The docs list both Chat Completions and Responses endpoints, but this product should route GPT-5.5 through Responses like GPT-5.4 and GPT-5.4 Mini. Source: https://developers.openai.com/api/docs/models/gpt-5.5
- Anthropic model overview: Claude Opus 4.7 API ID is `claude-opus-4-7`, with AWS Bedrock ID `anthropic.claude-opus-4-7`, 1M context, and 128K max output. Source: https://platform.claude.com/docs/en/about-claude/models/overview
- Anthropic pricing: Claude Opus 4.7 is $5 input / $25 output per MTok, $6.25 per MTok for 5m cache writes, $10 per MTok for 1h cache writes, and $0.50 per MTok for cache hits. Anthropic also says Opus 4.7 has standard pricing across the full 1M context window. Source: https://platform.claude.com/docs/en/about-claude/pricing
- AWS Bedrock model card: Bedrock runtime model ID is `anthropic.claude-opus-4-7`; global inference ID is `global.anthropic.claude-opus-4-7`. Source: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-7.html
- OpenRouter registry, fetched from `https://openrouter.ai/api/v1/models` on 2026-05-07:
  - `openai/gpt-5.5`, context `1050000`, max completion `128000`, prompt `0.000005`, completion `0.00003`, cache read `0.0000005`.
  - `anthropic/claude-opus-4.7`, context `1000000`, max completion `128000`, prompt `0.000005`, completion `0.000025`, cache read `0.0000005`, cache write `0.00000625`.

## Blocking Feedback

### 1. Add GPT-5.5 as a new OpenAI model and route it through Responses

The current diff does not include GPT-5.5 anywhere in the model type, catalog, picker options, sandbox-host routing, Pi provider registration, or pricing table. Add it as a first-class `LlmModel`, not just as a raw provider string. Keep the existing `gpt-5.4` and `gpt-5.4-mini` models unchanged.

Required implementation points:

- Add `gpt-5.5` to `src/types.ts`, `ALL_LLM_MODELS`, `LLM_MODEL_TO_PRICING_KEY`, `MODEL_CATALOG`, and `CODEX_LLM_MODEL_OPTIONS`.
- Add GPT-5.5 to hosted/OpenRouter Codex visibility in `src/lib/llm-provider-config.ts`. OpenAI BYOK orgs should also see it.
- In `services/sandbox-host/internal/app/pi_chat.go`, copy the GPT-5.4 pattern:
  - hosted/OpenRouter upstream: `camel/openai/gpt-5.5`
  - direct OpenAI BYOK: `openai/gpt-5.5`
- In `services/sandbox-host/pi/container-tools.ts`, add the model next to GPT-5.4 with `api: "openai-responses"`. Do not register it as a chat-completions model.
- In `services/sandbox-host/internal/app/usage_pricing.go`, add per-token pricing for `gpt-5.5` and any normalized forms that usage rows may record.
- Billing caveat: OpenAI charges GPT-5.5 prompts over 272K input tokens at 2x input and 1.5x output for the full session. The current `ModelPricing` table is flat per model, so it cannot bill this correctly if the implementation exposes the full 1.05M context. Either cap GPT-5.5 to 272K context until usage pricing can branch on token count, or extend `CostUSD`/pricing lookup so GPT-5.5 long-context sessions use the higher rates. Do not ship full-context GPT-5.5 with only the base flat rate.

Required tests:

- Type/catalog tests must assert GPT-5.5 exists with pricing and catalog metadata.
- Sandbox-host routing tests must cover `gpt-5.5` for hosted/OpenRouter and OpenAI BYOK.
- Pi provider/model registration tests or snapshots must assert GPT-5.5 uses `openai-responses`.
- Usage pricing tests must cover standard GPT-5.5 pricing and, if full context is exposed, the >272K long-context pricing rule.
- Regression tests must continue to assert GPT-5.4 and GPT-5.4 Mini remain visible/routable.

### 2. Add Claude Opus 4.7 as a separate model while keeping Opus 4.6

Audit result: the code currently has only one Opus-shaped internal `LlmModel`, named `opus`, and it maps to Claude Opus 4.6. That is not enough to support both Opus 4.6 and Opus 4.7 in the model picker. Do not retarget `opus` to Opus 4.7.

Clarification on terminology: by "alias" I meant the current shorthand internal model key `opus`. In this codebase, `opus` is the only Opus entry today and should continue to mean Opus 4.6 for backwards compatibility with persisted thread/model-picker state. Opus 4.7 needs its own distinct internal model ID.

Recommended internal ID: add `opus-4.7` as a new `LlmModel`. Keep `opus` as the existing Opus 4.6 model. If the implementation chooses a more explicit ID such as `claude-opus-4.7`, apply it consistently everywhere, but do not reuse `opus` for Opus 4.7.

Current Opus 4.6 wiring that must remain valid:

- `src/lib/model-catalog.ts:59` maps `opus` to `claude-opus-4-6`.
- `src/lib/model-catalog.ts:82` labels `opus` as `Opus 4.6`.
- `src/lib/llm-provider-config.ts:31` labels the Claude picker option as `Opus 4.6`.
- `services/sandbox-host/internal/app/pi_chat.go:580` and `:633` route direct Anthropic `opus` to `anthropic/claude-opus-4-6`.
- `services/sandbox-host/internal/app/server.go:1674` maps OpenRouter `opus` to `anthropic/claude-opus-4.6`.
- `services/sandbox-host/pi/container-tools.ts:936` and `:1436` register/use `anthropic/claude-opus-4.6`.

Required Opus 4.7 target IDs:

- Anthropic API: `claude-opus-4-7`
- Direct Pi model string: `anthropic/claude-opus-4-7`
- OpenRouter: `anthropic/claude-opus-4.7`
- Bedrock runtime/global mapping: `global.anthropic.claude-opus-4-7` for the current direct Bedrock map pattern, with `anthropic.claude-opus-4-7` as the underlying model ID from AWS docs.

Required Opus 4.7 implementation points:

- Add the new Opus 4.7 internal ID to `src/types.ts`, `ALL_LLM_MODELS`, `LLM_MODEL_TO_PRICING_KEY`, `MODEL_CATALOG`, and `CLAUDE_LLM_MODEL_OPTIONS`.
- Add Opus 4.7 to Claude-family visibility for hosted/camelAI, OpenRouter, Anthropic BYOK, and Bedrock BYOK orgs.
- Add `services/sandbox-host/internal/app/pi_chat.go` routing for the new internal ID:
  - hosted/OpenRouter upstream: `camel/anthropic/claude-opus-4.7`
  - direct Anthropic BYOK: `anthropic/claude-opus-4-7`
- Keep existing `opus` routing to Opus 4.6.
- Add `services/sandbox-host/pi/container-tools.ts` support for both Opus 4.6 and Opus 4.7 in `resolveSubagentModel` and provider model registration.
- Add `services/sandbox-host/internal/app/server.go` mappings for both Opus versions:
  - `openRouterClaudeModel("opus")` should continue to return `anthropic/claude-opus-4.6`.
  - `openRouterClaudeModel("opus-4.7")` and `openRouterClaudeModel("claude-opus-4-7")` should return `anthropic/claude-opus-4.7`.
  - `bedrockModelMap` should keep `claude-opus-4-6` and add `claude-opus-4-7`.

Required Opus 4.7 pricing:

- Input: `0.000005`
- Output: `0.000025`
- 5m cache write: `0.00000625`
- Cache read: `0.0000005`

Also audit Opus 4.6 pricing normalization while touching this area. The current table has `claude-opus-4-6`, but the OpenRouter route string can be `anthropic/claude-opus-4.6`; make sure both dotted OpenRouter IDs and hyphenated Anthropic IDs for Opus 4.6 and Opus 4.7 bill at the intended Opus rate instead of falling through to Sonnet-tier fallback pricing.

Required tests:

- Keep existing Opus 4.6 tests for `opus` and add parallel Opus 4.7 tests for the new internal ID.
- Add explicit Opus 4.7 tests for Anthropic BYOK, Bedrock BYOK, and OpenRouter hosted mapping.
- Add pricing tests for `claude-opus-4-6`, `anthropic/claude-opus-4.6`, `claude-opus-4-7`, `anthropic/claude-opus-4.7`, and normalized hosted prefixes such as `camel/anthropic/claude-opus-4.7`.
- Add picker/catalog tests that show both Opus 4.7 and Opus 4.6 are valid, visible Claude-family models.

### 3. Fix provider grouping in picker/settings ordering

The screenshot bug is caused by all OpenRouter-hosted non-OpenAI brands sharing `providerOrder: 2` and then sorting by recency. In `src/lib/model-catalog.ts:206`, `resolveModelPickerCatalog` sorts by provider order, then `addedAt`; this splits DeepSeek around Gemini. `sortAdditionalModelCatalogEntries` at `src/lib/model-catalog.ts:220` has the same provider-order problem for settings.

The current test `tests/model-catalog.test.ts:137` codifies the wrong behavior by asserting "orders same-provider OpenRouter picker models by recency" and expecting DeepSeek/Gemini interleaving. Replace that with a grouping regression test.

Required ordering behavior:

- Claude group first.
- OpenAI group second.
- Gemini group third.
- DeepSeek group fourth.
- Kimi and Grok after those, matching the requested default suite.
- Within Gemini and DeepSeek, put the smarter/slower model before the fast/cheap model: Gemini Pro before Gemini Flash, DeepSeek Pro before DeepSeek Flash.

Implementation options:

- Split `providerOrder` so each provider logo/brand has its own order, for example Claude `0`, OpenAI `1`, Gemini `2`, DeepSeek `3`, Kimi `4`, Grok `5`.
- Or add a separate `providerGroupOrder`/`modelOrder` field and use it in both `resolveModelPickerCatalog` and `sortAdditionalModelCatalogEntries`.

Do not use recency as the primary order within the default picker display; it makes provider groups unstable.

### 4. Update the default model suite, without raising capacity

Keep `MODEL_PICKER_MAX_MODELS = 10`. The default suite should be provider-aware. The current `DEFAULT_MODEL_ORDER` in `src/lib/model-picker-config.ts:19` is still the old seven-model suite and cannot satisfy the requested provider-specific defaults by itself.

For camelAI hosted provider or OpenRouter BYOK, the auto-chosen default picker state should be exactly:

1. `opus-4.7` (Opus 4.7, or the chosen distinct internal ID)
2. `sonnet` (Sonnet 4.6)
3. `gpt-5.5`
4. `gpt-5.4-mini`
5. `gemini-3.1-pro-preview`
6. `gemini-3-flash-preview`
7. `deepseek-v4-pro`
8. `deepseek-v4-flash`
9. `kimi-k2.6`
10. `grok-4.3`

For direct provider BYOK defaults:

- OpenAI BYOK: default picker should include all OpenAI models, currently `gpt-5.5`, `gpt-5.4`, and `gpt-5.4-mini`.
- Anthropic BYOK: default picker should include all Anthropic/Claude models, currently `opus-4.7`, `opus` (Opus 4.6), `sonnet`, and `haiku`.
- AWS Bedrock BYOK: default picker should include all supported Anthropic/Claude models available through Bedrock, currently `opus-4.7`, `opus` (Opus 4.6), `sonnet`, and `haiku`.

This probably requires a provider-aware default helper rather than a single static `defaultOrgModelPickerConfig()`. Be careful with persisted org configs: existing customized pickers should continue to parse as stored, while missing/malformed config should use the default suite appropriate for the org provider.

Required tests:

- Assert the exact hosted/OpenRouter default suite above, in order, and assert it has length 10.
- Assert direct OpenAI defaults contain all OpenAI models and no Claude/OpenRouter-only models.
- Assert direct Anthropic and Bedrock defaults contain both Opus 4.7 and Opus 4.6 plus all other Claude models, with no OpenAI/OpenRouter-only models.
- Keep the existing capacity test at 10; do not change it to 12.

### 5. Fix model intelligence metadata

The current catalog metadata does not match the requested classifications:

- `src/lib/model-catalog.ts:145` Gemini 3 Flash Preview is `medium`; change to `low`.
- `src/lib/model-catalog.ts:163` DeepSeek V4 Pro is `high`; change to `medium`.
- `src/lib/model-catalog.ts:172` DeepSeek V4 Flash is `medium`; change to `low`.

Update `tests/model-catalog.test.ts:20` metadata expectations at the same time. These should be direct assertions so future metadata drift fails loudly.

## Other Notes

- The settings tooltip change in `src/routes/_app.settings.organization.models.tsx` correctly uses the configured capacity. Keep that change.
- The logo placement/registry additions look consistent with the requested no-theme Gemini and DeepSeek SVGs.
- The new tests in the current diff are useful, but several of them now assert the wrong behavior: OpenRouter-only models outside the default picker and recency interleaving across providers. Keep Opus 4.6 route expectations for the existing `opus` model, and add new Opus 4.7 route expectations for the new internal model ID.

## Suggested Verification Commands

Run the focused tests after implementation:

```bash
bun run test:run -- tests/model-catalog.test.ts tests/model-picker-config.test.ts tests/model-logo-and-pricing.test.ts tests/model-settings-action.test.ts workers/main/tests/llm-provider-config.test.ts workers/main/tests/ai-virtual-binding.test.ts
bun run test:sandbox-host
bun run typecheck
```

If the implementation changes worker proxy behavior beyond model string rewrites, also run the relevant worker test target:

```bash
bun run test:workers -- workers/main/tests/ai-virtual-binding.test.ts
```
