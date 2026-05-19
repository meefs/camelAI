# Add Gemini 3.5 Flash And Retire Gemini 3.1 Pro Preview

## Goal

Add `google/gemini-3.5-flash` as a curated OpenRouter-backed Codex chat model and use it as the direct replacement for `gemini-3.1-pro-preview`.

User-facing outcome:

- `gemini-3.5-flash` appears in the hosted/OpenRouter default model suite.
- `gemini-3.1-pro-preview` is no longer offered in the model picker, settings, curated aliases, or docs examples.
- Existing stored org/workspace picker configs and existing threads that still reference `gemini-3.1-pro-preview` are remapped to `gemini-3.5-flash` instead of falling back to an unrelated default.

## Current Codebase Differences From The Older Plan

The previous plan in `docs/add-gemini-deepseek-models-plan.md` mentions files that no longer exist or are no longer the model support path:

- Do not plan work in `services/sandbox-host/internal/app/pi_chat.go`, `services/sandbox-host/internal/app/usage_pricing.go`, or `sandbox/pi/container-tools.ts`; those paths are gone.
- Chat Pi model routing now lives in `workers/main/src/durable-objects.ts`.
- TypeScript billing fallback pricing now lives in `src/lib/usage-pricing.ts`.
- Curated model picker/catalog support lives in `src/types.ts`, `src/lib/llm-provider-config.ts`, `src/lib/model-catalog.ts`, and `src/lib/model-picker-config.ts`.
- User app virtual AI aliases live in `workers/main/src/ai-virtual-binding.ts`.
- Sandbox/user-facing AI guidance lives in `sandbox/skills/developing-software/AI-APPS.md`; the generated bundle `workers/main/src/pi-skills-bundle.ts` may need regeneration or an equivalent update if that source skill changes.

## Pricing And Capability Validation

Source of truth is OpenRouter because hosted camelAI routing and OpenRouter BYOK both use OpenRouter-compatible model ids for Gemini. Verified on 2026-05-19 from the live OpenRouter models API:

- OpenRouter models API: https://openrouter.ai/api/v1/models
- OpenRouter model page: https://openrouter.ai/google/gemini-3.5-flash

Revalidate before implementation/merge:

```bash
curl -s https://openrouter.ai/api/v1/models \
  | jq -r '.data[]
    | select(.id == "google/gemini-3.5-flash"
      or .id == "google/gemini-3.1-pro-preview"
      or .id == "google/gemini-3-flash-preview")
    | {id, canonical_slug, name, created, created_iso: (.created | strftime("%Y-%m-%dT%H:%M:%SZ")), context_length, architecture, pricing, top_provider, supported_parameters}'
```

Live values to use for `google/gemini-3.5-flash`:

| Field | Value |
|---|---|
| OpenRouter id | `google/gemini-3.5-flash` |
| Canonical slug | `google/gemini-3.5-flash-20260519` |
| Created | `2026-05-19T12:30:00Z` |
| Context length | `1048576` |
| Max completion tokens | `65536` |
| Modality | `text+image+file+audio+video->text` |
| Input modalities | `text`, `image`, `video`, `file`, `audio` |
| Supported parameters | `include_reasoning`, `max_tokens`, `reasoning`, `response_format`, `seed`, `stop`, `structured_outputs`, `temperature`, `tool_choice`, `tools`, `top_p` |

Pricing:

| Meter | Per token | Per 1M |
|---|---:|---:|
| Input/prompt | `0.0000015` | `$1.50` |
| Output/completion | `0.000009` | `$9.00` |
| Internal reasoning | `0.000009` | `$9.00` |
| Cache read | `0.00000015` | `$0.15` |
| Cache write | `0.00000008333333333333334` | `$0.083333` |
| Image input | `0.0000015` | `$1.50` |
| Audio input | `0.000003` | `$3.00` |
| Web search | `0.014` | `$0.014/search` |

