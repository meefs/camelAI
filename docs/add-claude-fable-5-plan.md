# Add Claude Fable 5

## Goal

Add Anthropic's Claude Fable 5 (`claude-fable-5`) as a new curated Claude chat model alongside Opus 4.8, Sonnet 4.6, and Haiku 4.5.

User-facing outcome:

- `fable-5` appears as the top Claude entry in the model picker for hosted, Anthropic BYOK, Bedrock BYOK, OpenRouter BYOK, and anthropic-messages custom-provider orgs.
- Fable 5 is additive. It does not replace Opus 4.8. No legacy model remap, no `LEGACY_LLM_MODEL_REPLACEMENTS` changes, no thread migration.
- Defaults do not change: `DEFAULT_LLM_MODEL` stays `sonnet`.

Reference implementation: commit `bc845560` ("Support Claude Opus 4.8 (#681)") is the closest prior model addition — but it shipped with a Bedrock routing bug that was only fixed later in `ead878c2`. Mirror the **current** state of the Opus 4.8 code, not the original commit. See the next section.

## Critical: Bedrock Must Route Through the `global.` Inference Profile

When Opus 4.8 was added, every Bedrock mapping used the US cross-region inference profile (`us.anthropic.claude-opus-4-8`). That pinned all Bedrock inference to US regions and made serve speed noticeably slow. Commit `ead878c2` fixed it by switching every mapping to the global profile (`global.anthropic.claude-opus-4-8`).

For Fable 5, use `global.anthropic.claude-fable-5` from day one. Never emit a `us.`-prefixed id for this model. There are **three independent Bedrock mapping sites**, and all three must agree:

1. `workers/main/src/pi-bedrock-provider.ts` — `BEDROCK_CLAUDE_MODEL_METADATA` and `mapToBedrockModelId()` (used by the Pi chat path for Bedrock BYOK).
2. `workers/bedrock-provider/src/index.ts` — `bedrockModels`, `bedrockModelMap`, and `mapToBedrockModel()` (the AI Gateway custom provider worker).
3. `workers/main/src/chat-thread-do.ts` — `bedrockClaudeModel()` (resolves the request model id for Bedrock BYOK turns).

Two traps in the existing code:

- **The `-v1:0` fallback.** Both `mapToBedrockModelId()` (pi-bedrock-provider) and `mapToBedrockModel()` (bedrock-provider worker) end with a generic fallback that returns `` `global.anthropic.${modelId}-v1:0` ``. Opus 4.8 and Sonnet 4.6 needed explicit branches because their Bedrock ids have **no** `-v1:0` suffix. Fable 5 needs the same explicit branch in both functions; do not rely on the fallback.
- **`bedrockClaudeModel()` silently falls back to Sonnet.** Its `default:` branch returns `global.anthropic.claude-sonnet-4-6`. Without an explicit `case "claude-fable-5":`, a Bedrock BYOK Fable thread would silently run Sonnet.

Add regression tests (see Test Plan) asserting the resolved Bedrock id for Fable is exactly `global.anthropic.claude-fable-5` in both workers — these tests are the guard against re-introducing the `us.` mistake.

## Verified Model Facts

