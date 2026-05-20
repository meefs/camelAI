# Context Remaining Indicator

**February 28, 2026** | Files: `durable-objects.ts`, `Chat.tsx`, `prompt-input.tsx`, `context-indicator.tsx` (new)

---

## Problem

Long conversations eventually fill the context window, triggering an automatic compaction (summarize-and-continue). Today, users have **no visibility** into how close they are to this limit. Compaction can feel jarring — it appears to hang, and afterward the agent may lose some nuance from earlier in the conversation. Giving users a real-time gauge lets them proactively compact on their own terms.

### Current state

```
┌──────────────────────────────────────────────────┐
│  User: Can you refactor this module...           │
│                                                  │
│  Agent: Sure! I'll restructure the...            │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │  Type a message...                       │    │
│  │                                 [  ↑  ]  │    │
│  └──────────────────────────────────────────┘    │
│           no context info anywhere ^             │
└──────────────────────────────────────────────────┘
```

### Desired state

```
┌──────────────────────────────────────────────────┐
│  User: Can you refactor this module...           │
│                                                  │
│  Agent: Sure! I'll restructure the...            │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │  Type a message...                       │    │
│  │                              (◔) [  ↑  ] │    │
│  └──────────────────────────────────────────┘    │
│                                 ^                │
│                          context gauge           │
│                       (pie-fill circle)          │
└──────────────────────────────────────────────────┘

On hover / tooltip:
┌──────────────────────┐
│  62% context used    │
│  Click to compact    │
└──────────────────────┘
```

The indicator is a small SVG circle (pie-wedge style) that fills clockwise to represent context consumption. It sits immediately to the left of the send button. On hover, a tooltip shows the exact percentage and invites the user to click. Clicking sends `/compact` through the existing `sendMessage` pipeline — preserving any unsent draft text in the composer.

---

## Background: Token Usage Data Flow

The Claude Agent SDK already provides all the data we need. Here's how it flows today, and how this feature changes it:

```
Claude SDK query()
  │  yields SDKResultSuccess { usage, modelUsage, ... }
  ▼
control-plane.mjs  →  broadcast({ type: 'sdk_event', event })
  │  (already broadcasts ALL events, including result)
  ▼
ChatThreadDO  →  receives sdk_event
  │  ✅ NEW: extract modelUsage from result, compute %, persist, broadcast context_usage_state
  ▼
Browser WebSocket
  ▼
Chat.tsx  →  receives context_usage_state { usedPercent }
  │  ✅ NEW: store in state, pass to PromptInput
  ▼
PromptInput  →  renders ContextIndicator
```

### What the SDK provides in every `result` event

From the SDK type definitions (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`):

```typescript
type SDKResultSuccess = {
  type: 'result';
  subtype: 'success';
  usage: NonNullableUsage;
  modelUsage: Record<string, ModelUsage>;
  // ... other fields
};

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;      // ← the limit
  maxOutputTokens: number;
  costUSD: number;
  webSearchRequests: number;
};
```

### How to compute context fill percentage

From the SDK's own internal logic:

```typescript
// For each model in modelUsage:
const totalInput = usage.inputTokens
  + usage.cacheReadInputTokens
  + usage.cacheCreationInputTokens;

