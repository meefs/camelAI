# Chat Usage Alerts — Restyle Plan

## Problem

The in-chat hosted-credit alerts currently use **amber (warning)** styling for the low-credit state and **destructive red** for the exhausted state. Both feel like error states, even though running low on credits is a routine, expected event for hosted-tier users. The CTAs are also misaligned with how we want users to manage credits:

- The "Use own key" / "Add API key" secondary CTA is over-prescriptive — it pushes BYOK as the primary alternative when most users just want to see their usage and decide.
- There is no progress affordance, so users can't tell at a glance how close they are to running out.

## Goals

1. **Tone down the visual urgency.** Drop amber/red. Low-credit should read as informational on a neutral surface; exhausted should be a clear blocker that stands out by **inverting the theme** (light card in dark mode, dark card in light mode) — high contrast without using a color we don't own in the design system.
2. **Replace the secondary CTA "Add API key" with "View usage"**, linking to `/settings/organization/usage` where users can review usage *and* top up *and* find the BYOK link if they want it.
3. **Add a usage progress bar** to the low-credit state so users can see at a glance how close to exhaustion they are.
4. **Restyle `ChatErrorNotice` as a low-profile inline line.** When the exhausted alert is already visible above the input, the rejection message doesn't need to be a bulky red card — a single muted line with an icon ("Message not sent — top up credits or add an API key to continue.") is sufficient and reads as paired with the alert above the input.

Out of scope: changing the hosted/BYOK enforcement logic, disabling the chat input on exhaustion (the input stays enabled; sending while exhausted surfaces the restyled inline error).

## Current State (reference)