Verified 2026-06-11 from Anthropic/AWS/OpenRouter announcement and docs pages. Revalidate at implementation time (sources: [Anthropic announcement](https://www.anthropic.com/news/claude-fable-5-mythos-5), [Claude API models overview](https://platform.claude.com/docs/en/about-claude/models/overview), [AWS Bedrock model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-fable-5.html), [OpenRouter model page](https://openrouter.ai/anthropic/claude-fable-5)):

| Field | Value |
|---|---|
| Anthropic API model id | `claude-fable-5` |
| Context window | 1,000,000 tokens |
| Max output tokens | 128,000 |
| Input price | $10 / 1M tokens (`0.00001`/token) |
| Output price | $50 / 1M tokens (`0.00005`/token) |
| Cache write | $12.50 / 1M tokens (`0.0000125`/token) |
| Cache read | $1 / 1M tokens (`0.000001`/token) |
| OpenRouter slug | `anthropic/claude-fable-5` |
| Bedrock | GA day one; **must** be invoked via an inference profile (`us.` / `eu.` / `global.` prefix) — use `global.` |
| Modality | text + image in, text out |

Confirm before merging (do not guess):

1. **Exact global inference profile id.** Expected `global.anthropic.claude-fable-5` (Opus 4.8 / Sonnet 4.6 profiles have no `-v1:0` suffix). Confirm against the Bedrock model card above or `aws bedrock list-inference-profiles --region us-east-1`.
2. **Adaptive thinking support.** Opus 4.8 and Sonnet 4.6 use `thinking: { type: "adaptive" }` + `output_config.effort`, gated by `supportsAdaptiveThinking()` in `workers/main/src/pi-bedrock-provider.ts`, and Opus carries `thinkingLevelMap: { xhigh: "xhigh" }`. Fable 5 is a newer generation and almost certainly supports both — confirm in the [models overview](https://platform.claude.com/docs/en/about-claude/models/overview). If it does, add Fable to `supportsAdaptiveThinking()` and give it the same `thinkingLevelMap`; if not, the existing budget-tokens path applies automatically.
3. **OpenRouter slug + `:nitro` availability**:

```bash
curl -s https://openrouter.ai/api/v1/models \
  | jq -r '.data[] | select(.id == "anthropic/claude-fable-5")
    | {id, context_length, pricing, top_provider, supported_parameters}'
```

## Model Identity

| Surface | Id |
|---|---|
| UI / `LlmModel` union | `fable-5` |
| Pricing key (`LLM_MODEL_TO_PRICING_KEY`) | `claude-fable-5` |
| Anthropic API (direct BYOK + Pi fallback) | `claude-fable-5` |
| OpenRouter (hosted gateway + OpenRouter BYOK) | `anthropic/claude-fable-5` (nitro-wrapped like Opus) |
| Bedrock (BYOK + bedrock-provider worker) | `global.anthropic.claude-fable-5` |

`fable-5` (not bare `fable`) matches the version-qualified direction the catalog moved to with `opus-4.8`, and avoids a future legacy-remap when Fable 6 ships.

Recommended `MODEL_CATALOG` entry:

| Field | Value | Reason |
|---|---|---|
| `id` | `fable-5` | Version-qualified UI id. |
| `label` | `Fable 5` | Matches Anthropic naming. |
| `providerLogo` | `claude` | Existing logo. |
| `providerOrder` | `0` | Claude group. |
| `modelOrder` | `0` | Top of the Claude group; bump opus→1, sonnet→2, haiku→3. |
| `cost` | `$$$` | $10 input ≥ $5 threshold. |
| `intelligence` | `5` | New top-tier model. Consider lowering Opus 4.8 to `4.5` in the same PR so the ratings still differentiate — product call, flag it in the PR description. |
| `speed` | `2` | Mythos-class model; assume Opus-like or slower until measured. |

`CLAUDE_LLM_MODEL_OPTIONS` (in `src/lib/llm-provider-config.ts`): add `fable-5` first with a description like `"Most capable Claude model"`. Opus 4.8's current description is `"Smartest Claude model"` — reword it (e.g. `"Flagship coding model"`) so the two don't conflict.

## Picker Default Decision (Required Before Implementation)

`MODEL_PICKER_MAX_MODELS = 10` and `HOSTED_OR_OPENROUTER_DEFAULT_MODEL_ORDER` in `src/lib/model-picker-config.ts` already has exactly 10 entries. Adding `fable-5` requires one of:

- **Recommended:** insert `fable-5` first and drop `gemini-3-flash-preview` (its cheap/fast niche is covered by `deepseek-v4-flash`; the model stays fully supported and selectable in org model settings, just not in the default suite).
- Alternative: raise `MODEL_PICKER_MAX_MODELS` to 11 (touches row-truncation behavior and `tests/model-picker-config.test.ts` capacity assertions).

Confirm the choice with the user before implementing. `CLAUDE_DEFAULT_MODEL_ORDER` has no capacity issue — it becomes `["fable-5", "opus-4.8", "sonnet", "haiku"]`.

Given Fable is 2× Opus pricing, the user may instead prefer Fable to be opt-in (not in default orders at all). Default assumption in this plan: it ships in the default suite, top position, like Opus does today.

## Implementation Steps

### 1. Types, catalog, options, picker config

Touch:

- `src/types.ts` — add `"fable-5"` to the `LlmModel` union.
- `src/lib/model-catalog.ts` — add to `ALL_LLM_MODELS`, `LLM_MODEL_TO_PRICING_KEY` (`"fable-5": "claude-fable-5"`), and `MODEL_CATALOG` (metadata table above; bump existing Claude `modelOrder`s).
- `src/lib/llm-provider-config.ts` — add to `CLAUDE_LLM_MODEL_OPTIONS` (first entry). This automatically flows into `isClaudeLlmModel`, `isLlmModel`, `isLlmModelAllowedForOrgProvider` (anthropic/bedrock/custom-anthropic orgs), and `getVisibleLlmModelOptions`. Do **not** touch `LEGACY_LLM_MODEL_REPLACEMENTS`.
- `src/lib/model-picker-config.ts` — `CLAUDE_DEFAULT_MODEL_ORDER` and `HOSTED_OR_OPENROUTER_DEFAULT_MODEL_ORDER` per the decision above.

### 2. Pricing

Touch `src/lib/usage-pricing.ts`. Add exact entries:

```ts
"claude-fable-5": {
  inputPerToken: 0.00001,
  outputPerToken: 0.00005,
  cacheCreationPerToken: 0.0000125,
  cacheReadPerToken: 0.000001,
},
"anthropic/claude-fable-5": {
  inputPerToken: 0.00001,
  outputPerToken: 0.00005,
  cacheCreationPerToken: 0.0000125,
  cacheReadPerToken: 0.000001,
},
```

Opus 4.8 has pricing rows under both its dotted and dashed OpenRouter forms plus the bare API id. Fable's slug only has one form, but verify `lookupPricing` normalization (`:nitro` suffix, `camel/`/`openrouter/` prefixes) resolves the hosted-gateway usage rows for Fable the same way the existing Opus tests prove it does for Opus.

### 3. Pi chat routing — `workers/main/src/chat-thread-do.ts`

Mirror Opus 4.8 exactly at four places:

- `resolvePiModelReference()`: add `case "fable-5": return claudeReference("claude-fable-5");`. Keep it a separate case — do not fold into the opus case group.
- `openRouterClaudeModel()`: add `case "fable-5":` and `case "claude-fable-5":` returning `"anthropic/claude-fable-5"`.
- `bedrockClaudeModel()`: add `case "claude-fable-5": return "global.anthropic.claude-fable-5";` (the `default:` returns Sonnet — see the Bedrock section above).
- `PI_MODEL_CATALOG_FALLBACKS`: add an `"anthropic/claude-fable-5"` entry shaped like the existing `"anthropic/claude-opus-4-8"` one:

```ts
"anthropic/claude-fable-5": {
  id: "claude-fable-5",
  name: "Claude Fable 5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh" }, // if adaptive-thinking confirmation holds
  input: ["text", "image"],
  cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
} satisfies Model<"anthropic-messages">,
```

The fallback entry is **required**, not optional: the bundled `@mariozechner/pi-ai` registry will not contain `claude-fable-5` yet, and without the fallback every Fable init throws `Unsupported anthropic Pi model claude-fable-5` (this exact failure mode hit Gemini 3.5 Flash — see the post-implementation note in `docs/add-gemini-3-5-flash-plan.md`). Delete the entry later once the Pi registry catches up.

### 4. Pi Bedrock provider — `workers/main/src/pi-bedrock-provider.ts`

- `BEDROCK_CLAUDE_MODEL_METADATA`: add a `'global.anthropic.claude-fable-5'` entry (name `'Claude Fable 5 (Global)'`, cost `{ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }`, contextWindow `1_000_000`, maxTokens `128_000`, `thinkingLevelMap: { xhigh: 'xhigh' }` if confirmed).
- `mapToBedrockModelId()`: add a `fable-5` branch returning `'global.anthropic.claude-fable-5'` **before** the generic `-v1:0` fallback.
- `supportsAdaptiveThinking()`: add the fable patterns if adaptive thinking is confirmed.
- `supportsPromptCaching()`: **this currently returns `false` for Fable.** It matches only `-4-`/`-4.`/`-3-7-` id patterns, and `claude-fable-5` matches none of them. Left as-is, prompt caching silently turns off for all Bedrock Fable turns — slow TTFB and ~10× input cost on retries, with no error anywhere. Extend the check (e.g. `id.includes('fable')`) and add a test asserting `buildBedrockInvokeBody` emits `cache_control` blocks for a Fable model id.

### 5. AI Gateway Bedrock worker — `workers/bedrock-provider/src/index.ts`

- `bedrockModels`: add `{ id: 'claude-fable-5', bedrockModelId: 'global.anthropic.claude-fable-5', name: 'Claude Fable 5', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' }, input: ['text', 'image'], cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }, contextWindow: 1_000_000, maxTokens: 128_000 }`.
- `bedrockModelMap`: add explicit aliases `'anthropic/claude-fable-5'` and `'anthropic.claude-fable-5'` → `'global.anthropic.claude-fable-5'`. (No 4.6/4.7-style alias spray needed — Fable has no prior versions.)
- `mapToBedrockModel()`: add a fable branch before the generic `-v1:0` fallback.

This worker serves `/v1/models` dynamically, so the AI Gateway custom provider picks up the new model on deploy with no dashboard change — but it **must be deployed** (`bun run deploy:bedrock-provider:staging` / `:prod`) alongside the main worker.

### 6. Admin surfaces

- `workers/main/src/routes/admin/schemas.ts`: add `"fable-5"` to both model enums (the thread-update schema and `LlmModelSchema`).
- `workers/main/src/routes/admin-mcp.ts`: add `"fable-5"` to the `update-thread` tool's model enum.

### 7. Explicitly out of this change

- `workers/main/src/ai-virtual-binding.ts`: leave the `smart` alias pointing at `claude-opus-4-8` / `global.anthropic.claude-opus-4-8` — moving `smart` to Fable doubles deployed-app inference cost and is a separate product decision. Explicit `claude-fable-5` ids already pass through the anthropic/bedrock BYOK paths unchanged; no code change required.
- `sandbox/skills/developing-software/AI-APPS.md` enumerates virtual-binding models; since the binding doesn't change, it shouldn't either. Verify with `rg -n "opus|claude-" sandbox/skills/` that nothing enumerates the picker model list.
- No changes to `src/lib/chat-do.server.ts`, `src/lib/recent-model.ts`, fork route, or `OrgDO` thread-model normalization in `workers/main/src/auth.ts` — those changed in the Opus 4.8 commit only because of the legacy `opus`→`opus-4.8` rename, which doesn't apply here.

## Test Plan

Bedrock routing regressions (the important ones):

- `workers/main/tests/pi-bedrock-provider.test.ts`
  - `mapToBedrockModelId`-level: a model id containing `fable-5` resolves to exactly `global.anthropic.claude-fable-5` — assert it starts with `global.` and does **not** end with `-v1:0`.
  - The bedrock-provider worker (imported in this file) maps `claude-fable-5`, `anthropic/claude-fable-5`, and `anthropic.claude-fable-5` to `global.anthropic.claude-fable-5`, and the invoke URL path contains the encoded global id.
  - `buildBedrockInvokeBody` for a Fable model includes `cache_control` checkpoints (the `supportsPromptCaching` fix).
  - If adaptive thinking is confirmed: Fable payload uses `thinking: { type: 'adaptive' }` + `output_config.effort`, and `xhigh` maps through.

Catalog/picker/pricing:

- `tests/model-catalog.test.ts` — add `fable-5` to the expected catalog (exact metadata), pricing-key coverage, and ordering assertions (Fable first in Claude group).
- `tests/model-logo-and-pricing.test.ts` — `fable-5` resolves the claude logo and a pricing entry.
- `tests/usage-pricing.test.ts` — exact cost math for `claude-fable-5` and `anthropic/claude-fable-5`, including prefixed/`:nitro` normalized forms, mirroring the Opus assertions.
- `tests/model-picker-config.test.ts` — default Claude order is `fable-5, opus-4.8, sonnet, haiku`; hosted default suite matches the capacity decision and stays ≤ `MODEL_PICKER_MAX_MODELS`.
- `tests/model-picker.test.tsx`, `tests/model-settings-action.test.ts` — fixtures that enumerate models.

Routing/provider gating:

- `workers/main/tests/llm-provider-config.test.ts` — `isLlmModel("fable-5")` true; allowed for `anthropic`/`bedrock`/custom-anthropic orgs; hidden for `openai` orgs.
- `workers/main/tests/chat-thread-codex-external-turn.test.ts` — `fable-5` resolves to the anthropic reference `claude-fable-5` with hosted OpenRouter model `anthropic/claude-fable-5` (nitro), including the stubbed-`getModel` fallback-registry case used for Opus/Gemini.
- `workers/main/tests/admin-api-thread-update.test.ts` — admin can set a thread to `fable-5`.

## Verification Commands

```bash
bun run typecheck
bun run test:run -- \
  tests/model-catalog.test.ts \
  tests/model-logo-and-pricing.test.ts \
  tests/model-picker-config.test.ts \
  tests/model-picker.test.tsx \
  tests/model-settings-action.test.ts \
  tests/usage-pricing.test.ts
bun run test:workers -- \
  workers/main/tests/llm-provider-config.test.ts \
  workers/main/tests/pi-bedrock-provider.test.ts \
  workers/main/tests/chat-thread-codex-external-turn.test.ts \
  workers/main/tests/admin-api-thread-update.test.ts
```

## Manual Smoke Test (Staging)

Deploy `bedrock-provider:staging` and `main:staging`, then:

1. Hosted org: select Fable 5, send a prompt, confirm a completed turn and a usage row priced at $10/$50 rates.
2. Bedrock BYOK org: send a Fable turn; confirm the logged/observed request model id is `global.anthropic.claude-fable-5` (not `us.` and not a Sonnet fallback), and that a second consecutive turn shows nonzero `cacheRead` in usage (caching active).
3. Anthropic BYOK org: send a Fable turn (exercises the `PI_MODEL_CATALOG_FALLBACKS` entry).
4. Confirm Opus 4.8 / Sonnet / Haiku threads still start and the picker ordering looks right.

## Out of Scope

- Changing `DEFAULT_LLM_MODEL`, `BYOK` provider set, or the virtual AI `smart` alias.
- Retiring or remapping Opus 4.8.
- Claude Mythos 5 (the higher tier announced alongside Fable) — separate effort if ever offered.
