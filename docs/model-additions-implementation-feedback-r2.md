# Model Additions Implementation Feedback R2

Review date: 2026-05-07

Overall, the implementation now correctly treats GPT-5.5 and Opus 4.7 as additive models. `opus` remains Opus 4.6, `opus-4.7` is distinct, GPT-5.5 uses the Responses-style Pi registration, the hosted/OpenRouter default suite is capped at 10, and the focused tests pass.

## Finding

### Settings page still shows provider-incompatible additional models

Severity: Medium

The chat picker path filters through `resolveModelPickerCatalog`, so provider-specific visibility is correct there. The organization model settings loader does not apply the same visibility filter when building the settings lists:

- `src/routes/_app.settings.organization.models.tsx:138` builds `additional` from all `ALL_LLM_MODELS` not already in the config.
- `src/routes/_app.settings.organization.models.tsx:179` loads only `orgConfig` and workspaces, not the org LLM provider/experimental settings needed for visible-model filtering.
- `src/routes/_app.settings.organization.models.tsx:221` returns `inPicker`, `additional`, and `capacity.used` from the unfiltered effective config.
- `src/routes/_app.settings.organization.models.tsx:419` correctly rejects incompatible models on submit, which confirms the UI can currently show models that cannot actually be added.

Impact: for an OpenAI BYOK org, the default in-picker suite contains only GPT models, but the settings page additional list will still show Claude, Gemini, DeepSeek, Kimi, and Grok rows. Clicking one produces a validation error. This conflicts with the requirement that direct OpenAI/Anthropic/Bedrock providers only show the models available for that provider, and it can also make capacity counts misleading if a stored config contains hidden models after a provider switch.

Recommended fix:

- In the settings loader, fetch `orgStub.getLlmProviderConfig()` and `orgStub.getExperimentalSettings()`.
- Reuse `getVisibleModelIdsForSettings`.
- Normalize the effective config for display with `normalizeConfigForVisibleModels`.
- Filter `buildAdditionalRows` by the same visible model set, or pass the set into `buildAdditionalRows`.
- Use the visible/normalized config for `capacity.used`.

Suggested tests:

- Add a loader test for `provider: "openai"` where `additional` is empty when the default OpenAI suite already includes `gpt-5.5`, `gpt-5.4`, and `gpt-5.4-mini`.
- Add a loader test for a stored mixed-provider config after switching to OpenAI: `inPicker` and `capacity.used` should only count visible OpenAI models.
- Add equivalent coverage for `anthropic` or `bedrock` showing only `opus-4.7`, `opus`, `sonnet`, and `haiku`.

## Verified Good

- GPT-5.5 is present as a distinct `LlmModel` and maps to `openai/gpt-5.5`.
- The Pi model registration uses `api: "openai-responses"` for GPT-5.5 and caps context at `272000`, avoiding the long-context GPT-5.5 billing tier for hosted usage.
- Opus 4.7 is a distinct `opus-4.7` model; existing `opus` remains Opus 4.6.
- Opus 4.6 and Opus 4.7 both have direct Anthropic, OpenRouter, Bedrock, and pricing mappings.
- Gemini and DeepSeek are grouped by provider/model order rather than recency, and the requested intelligence metadata is set.
- `MODEL_PICKER_MAX_MODELS` remains `10`.

## Source Checks

- OpenAI GPT-5.5 docs confirm `gpt-5.5`, Responses support, 1,050,000 context, 128,000 max output, $5 input / $0.50 cached input / $30 output per MTok, and the >272K input long-context pricing rule: https://developers.openai.com/api/docs/models/gpt-5.5
- Anthropic model docs confirm Opus 4.7 API ID `claude-opus-4-7`, 1M context, and Opus 4.7 as a step up from Opus 4.6: https://platform.claude.com/docs/en/about-claude/models/overview
- Anthropic pricing docs confirm Opus 4.7 pricing and standard pricing across the 1M context window: https://platform.claude.com/docs/en/about-claude/pricing
- AWS Bedrock docs confirm `anthropic.claude-opus-4-7` and `global.anthropic.claude-opus-4-7`: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-7.html

## Verification Run

```bash
bun run test:run -- tests/model-catalog.test.ts tests/model-picker-config.test.ts tests/model-logo-and-pricing.test.ts tests/model-settings-action.test.ts tests/chat-do-model-picker-state.test.ts tests/new-chat-sales-prompt-loader.test.ts workers/main/tests/llm-provider-config.test.ts workers/main/tests/ai-virtual-binding.test.ts
bun run test:workers -- workers/main/tests/llm-provider-config.test.ts workers/main/tests/ai-virtual-binding.test.ts
bun run test:sandbox-host
bun run typecheck
```

All commands above passed. I did not run the full e2e suite.
