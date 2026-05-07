# Add Gemini 3 and DeepSeek V4 Chat Models

## Goal

Add four user-facing chat models to camelAI:

| UI model ID | OpenRouter route model | Label | Release/date sanity check |
|-------------|------------------------|-------|---------------------------|
| `gemini-3-flash-preview` | `google/gemini-3-flash-preview` | Gemini 3 Flash Preview | OpenRouter shows Dec 17, 2025 |
| `gemini-3.1-pro-preview` | `google/gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | OpenRouter shows Feb 19, 2026 |
| `deepseek-v4-pro` | `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | OpenRouter shows Apr 24, 2026 |
| `deepseek-v4-flash` | `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | OpenRouter shows Apr 24, 2026 |

These are Codex-harness models. They should work in both hosted camelAI billing mode and org BYOK OpenRouter mode. Do not add Google or DeepSeek as new BYOK providers in this change.

## Pricing Source Of Truth

For this implementation, bill these models from OpenRouter prices because the existing hosted third-party path and OpenRouter BYOK path both route through OpenRouter-compatible endpoints. Use Google and DeepSeek official docs only as sanity checks unless the routing is changed to call Google or DeepSeek directly.

Verified on 2026-05-07:

| Model | Input/token | Output/token | Cache read/token | Cache write/token | Cost bucket |
|-------|-------------|--------------|------------------|-------------------|-------------|
| `google/gemini-3-flash-preview` | `0.0000005` | `0.000003` | `0.00000005` | `0.00000008333333333333334` | `$` |
| `google/gemini-3.1-pro-preview` | `0.000002` | `0.000012` | `0.0000002` | `0.000000375` | `$$` |
| `deepseek/deepseek-v4-pro` | `0.000000435` | `0.00000087` | `0.000000003625` | `0` | `$` |
| `deepseek/deepseek-v4-flash` | `0.00000014` | `0.00000028` | `0.0000000028` | `0` | `$` |

Before merging, rerun:

```bash
curl -s https://openrouter.ai/api/v1/models \
  | jq -r '.data[]
    | select(.id == "google/gemini-3-flash-preview"
      or .id == "google/gemini-3.1-pro-preview"
      or .id == "deepseek/deepseek-v4-pro"
      or .id == "deepseek/deepseek-v4-flash")
    | {id, created, context_length, pricing, top_provider}'
