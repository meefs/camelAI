# Model Additions Implementation Feedback R3

Review date: 2026-05-07

The round 2 settings-page display fix is mostly in place: the loader now fetches org provider state, filters the displayed picker/additional rows to visible models, and reports visible capacity. I found one remaining write-path issue.

## Finding

### Hidden stored models can still block adding visible models after a provider switch

Severity: Medium

The settings loader now normalizes the effective config for display:

- `src/routes/_app.settings.organization.models.tsx:217` builds `displayConfig` with `normalizeConfigForVisibleModels`.
- `src/routes/_app.settings.organization.models.tsx:237` displays rows and capacity from that filtered config.

However, the action path still enforces capacity and saves additions against the raw stored config:

- `src/routes/_app.settings.organization.models.tsx:444` checks `target.config.models.length >= MODEL_PICKER_MAX_MODELS`.
- `src/routes/_app.settings.organization.models.tsx:453` saves `models: addModel(target.config.models, model)`.

Impact: if an org previously had a 10-model hosted/OpenRouter picker, then switches to OpenAI BYOK, the settings page correctly shows only the visible OpenAI models and may show `gpt-5.4` as available to add. But the add action still sees the hidden stored models in `target.config.models`, thinks the picker is full, and returns `Picker capacity reached`. This makes the UI say there is visible capacity while the submit path rejects the visible add.

Recommended fix:

- Normalize `target.config` with `normalizeConfigForVisibleModels(target.config, target.visibleModelIds)` before action mutations that are scoped to the current provider.
- For `addModel`, perform the capacity check against the visible/normalized model list.
- Save the normalized config plus the added model, so hidden provider-incompatible entries do not keep blocking future edits.
- Apply the same approach to org and workspace actions.

Suggested test:

- In `tests/model-settings-action.test.ts`, add an OpenAI BYOK action test where stored config has the full 10-model hosted suite, visible display would only contain `gpt-5.5` and `gpt-5.4-mini`, and adding `gpt-5.4` succeeds instead of returning `Picker capacity reached`. Assert the saved config contains the OpenAI-visible models and does not preserve hidden provider-incompatible rows.

## Verified Good

- The settings loader now filters additional rows for direct OpenAI/Anthropic providers.
- The settings loader capacity count is based on visible models.
- GPT-5.5 and Opus 4.7 remain additive, with `opus` still representing Opus 4.6.
- The focused model/default/routing tests pass.

## Verification Run

```bash
bun run test:run -- tests/model-settings-action.test.ts tests/model-catalog.test.ts tests/model-picker-config.test.ts tests/model-logo-and-pricing.test.ts tests/chat-do-model-picker-state.test.ts tests/new-chat-sales-prompt-loader.test.ts workers/main/tests/llm-provider-config.test.ts workers/main/tests/ai-virtual-binding.test.ts
bun run test:workers -- workers/main/tests/llm-provider-config.test.ts workers/main/tests/ai-virtual-binding.test.ts
bun run test:sandbox-host
bun run typecheck
```

All commands above passed. I did not run the full e2e suite.
