# Context Remaining Indicator — Implementation Feedback

**February 28, 2026** | Review of initial implementation

---

## Bugs

### 1) CRITICAL — Token math produces inflated percentages

**Symptom:** The indicator appeared fully filled (~100%) when the context was far from full. The user could continue sending many messages, proving the context wasn't actually exhausted.

**Root cause:** The SDK's `modelUsage` in the `result` event accumulates `inputTokens`, `cacheReadInputTokens`, and `cacheCreationInputTokens` across **all API calls** within a single `query()` invocation. A single agent turn can involve many API calls (the tool-use loop: initial response → tool call → tool result → next response → ...). Each subsequent API call includes a progressively larger prompt as tool results accumulate.

The current formula sums all of these:

```
totalInput = inputTokens + cacheReadInputTokens + cacheCreationInputTokens
pct = totalInput / contextWindow * 100
```

But `inputTokens` here is the **cumulative** non-cached input across all API calls in the turn, not the last call's prompt size. Same for the cache fields. The sum can easily exceed `contextWindow` after a few tool calls, producing a clamped 100%.

**Example:**

```
Agent turn with 4 tool calls (4 API calls):
  Call 1:  20k input +  0k cache_read + 20k cache_create =  40k total prompt
  Call 2:   5k input + 20k cache_read +  5k cache_create =  30k total prompt
  Call 3:   5k input + 25k cache_read +  5k cache_create =  35k total prompt
  Call 4:   5k input + 30k cache_read +  5k cache_create =  40k total prompt

modelUsage accumulates:
  inputTokens           = 20k + 5k + 5k + 5k  = 35k
  cacheReadInputTokens  =  0 + 20k + 25k + 30k = 75k
  cacheCreationInputTokens = 20k + 5k + 5k + 5k = 35k
  Total: 145k

contextWindow = 200k
Computed: 145k / 200k = 73% ← WRONG

Actual context fill (last call): 40k / 200k = 20% ← CORRECT
```

With longer tool-use chains, this easily hits 100%.

**Fix:** Do NOT use `modelUsage` token fields for context fill computation. Instead, capture **per-API-call** usage from `stream_event` messages. The Anthropic API emits a `message_start` event at the beginning of each API call that includes per-call `usage` with `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`. These represent the **actual prompt size** for that specific call.

The approach:

