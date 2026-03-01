# Context Indicator Live Updates — Implementation Feedback

**March 1, 2026** | Review of implementation

---

## Worker-side Implementation: Well Done

The `durable-objects.ts` changes are solid. Highlights:

- **Pure function extraction:** `applyContextUsageSdkEvent` is a pure function that takes state + event and returns the next state + side effects. This made it trivially testable without needing a full DO harness. Good architectural decision — this wasn't explicitly in the plan.
- **Merge semantics for contextWindow cache:** The result handler merges new entries into the existing cache (`{ ...current, ...new }`) rather than replacing wholesale. This means switching models doesn't lose the previous model's cached contextWindow. Correct and better than the plan's simpler replacement.
- **Fallback contextWindow on result:** If `extractContextWindowForModel` returns 0 (model not in current `result.modelUsage`), it falls back to the cached value. Handles edge cases the plan didn't explicitly cover.
- **Tests:** All 5 required test matrix cases are covered. Tests are clean and exercise the pure function directly.

No worker-side bugs found.

---

## Bugs

### 1) HIGH — `handleCompactFromIndicator` has `sendMessage` in its dependency array but `sendMessage` is not stable

**Symptom:** `handleCompactFromIndicator` recreates on every render, defeating the `useCallback` and causing `PromptInput` to re-render unnecessarily. This compounds Issue #3 below.

**Root cause:** `sendMessage` is declared as a plain function (`function sendMessage(opts?: SendOptions)`) inside the Chat component body. It is not wrapped in `useCallback` and is not referentially stable. It is included in `handleCompactFromIndicator`'s dependency array:

```typescript
const handleCompactFromIndicator = useCallback(() => {
  if (loading || isStreaming || isCompacting || readOnly) return;
  sendMessage({
    contentOverride: '/compact',
    preserveDraft: true,
    skipAttachmentRefs: true,
  });
}, [loading, isStreaming, isCompacting, readOnly, sendMessage]);
//                                                ^^^^^^^^^^^
// sendMessage is a new function reference on every render
```

Since `sendMessage` is new on every render, the `useCallback` effectively does nothing — `handleCompactFromIndicator` is also new on every render.

**Fix:** Use a ref to access `sendMessage` without adding it to the dependency array:

```typescript
const sendMessageRef = useRef(sendMessage);
sendMessageRef.current = sendMessage;

const handleCompactFromIndicator = useCallback(() => {
  if (loading || isStreaming || isCompacting || readOnly) return;
  sendMessageRef.current({
    contentOverride: '/compact',
    preserveDraft: true,
    skipAttachmentRefs: true,
  });
}, [loading, isStreaming, isCompacting, readOnly]);
```

This is the same pattern already used elsewhere in Chat.tsx (e.g., `connectWebSocketRef`).

---

## Missing Requirements

### 2) HIGH — Indicator should be hidden when context usage is below 50%

**Requirement:** From the original feature spec, the context indicator should only appear when context usage exceeds 50%. Currently, it appears as soon as the first `context_usage_state` message arrives (often at ~5%).

**Current behavior:**
```
┌──────────────────────────────────────────────┐
│  Type a message...                           │
│                                              │
│  [+] [🎤]  (◔) 5% used              [  ↑  ] │
│             ^^^^^^^^^^^^                     │
│             Visible at 5% — shouldn't be     │
└──────────────────────────────────────────────┘
```

**Desired behavior:**
```
Context < 50%:
┌──────────────────────────────────────────────┐
│  Type a message...                           │
│                                              │
│  [+] [🎤]                            [  ↑  ] │
│                     (indicator hidden)       │
└──────────────────────────────────────────────┘

Context >= 50%:
┌──────────────────────────────────────────────┐
│  Type a message...                           │
│                                              │
│  [+] [🎤]  (◔) 57% used              [  ↑  ]│
│             ^^^^^^^^^^^^                     │
│             Now visible                      │
└──────────────────────────────────────────────┘
```

**Fix:** Apply the threshold in `prompt-input.tsx` at the render site, not inside `ContextIndicator` itself (so the component stays reusable):

**File:** `src/components/prompt-input.tsx`

```tsx
// FIND (line 340):
{contextUsedPercent != null && onCompact && (
  <ContextIndicator usedPercent={contextUsedPercent} onCompact={onCompact} />
)}

// REPLACE WITH:
{contextUsedPercent != null && contextUsedPercent >= 50 && onCompact && (
  <ContextIndicator usedPercent={contextUsedPercent} onCompact={onCompact} />
)}
```

The DO-side computation and broadcasting should continue at all levels — only the UI visibility is gated. This ensures the persisted value is always accurate and the indicator appears instantly when crossing 50%, without waiting for the next turn.

---

### 3) HIGH — `contextUsedPercent` state changes cause full `PromptInput` re-render including the send button

**Symptom:** When the context indicator updates (now multiple times per turn with live updates), the send button visually re-renders/flickers. This is because `contextUsedPercent` is a prop on `PromptInput`, and changing it re-renders the entire component including the submit button.

**Root cause:** `PromptInput` is not memoized. Every `setContextUsedPercent` in Chat.tsx creates a new `contextUsedPercent` prop value, which re-renders the entire `PromptInput` component tree including the textarea, buttons, and send button.

With live updates, this now happens 3-8 times per turn instead of once, making the flicker more noticeable.

