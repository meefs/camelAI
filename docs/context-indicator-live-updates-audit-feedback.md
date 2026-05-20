# Context Indicator Live Updates Plan - Audit Feedback

**Date:** March 1, 2026  
**Target plan:** [docs/context-indicator-live-updates.md](/Users/illiana/Projects/chiridion-app/docs/context-indicator-live-updates.md)

## Summary

The plan is directionally good and the core architecture (DO-side compute + broadcast) is still correct.  
Before implementation, two issues should be fixed to avoid stale or wrong percentages in production:

1. Intermediate `message_start` updates must not overwrite canonical persisted state.
2. `contextWindow` caching should be model-aware, not a single shared number.

## Vital Issues and Required Fixes

## 1) P0 - Intermediate updates can poison canonical replay state

### Issue

In Step 3, the plan sets:

```ts
this.contextUsedPercent = pct;
```

while also claiming intermediate updates are ephemeral and that refresh should replay only the last persisted result value.

This conflicts with the stated behavior in Verification #4:
- [docs/context-indicator-live-updates.md:266](/Users/illiana/Projects/chiridion-app/docs/context-indicator-live-updates.md:266)

and creates a stale-state risk around compaction ordering (`compact_boundary` without a later `message_start` before `result`).

### Required plan change

Keep **canonical** `contextUsedPercent` as result-derived only.  
Do not assign canonical state during intermediate broadcasts.

### Concrete implementation shape

```ts
// Canonical persisted/replayed value (result-only):
private contextUsedPercent: number | null = null;

// Optional ephemeral value for mid-turn reconnects (not persisted):
private transientContextUsedPercent: number | null = null;

// On message_start live update:
const livePct = computeFromMessageStart(...);
this.transientContextUsedPercent = livePct;
this.broadcastChat({ type: 'context_usage_state', usedPercent: livePct });

// On result final update:
const finalPct = computeFinalFromLastMessageStart(...);
this.contextUsedPercent = finalPct;
this.transientContextUsedPercent = null;
this.ctx.storage.kv.put(CHAT_CONTEXT_USED_PERCENT_KEY, finalPct);
this.broadcastChat({ type: 'context_usage_state', usedPercent: finalPct });
```

If you do not need mid-turn reconnect replay, skip `transientContextUsedPercent` entirely.

## 2) P1 - Single cached contextWindow is fragile with model changes

### Issue

The plan caches one `cachedContextWindow` for all models:
- [docs/context-indicator-live-updates.md:105](/Users/illiana/Projects/chiridion-app/docs/context-indicator-live-updates.md:105)

It already acknowledges one-turn inaccuracy after model switches:
- [docs/context-indicator-live-updates.md:231](/Users/illiana/Projects/chiridion-app/docs/context-indicator-live-updates.md:231)

This is avoidable with low complexity.

### Required plan change

Cache context windows **per model** (map/object), keyed by model string from `message_start.message.model`.

### Concrete implementation shape

```ts
type ContextWindowByModel = Record<string, number>;

const CHAT_CONTEXT_WINDOW_BY_MODEL_KEY = 'chatContextWindowByModel';
private cachedContextWindowByModel: ContextWindowByModel = {};

// On constructor hydrate:
const stored = ctx.storage.kv.get<ContextWindowByModel>(CHAT_CONTEXT_WINDOW_BY_MODEL_KEY);
if (stored && typeof stored === 'object') {
  for (const [model, cw] of Object.entries(stored)) {
    if (typeof cw === 'number' && Number.isFinite(cw) && cw > 0) {
      this.cachedContextWindowByModel[model] = cw;
    }
  }
}

// On message_start live update:
const model = this.lastMessageStartUsage.model;
const cw = model ? this.cachedContextWindowByModel[model] : undefined;
if (cw && cw > 0) {
  broadcastLivePct(cw);
}

// On result:
// update map from sdkEvent.modelUsage entries that include contextWindow
// persist map only if changed
```

## 3) P1 - Missing explicit automated tests for sequencing regressions

### Issue

Plan includes manual verification but no required automated tests:
- [docs/context-indicator-live-updates.md:261](/Users/illiana/Projects/chiridion-app/docs/context-indicator-live-updates.md:261)

Given prior failures in event sequencing/compaction behavior, this is risky.

### Required plan change

Add worker tests that assert broadcast and persistence semantics.

### Minimum test matrix

1. Multi-call turn (`message_start` xN, one `result`) emits live `context_usage_state` after each `message_start`.
2. Mid-turn refresh/reconnect replays canonical persisted value (not transient mid-turn value), unless an explicit transient replay strategy is chosen.
3. `compact_boundary` then `result` without new `message_start` does not persist stale intermediate value.
4. `message_start(pre)` -> `compact_boundary` -> `message_start(post)` -> `result` computes and persists from post-compaction usage.
5. Model switch turn uses model-matched cached context window (or safely skips live update when unknown model).

## 4) P2 - Wording bug in desired behavior can mislead implementation

### Issue

The plan says final `result` moves percent because "output tokens added":
- [docs/context-indicator-live-updates.md:44](/Users/illiana/Projects/chiridion-app/docs/context-indicator-live-updates.md:44)

This feature's math is based on prompt/input+cache usage, not output tokens.

### Required plan change

Reword that line to:

`Indicator: 19% -> 20% (final result-derived prompt usage persisted)`

## Plan Patch Checklist (for the implementation agent)

1. In Step 3, remove canonical assignment on intermediate updates (`this.contextUsedPercent = pct`).
2. Keep intermediate updates broadcast-only, or isolate them to a separate non-persisted transient field.
3. Replace single `cachedContextWindow` with model-keyed cache (`cachedContextWindowByModel` + KV key).
4. Update result handling to refresh/persist model->contextWindow cache from `modelUsage`.
5. Add explicit worker tests for event-order and compaction edge cases.
6. Fix wording in Desired behavior line about "output tokens added."

## Acceptance Criteria Addendum

- Canonical replay value remains result-derived and persisted only at `result`.
- Intermediate live updates never corrupt persisted state.
- Live update uses context window matched to the `message_start` model (or safely skips when unavailable).
- Compaction ordering edge cases do not leave stale full values after refresh.