Comparison notes:

- Gemini 3.5 Flash is 25% cheaper than Gemini 3.1 Pro Preview on input and output tokens (`$1.50/$9.00` vs `$2.00/$12.00` per 1M).
- Gemini 3.5 Flash is 3x the input/output/cache-read price of Gemini 3 Flash Preview (`$0.50/$3.00/$0.05` per 1M).
- Under the current catalog bucket rule in `src/lib/model-catalog.ts` (`$` means input < `$2/M` and output < `$10/M`), Gemini 3.5 Flash still falls into `$`, but it is near the high end of that bucket. Avoid describing it as "cheaper"; describe it as fast and high-intelligence.

## Proposed User-Facing Metadata

Add this curated model id:

| UI model ID | OpenRouter route model | Label |
|---|---|---|
| `gemini-3.5-flash` | `google/gemini-3.5-flash` | `Gemini 3.5 Flash` |

Recommended `MODEL_CATALOG` metadata:

| Field | Value | Reason |
|---|---|---|
| `id` | `gemini-3.5-flash` | Version-qualified, stable UI id. |
| `label` | `Gemini 3.5 Flash` | Matches OpenRouter name without provider prefix. |
| `providerLogo` | `gemini` | Existing Gemini logo is already registered. |
| `providerOrder` | `2` | Keeps Gemini grouped before DeepSeek/Kimi/Grok. |
| `modelOrder` | `0` | Replaces Gemini 3.1 Pro Preview as the top Gemini entry. |
| `cost` | `$` | Current bucket thresholds classify `$1.50/$9.00` per 1M as `$`. |
| `intelligence` | `4.5` | High intelligence and intended to replace Gemini 3.1 Pro Preview, but not the smartest model offered. |
| `speed` | `4.5` | It is still a Flash model and should surface as fast, but not as cheap/fast as the older Flash-only entry. |

Recommended Codex option description:

```text
OpenRouter/camelAI hosted fast high-intelligence coding model
```

Default hosted/OpenRouter suite after replacement:

```ts
[
  "opus-4.7",
  "sonnet",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "kimi-k2.6",
  "grok-4.3",
]
```

Keep `MODEL_PICKER_MAX_MODELS = 10`.

## Replacement Policy For Gemini 3.1 Pro Preview

Do not keep `gemini-3.1-pro-preview` as a supported selectable `LlmModel`. Remove it from curated model lists and tests that define available models.

Add a small legacy replacement map so persisted values are handled intentionally:

```ts
const LEGACY_LLM_MODEL_REPLACEMENTS = {
  "gemini-3.1-pro-preview": "gemini-3.5-flash",
} as const;
```

Use that map before validation in:

- `normalizeLlmModel(...)`, so old thread rows and runner env resolution use Gemini 3.5 Flash.
- `parseOrgModelPickerConfig(...)` and `parseWorkspaceModelPickerConfig(...)`, so old picker configs keep the admin's Gemini slot but point at the new model.
- `normalizeDefaultModel(...)`, so an old stored default model becomes `gemini-3.5-flash` when that model is present in the parsed picker rows.

Important behavior to test:

- `isLlmModel("gemini-3.1-pro-preview")` should be false.
- `normalizeLlmModel("gemini-3.1-pro-preview", "codex")` should return `gemini-3.5-flash`.
- A stored picker config containing both old and new ids should dedupe to one `gemini-3.5-flash` entry.
- The model settings action should reject attempts to add `gemini-3.1-pro-preview` as a new model.

Keep historical billing lookup entries for `google/gemini-3.1-pro-preview` in `src/lib/usage-pricing.ts` unless there is a separate data migration. Historical usage rows may still need old pricing when upstream cost was not recorded.

## Implementation Steps

1. Update type and catalog definitions.

Touch:

- `src/types.ts`
- `src/lib/model-catalog.ts`
- `src/lib/llm-provider-config.ts`
- `src/lib/model-picker-config.ts`

