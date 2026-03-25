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
  - **Note:** The AI provider settings page is admin-only (`requireOrgAdmin()`), but free-tier accounts are typically single-user orgs where the user is the admin. Always show the direct link. Add a code comment noting the admin-only route for future reference if team accounts need differentiated messaging.

### Placement & Spacer Suppression

Same location as the current error banner — inside `ChatMessagesView`, after messages and before the compacting indicator (Chat.tsx ~line 644).

**Important:** The chat scroll area has a bottom spacer (~line 2760) that stays visible when the last message is assistant-like. The error handler finalizes the streaming assistant message, so the spacer can push the error card above the fold, and a naive `scrollToBottom()` may scroll past it.

**Requirement:** When `error` is set, **suppress the bottom spacer** so the error card sits flush at the end of the message list. The simplest fix is to add `&& !error` to the spacer's render condition. This ensures the limit card (or any error banner) is the last visible element and scrolling to bottom lands on it.

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

The main UX issue is that the error doesn't appear until a page reload. The backend pipeline is already wired correctly:

- `control-plane.mjs` broadcasts `type: 'error'` from both the event-loop catch (line 1212) and the `handleMessage` catch (line 1491)
- `ChatThreadDO` receives runner error events (durable-objects.ts ~line 1987) and pushes them into the chat event buffer (~line 2141)
- The client error handler in Chat.tsx (line 2590) calls `setError()`, `setLoading(false)`, and `setStreamingMessageId(null)` — all correct

**The backend path should not need code changes.** The DO and control-plane already forward errors. Do NOT add synthesized "runner closed" errors — that would conflict with the existing reconnect-grace path (durable-objects.ts ~line 2211).

### Client-side fix: scroll to error + suppress spacer

In Chat.tsx at the `data.type === 'error'` handler (~line 2590):

1. After `setError()`, scroll the error element into view using `requestAnimationFrame` → `scrollToBottom()` (or `scrollIntoView` on an error ref) so the banner is visible without manual scroll
2. Suppress the bottom spacer when `error` is set (see Placement section above) so `scrollToBottom()` doesn't overshoot past the error card

### Backend verification (no code changes expected)

As a **verification-only** step, confirm the error event arrives on the client by checking browser DevTools console for `"WebSocket error:"` logs when a 429 is triggered. If client logs show the error event never arrives, only then investigate the DO/control-plane forwarding path.

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

- In the `data.type === 'error'` handler, after `setError()`, scroll to bottom via `requestAnimationFrame(() => scrollToBottom())` so the error card is visible
- Add `&& !error` to the bottom spacer render condition (~line 2760) so the spacer doesn't push the error card out of view
- Verify the error banner is not conditionally hidden by any streaming/loading state

**Backend files (verification only, no code changes expected):**
- `workers/main/src/durable-objects.ts` and `sandbox/control-plane.mjs` already forward error events correctly. Do NOT add runner-close error synthesis (conflicts with reconnect-grace). Only make changes if client-side testing proves the error event never arrives.

### 4. Humanize the window label
The sandbox-host sends labels like `"5h"` and `"7d"`. Parse the numeric value and unit generically — don't hardcode only known values, since limits can be overridden per-org to arbitrary windows.

Pattern: extract `(\d+(?:\.\d+)?)(h|d|m|s)` → expand unit to full word, pluralize when value !== 1.

Examples:
- `"5h"` → `"5 hours"`
- `"1h"` → `"1 hour"`
- `"7d"` → `"7 days"`
- `"1d"` → `"1 day"`
- `"30d"` → `"30 days"`
- `"2.5h"` → `"2.5 hours"`

Simple pure function in the component file — no backend changes needed.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/components/usage-limit-error.tsx` | **New** — Styled limit error card component |
| `src/components/Chat.tsx` | Parse error string, render limit component or generic banner, scroll-to-bottom on error, suppress bottom spacer when error is set |

## Out of Scope

- **Showing exact refresh time:** The rolling window is continuous (not epoch-aligned), so there's no single "refresh at" timestamp. The oldest charges age out gradually. Calculating this precisely would require querying the usage log. Not worth the complexity — "Your usage will refresh soon" is sufficient.
- **Backend changes to the error format:** The string format works fine for client-side parsing and is controlled by our own code. No need to add structured JSON fields to the WebSocket error event.
- **Proactive warning before hitting the limit:** Good future enhancement but separate scope. The `ContextIndicator` pattern could be adapted for spend tracking.
