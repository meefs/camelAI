# Add Claude Fable 5 — Implementation Review and Follow-Up Work

Review of the working-tree diff implementing `docs/add-claude-fable-5-plan.md`, plus a second round of required changes (cost bucket, cost display, intelligence recalibration) from product feedback.

## Review Verdict: Correct — No Routing Defects Found

The diff matches the plan. All verification commands pass as of this review:

- `bun run typecheck` — clean.
- App suites (`model-catalog`, `model-logo-and-pricing`, `model-picker-config`, `model-picker`, `model-settings-action`, `usage-pricing`): 52/52 pass.
- Worker suites (`llm-provider-config`, `pi-bedrock-provider`, `chat-thread-codex-external-turn`, `admin-api-thread-update`): 186/186 pass.
- Adjacent untouched suites (`recent-model`, `chat-do-model-picker-state`, `chat-fork-route`, `chat-draft-persistence`, `chat-admin-readonly-loader`): 51/51 pass.

Specifically verified against the historical Bedrock routing bug:

- All three Bedrock mapping sites emit `global.anthropic.claude-fable-5` — `bedrockClaudeModel()` in `chat-thread-do.ts` (explicit case, no Sonnet default fallthrough), `mapToBedrockModelId()` + `BEDROCK_CLAUDE_MODEL_METADATA` in `pi-bedrock-provider.ts`, and `bedrockModels`/`bedrockModelMap`/`mapToBedrockModel()` in the bedrock-provider worker. No `us.` prefix anywhere; explicit branches bypass the `-v1:0` generic fallback.
- Regression tests assert the invoke URL contains `/model/global.anthropic.claude-fable-5/invoke` and explicitly assert the absence of `us.anthropic.claude-fable-5` and `claude-fable-5-v1:0`.
- `supportsPromptCaching()` and `supportsAdaptiveThinking()` both match Fable, with payload-level tests for `cache_control` checkpoints and `thinking: adaptive` + `output_config.effort: xhigh`.
- `PI_MODEL_CATALOG_FALLBACKS` entry present; hosted, OpenRouter BYOK, and Bedrock BYOK paths each have a catalog-lag test stubbing `getModel → undefined`.
- Pricing rows and `lookupPricing` normalization covered including `camel/.../:nitro` and `openrouter/...` prefixed forms.
- Picker capacity resolved by dropping `gemini-3-flash-preview` from the hosted default suite (the plan's recommended option); cap stays 10.

Remaining pre-merge items (not code defects):

1. **Staging smoke test still required** before prod deploy — per the plan's Manual Smoke Test section. In particular, confirm AWS accepts the exact profile id `global.anthropic.claude-fable-5` (it was taken from docs, not validated against a live Bedrock account) and that a second consecutive Bedrock turn shows nonzero `cacheRead`.
2. **Deploy order**: `bun run deploy:bedrock-provider:staging` (and later `:prod`) must ship alongside the main worker deploy.

## Follow-Up Round: Cost Bucket, Cost Display, Intelligence Recalibration

Three product changes, all in the model catalog + picker hover card. The hover card lives in `src/components/model-picker.tsx` (`ModelMetadataCard`); catalog metadata lives in `src/lib/model-catalog.ts`. The org model-settings page does not render cost/ratings, so no changes there.

### 1. Rebucket cost onto a 5-tier scale with more granularity at the cheap end

The current 3-tier scale lumps eight models into `$`, hiding real differences (Gemini 3.5 Flash is 3× Gemini 3 Flash Preview; Kimi is ~5× DeepSeek V4 Flash on input). Move to five tiers. Fable is the only `$$$$$` model.

In `src/lib/model-catalog.ts`:

- Extend the type: `export type CostBucket = "$" | "$$" | "$$$" | "$$$$" | "$$$$$";`
- Export `COST_BUCKET_MAX = 5` (or derive it from the longest `CostBucket` literal) so the picker UI and catalog cannot drift.
- Replace the bucket-rule comment above `MODEL_CATALOG` with escalating ceilings (USD per 1M tokens; a model lands in the first tier whose ceilings it satisfies):

```
//   $     = input < $0.50 AND output < $1
//   $$    = input < $1.50 AND output < $6
//   $$$   = input < $4    AND output < $20
//   $$$$  = input < $10   AND output < $50
//   $$$$$ = input >= $10  OR  output >= $50
```

- Reassign every entry per those rules. Derived from the live pricing in `src/lib/usage-pricing.ts`:

| Model | Input/Output per 1M | Old | New |
|---|---|---|---|
| `deepseek-v4-flash` | $0.14 / $0.28 | `$` | `$` |
| `deepseek-v4-pro` | $0.44 / $0.87 | `$` | `$` |
| `custom` | n/a (placeholder) | `$` | `$` |
| `gemini-3-flash-preview` | $0.50 / $3.00 | `$` | `$$` |
| `kimi-k2.6` | $0.74 / $4.66 | `$` | `$$` |
| `gpt-5.4-mini` | $0.75 / $4.50 | `$` | `$$` |
| `haiku` | $1.00 / $5.00 | `$` | `$$` |
| `grok-4.3` | $1.25 / $2.50 | `$` | `$$` |
| `gemini-3.5-flash` | $1.50 / $9.00 | `$` | `$$$` |
| `gpt-5.4` | $2.50 / $15.00 | `$$` | `$$$` |
| `sonnet` | $3.00 / $15.00 | `$$` | `$$$` |
| `opus-4.8` | $5.00 / $25.00 | `$$$` | `$$$$` |
| `gpt-5.5` | $5.00 / $30.00 | `$$$` | `$$$$` |
| `fable-5` | $10.00 / $50.00 | `$$$` | `$$$$$` |

This satisfies the two motivating splits: Gemini 3 Flash Preview (`$$`) vs Gemini 3.5 Flash (`$$$`), and DeepSeek V4 Flash (`$`) vs Kimi (`$$`).

### 2. Render cost with placeholder dollar signs

Today `ModelMetadataCard` renders the raw bucket string (`<MetadataRow label="cost" value={entry.cost} />`), so a `$` model gives the user no sense of scale. Replace that row with a `CostRow` that renders all `COST_BUCKET_MAX` glyphs — filled ones for the bucket value, muted placeholders for the rest — mirroring how `RatingDots` already renders empty circles:

```tsx
function CostRow({ cost }: { cost: CostBucket }) {
  const filled = cost.length;
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-muted-foreground">cost</span>
      <span
        role="img"
        aria-label={`Cost rating: ${filled} out of ${COST_BUCKET_MAX}`}
        className="font-medium"
      >
        {"$".repeat(filled)}
        <span className="text-muted-foreground/40">
          {"$".repeat(COST_BUCKET_MAX - filled)}
        </span>
      </span>
    </div>
  );
}
```

Use letter-spacing/mono styling only if the default rendering looks cramped; match the visual weight of the rating dots row. Placeholder opacity should read as "empty slot", consistent with the empty `RatingDot` fill.

### 3. Recalibrate intelligence ratings

Directives: Fable 5 and GPT-5.5 share the top rating; Opus 4.8 drops below them; everything else shifts down to preserve the existing ordering. Speed ratings are untouched. Apply exactly:

| Model | Intelligence (old → new) |
|---|---|
| `fable-5` | 5 (unchanged) |
| `gpt-5.5` | 5 (unchanged) |
| `opus-4.8` | 5 → 4.5 |
| `gpt-5.4` | 4.5 → 4 |
| `gemini-3.5-flash` | 4.5 → 4 |
| `sonnet` | 4 → 3.5 |
| `deepseek-v4-pro` | 3.5 → 3 |
| `kimi-k2.6` | 3.5 → 3 |
| `grok-4.3` | 3.5 → 3 |
| `custom` | 3 (unchanged — neutral placeholder for arbitrary models) |
| `haiku` | 2.5 → 2 |
| `gpt-5.4-mini` | 2.5 → 2 |
| `gemini-3-flash-preview` | 2.5 → 2 |
| `deepseek-v4-flash` | 2 → 1.5 |

### Tests for this round

- `tests/model-catalog.test.ts` — update the `NEW_OPENROUTER_MODELS`/`NEW_FRONTIER_MODELS` fixtures' `intelligence` and `cost` values per the tables above; `fable-5` expects `$$$$$`; add an assertion that every catalog `cost` length is ≤ `COST_BUCKET_MAX`.
- `tests/model-picker.test.tsx` — hover-card assertion that a `$` model renders 1 filled + 4 placeholder dollar signs (assert via the `Cost rating: 1 out of 5` aria-label) and that `fable-5` renders `Cost rating: 5 out of 5`.
- `tests/model-logo-and-pricing.test.ts` — only if it asserts cost buckets (it currently asserts pricing-key coverage; likely untouched).

### Verification

```bash
bun run typecheck
bun run test:run -- tests/model-catalog.test.ts tests/model-picker.test.tsx tests/model-logo-and-pricing.test.ts
```

No worker-side changes in this round — cost buckets and ratings are picker-only metadata.