const usedPct = Math.round((totalInput / usage.contextWindow) * 100);
```

This gives the per-turn context fill level — how close the **last API call's prompt** was to the limit. After compaction, this number drops dramatically. We use the **max** across all models in `modelUsage` (typically only one model is active).

### What already works

- **Control plane** (`sandbox/control-plane.mjs:1022`): Broadcasts all SDK events including `result` with full `modelUsage`
- **ChatThreadDO**: Proxies events to browser clients
- **Manual `/compact`**: Already supported via `sendMessage()` in Chat.tsx
- **`ctx.storage.kv` persistence + init replay**: Used by `todoState` and MCP prompts — same pattern reused here

### What's missing

- `ChatThreadDO` does not extract `modelUsage` from `result` events
- No state tracks context usage percentage (server-side or client-side)
- PromptInput has no awareness of context data
- No visual indicator exists

---

## Design Decisions

### 1. Pie-wedge filled circle (not a ring or bar)

A small SVG circle with a clockwise wedge fill communicates fullness at a glance without taking meaningful space. Uses a `<path>` wedge (`fill="currentColor"`) — a true pie slice, not a stroke-dash arc ring. At 16px rendered size, it fits naturally beside the 28px send button.

### 2. Position: left of send button

```
Bottom addon bar layout:
┌────────────────────────────────────────────────┐
│  [+] [🎤]                          (◔) [  ↑  ]│
│  └─ left ─┘                        └─ right ──┘│
└────────────────────────────────────────────────┘
```

The indicator goes in a right-aligned group with the send button. This keeps it visible but unobtrusive — the user's eye naturally rests near the send button.

### 3. Color thresholds

| Range      | Color                     | Meaning              |
|------------|---------------------------|----------------------|
| 0-59%      | `text-muted-foreground`   | Plenty of room       |
| 60-79%     | `text-amber-500`          | Getting full         |
| 80-100%    | `text-destructive`        | Compact soon         |

The circle border stays `stroke-muted-foreground/30` (light gray) so the fill color pops.

### 4. `ChatThreadDO` is the single source of truth

The DO computes the percentage from `modelUsage`, persists it in `ctx.storage.kv`, replays it on init, and broadcasts updates. The client is presentation-only — it never parses raw `modelUsage`. This gives us:
- **Cross-device consistency**: different browsers/tabs for the same thread see the same value
- **Reload survival**: reopen a thread and the indicator appears immediately without waiting for a new exchange
- **Type safety**: runtime guards live in worker code; client receives a clean `{ type: 'context_usage_state', usedPercent: number }`

### 5. Click triggers `/compact` via `sendMessage` with content override

Clicking the indicator calls `sendMessage({ contentOverride: '/compact', preserveDraft: true })`. This:
- Reuses the full `sendMessage` pipeline (optimistic message, WS send/queue, reconnect, compaction queue)
- Does **not** write `/compact` into the input field
- Preserves the user's unsent draft text and attachments

### 6. Show only after first valid computation

The indicator is hidden until `ChatThreadDO` has computed and sent at least one `context_usage_state`. On fresh threads with no exchanges, no indicator is shown.

---

## Implementation

### Step 0: Preflight Validation

Before implementation is complete, validate the token math:

1. In a long thread, log/inspect `result.modelUsage` values.
2. Confirm percentage rises with larger history and drops after `/compact`.
3. Confirm percentage is bounded 0-100.
4. Confirm DO-persisted value matches live result-derived value.
5. Confirm client receives the DO-broadcast `context_usage_state` and never needs raw `modelUsage`.

If `modelUsage` is absent or malformed on any turn: keep indicator hidden for that turn, do not throw.

---

### Step 1: Create the `ContextIndicator` component

**New file:** `src/components/context-indicator.tsx`

A self-contained SVG pie-wedge circle with tooltip.

```tsx
'use client';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface ContextIndicatorProps {
  /** Context used percentage (0-100) */
  usedPercent: number;
  /** Callback when indicator is clicked (triggers compaction) */
  onCompact: () => void;
  className?: string;
}

/**
 * Build an SVG path string for a pie-wedge starting at 12 o'clock,
 * sweeping clockwise by `pct` percent of the full circle.
 */
function describeWedgePath(pct: number, cx = 10, cy = 10, r = 8): string {
  if (pct <= 0) return '';
  if (pct >= 100) {
    // Full circle — two arcs (a single arc can't draw a complete circle)
    return [
      `M ${cx} ${cy}`,
      `m -${r},0`,
      `a ${r},${r} 0 1,0 ${2 * r},0`,
      `a ${r},${r} 0 1,0 -${2 * r},0`,
    ].join(' ');
  }
  const angle = (pct / 100) * 360 - 90; // -90 to start at 12 o'clock
  const radians = (angle * Math.PI) / 180;
  const x = cx + r * Math.cos(radians);
  const y = cy + r * Math.sin(radians);
  const largeArc = pct > 50 ? 1 : 0;
  return `M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${largeArc} 1 ${x} ${y} Z`;
}

