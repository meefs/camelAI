# Model Fallback Banner + Low-Credit Alert Polish Plan

## Scope

Two chat banners render directly above the composer in `src/components/Chat.tsx` (~line 4356), both currently drawn as bordered `bg-card` boxes:

1. **Model fallback banner** — `src/components/model-fallback-banner.tsx`. Shows when a hosted turn fell back to camelCode ("Monthly credits used up — switched to camelCode.").
2. **Low-credit rail** — the non-exhausted branch of `src/components/chat-billing-credit-notice.tsx` (from line 231). Shows "X.XX credits left" with a progress meter when the balance drops under a threshold.

Three changes, and **nothing else**:

- **Remove the background fill on both banners** — delete the `bg-card` class only. The border, rounding, padding, font sizes/weights, icon, button variants, dismiss button position, and progress bar all stay exactly as they are today. The boxes keep their outline; they just become transparent so they sit lower-profile against the page background.
- **New fallback headline**: "Premium model credits used. You've been switched to camelCode."
- **Drop the trailing colon** on "Get back on {model}:".

**Not in scope — leave unchanged:**

- The *exhausted* branch of `BillingCreditNotice` (line 170, the inverted `bg-foreground` "You're out of hosted credits this month" box). That is the hard-stop state and keeps its high-contrast treatment.
- Any layout, spacing, typography, or component-structure change. This is a one-class + two-string diff per the sections below.
- All button handlers, dismissal/localStorage logic, the sr-only live region, and the enter/exit animations.
- Chat.tsx placement and the `mb-2 shrink-0` spacing both banners receive there.

Note the two banners never co-occur in real chat: when the thread is on camelCode, `displayedBillingCreditStatus` is nulled (`Chat.tsx:1369-1372`), so only the fallback banner shows.

---

## Copy (verbatim — do not paraphrase)

In `src/components/model-fallback-banner.tsx`:

| Line | Current | New |
| --- | --- | --- |
| 90 | `Monthly credits used up — switched to camelCode.` | `Premium model credits used. You've been switched to camelCode.` |
| 95 | `Get back on {fromModelLabel}:` | `Get back on {fromModelLabel}` |

Use a real apostrophe entity as elsewhere in the file (`You&apos;ve`).

**Optional, cuttable** (consistency with the new headline style; skip if reviewers prefer minimal diff): line 91 `Your subscription is unavailable — switched to camelCode.` → `Your subscription is unavailable. You've been switched to camelCode.` If taken, also update the assertion at `tests/model-fallback-banner.test.tsx:47`.

No other copy changes. "Ask an org admin to top up or upgrade." and all button labels stay as-is.

---

## ASCII Design

Layout is identical before and after — the only visual differences are the fill color, the headline text, and the dropped colon.

### Fallback banner — before

```
┌──────────────────────────────────────────────────────────────────┐
│ ⓘ  Monthly credits used up — switched to camelCode.          [x] │  ← border + bg-card fill
│    Get back on GPT-5.6 Sol:                                       │
│    [Sign in with OpenAI] [Top up credits] [Upgrade plan]          │
│    [Use API key]                                                  │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ Type a message...                                          [Send] │  ← composer (PromptInput)
└──────────────────────────────────────────────────────────────────┘
```

### Fallback banner — after (same box, transparent fill, new copy)

```
┌──────────────────────────────────────────────────────────────────┐
│ ⓘ  Premium model credits used. You've been switched to       [x] │  ← border kept, NO fill
│    camelCode.                                                     │     (page background shows
│    Get back on GPT-5.6 Sol                                        │     through); no colon
│    [Sign in with OpenAI] [Top up credits] [Upgrade plan]          │
│    [Use API key]                                                  │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ Type a message...                                          [Send] │
└──────────────────────────────────────────────────────────────────┘
```

### Low-credit rail — before

```
┌──────────────────────────────────────────────────────────────────┐
│ 4.50 credits left                    [View usage] [Top up]   [x] │  ← border + bg-card fill
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  ← Progress pinned to bottom
└──────────────────────────────────────────────────────────────────┘
```

### Low-credit rail — after (same box, transparent fill; nothing else moves)

```
┌──────────────────────────────────────────────────────────────────┐
│ 4.50 credits left                    [View usage] [Top up]   [x] │  ← border kept, NO fill
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  ← Progress unchanged
└──────────────────────────────────────────────────────────────────┘
```

---

## Implementation

### 1. `src/components/model-fallback-banner.tsx`

- **Line 83** — delete `bg-card` (and its now-pointless `text-card-foreground` pairing) from the container. Keep every other class:

  ```tsx
  // before
  <div className="relative overflow-hidden rounded-lg border bg-card px-3 py-3 text-card-foreground">
  // after
  <div className="relative overflow-hidden rounded-lg border px-3 py-3">
  ```

- **Lines 90 and 95** — copy per the table above.
- Nothing else in the file changes — headline stays `text-sm font-semibold`, dismiss button stays at `right-1.5 top-1.5`, padding stays `px-3 py-3`.

### 2. `src/components/chat-billing-credit-notice.tsx`

Only the low-credit rail branch (the JSX returned from line 231). The exhausted branch above it is untouched.

- **Line 244** — same one-class deletion:

  ```tsx
  // before
  <div className="relative overflow-hidden rounded-lg border bg-card px-3 py-2.5 text-card-foreground">
  // after
  <div className="relative overflow-hidden rounded-lg border px-3 py-2.5">
  ```

- Nothing else in the file changes — the `Progress` bar keeps its `absolute inset-x-0 bottom-0 rounded-none` overlay position, buttons and animations stay as-is.

### 3. Tests

- `tests/model-fallback-banner.test.tsx:40` — update the asserted string to `"Premium model credits used. You've been switched to camelCode."` (line 47 too only if the optional subscription-copy change is taken).
- `e2e/staging-billing/staging-billing.spec.ts:46` — update the exact-match `getByText` to the same new headline. (This spec only runs against staging; updating the string is sufficient.)
- `grep -rn "Monthly credits used up\|Get back on"` across the repo to confirm nothing else references the old strings — as of this plan, only the component, the unit test, and the e2e spec do.

---

## Verification

- `bun run test:run -- model-fallback-banner`
- `bun run typecheck`
- Visual: `bun run dev`, then `/dev/chat-credit-states?state=fallback-credits`, `?state=fallback-subscription`, `?state=low-500`, `?state=low-50` — both banners keep their border/rounding/layout but show the page background through; `?state=exhausted` must still show the unchanged inverted box. Check both light and dark themes (in dark mode the delta is more visible since `bg-card` is an elevated surface there).