```

If any OpenRouter price differs, update the Go pricing table, tests, and the cost bucket values in this plan's spirit. DeepSeek's official direct API page says `deepseek-v4-pro` is discounted through 2026-05-31 15:59 UTC, so this check is not optional.

## Source Links

- OpenRouter Gemini 3 Flash Preview: https://openrouter.ai/google/gemini-3-flash-preview
- OpenRouter Gemini 3.1 Pro Preview: https://openrouter.ai/google/gemini-3.1-pro-preview
- OpenRouter DeepSeek V4 Pro: https://openrouter.ai/deepseek/deepseek-v4-pro
- OpenRouter DeepSeek V4 Flash: https://openrouter.ai/deepseek/deepseek-v4-flash
- OpenRouter models API: https://openrouter.ai/api/v1/models
- Google Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing
- DeepSeek API pricing: https://api-docs.deepseek.com/quick_start/pricing

## Data To Add

Recommended model catalog metadata:

| Model | Provider logo | Provider order | Cost | Intelligence | Speed |
|-------|---------------|----------------|------|--------------|-------|
| `gemini-3-flash-preview` | `gemini` | `2` | `$` | `medium` | `fast` |
| `gemini-3.1-pro-preview` | `gemini` | `2` | `$$` | `high` | `balanced` |
| `deepseek-v4-pro` | `deepseek` | `2` | `$` | `high` | `balanced` |
| `deepseek-v4-flash` | `deepseek` | `2` | `$` | `medium` | `fast` |

Keep `providerOrder: 2` for these because the current picker treats non-OpenAI, non-Claude Codex models as OpenRouter-hosted third-party models. If the UI later needs provider grouping, split provider orders in a separate change.

Recommended Codex option descriptions:

- Gemini 3 Flash Preview: `OpenRouter/camelAI hosted fast reasoning model`
- Gemini 3.1 Pro Preview: `OpenRouter/camelAI hosted flagship reasoning model`
- DeepSeek V4 Pro: `OpenRouter/camelAI hosted flagship reasoning model`
- DeepSeek V4 Flash: `OpenRouter/camelAI hosted faster and cheaper model`

## Implementation Steps

1. Add logos.

Move the already-downloaded SVGs into `public/logos/`:

```bash
mv /Users/illiana/Downloads/gemini-color.svg public/logos/gemini.svg
mv /Users/illiana/Downloads/deepseek.svg public/logos/deepseek.svg
```

Then register both as single-variant logos in `src/lib/integration-logo-registry.ts` and add them to `public/logos/README.md`. The existing `ModelLogo` component will pick them up through `MODEL_CATALOG.providerLogo`.

2. Add model IDs and picker metadata.

Touch:

- `src/types.ts`: extend `LlmModel`.
- `src/lib/model-catalog.ts`: extend `ProviderLogoType`, `ALL_LLM_MODELS`, `LLM_MODEL_TO_PRICING_KEY`, and `MODEL_CATALOG`.
- `src/lib/model-picker-config.ts`: keep `MODEL_PICKER_MAX_MODELS` at `10`; do not add all four new IDs to `DEFAULT_MODEL_ORDER`.
- `src/lib/llm-provider-config.ts`: add the four IDs to `CODEX_LLM_MODEL_OPTIONS`, `getProviderForModel`, `isLlmModel`, and OpenRouter-only provider gating.

The model picker is intentionally capped at 10. Adding a supported model to `ALL_LLM_MODELS` makes it available in Settings as an additional model; it does not mean every model belongs in every org's default picker. For this implementation, leave `MODEL_PICKER_MAX_MODELS = 10` and keep `DEFAULT_MODEL_ORDER` as a curated list of at most 10 models. If product wants any of these four models included in new-org defaults, replace an existing default model in the same patch rather than increasing the cap.

Also fix the hardcoded tooltip in `src/routes/_app.settings.organization.models.tsx` that currently says `Picker capacity reached (max 10)` so it uses `data.config.capacity.max`. This keeps the UI correct if the cap changes in a future product decision.

Do not change `DEFAULT_LLM_MODEL`, `DEFAULT_CODEX_MODEL`, or `DEFAULT_OPENROUTER_MODEL` unless product explicitly asks for a default model change.

3. Add sandbox-host routing.

Touch:

- `services/sandbox-host/internal/app/pi_chat.go`
- `services/sandbox-host/pi/container-tools.ts`

Map UI IDs to OpenRouter route models:

```text
gemini-3-flash-preview -> camel/google/gemini-3-flash-preview
gemini-3.1-pro-preview -> camel/google/gemini-3.1-pro-preview
deepseek-v4-pro -> camel/deepseek/deepseek-v4-pro
deepseek-v4-flash -> camel/deepseek/deepseek-v4-flash
```

Update both `resolvePiModel` and `resolvePiModelCommand` in Go, plus `resolveSubagentModel` in `container-tools.ts`.

In the `camel` provider registration in `container-tools.ts`, add model specs with:

| Route model | API | Reasoning | Input | Context | Max tokens |
|-------------|-----|-----------|-------|---------|------------|
| `google/gemini-3-flash-preview` | `openai-responses` | `true` | `["text", "image"]` | `1048576` | `65536` |
| `google/gemini-3.1-pro-preview` | `openai-responses` | `true` | `["text", "image"]` | `1048576` | `65536` |
| `deepseek/deepseek-v4-pro` | `openai-responses` | `true` | `["text"]` | `1048576` | `384000` |
| `deepseek/deepseek-v4-flash` | `openai-responses` | `true` | `["text"]` | `1048576` | `384000` |

Use the same per-million-token `cost` numbers as the pricing table above, but expressed per million in the Pi model specs.

4. Add billing prices and aliases.

Touch `services/sandbox-host/internal/app/usage_pricing.go`.

Add exact OpenRouter route model keys, plus UI-ID aliases if useful:

```go
"google/gemini-3-flash-preview": { ... }
"gemini-3-flash-preview": { ... }
"google/gemini-3.1-pro-preview": { ... }
"gemini-3.1-pro-preview": { ... }
"deepseek/deepseek-v4-pro": { ... }
"deepseek-v4-pro": { ... }
"deepseek/deepseek-v4-flash": { ... }
"deepseek-v4-flash": { ... }
```

There is already a `gemini-3-flash-preview` pricing entry for virtual AI. Re-check it against OpenRouter before keeping it: hosted OpenRouter cache write pricing is `0.00000008333333333333334` per token, not the current `0.0000005` value. Update `usage_pricing_test.go` in the same patch.

Update `lookupPricing` fallback cases so prefixed models like `camel/google/gemini-3.1-pro-preview`, `openrouter/deepseek/deepseek-v4-pro`, and `camelai-openrouter/deepseek/deepseek-v4-flash` resolve to exact rates and never fall back to Sonnet pricing.

5. Add virtual AI aliases.

Touch:

- `workers/main/src/ai-virtual-binding.ts`
- `services/sandbox-host/internal/app/server.go` if you want the sandbox-host virtual AI endpoint to be defensive too

Add shorthand aliases:

```text
gemini-3-flash-preview -> google/gemini-3-flash-preview
gemini-3.1-pro-preview -> google/gemini-3.1-pro-preview
deepseek-v4-pro -> deepseek/deepseek-v4-pro
deepseek-v4-flash -> deepseek/deepseek-v4-flash
```

This is not the main chat path, but it keeps user app `env.AI.run()` model aliases aligned with the chat catalog.

6. Update tests.

Tests are required for this change. Do not merge a model-support implementation without focused automated coverage for catalog metadata, provider gating, routing aliases, billing prices, and OpenRouter request handling.

Update or add coverage in:

- `tests/model-catalog.test.ts`: catalog completeness, logo registry, OpenAI BYOK hiding, expected ordering.
- `tests/model-logo-and-pricing.test.ts`: Gemini and DeepSeek logo variants, Go pricing keys.
- `tests/model-picker-config.test.ts`: assert `MODEL_PICKER_MAX_MODELS` remains `10`, default org picker config stays within that cap, and newly supported models can be parsed/normalized even when they are not in the default picker.
- `workers/main/tests/llm-provider-config.test.ts`: Codex options, visible models for hosted, OpenAI BYOK, and OpenRouter BYOK, provider inference, OpenRouter-only gating.
- `tests/model-settings-action.test.ts`: OpenAI BYOK rejects at least one new OpenRouter-only model with the correct label.
- `workers/main/tests/ai-virtual-binding.test.ts`: new alias mapping.
- `services/sandbox-host/internal/app/pi_chat_test.go`: `resolvePiModel` and command mapping.
- `services/sandbox-host/internal/app/usage_pricing_test.go`: exact rates and prefixed alias fallback.
- `services/sandbox-host/internal/app/server_test.go`: hosted and BYOK OpenRouter requests preserve or route the new model IDs as expected. Cover at least one Gemini and one DeepSeek representative; cover all four if the helper structure makes that low-friction.

Before finishing, confirm every new `LlmModel` has explicit positive coverage in either a table-driven test or a named assertion for:

- catalog entry and pricing-key mapping
- provider visibility/gating
- Pi model alias mapping
- Go pricing lookup, including prefixed `camel/` or `openrouter/` forms

Search for hardcoded model arrays in tests before finishing:

```bash
rg -n "gpt-5\\.4|kimi-k2\\.6|grok-4\\.3|allowedThreadModels|MODEL_PICKER_MAX_MODELS|Picker capacity" tests workers/main/tests services/sandbox-host/internal/app
```

7. Verify.

Run:

```bash
bun run typecheck
bun run test:run -- tests/model-catalog.test.ts tests/model-logo-and-pricing.test.ts tests/model-picker-config.test.ts tests/model-settings-action.test.ts
bun run test:workers -- workers/main/tests/llm-provider-config.test.ts workers/main/tests/ai-virtual-binding.test.ts
bun run test:sandbox-host
```

If Go pricing or proxy routing changes touch shared behavior beyond the focused tests, run `bun run test:workers` as well.

## Out Of Scope

- Adding direct Google or DeepSeek BYOK providers.
- Migrating existing stored org or workspace picker configs to auto-add the new models. New/default configs will include them, and existing admins can add them from Settings.
- Changing the default chat model.
- Replacing the Go pricing table with a runtime OpenRouter pricing fetch.

## Manual Smoke Test

After tests pass, create a new hosted billing thread and an OpenRouter BYOK thread, then send one trivial prompt using:

- one Gemini model, preferably `gemini-3.1-pro-preview`
- one DeepSeek model, preferably `deepseek-v4-flash`

Confirm the sandbox-host usage rows record `provider = openrouter`, the correct route model or UI model, nonzero token counts, and a cost matching `UsageTokens.CostUSD()`.