export function ContextIndicator({ usedPercent, onCompact, className }: ContextIndicatorProps) {
  // Clamp to 0-100
  const pct = Math.min(100, Math.max(0, usedPercent));

  // Color thresholds
  const fillColor =
    pct >= 80 ? 'text-destructive'
    : pct >= 60 ? 'text-amber-500'
    : 'text-muted-foreground';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onCompact}
          className={cn(
            'flex items-center justify-center rounded-full',
            'size-7 hover:bg-muted transition-colors',
            className
          )}
          aria-label={`${pct}% context used. Click to compact.`}
        >
          <svg
            viewBox="0 0 20 20"
            className="size-4"
            aria-hidden="true"
          >
            {/* Background circle (track) */}
            <circle
              cx={10}
              cy={10}
              r={8}
              fill="none"
              className="stroke-muted-foreground/30"
              strokeWidth={1.5}
            />
            {/* Filled wedge (pie slice) */}
            {pct > 0 && (
              <path
                d={describeWedgePath(pct)}
                className={cn('fill-current', fillColor)}
                style={{ transition: 'd 0.4s ease' }}
              />
            )}
          </svg>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="font-medium">{pct}% context used</p>
        <p className="text-xs text-muted-foreground">Click to compact</p>
      </TooltipContent>
    </Tooltip>
  );
}
```

The SVG uses a `<path>` with a wedge: a line from center to top, an arc sweeping clockwise, and a line back to center. This produces the true pie-slice fill requested.

---

### Step 2: Add context usage computation and persistence to `ChatThreadDO`

**File:** `workers/main/src/durable-objects.ts`

This step makes `ChatThreadDO` the single source of truth for context usage.

**2a.** Add the storage key constant (around line 210-213, alongside other `CHAT_*` keys):

```typescript
const CHAT_CONTEXT_USED_PERCENT_KEY = 'chatContextUsedPercent';
```

**2b.** Add the compute helper function (above the `ChatThreadDO` class or as a module-level function):

```typescript
/**
 * Extract context-used percentage from a SDK result event's modelUsage.
 * Returns null if modelUsage is absent or malformed (never throws).
 */