Changes:

- Add `gemini-3.5-flash` to `LlmModel`.
- Remove `gemini-3.1-pro-preview` from selectable model unions/lists where practical, or treat it only as a legacy string outside `LlmModel`.
- Add `gemini-3.5-flash` to `ALL_LLM_MODELS`, `LLM_MODEL_TO_PRICING_KEY`, `MODEL_CATALOG`, `CODEX_LLM_MODEL_OPTIONS`, and `OPENROUTER_ONLY_CODEX_MODELS`.
- Remove `gemini-3.1-pro-preview` from `ALL_LLM_MODELS`, `LLM_MODEL_TO_PRICING_KEY`, `MODEL_CATALOG`, `CODEX_LLM_MODEL_OPTIONS`, and `OPENROUTER_ONLY_CODEX_MODELS`.
- Replace `gemini-3.1-pro-preview` with `gemini-3.5-flash` in `HOSTED_OR_OPENROUTER_DEFAULT_MODEL_ORDER`.
- Add the legacy replacement helper before picker/model normalization so stored configs and thread rows map to the replacement model.

2. Update pricing fallback.

Touch:

- `src/lib/usage-pricing.ts`
- `src/lib/usage-pricing.test.ts`

Add exact entries:

```ts
"google/gemini-3.5-flash": {
  inputPerToken: 0.0000015,
  outputPerToken: 0.000009,
  cacheCreationPerToken: 0.00000008333333333333334,
  cacheReadPerToken: 0.00000015,
},
"gemini-3.5-flash": {
  inputPerToken: 0.0000015,
  outputPerToken: 0.000009,
  cacheCreationPerToken: 0.00000008333333333333334,
  cacheReadPerToken: 0.00000015,
},
```

Add a `lookupPricing` fallback for normalized/prefixed forms containing `gemini-3.5-flash`, including `camel/google/gemini-3.5-flash`, `openrouter/google/gemini-3.5-flash`, and `camelai-openrouter/google/gemini-3.5-flash`.

Retain `gemini-3.1-pro-preview` pricing for historical usage fallback, but do not include it in catalog coverage expectations.

3. Update Pi chat routing.

Touch:

- `workers/main/src/durable-objects.ts`
- `workers/main/tests/chat-thread-codex-external-turn.test.ts`

Add:

```ts
case "gemini-3.5-flash":
  return openRouterReference("google/gemini-3.5-flash");
```

Recommendation for legacy support:

```ts
case "gemini-3.1-pro-preview":
  return openRouterReference("google/gemini-3.5-flash");
```

This legacy case should not make 3.1 Pro selectable; it only prevents old threads or stale env vars from breaking or silently falling to GPT.

Keep Gemini on the current OpenRouter chat-completions path unless manual testing shows Gemini 3.5 Flash requires the Responses API. The current test suite explicitly expects Gemini aliases to route through OpenRouter chat completions rather than a Google-specific or Responses-only path.

### Post-Implementation Note: Pi Registry Fallback

After the initial implementation, Gemini 3.5 Flash appeared in the app catalog and routed to the right OpenRouter id, but chat initialization failed with:

```text
Internal error handling init: Unsupported Pi model codex/gemini-3.5-flash
```

The cause was not the camelAI model catalog. `workers/main/src/durable-objects.ts` correctly resolved `gemini-3.5-flash` and the legacy `gemini-3.1-pro-preview` alias to `openrouter/google/gemini-3.5-flash`, but Pi's bundled generated model registry in `@mariozechner/pi-ai` did not yet include that new OpenRouter model. `resolvePiModel(...)` called Pi's `getModel(...)`, received no model metadata, and threw before hosted AI Gateway or OpenRouter BYOK request configuration could run.

The implemented fix was to add a local, narrow fallback registry in `workers/main/src/durable-objects.ts`:

