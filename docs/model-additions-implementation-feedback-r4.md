# Model Additions Implementation Feedback R4

Review date: 2026-05-07

No actionable findings.

The round 3 issue appears fixed. The settings action now normalizes `target.config` through `normalizeConfigForVisibleModels` before add/remove/default mutations, so hidden provider-incompatible rows no longer block adding visible models after a provider switch. The added test covers the OpenAI BYOK case where a previously full hosted picker can still add `gpt-5.4` after hidden rows are dropped.

## Verified

- Settings loader filters displayed picker rows, additional rows, and capacity to provider-visible models.
- Settings add/remove/default actions mutate the provider-visible normalized config instead of the raw mixed-provider stored config.
- GPT-5.5 and Opus 4.7 remain additive, with `opus` still representing Opus 4.6.
- The 10-model hosted/OpenRouter default suite is preserved.
- Provider grouping and intelligence metadata remain covered by tests.

## Verification Run

```bash
bun run test:run -- tests/model-settings-action.test.ts tests/model-catalog.test.ts tests/model-picker-config.test.ts tests/model-logo-and-pricing.test.ts tests/chat-do-model-picker-state.test.ts tests/new-chat-sales-prompt-loader.test.ts workers/main/tests/llm-provider-config.test.ts workers/main/tests/ai-virtual-binding.test.ts
bun run test:workers -- workers/main/tests/llm-provider-config.test.ts workers/main/tests/ai-virtual-binding.test.ts
bun run test:sandbox-host
bun run typecheck
```

All commands above passed. I did not run the full e2e suite.