1. In `ChatThreadDO`, intercept `stream_event` messages where `event.type === 'message_start'`.
2. On each `message_start`, extract `event.message.usage` **and** `event.message.model`, and save both to an in-memory ref (overwrite on each new `message_start` — we only care about the **last** one).
3. On the subsequent `result` event, use the **last saved `message_start` usage** for token counts, combined with `contextWindow` from `modelUsage` **matched to the captured model** (which is correct — it's a static property of the model, not accumulated). Fallback to max `contextWindow` across all models if the captured model is missing or not found.

```
┌─────────────────────────────────────────────────────────────────┐
│ SDK Event Sequence for One Agent Turn                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ stream_event { event.type: 'message_start',                     │
│                event.message.model: 'claude-sonnet-...',        │
│                event.message.usage: { input_tokens: 20000,      │
│                  cache_read_input_tokens: 0,                    │
│                  cache_creation_input_tokens: 20000 } }         │
│ ... content_block deltas, tool_use, etc ...                     │
│                                                                 │
│ stream_event { event.type: 'message_start',  ← CALL 2          │
│                event.message.model: 'claude-sonnet-...',        │
│                event.message.usage: { input_tokens: 5000,       │
│                  cache_read_input_tokens: 20000,                │
│                  cache_creation_input_tokens: 5000 } }          │
│ ... content_block deltas, tool_use, etc ...                     │
│                                                                 │
│ stream_event { event.type: 'message_start',  ← CALL 3 (LAST)   │
│                event.message.model: 'claude-sonnet-...',        │
│                event.message.usage: { input_tokens: 5000,       │
│                  cache_read_input_tokens: 25000,                │
│                  cache_creation_input_tokens: 5000 } }          │
│ ... content_block deltas, final text ...                        │
│                                                                 │
│ result { modelUsage: { "claude-sonnet-...": {                   │
│            contextWindow: 200000 } } }                          │
│         Match contextWindow to last message_start model,        │
│         use token counts from that message_start                │
│                                                                 │
│ Correct fill: (5k + 25k + 5k) / 200k = 17.5%                  │
└─────────────────────────────────────────────────────────────────┘
```

Concrete `ChatThreadDO` changes:

```typescript
// New instance variables:
private lastMessageStartUsage: {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  model: string | null;            // ← model from message_start for contextWindow lookup
} | null = null;
private usageIsPostCompaction = true; // tracks whether lastMessageStartUsage is from after the most recent compact_boundary

// In the runner event handler, inside the sdk_event branch:
if (sdkEvent?.type === 'stream_event') {
  const evt = sdkEvent.event as { type?: string; message?: { usage?: unknown; model?: string } } | undefined;
  if (evt?.type === 'message_start' && evt.message?.usage) {
    const u = evt.message.usage as Record<string, unknown>;
    this.lastMessageStartUsage = {
      input_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
      cache_read_input_tokens: typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0,
      cache_creation_input_tokens: typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0,
      model: typeof evt.message.model === 'string' ? evt.message.model : null,
    };
    this.usageIsPostCompaction = true; // this message_start is fresh (post-boundary if one occurred)
  }
}

// On result event, compute from last message_start usage + modelUsage.contextWindow:
// IMPORTANT: only compute if usageIsPostCompaction is true. If a compact_boundary fired
// but no subsequent message_start arrived, the captured usage is stale (pre-compaction)
// and must not be used — leave the persisted value unchanged.
if (sdkEvent?.type === 'result' && this.lastMessageStartUsage && this.usageIsPostCompaction) {
  const contextWindow = extractContextWindowForModel(sdkEvent, this.lastMessageStartUsage.model);
  if (contextWindow > 0) {
    const u = this.lastMessageStartUsage;
    const totalInput = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
    const pct = Math.max(0, Math.min(100, Math.round((totalInput / contextWindow) * 100)));
    this.contextUsedPercent = pct;
    this.ctx.storage.kv.put(CHAT_CONTEXT_USED_PERCENT_KEY, pct);
    this.broadcastChat({ type: 'context_usage_state', usedPercent: pct });
  }
  this.lastMessageStartUsage = null; // reset for next turn
  this.usageIsPostCompaction = true;  // reset flag
}
```

The `computeContextUsedPercentFromResult` helper should be replaced entirely with this two-phase approach (capture last `message_start`, compute on `result`).

**Model-to-contextWindow matching:** The `message_start` event includes `event.message.model` identifying which model produced that API call. In multi-model turns, different models may have different context windows. The `contextWindow` lookup on `result` must prefer the entry matching the last `message_start`'s model, falling back to the max `contextWindow` across all entries if the model is missing or unmatched.

```typescript
// Helper: extract contextWindow matching the model from the last message_start.
function extractContextWindowForModel(
  sdkEvent: { modelUsage?: unknown },
  model: string | null
): number {
  if (!sdkEvent.modelUsage || typeof sdkEvent.modelUsage !== 'object') return 0;
  const entries = sdkEvent.modelUsage as Record<string, Record<string, unknown>>;

  // Prefer exact model match
  if (model && entries[model]) {
    const cw = entries[model].contextWindow;
    if (typeof cw === 'number' && cw > 0) return cw;
  }

  // Fallback: max contextWindow across all models
  let max = 0;
  for (const usage of Object.values(entries)) {
    if (usage && typeof usage === 'object') {
      const cw = (usage as Record<string, unknown>).contextWindow;
      if (typeof cw === 'number' && cw > max) max = cw;
    }
  }
  return max;
}
```

---

### 2) HIGH — Indicator doesn't update after auto-compaction

**Symptom:** After auto-compaction triggered mid-conversation, the indicator remained at 100% and didn't decrease. Even after page refresh, it still showed full.

**Root cause:** Two issues compound here:

1. **Same-turn compaction:** When auto-compaction fires, it happens mid-`query()`. The `result` event arrives when the entire turn finishes (after compaction AND the subsequent response). The accumulated `modelUsage` includes tokens from both before and after compaction, so the percentage stays high.

2. **Persisted stale value:** The inflated percentage is persisted in `ctx.storage.kv` and replayed on init. Since the `result` event after compaction still has inflated numbers (Bug 1), the persisted value never corrects itself.

**Fix:** Both issues are resolved by Bug 1's fix (using per-call `message_start` usage). After compaction, the next `message_start` will reflect the compacted context (much smaller prompt), and the percentage will drop on the subsequent `result`.

On compaction boundary events, mark the current captured usage as stale rather than nulling it out. This is important: if `compact_boundary` fires but no subsequent `message_start` arrives before `result` (edge case), nulling would cause us to skip recompute entirely and leave the stale persisted value unchanged — the same symptom. The flag-based approach ensures we only compute from post-compaction data:

```typescript
// Also in the sdk_event handler:
if (sdkEvent?.type === 'system' && sdkEvent.subtype === 'compact_boundary') {
  this.usageIsPostCompaction = false; // mark current usage as pre-compaction (stale)
  // Do NOT null out lastMessageStartUsage — the next message_start will overwrite it
  // and set usageIsPostCompaction = true. If no message_start arrives, the result handler
  // will see usageIsPostCompaction = false and skip recompute (safe: keeps last known value).
}
```

**Normal flow (with compaction):**
```
message_start(pre) → compact_boundary → message_start(post) → result
  ↑ captured, fresh    ↑ marks stale     ↑ overwrites, fresh   ↑ computes from post-compaction ✓
```

**Edge case (boundary but no new message_start):**
```
message_start(pre) → compact_boundary → result
  ↑ captured, fresh    ↑ marks stale     ↑ sees stale flag, skips recompute,
                                            keeps last persisted value (safe fallback)
```

---

## Design Changes

### 3) Move indicator to left side — before the microphone button

**Current position (wrong):**

```
┌────────────────────────────────────────────────┐
│  Type a message...                             │
│                                                │
│  [+] [🎤]                          (◔) [  ↑  ]│
│  └─ left ─┘                        └─ right ──┘│
└────────────────────────────────────────────────┘
```

**Desired position:**

```
┌─────────────────────────────────────────────────┐
│  Type a message...                              │
│                                                 │
│  [+] [🎤]  (◔) 57% used                 [  ↑  ]│
│  └──────── left group ───┘               right ─┘│
└─────────────────────────────────────────────────┘
```

The indicator should be in the left button group, to the right of the microphone button. This groups it with the other tool buttons rather than crowding the send button.

**File:** `src/components/prompt-input.tsx`

Move the `ContextIndicator` render from the right-side `div` (lines 341-345) into the left-side button group (line 291), after the Microphone button (ends ~line 338).

---

### 4) Show percentage text inline next to the circle

The indicator should display the percentage as text, not only as a pie chart. The text should read `XX% used` and appear next to the circle icon.

**Target appearance (matching the screenshot):**

```
(◔) 57% used
```

This is a small inline label — the pie icon followed by muted text showing the exact percentage. The tooltip can remain for the "Click to compact" call to action, but the percentage itself should be always-visible text, not tooltip-only.

**Suggested component structure:**

```tsx
<button onClick={onCompact} className="flex items-center gap-1.5 ...">
  <svg ...>{/* pie wedge */}</svg>
  <span className="text-xs text-muted-foreground">{pct}% used</span>
</button>
```

---

### 5) Remove color transitions — single muted color for all percentages

The current implementation uses three colors: `text-muted-foreground` (0-59%), `text-amber-500` (60-79%), `text-destructive` (80-100%). The user wants the indicator to match the visual weight of the other icons (Plus, Mic), which are all `text-muted-foreground`.

**Change:** Remove the amber and red color thresholds. Use `text-muted-foreground` for the pie fill and percentage text at all levels. The filling of the pie itself already communicates urgency — color coding is unnecessary and inconsistent with the rest of the toolbar.

```tsx
// REMOVE:
const fillColor =
  pct >= 80 ? 'text-destructive'
  : pct >= 60 ? 'text-amber-500'
  : 'text-muted-foreground';

// REPLACE WITH:
const fillColor = 'text-muted-foreground';
```

Also ensure the background circle track uses a lighter shade so the fill is still distinguishable (the current `stroke-muted-foreground/30` is fine for this).

---

## Summary of Required Changes

| # | Severity | Area | Change |
|---|----------|------|--------|
| 1 | CRITICAL | `durable-objects.ts` | Replace `computeContextUsedPercentFromResult` with two-phase approach: capture last `message_start` usage + model from stream events, compute on `result` using `extractContextWindowForModel` matched to captured model |
| 2 | HIGH | `durable-objects.ts` | Flag-based compaction boundary handling: set `usageIsPostCompaction = false` on `compact_boundary` (do NOT null usage); only compute on `result` when flag is true |
| 3 | MEDIUM | `prompt-input.tsx` | Move indicator from right side (next to send) to left side (after Mic button) |
| 4 | MEDIUM | `context-indicator.tsx` | Add inline `XX% used` text label next to the pie circle |
| 5 | LOW | `context-indicator.tsx` | Remove amber/red color thresholds, use `text-muted-foreground` everywhere |

---

## Verification After Fixes

1. **Accuracy at low fill:** Send a simple message (no tool use). Indicator should show a low percentage (single digits to teens), not 50%+.
2. **Progressive fill:** Continue conversation. Percentage should grow gradually, roughly proportional to conversation length.
3. **Post-compaction drop:** Trigger `/compact`. After compaction and the next exchange, the percentage should drop dramatically.
4. **Auto-compaction recovery:** Let auto-compaction trigger naturally. After the turn completes and a new exchange happens, the percentage should reflect the compacted (smaller) context.
5. **Refresh persistence:** Refresh the page. The indicator should show the last known correct percentage immediately.
6. **Visual consistency:** The indicator (circle + text) should match the visual weight and color of the Plus and Mic buttons.