- Add `PI_MODEL_CATALOG_FALLBACKS` keyed by `${provider}/${modelId}`.
- Add an entry for `openrouter/google/gemini-3.5-flash` using the same `Model<"openai-completions">` shape as Pi's generated OpenRouter Gemini models.
- Populate the fallback with OpenRouter-validated metadata: context window `1048576`, max tokens `65536`, input cost `$1.50/M`, output cost `$9.00/M`, cache read `$0.15/M`, and cache write `$0.083333/M`.
- Change `resolvePiModel(...)` to use `getModel(...) ?? resolvePiModelCatalogFallback(...)` before throwing `Unsupported Pi model`.
- Add a regression test in `workers/main/tests/chat-thread-codex-external-turn.test.ts` that stubs Pi `getModel(...)` to return `undefined` and verifies both `gemini-3.5-flash` and legacy `gemini-3.1-pro-preview` still resolve to a configured hosted OpenRouter model.

Use this same pattern the next time OpenRouter adds a model before the Pi package's generated registry has caught up. Keep the fallback narrow and delete it when the bundled Pi registry includes the model and tests still pass without it. Do not edit `node_modules` for this class of issue.

4. Update virtual AI aliases and docs.

Touch:

- `workers/main/src/ai-virtual-binding.ts`
- `workers/main/tests/ai-virtual-binding.test.ts`
- `sandbox/skills/developing-software/AI-APPS.md`
- `workers/main/src/pi-skills-bundle.ts` if the skill bundle is committed/generated manually in this repo

Changes:

- Add `"gemini-3.5-flash": "google/gemini-3.5-flash"` to `MODEL_ALIASES`.
- Remove `gemini-3.1-pro-preview` from curated examples and docs.
- Decide whether the old shorthand alias maps to Gemini 3.5 Flash for compatibility or is removed. Recommended: map the shorthand to Gemini 3.5 Flash for compatibility, but do not document it.
- Do not change `DEFAULT_VIRTUAL_MODEL` from `google/gemini-3-flash-preview` in this model-picker change. That route is used by user app `auto`, and Gemini 3.5 Flash is materially more expensive than Gemini 3 Flash Preview. Change it only with a separate product decision.
- Do not block arbitrary full OpenRouter ids such as `google/gemini-3.1-pro-preview` in the generic virtual AI pass-through unless product explicitly wants a hard block. This plan removes curated support, not OpenRouter's generic model pass-through.

5. Update user-facing docs and old references.

Search and replace curated references:

```bash
rg -n "gemini-3\\.1-pro-preview|Gemini 3\\.1 Pro Preview" src workers sandbox tests docs
```

Expected actions:

- Replace docs examples with `google/gemini-3.5-flash` or a non-retired generic example.
- Remove 3.1 Pro from model picker/rating docs that enumerate curated models.
- Keep only explicitly historical references, such as this plan, older plans, and historical pricing fallback comments/tests.

## Test Plan

Update focused tests:

- `tests/model-catalog.test.ts`
  - Assert `gemini-3.5-flash` metadata exactly matches the proposed values.
  - Assert `gemini-3.1-pro-preview` is absent from `ALL_LLM_MODELS`, `MODEL_CATALOG`, and `LLM_MODEL_TO_PRICING_KEY`.
  - Update Gemini provider ordering to `gemini-3.5-flash`, then `gemini-3-flash-preview`.

- `tests/model-picker-config.test.ts`
  - Assert default hosted/OpenRouter suite replaces 3.1 Pro with 3.5 Flash and remains at capacity 10.
  - Assert old stored picker rows and old stored defaults remap to `gemini-3.5-flash`.
  - Assert old+new duplicate rows dedupe to one new entry.

- `workers/main/tests/llm-provider-config.test.ts`
  - Update `CODEX_MODELS` and `OPENROUTER_ONLY_MODELS`.
  - Assert OpenAI BYOK still hides Gemini/OpenRouter-only models.
  - Assert `isLlmModel("gemini-3.1-pro-preview")` is false.
  - Assert `normalizeLlmModel("gemini-3.1-pro-preview", "codex")` returns `gemini-3.5-flash`.