function computeContextUsedPercentFromResult(
  sdkEvent: { type?: string; modelUsage?: unknown }
): number | null {
  if (sdkEvent.type !== 'result') return null;
  if (!sdkEvent.modelUsage || typeof sdkEvent.modelUsage !== 'object') return null;

  let maxPct: number | null = null;
  for (const usage of Object.values(sdkEvent.modelUsage as Record<string, unknown>)) {
    if (!usage || typeof usage !== 'object') continue;
    const u = usage as Record<string, unknown>;
    const inputTokens = typeof u.inputTokens === 'number' ? u.inputTokens : 0;
    const cacheRead = typeof u.cacheReadInputTokens === 'number' ? u.cacheReadInputTokens : 0;
    const cacheCreate = typeof u.cacheCreationInputTokens === 'number' ? u.cacheCreationInputTokens : 0;
    const contextWindow = typeof u.contextWindow === 'number' ? u.contextWindow : 0;
    if (contextWindow <= 0) continue;
    const totalInput = inputTokens + cacheRead + cacheCreate;
    const pct = Math.max(0, Math.min(100, Math.round((totalInput / contextWindow) * 100)));
    maxPct = maxPct === null ? pct : Math.max(maxPct, pct);
  }
  return maxPct;
}
```

**2c.** Add instance property to `ChatThreadDO` (alongside other state like `currentTodos`):

```typescript
private contextUsedPercent: number | null = null;
```

**2d.** Hydrate from storage in the constructor's `blockConcurrencyWhile` block (around line 410-413, after `currentTodos` hydration):

```typescript
const storedPct = ctx.storage.kv.get<number>(CHAT_CONTEXT_USED_PERCENT_KEY);
if (typeof storedPct === 'number' && Number.isFinite(storedPct)) {
  this.contextUsedPercent = Math.max(0, Math.min(100, Math.round(storedPct)));
}
```

**2e.** Compute, persist, and broadcast on `result` events. In the runner event handler (around line 1780), inside the `if (sdkEvent?.type === 'result')` block, after the existing `this.persistRunnerSeqIfNeeded('result')` call:

```typescript
// Update persisted context usage from result event
const pct = computeContextUsedPercentFromResult(sdkEvent);
if (pct !== null) {
  this.contextUsedPercent = pct;
  this.ctx.storage.kv.put(CHAT_CONTEXT_USED_PERCENT_KEY, pct);
  this.broadcastChat({ type: 'context_usage_state', usedPercent: pct });
}
// IMPORTANT: do NOT clear/overwrite when result has no modelUsage
// (e.g. synthetic runner_disconnected result events).
```

**2f.** Replay persisted value on client init. In `handleChatInit` (around line 944-946, after `todo_state` replay):

```typescript
if (this.contextUsedPercent !== null) {
  this.sendDirect(ws, { type: 'context_usage_state', usedPercent: this.contextUsedPercent });
}
```

---

### Step 3: Add context usage state to Chat.tsx

**File:** `src/components/Chat.tsx`

**3a.** Add state (around line 814, near compaction ref declarations):

```typescript
const [contextUsedPercent, setContextUsedPercent] = useState<number | null>(null);
```

**3b.** Handle the new `context_usage_state` message type in the WebSocket `onmessage` handler. Add a new branch in the top-level `data.type` switch (around where `todo_state` is handled):

```typescript
if (data.type === 'context_usage_state') {
  const used = typeof data.usedPercent === 'number' ? data.usedPercent : null;
  setContextUsedPercent(
    used !== null ? Math.max(0, Math.min(100, Math.round(used))) : null
  );
}
```

**3c.** Reset on thread change. In the thread-change effect (wherever `threadId` changes cause a state reset):

```typescript
setContextUsedPercent(null);
```

---

### Step 4: Refactor `sendMessage` to accept a content override

**File:** `src/components/Chat.tsx`

The current `sendMessage` (around line 3205-3295) takes no arguments. Refactor it to accept an optional `SendOptions` parameter so the context indicator can send `/compact` without clobbering the user's draft.

**4a.** Define the options type (above `sendMessage` or in the component body):

```typescript
type SendOptions = {
  /** Override the message content instead of using the input field */
  contentOverride?: string;
  /** When true, do not clear the input field (used for indicator compact) */
  preserveDraft?: boolean;
  /** When true, do not append attachment refs (used for indicator compact) */
  skipAttachmentRefs?: boolean;
};
```

**4b.** Modify `sendMessage` to accept the options. The key changes are:

```typescript
function sendMessage(opts?: SendOptions) {
  if (readOnly) return;

  const raw = (opts?.contentOverride ?? input).trim();

  if (
    isLoadingMessages ||
    !raw ||
    !shouldShowChat ||
    !resolvedWorkspaceId ||
    !threadId
  ) {
    return;
  }

  // ... existing: wasSentDuringStreaming, hasHadUserInteraction ...

  // Only clear input when NOT using a content override
  if (!opts?.preserveDraft) {
    setInput('');
  }

  // Build final content — skip attachment refs for overridden content
  let finalContent = raw;
  if (!opts?.skipAttachmentRefs) {
    const completedAttachments = attachments.filter(a => a.status === 'complete');
    if (completedAttachments.length > 0) {
      const fileRefs = completedAttachments
        .map(a => `(user uploaded file to ${a.path})`)
        .join('\n');
      finalContent = `${raw}\n\n${fileRefs}`;
    }
  }

  const shouldShowCompactingIndicator = isManualCompactCommand(finalContent);
  if (shouldShowCompactingIndicator) {
    queueManualCompaction();
  }

  // Only clear attachments when NOT using a content override
  if (!opts?.skipAttachmentRefs) {
    setAttachments(prev => {
      for (const a of prev) {
        revokeAttachmentPreviewUrl(a.previewUrl);
      }
      return [];
    });
  }

  // ... rest of existing sendMessage logic unchanged:
  // setError(null), optimistic userMsg, WS send or queue, etc.
}
```

The goal is minimal disruption: `sendMessage()` with no args behaves identically to today. Only `sendMessage({ contentOverride, preserveDraft, skipAttachmentRefs })` enables the new path.

**4c.** Add the indicator callback:

```typescript
const handleCompactFromIndicator = useCallback(() => {
  if (loading || isStreaming || isCompacting || readOnly) return;
  sendMessage({
    contentOverride: '/compact',
    preserveDraft: true,
    skipAttachmentRefs: true,
  });
}, [loading, isStreaming, isCompacting, readOnly, sendMessage]);
```

---

### Step 5: Pass new props to PromptInput

**File:** `src/components/Chat.tsx`

In the JSX where `<PromptInput>` is rendered (around line 3540-3552):

```tsx
// FIND:
<PromptInput
  value={input}
  onChange={setInput}
  onSubmit={sendMessage}
  onStop={stopGeneration}
  placeholder="Type a message..."
  isLoading={isLoadingMessages}
  isAssistantRunning={loading || isStreaming}
  autoFocus
  attachments={attachments}
  onFilesSelected={handleFilesSelected}
  onAttachmentRemove={handleAttachmentRemove}
