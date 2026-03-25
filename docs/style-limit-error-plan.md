# Usage Limit Error — Styled UX Plan

## Problem

When a user hits their org spend limit, the agent silently stops responding. The raw error (`API Error: 429 {"error":"Usage limit exceeded: $50.21 spent in the last 5h (limit $50.00). Please try again later."}`) only appears after a page reload. The current generic error banner gives no actionable guidance.

**Current experience:**
1. Agent stops mid-turn with no feedback
2. User must reload the page to see any error
3. Error renders as a generic "Something went wrong" red banner with the raw API string
4. No guidance on how to resolve or work around the limit

## Current Error Flow

```
sandbox-host (Go)                control-plane.mjs              ChatThreadDO              Chat.tsx
  │                                   │                              │                       │
  │◄── /api/claude/v1/messages ───────│                              │                       │
  │  checkOrgBudget() → exceeded      │                              │                       │
  │── HTTP 429 JSON ─────────────────►│                              │                       │
  │                                   │  SDK throws, caught in       │                       │
  │                                   │  event loop try/catch        │                       │
  │                                   │── { type:'error',            │                       │
  │                                   │    error: String(err) } ────►│                       │
  │                                   │                              │── broadcast to ───────►│
  │                                   │                              │   all WS clients       │
  │                                   │                              │                       │  setError(data.error)
  │                                   │                              │                       │  → red banner
```

**Key issue:** The error string from sandbox-host arrives as a stringified SDK error. It contains the structured info (spent, limit, window) but only as a human-readable string, not structured JSON. The client receives it via `data.error` on the WebSocket `error` event.

## Design

### Error Detection — Client-Side Parsing

Parse the error string in Chat.tsx to detect usage limit errors. The format is stable and controlled by our own sandbox-host code:

```
Usage limit exceeded: $50.21 spent in the last 5h (limit $50.00). Please try again later.
```

Regex pattern:
```typescript
const LIMIT_REGEX = /Usage limit exceeded: \$([0-9.]+) spent in the last (\S+) \(limit \$([0-9.]+)\)/;
```

Extract: `spentUSD`, `windowLabel`, `limitUSD`.

### Two-Tier Error Display

Replace the current generic error banner with a **context-aware** display. When the error matches the limit pattern, show a styled limit card. For all other errors, keep the existing generic banner.

---

### Limit Error Card

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│   ⏸  Usage limit reached                                            ✕   │
│                                                                          │
│   You've used $50.21 of your $50.00 limit in the last 5 hours.          │
│   Your usage will refresh soon — you can continue chatting then.         │
│                                                                          │
│   ┌──────────────────────────────────────────────────────────────────┐   │
│   │  💡 Bypass limits by adding your own API key                     │   │
│   │  Connect an Anthropic or AWS Bedrock key in                      │   │
│   │  Organization Settings → AI Provider                             │   │
│   │                                                     [Add key →]  │   │
│   └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

**Visual spec:**

- **Container:** `rounded-xl border border-amber-500/20 bg-amber-500/5 px-5 py-4` (amber/warning tone — this is a limit, not a crash)
- **Header row:** `flex items-center justify-between`
  - Icon: `CirclePause` from lucide-react, `text-amber-600 dark:text-amber-400 size-5`
  - Title: `"Usage limit reached"` — `text-sm font-semibold text-amber-700 dark:text-amber-300`
  - Close button: existing ghost `Button` with `X` icon (keeps current dismiss behavior)
- **Body text:** `text-sm text-muted-foreground mt-2 space-y-1`
  - Line 1: `"You've used $X of your $Y limit in the last Z."` (parsed from error)
  - Line 2: `"Your usage will refresh soon — you can continue chatting then."`
- **API key CTA card:** `mt-3 rounded-lg border border-border bg-card px-4 py-3`
  - Lightbulb icon: `Lightbulb` from lucide-react, `text-muted-foreground size-4`
  - Heading: `"Bypass limits by adding your own API key"` — `text-sm font-medium`
  - Description: `"Connect an Anthropic or AWS Bedrock key in Organization Settings → AI Provider"` — `text-xs text-muted-foreground`
  - Link button: `<Link to="/settings/organization/ai-provider">` styled as `Button variant="outline" size="sm"` with text `"Add key"` + `ArrowRight` icon

### Placement

Same location as the current error banner — inside `ChatMessagesView`, after messages and before the compacting indicator (Chat.tsx ~line 644). This keeps the error visible at the bottom of the chat scroll, right where the user is looking.

### Generic Error Banner (unchanged)

All non-limit errors continue to use the existing red destructive banner exactly as-is:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ⚠  Something went wrong                                            ✕   │
│  {error message text}                                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

No changes needed here.

---

## Immediate Error Display (No Reload Required)

The main UX issue is that the error doesn't appear until a page reload. This needs investigation in the WebSocket handler. The error event IS being received (it flows through the WebSocket), but it may be getting swallowed or the UI may not scroll to it. Two potential fixes:

### Fix 1: Ensure error event triggers UI update immediately

In Chat.tsx at the `data.type === 'error'` handler (~line 2590), verify:
- `setError()` is called (it is)
- `setLoading(false)` is called (it is — line 2603)
- The streaming state is fully cleared so the composer re-enables