- `src/lib/usage-pricing.test.ts`
  - Assert exact calculated costs for prompt, completion, cache read, and cache write using `google/gemini-3.5-flash`.
  - Assert prefixed model strings normalize to the same pricing.
  - Keep or add a historical 3.1 Pro pricing assertion if old rows still depend on it.

- `workers/main/tests/chat-thread-codex-external-turn.test.ts`
  - Assert `gemini-3.5-flash` resolves to `google/gemini-3.5-flash`.
  - Assert legacy `gemini-3.1-pro-preview` resolves to `google/gemini-3.5-flash` if the compatibility case is added.
  - Assert hosted AI Gateway and OpenRouter BYOK still use the OpenRouter provider path.

- `workers/main/tests/ai-virtual-binding.test.ts`
  - Assert `resolveModel("gemini-3.5-flash")` maps to `google/gemini-3.5-flash`.
  - Update or remove assertions for `gemini-3.1-pro-preview` according to the compatibility decision.

- Existing fixtures likely needing updates:
  - `tests/model-settings-action.test.ts`
  - `tests/model-logo-and-pricing.test.ts`
  - `tests/new-chat-sales-prompt-loader.test.ts`
  - `tests/chat-do-model-picker-state.test.ts`
  - `tests/model-picker.test.tsx` or `tests/model-settings-ui.test.tsx` if snapshots/labels enumerate models
  - `workers/main/tests/model-picker-config-compat.test.ts` if fallback suite expectations are explicit

## Verification Commands

Run the smallest representative set after implementation:

```bash
bun run typecheck
bun run test:run -- \
  tests/model-catalog.test.ts \
  tests/model-logo-and-pricing.test.ts \
  tests/model-picker-config.test.ts \
  tests/model-settings-action.test.ts \
  tests/new-chat-sales-prompt-loader.test.ts \
  tests/chat-do-model-picker-state.test.ts \
  src/lib/usage-pricing.test.ts
bun run test:workers -- \
  workers/main/tests/llm-provider-config.test.ts \
  workers/main/tests/ai-virtual-binding.test.ts \
  workers/main/tests/chat-thread-codex-external-turn.test.ts \
  workers/main/tests/model-picker-config-compat.test.ts
```

Run `bun run test:sandbox-host` only if the implementation unexpectedly touches `services/sandbox-host/`.

## Manual Smoke Test

After automated tests pass:

1. Create a new hosted billing thread and confirm Gemini 3.5 Flash appears in the default model suite where Gemini 3.1 Pro Preview used to appear.
2. Confirm Gemini 3.1 Pro Preview does not appear in model picker or organization model settings.
3. Send a simple prompt using Gemini 3.5 Flash in hosted mode.
4. Repeat using OpenRouter BYOK.
5. Confirm usage rows record an OpenRouter route model of `google/gemini-3.5-flash` or the hosted gateway equivalent, nonzero token counts, and expected cost behavior.
6. Seed or mock an old stored config/thread with `gemini-3.1-pro-preview` and confirm it resolves to Gemini 3.5 Flash without crashing the model logo, picker, or chat runner.

## Out Of Scope

- Adding direct Google BYOK as a provider.
- Changing the default chat model (`DEFAULT_CODEX_MODEL`, `DEFAULT_OPENROUTER_MODEL`, or `DEFAULT_LLM_MODEL`).
- Changing the virtual AI `auto` default from Gemini 3 Flash Preview to Gemini 3.5 Flash.
- Blocking all arbitrary full OpenRouter ids for retired models in user app `env.AI.run()` pass-through.
- Reworking model-picker cost buckets. Gemini 3.5 Flash is expensive for a Flash model, but still lands in `$` under the current bucket thresholds.