/>

// REPLACE WITH:
<PromptInput
  value={input}
  onChange={setInput}
  onSubmit={sendMessage}
  onStop={stopGeneration}
  placeholder="Type a message..."
  isLoading={isLoadingMessages}
  isAssistantRunning={loading || isStreaming}
  autoFocus
  attachments={attachments}
  onFilesSelected={handleFilesSelected}
  onAttachmentRemove={handleAttachmentRemove}
  contextUsedPercent={contextUsedPercent}
  onCompact={handleCompactFromIndicator}
/>
```

---

### Step 6: Update PromptInput to render the indicator

**File:** `src/components/prompt-input.tsx`

**6a.** Add the new props to the interface (around line 17-38):

```typescript
interface PromptInputProps {
  // ... existing props ...
  // Context indicator props
  contextUsedPercent?: number | null;
  onCompact?: () => void;
}
```

**6b.** Destructure the new props (around line 40-58):

```typescript
export function PromptInput({
  // ... existing destructured props ...
  contextUsedPercent,
  onCompact,
}: PromptInputProps) {
```

**6c.** Add the import at the top of the file:

```typescript
import { ContextIndicator } from '@/components/context-indicator';
```

**6d.** Render the indicator to the left of the send button (around line 335-351). Wrap the send button and indicator in a flex container:

```tsx
// FIND:
                {/* Submit/Stop button */}
                <InputGroupButton
                  type={showStopButton ? 'button' : 'submit'}
                  size="icon-sm"
                  variant={showStopButton ? 'destructive' : 'default'}
                  disabled={isSubmitDisabled}
                  onClick={handleButtonClick}
                  className="rounded-full"
                >
                  {isLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : showStopButton ? (
                    <Square className="size-3" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </InputGroupButton>

// REPLACE WITH:
                {/* Context indicator + Submit/Stop button */}
                <div className="flex items-center gap-1">
                  {contextUsedPercent != null && onCompact && (
                    <ContextIndicator
                      usedPercent={contextUsedPercent}
                      onCompact={onCompact}
                    />
                  )}
                  <InputGroupButton
                    type={showStopButton ? 'button' : 'submit'}
                    size="icon-sm"
                    variant={showStopButton ? 'destructive' : 'default'}
                    disabled={isSubmitDisabled}
                    onClick={handleButtonClick}
                    className="rounded-full"
                  >
                    {isLoading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : showStopButton ? (
                      <Square className="size-3" />
                    ) : (
                      <ArrowUp className="size-4" />
                    )}
                  </InputGroupButton>
                </div>
```

The `gap-1` gives 4px spacing between the indicator and the send button. The indicator only renders when `contextUsedPercent` is not null (i.e., at least one `context_usage_state` message has arrived).

---

## Visual Reference

### Indicator at different fill levels

```
  0%        25%        50%        75%       100%
  ○          ◔          ◑          ◕          ●

 gray      gray       gray      amber       red
```

### Indicator in context (low usage)

```
┌────────────────────────────────────────────────┐
│  Type a message...                             │
│                                                │
│  [+] [🎤]                          (◔) [  ↑  ]│
└────────────────────────────────────────────────┘
                                      │
                                  gray circle,
                                  25% filled
```

### Indicator in context (high usage — amber)

```
┌────────────────────────────────────────────────┐
│  Type a message...                             │
│                                                │
│  [+] [🎤]                          (◕) [  ↑  ]│
└────────────────────────────────────────────────┘
                                      │
                                 amber circle,
                                  75% filled
                              ┌──────────────────┐
                              │ 75% context used │
                              │ Click to compact │
                              └──────────────────┘
```

### Indicator in context (critical — red)

```
┌────────────────────────────────────────────────┐
│  Type a message...                             │
│                                                │
│  [+] [🎤]                          (●) [  ↑  ]│
└────────────────────────────────────────────────┘
                                      │
                                  red circle,
                                  95% filled
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src/components/context-indicator.tsx` | **New file** — SVG pie-wedge circle with tooltip, click-to-compact |
| `workers/main/src/durable-objects.ts` | Add `computeContextUsedPercentFromResult` helper, `contextUsedPercent` instance property, KV persistence, init replay, realtime broadcast |
| `src/components/Chat.tsx` | Add `contextUsedPercent` state, handle `context_usage_state` messages, refactor `sendMessage` with `SendOptions`, add `handleCompactFromIndicator`, pass new props to `<PromptInput>`, reset on thread change |
| `src/components/prompt-input.tsx` | Add `contextUsedPercent` and `onCompact` props, render `ContextIndicator` beside send button |

## Files NOT Modified

| File | Reason |
|------|--------|
| `sandbox/control-plane.mjs` | Already broadcasts `result` events with full `modelUsage` data |
| `src/lib/streaming.ts` | Client never parses raw `modelUsage`; `SDKEvent` type unchanged |

---

## Verification

1. **Fresh thread**: Open a new chat thread. The context indicator should be **hidden** (no circle visible) because no `context_usage_state` has been computed yet.
2. **After first exchange**: Send a message and wait for the response to complete. The indicator should appear to the left of the send button, showing a small percentage filled (gray).
3. **Progressive fill**: Continue the conversation with several exchanges. The indicator's fill should increase with each completed response.
4. **Color transitions**: At 60%+ the circle should turn amber. At 80%+ it should turn red.
5. **Tooltip**: Hover over the indicator. Tooltip should show "XX% context used" and "Click to compact".
6. **Click-to-compact**: Click the indicator. It should trigger compaction (same behavior as typing `/compact`). The compacting indicator ("Compacting conversation...") should appear. After compaction completes, the context indicator should show a dramatically lower percentage on the next exchange.
7. **Draft text preserved**: Type some text in the composer, then click the indicator. After compaction triggers, the drafted text should still be in the composer.
8. **Reload/reopen survival**: Refresh the page or close and reopen the thread. The indicator should appear immediately with the last known percentage — no need to wait for a new exchange.
9. **Cross-device consistency**: Open the same thread in two browser tabs (or two devices). Both should show the same context percentage, and both should update when a new exchange completes.
10. **Thread switch**: Navigate to a different thread. The indicator should reset, then show the persisted value for the new thread (or hide if no value exists yet).
11. **No indicator during streaming**: While the assistant is actively responding (before `result` arrives), the indicator should show the **previous** turn's percentage (or be hidden if first turn). It should not flicker or show stale data.
12. **Malformed/missing `modelUsage`**: If a `result` event lacks `modelUsage` (e.g. synthetic `runner_disconnected` result), the previously persisted percentage should remain unchanged. The indicator must not crash.
13. **No raw `modelUsage` in client**: Confirm that `Chat.tsx` does not parse `modelUsage` from `result` events — it only reads `context_usage_state` messages.
14. **QAML admin readonly mode**: In read-only thread view (`?adminReadonly=1`), the indicator should render if a persisted value exists (replayed on init), but clicking should be disabled or no-op since `readOnly` is true.

---

## Acceptance Criteria

- `ChatThreadDO` is the single source of truth for computed context usage percentage
- Percentage is computed from `modelUsage` in worker code with runtime type guards (never throws)
- Percentage is persisted in DO KV and replayed to newly connected clients
- Percentage is broadcast to all connected clients on each `result` event update
- Synthetic/malformed `result` events without valid `modelUsage` do not erase persisted value
- A pie-wedge SVG circle renders to the left of the send button after the first computation
- The circle fills clockwise from 0% to 100%, transitioning through gray → amber → red
- Tooltip on hover shows exact percentage and "Click to compact" prompt
- Clicking the indicator sends `/compact` through the same `sendMessage` pipeline as normal messages
- Clicking preserves unsent draft text and does not clear attachments
- Indicator survives page refresh/reopen with per-thread DO persistence
- Different devices/browsers for the same thread see the same latest value
- Indicator resets when switching threads, then shows persisted value for new thread
- Client code has no raw `modelUsage` parsing — presentation only

---

## Rollout Notes

- Worker deployment is required (DO changes to `ChatThreadDO`) — deploy worker before or alongside frontend
- The feature is purely additive with no existing behavior changes; `sendMessage()` with no args behaves identically to today
- After shipping, update `AGENTS.md` section "Message Sending" to mention context indicator in the composer, and add a row in the "SDK Event Types" table for `context_usage_state`

## Not in Scope

- Showing token counts (raw numbers) — percentage is sufficient for user-facing UX
- Showing cost data (`total_cost_usd`) — separate feature
- Animating the indicator during streaming (we update on `result` events only)
- Showing the indicator in Slack/email ingress contexts (browser-only)