**Component:** `BillingCreditNotice` in [src/components/Chat.tsx:584-648](src/components/Chat.tsx#L584-L648)

**Data model:** `BillingCreditStatus` in [src/lib/chat-credit-status.ts](src/lib/chat-credit-status.ts) — already exposes `availableCreditsCents`, `totalCreditLimitCents`, `usedPercent`, `isLow`, `isExhausted`, `hasByokProvider`. No data-model changes required.

**Render site:** [src/components/Chat.tsx:4543-4548](src/components/Chat.tsx#L4543-L4548) — banner sits above the chat input (`PromptInput`).

**Current props/behavior:**
```ts
<BillingCreditNotice
  status={billingCreditStatus}
  onOpenBilling={() => navigate('/settings/organization/billing')}
  onOpenProviderSettings={() => navigate('/settings/organization/ai-provider')}
/>
```

## Visual Design

### Low-credit state (informational)

A calm, neutral card with a progress bar. Uses standard surface tokens — no warning color.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  8.25 of 10 credits used this month         [ View usage ]  [ Top up ]   │
│                                                                          │
│  ████████████████████████████████████████░░░░░░░░░░░░                    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

**Spec:**
- Container: `rounded-lg border bg-card text-card-foreground px-4 py-3` (the same neutral surface used elsewhere — no amber).
- Layout: header row (`flex items-center justify-between gap-3`) above progress bar.
- Title: `"{used} of {total} credits used this month"` — `text-sm font-medium`.
  - `used = totalCreditLimitCents - availableCreditsCents` formatted as dollars (reuse existing `formatCredits` helper in [Chat.tsx](src/components/Chat.tsx)).
  - `total = totalCreditLimitCents` formatted as dollars.
  - Show two decimal places to match the mock (e.g. `"8.25 of 10 credits used this month"`).
- BYOK aside: when `status.hasByokProvider`, append a muted line below the title: `"Own-key threads do not use hosted credits."` — `text-xs text-muted-foreground`. Keep it on its own line; do not crowd the title.
- Progress bar: shadcn `<Progress value={status.usedPercent} />` from [src/components/ui/progress.tsx](src/components/ui/progress.tsx) — uses primary color by default, which matches the mock's blue fill. `mt-2 h-2`.
- CTAs (right-aligned, vertically centered with the title):
  - `<Button variant="outline" size="sm" onClick={onOpenUsage}>View usage</Button>`
  - `<Button size="sm" onClick={onTopUp}>Top up</Button>` (default variant = primary)
- Responsive: on narrow widths stack the header row vertically (`flex-col sm:flex-row`), CTAs row beneath the title; progress bar always full-width below.

### Exhausted state (blocker, theme-inverted)

A filled card that **inverts the current theme**: in light mode it renders dark, in dark mode it renders light. We don't have a brand blue in the design system, and inverting the theme gives the alert the standout quality the blue card had in the mock — without inventing a new color token. It reads as a deliberate surface change, not as an error.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  You're out of hosted credits this month        [ View usage ] [ Top up ]│
│  Top up to keep going, or use your own API key.                          │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

**Spec:**
- Container: `rounded-lg bg-foreground text-background px-4 py-3`. No border — the inverted fill is the affordance. The `bg-foreground` / `text-background` token pair already exists and flips with the theme automatically (dark surface in light mode, light surface in dark mode).
- Title: `"You're out of hosted credits this month"` — `text-sm font-semibold`.
- Description (own line, `mt-0.5`):
  - Default: `"Top up to keep going, or use your own API key."` — `text-xs text-background/80`.
  - When `status.hasByokProvider`: `"Top up to keep using hosted models. Own-key threads continue to work."` — same styling.
- CTAs (both need explicit className overrides because the standard variants are tuned for non-inverted surfaces — do NOT add new shadcn variants):
  - **View usage** (secondary, outlined-on-inverted): `<Button size="sm" variant="outline" className="border-background/40 bg-transparent text-background hover:bg-background/10 hover:text-background">View usage</Button>`
  - **Top up** (primary, light pill on inverted card): `<Button size="sm" className="bg-background text-foreground hover:bg-background/90">Top up</Button>`
- No progress bar (it would be 100% and adds nothing).
- No icon. The card itself is the alert.

### Inline send-blocked error (low-profile restyle)

`ChatErrorNotice` in [src/components/Chat.tsx:650-680](src/components/Chat.tsx#L650-L680) is currently a bulky red card with a heading ("Something went wrong") and the raw error string. When the inverted exhausted alert is already sitting directly above the input, that big red card on top of it is overkill. Restyle it as a single muted line with a small icon:

```
  ⓘ  Message not sent — top up credits or add an API key to continue.
```

**Spec:**
- Container: `flex items-center gap-2 px-1 py-1.5 text-sm text-muted-foreground`. No card, no border, no background fill. Sits inline above the prompt input.
- Icon: `CircleAlert` (or `Info`) from `lucide-react`, `h-4 w-4 shrink-0 text-muted-foreground`. Matches the mock's outlined circle-with-exclamation glyph.
- Message text: `text-sm text-muted-foreground` — single line, no heading.
- Dismiss: keep the existing optional `onDismiss` prop. Render the `X` button only when `onDismiss` is provided, as `<Button variant="ghost" size="icon-sm" className="ml-auto h-5 w-5 text-muted-foreground">`. Keep it small enough to not dominate the line.
- Drop the `"Something went wrong"` title entirely — the message itself is self-explanatory and including a heading defeats the low-profile goal.
- The component still receives the raw `error` string. The body of the line should display the `error` string directly (which today reads "Hosted model credits are used up. … Buy credits or manage your subscription in Settings -> Billing, or add your own API key in Settings -> AI Provider. Your workspace is saved." for the credit-exhausted case).
- **Copy alignment:** the dev-mode initial error in [src/lib/chat-credit-status.ts:74-83](src/lib/chat-credit-status.ts#L74-L83) and the equivalent server-emitted message should be shortened to match the mock's tone: `"Message not sent — top up credits or add an API key to continue."` Coordinate the dev string and the server-side string so they read the same. The server-emitted strings live in `workers/main/` and `sandbox/control-plane.mjs`; let the implementing agent grep for the existing wording (`Buy credits or manage your subscription`) and replace consistently. If the server-side rewrite is too broad for this PR, ship the client-side restyle now and gate the copy update behind a follow-up — flag in the PR description.

This restyle, paired with the inverted exhausted alert above the input, produces the layout in the user's third mock (a thin error line above the standalone alert).

## Component Changes

**File:** [src/components/Chat.tsx:584-648](src/components/Chat.tsx#L584-L648) (`BillingCreditNotice`)

### Prop renames

```ts
export function BillingCreditNotice({
  status,
  onOpenUsage,    // was: onOpenBilling
  onTopUp,        // new — primary CTA
}: {
  status: BillingCreditStatus;
  onOpenUsage: () => void;
  onTopUp: () => void;
}) { ... }
```

Drop `onOpenProviderSettings` entirely. The BYOK conditional CTA is removed; the description text mentions API keys, and users discover the BYOK flow via the usage/settings pages.

### Render-site update

[src/components/Chat.tsx:4543-4548](src/components/Chat.tsx#L4543-L4548):

```tsx
<BillingCreditNotice
  status={billingCreditStatus}
  onOpenUsage={() => navigate('/settings/organization/usage')}
  onTopUp={() => navigate('/settings/organization/usage?action=topup')}
/>
```

**Top up behavior:** clicking **Top up** navigates to `/settings/organization/usage?action=topup`, and the usage route auto-opens `TopUpDialog` when that query param is present, then strips the param via `setSearchParams({}, { replace: true })` so refresh doesn't re-open it. `TopUpDialog` lives at [src/components/billing/top-up-dialog.tsx](src/components/billing/top-up-dialog.tsx); the usage route is [src/routes/_app.settings.organization.usage.tsx:261-325](src/routes/_app.settings.organization.usage.tsx#L261-L325). One click from chat to dialog is the expected behavior.

### Imports to remove

`AlertTriangle` from `lucide-react` is no longer needed by `BillingCreditNotice` (verify no other usage in the file before removing the import).

### Imports to add

- `Progress` from `@/components/ui/progress` (for the low-credit progress bar).
- `CircleAlert` (or `Info`) from `lucide-react` for the restyled `ChatErrorNotice`. The inline SVG currently embedded in `ChatErrorNotice` should be replaced with this lucide icon for consistency with the rest of the codebase.

## Copy

| State | Title | Description |
|-------|-------|-------------|
| Low | `{used} of {total} credits used this month` | (BYOK only) `Own-key threads do not use hosted credits.` |
| Exhausted | `You're out of hosted credits this month` | `Top up to keep going, or use your own API key.` |
| Exhausted (BYOK) | `You're out of hosted credits this month` | `Top up to keep using hosted models. Own-key threads continue to work.` |

Use `formatCredits()` (already in [Chat.tsx](src/components/Chat.tsx)) for both `used` and `total` so the dollar formatting matches. The mock shows `8.25 of 10` — `formatCredits` should already drop trailing zeroes appropriately; verify on the rendered output.

## Implementation Checklist

1. **Update `BillingCreditNotice`** in [src/components/Chat.tsx:584-648](src/components/Chat.tsx#L584-L648):
   - Rename props (`onOpenBilling` → `onOpenUsage`, drop `onOpenProviderSettings`, add `onTopUp`).
   - Replace the body with two branches keyed off `status.isExhausted`, matching the visual specs above.
   - Import `Progress` from `@/components/ui/progress`.
   - Remove `AlertTriangle` import if no longer used in this file.

2. **Update the call site** at [src/components/Chat.tsx:4543-4548](src/components/Chat.tsx#L4543-L4548) with the new prop names and the usage-page navigation targets.

3. **Restyle `ChatErrorNotice`** in [src/components/Chat.tsx:650-680](src/components/Chat.tsx#L650-L680):
   - Replace the bulky destructive card with the inline `flex items-center gap-2 text-sm text-muted-foreground` row described above.
   - Replace the inline SVG with `<CircleAlert className="h-4 w-4 shrink-0 text-muted-foreground" />` (or `Info`).
   - Remove the `"Something went wrong"` title and the destructive border/background classes.
   - Keep the `error` and `onDismiss` props unchanged so call sites don't need to change.

4. **Auto-open Top up dialog** in [src/routes/_app.settings.organization.usage.tsx](src/routes/_app.settings.organization.usage.tsx):
   - On mount, if `searchParams.get('action') === 'topup'`, open `TopUpDialog` and strip the param via `setSearchParams({}, { replace: true })`.
   - Keep this behind a small `useEffect`; do not couple it to the loader.

5. **Shorten the credit-exhausted error copy** to `"Message not sent — top up credits or add an API key to continue."`:
   - Update the dev string in [src/lib/chat-credit-status.ts:74-83](src/lib/chat-credit-status.ts#L74-L83).
   - Grep for the current server-emitted wording (`Buy credits or manage your subscription`) in `workers/main/` and `sandbox/control-plane.mjs` and update consistently. If server-side scope is too broad, ship the client-side restyle now and follow up — flag in the PR description.

6. **Dev-mode preview.** The dev override `?devCreditState=low|low-byok|exhausted|exhausted-byok` from [src/lib/chat-credit-status.ts:45-65](src/lib/chat-credit-status.ts#L45-L65) already exposes both states. Use these to verify the redesign in all four permutations (low/exhausted × hosted/BYOK). The dev override `?devChatError=out-of-credits` exercises the restyled `ChatErrorNotice`.

7. **Smoke checks:**
   - `bun run typecheck`
   - Manual: open a chat with `?devCreditState=low`, then `?devCreditState=exhausted`, in light and dark mode. Confirm the progress bar fills in the low state and the exhausted card visibly inverts the theme (dark in light mode, light in dark mode).
   - Manual: with `?devCreditState=exhausted&devChatError=out-of-credits`, confirm the inline `ChatErrorNotice` reads as a single muted line above the inverted alert, with no large red card.
   - Manual: confirm clicking **Top up** from chat lands the user on the usage page with `TopUpDialog` open and the `action=topup` param stripped from the URL.

## Files to Modify

| File | Change |
|------|--------|
| [src/components/Chat.tsx](src/components/Chat.tsx) | Rewrite `BillingCreditNotice` body and update its call site; rename props; restyle `ChatErrorNotice` as a low-profile inline line; swap imports. |
| [src/routes/_app.settings.organization.usage.tsx](src/routes/_app.settings.organization.usage.tsx) | Auto-open `TopUpDialog` when `?action=topup` is present, then strip the param. |
| [src/lib/chat-credit-status.ts](src/lib/chat-credit-status.ts) | Shorten the dev `out-of-credits` error string to match the new copy. |
| `workers/main/` and `sandbox/control-plane.mjs` (paths to be located by grep) | Shorten the server-emitted credit-exhausted error string to match. May be deferred to a follow-up PR if scope is large — flag in PR description. |

No data-model or loader changes.

## Out of Scope

- **Disabling `PromptInput` on exhaustion.** Keep the input enabled — users can still send, the server rejects, and the (now low-profile) inline error appears above the input alongside the inverted alert. Matches the mocks.
- **BYOK CTA in chat.** Removed deliberately — the description text mentions own-API-key, and BYOK is reachable from the usage/settings pages.
- **Changing the trigger thresholds.** `isLow` (≥80%) and `isExhausted` (≤0 available) stay as defined in [chat-credit-status.ts](src/lib/chat-credit-status.ts).
- **Enterprise / unlimited billing states.** `buildBillingCreditStatus` already returns `null` for these, so the banner doesn't render.