**Fix:** Wrap `ContextIndicator` in `React.memo` so it only re-renders when its own props change, and isolate the `contextUsedPercent` from triggering a full `PromptInput` re-render by passing it through a memoized wrapper.

Two changes are needed:

**A) Memoize `ContextIndicator` itself:**

**File:** `src/components/context-indicator.tsx`

```tsx
import { memo } from 'react';

// Wrap the export:
export const ContextIndicator = memo(function ContextIndicator({
  usedPercent,
  onCompact,
  className,
}: ContextIndicatorProps) {
  // ... existing body unchanged ...
});
```

This prevents `ContextIndicator` from re-rendering when its parent re-renders but `usedPercent` and `onCompact` haven't changed. Necessary but not sufficient on its own.

**B) Isolate context indicator state from the rest of `PromptInput`:**

The real issue is that `contextUsedPercent` changing re-renders the entire `PromptInput` including the send button. The cleanest fix: move the `contextUsedPercent` state consumption out of `PromptInput` entirely. Instead, render the `ContextIndicator` as a sibling or use a separate wrapper component that subscribes to the state independently.

Alternatively, memoize the submit button section:

**File:** `src/components/prompt-input.tsx`

Extract the send button into a memoized component so it doesn't re-render when only `contextUsedPercent` changes:

```tsx
const MemoizedSendButton = memo(function MemoizedSendButton({
  showStopButton,
  isSubmitDisabled,
  isLoading,
  onClick,
}: {
  showStopButton: boolean;
  isSubmitDisabled: boolean;
  isLoading: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <InputGroupButton
      type={showStopButton ? 'button' : 'submit'}
      size="icon-sm"
      variant={showStopButton ? 'destructive' : 'default'}
      disabled={isSubmitDisabled}
      onClick={onClick}
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
  );
});
```

**IMPORTANT:** `MemoizedSendButton` is only effective if its `onClick` prop is stable. `handleButtonClick` is currently a plain function — it must be stabilized with `useCallback`:

```tsx
// FIND:
function handleButtonClick(e: React.MouseEvent) {
  if (showStopButton) {
    e.preventDefault();
    onStop?.();
  }
}

// REPLACE WITH:
const handleButtonClick = useCallback((e: React.MouseEvent) => {
  if (showStopButton) {
    e.preventDefault();
    onStop?.();
  }
}, [showStopButton, onStop]);
```

Without this, `handleButtonClick` is new on every render and the memoized send button re-renders anyway.

Then use it in the render:

```tsx
<MemoizedSendButton
  showStopButton={!!showStopButton}
  isSubmitDisabled={isSubmitDisabled}
  isLoading={isLoading}
  onClick={handleButtonClick}
/>
```

This ensures the send button only re-renders when its own props change (loading state, disabled state), not when `contextUsedPercent` updates.

---

### 4) MEDIUM — Frontend tests needed for new UX requirements

Worker tests were added at `workers/main/tests/context-usage-live-updates.test.ts` and cover the event-sequencing test matrix well.

However, the two new UX requirements (50% threshold, no re-render churn) have no frontend test coverage.

**Required tests** (in a new or existing test file under `src/components/`):

**A) 50% threshold visibility:**

```tsx
// PromptInput does not render ContextIndicator when contextUsedPercent < 50
render(<PromptInput contextUsedPercent={30} onCompact={mockFn} ... />);
expect(screen.queryByLabelText(/context used/i)).not.toBeInTheDocument();

// PromptInput renders ContextIndicator when contextUsedPercent >= 50
render(<PromptInput contextUsedPercent={50} onCompact={mockFn} ... />);
expect(screen.getByLabelText(/50% context used/i)).toBeInTheDocument();

// PromptInput renders ContextIndicator when contextUsedPercent is null
render(<PromptInput contextUsedPercent={null} onCompact={mockFn} ... />);
expect(screen.queryByLabelText(/context used/i)).not.toBeInTheDocument();
```

**B) ContextIndicator memoization (render count check):**

```tsx
// ContextIndicator does not re-render when parent re-renders with same props
const renderSpy = vi.fn();
// Use a wrapper that forces re-render and verify ContextIndicator render count
// stays at 1 when usedPercent and onCompact don't change
```

---

## Summary of Required Changes

| # | Severity | Area | Change |
|---|----------|------|--------|
| 1 | HIGH | `Chat.tsx` | Fix `handleCompactFromIndicator` — use ref for `sendMessage` instead of adding it to dependency array |
| 2 | HIGH | `prompt-input.tsx` | Gate indicator visibility on `contextUsedPercent >= 50` |
| 3 | HIGH | `context-indicator.tsx`, `prompt-input.tsx` | Memoize `ContextIndicator` with `React.memo`; extract send button into `MemoizedSendButton`; stabilize `handleButtonClick` with `useCallback` so the memo is effective |
| 4 | MEDIUM | `src/components/__tests__/` | Add frontend tests: 50% threshold visibility, memoization render-count check |

---

## Verification After Fixes

1. **50% threshold:** Indicator should not appear in a fresh or short conversation. It should appear when context crosses 50%.
2. **No send button flicker:** During a multi-tool-call turn, the send button should remain visually stable while the indicator updates.
3. **Compact click still works:** Clicking the indicator when visible should still send `/compact` without clobbering draft text.
4. **Live updates still work:** Indicator should still update after each `message_start` during a turn.