**Check if `setStreamingMessageId(null)` is missing from the error handler.** Looking at the code, the error handler finalizes the streaming message but may not be calling `setStreamingMessageId(null)` — this could leave the UI in a "still streaming" state where the error banner is hidden or the composer stays disabled.

The error handler (lines 2590-2609) does this:
```typescript
setError(data.error || 'An unknown error occurred');
splitStreamingMessageOnNextPartRef.current = false;
const msgId = streamingMessageIdRef.current;
lastCompletedAssistantMessageIdRef.current = msgId;
if (msgId) {
  setMessages(prev => prev.map(msg =>
    msg.id === msgId ? finalizeStreamingMessage(msg) : msg
  ));
}
setStreamingMessageId(null);  // ← This IS called, good
setLoading(false);
restorePendingDeliveryDraft();
```

This looks correct. The issue may be upstream — the error might not be reaching the client WebSocket at all in some cases.

### Fix 2: Investigate ChatThreadDO error forwarding

In `workers/main/src/durable-objects.ts`, check how the runner WebSocket `error` event is forwarded to browser clients. The runner (sandbox control-plane) sends `{ type: 'error', error: '...' }` but ChatThreadDO may not be forwarding all error events to the realtime broadcast channel, or may be dropping the connection before the error can be sent.

**Action items for the coding agent:**

1. **In `durable-objects.ts`** — Search for where runner WebSocket messages of `type: 'error'` are handled. Ensure the error is broadcast to all connected browser clients via `this.realtime.broadcast()` or equivalent. Check if there's a code path where the runner WS closes (e.g., on HTTP 429) before the error event is sent.

2. **In `control-plane.mjs`** — Check if the SDK error from a 429 response is actually caught by the event loop `try/catch` at line 1212-1214, or if it causes an unhandled rejection / process crash that closes the WebSocket without sending the error event. Add logging if needed.

3. **In `Chat.tsx`** — After `setError()`, auto-scroll to the bottom so the error banner is visible: call the existing `scrollToBottom()` function (or equivalent) after setting the error state.

---

## Implementation Checklist

### 1. Create `UsageLimitError` component
**File:** `src/components/usage-limit-error.tsx` (new file)

```typescript
interface UsageLimitErrorProps {
  spentUSD: string;
  limitUSD: string;
  windowLabel: string;
  onDismiss: () => void;
}
```

- Renders the amber limit card described above
- Uses `Link` from react-router for the settings navigation
- Uses lucide icons: `CirclePause`, `Lightbulb`, `ArrowRight`, `X`
- Uses existing `Button` component from `@/components/ui/button`

### 2. Update error display in Chat.tsx
**File:** `src/components/Chat.tsx` (~line 644-665)

- Add a helper to parse the error string:
  ```typescript
  function parseUsageLimitError(error: string): { spentUSD: string; limitUSD: string; windowLabel: string } | null
  ```
- In the error display block, check if the error matches the limit pattern
- If match → render `<UsageLimitError>` with parsed values
- If no match → render existing generic error banner (unchanged)

### 3. Fix immediate error display
**File:** `src/components/Chat.tsx` (~line 2590)

- In the `data.type === 'error'` handler, add a `scrollToBottom()` call after `setError()` (use `requestAnimationFrame` or `setTimeout(fn, 0)` to ensure the DOM has updated)
- Verify the error banner is not conditionally hidden by any streaming/loading state

**File:** `workers/main/src/durable-objects.ts`

- Trace the runner WebSocket message handler to confirm `type: 'error'` events from the sandbox are forwarded to browser clients
- If there's a gap (e.g., runner WS close before error send), add error synthesis on unexpected runner WS close

**File:** `sandbox/control-plane.mjs` (~line 1212)

- Confirm the 429 SDK error is caught by the existing try/catch and broadcast as an error event
- If the SDK throws before entering the event loop (e.g., during initial request), ensure that path also broadcasts an error

### 4. Humanize the window label
The sandbox-host sends labels like `"5h"` and `"7d"`. Expand for display:
- `"5h"` → `"5 hours"`
- `"7d"` → `"7 days"`
- `"1h"` → `"1 hour"`
- `"1d"` → `"1 day"`

Simple mapping function in the component — no backend changes needed.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/components/usage-limit-error.tsx` | **New** — Styled limit error card component |
| `src/components/Chat.tsx` | Parse error string, render limit component or generic banner, scroll-to-bottom on error |
| `workers/main/src/durable-objects.ts` | Verify/fix error event forwarding from runner to browser clients |
| `sandbox/control-plane.mjs` | Verify 429 errors are caught and broadcast (may need no changes) |

## Out of Scope

- **Showing exact refresh time:** The rolling window is continuous (not epoch-aligned), so there's no single "refresh at" timestamp. The oldest charges age out gradually. Calculating this precisely would require querying the usage log. Not worth the complexity — "Your usage will refresh soon" is sufficient.
- **Backend changes to the error format:** The string format works fine for client-side parsing and is controlled by our own code. No need to add structured JSON fields to the WebSocket error event.
- **Proactive warning before hitting the limit:** Good future enhancement but separate scope. The `ContextIndicator` pattern could be adapted for spend tracking.
