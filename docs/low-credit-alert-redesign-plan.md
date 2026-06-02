# Low Credits Alert — Redesign Plan

## Problem

The in-chat low-credit warning today (`BillingCreditNotice`, low branch) is a boxed card that:

- Triggers on **percent used** (`usedPercent >= 80`), not on a meaningful **dollar balance**. For larger limits this fires while the user still has plenty (80% of a $30 plan = $6 left); for small balances it can fire late.
- Shows a **fill-up** progress bar anchored to the monthly total (`used / total`), which doesn't tell the user how close they are to *running out* right now.
- Has **no dismiss** — it sits there permanently once low.
- Sends the user **away to the usage page** to top up (`navigate(...)`), interrupting the chat.
- Renders at the **top of the chat panel**, not directly above the composer.

We're replacing the low branch with a calm, dismissible **bottom rail** that sits flush above the chat input, triggers on concrete dollar thresholds, and lets users top up without leaving chat. The screenshot prototype (`$3.42 in credits left · View usage · [Top up] · ✕` with a thin bar along the bottom) is the target.

This plan **only changes the low-credit state**. The exhausted / zero-balance state (the dark inverted "You're out of hosted credits this month" card) is the "disabled-state messaging" the spec refers to and stays as-is, except it moves to the same slot above the input.

> **Note on live updates:** the original spec asked for the number/bar to update live as credits are spent. Per product decision this is **out of scope** — the balance is whatever the route loader produced (it refreshes on navigation, reload, and return from Stripe). The expected flow is "user gets the alert, dismisses it," so a live ticker isn't worth the backend plumbing.

## Goals

1. **Dollar-threshold triggers.** Fire when the remaining balance crosses below **$5.00, $2.50, $1.00, $0.10**. Each is a fresh trigger; dismissing at one threshold does not suppress lower ones.
2. **Bottom-rail layout.** A single-line, full-width-of-the-composer rail: balance · View usage · Top up · Dismiss, with a thin ~4px progress bar flush against the bottom edge, anchored to $5 (empties as credits are spent).
3. **Dismissible, per-user + per-org, cross-tab.** One click hides it everywhere in the browser for the same signed-in user and org — dismissing on one tab must never leave it showing on another. It stays hidden until that org's balance crosses the next lower threshold (or recovers above $5).
4. **Top up in chat.** Open the top-up modal in-chat instead of navigating to settings.
5. **Move it above the input.** Render directly above `PromptInput`, full width of the composer column.
6. **Accessible.** aria-label on dismiss, screen-reader announcement when it appears at a new threshold, progressbar aria, correct tab order, contrast in light/dark.

---

## Current State (reference — read before changing)

| Thing | Location |
|---|---|
| Component | `src/components/chat-billing-credit-notice.tsx` — `BillingCreditNotice` (exhausted branch lines 33–84, low branch 86–124) |
| Data model + builder + dev overrides | `src/lib/chat-credit-status.ts` — `BillingCreditStatus`, `buildBillingCreditStatus`, `applyDevBillingCreditStatusOverride`, `getDevBillingCreditStatus` |
| Render / call site | `src/components/Chat.tsx:4625-4632` (currently at the **top of the chat panel**, above the scroll container) |
| Composer / input | `src/components/Chat.tsx:4716-4775` — the `max-w-3xl mx-auto` container holding `<PromptInput>` at 4743 |
| Loader wiring | `src/routes/_app.chat.$id.tsx:965-972` (and the `_index` route) build `billingCreditStatus`; passed to `<Chat>` at 1338 |
| Top-up dialog | `src/components/billing/top-up-dialog.tsx` — `TopUpDialog`, `TopUpDialogPack` |
| Usage page + Stripe action | `src/routes/_app.settings.organization.usage.tsx` — `fetchConfiguredCreditPacks`, `createCreditsCheckoutSession`, `buyCredits` action, `canTopUpCredits` logic (lines 245–248) |
| Dismissal pattern reference | `src/components/legacy-user-banner.tsx` (localStorage read/write helpers, SSR guards, `userId` prop) |
| `$X.XX` formatter | `formatUsdFromCents(cents)` in `src/lib/billing.ts:89` → exactly two decimals with `$` |
| Dev preview route | `src/routes/dev.chat-credit-states.tsx` |
| Primitives | `Progress` (`src/components/ui/progress.tsx`, default `h-1` 4px, `bg-muted` track, `bg-primary` indicator, `transition-all`), `Button` (`src/components/ui/button.tsx`, `size="sm"` + `variant` `default`/`ghost`, `size="icon-sm"`) |
| Available in `Chat.tsx` already | `isAdmin` / `isOrgAdmin`, current user id via `user?.id`, current org id via `currentOrg?.id` from `useAuthData()` |

---

## Visual Design

Reference: the bottom-rail prototype. Calm and neutral — it should feel like part of the composer, not a floating notification.

```
   ── inside the composer column (max-w-3xl), directly above PromptInput ──

   ┌──────────────────────────────────────────────────────────────────────┐
   │  $3.42 in credits left              View usage   [ Top up ]      ✕     │
   │ ███████████████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │ ← 4px bar, flush to bottom edge
   └──────────────────────────────────────────────────────────────────────┘
        ▲                    ▲              ▲           ▲             ▲
    "$3.42" emphasized   "in credits    ghost,       primary       icon-sm
    (foreground,          left" muted   muted text   filled pill   ghost X
     font-semibold)                     (tertiary)   (default btn)

   [ Type a message…                                              📎  ▷ ]   ← PromptInput (unchanged)
```

Fill = `remaining / $5`. At $3.42 → 68% filled from the left; the bar **empties** as credits are spent.

### Container (the rail)

- **Root:** `relative overflow-hidden rounded-lg border bg-card text-card-foreground px-3 py-2.5`
  - `relative overflow-hidden` so the absolutely-positioned bottom bar is clipped to the rounded corners.
  - `bg-card` + `border` = neutral surface that adapts to light/dark and reads as composer chrome. **No** amber/red/blue.
  - `py-2.5` leaves the content clear of the 4px bar pinned to the bottom edge.
- **Placement wrapper:** the rail is `shrink-0 mb-2` and rendered as a child of the composer's `max-w-3xl mx-auto` container (see Placement). It does **not** need its own `mx-auto max-w-3xl px-4` wrapper anymore — it inherits the composer width.

### Row (single line, left → right)

`<div className="flex items-center gap-2">`

1. **Balance label** — `min-w-0 flex-1 truncate text-sm`. Single line only — **no secondary sentence, no BYOK explanation** (dropped per decision; if a user sees this alert they're on hosted credits and can add their own key in Settings → AI Provider).
   - Amount emphasized: `<span className="font-semibold text-foreground">{formatUsdFromCents(availableCents)}</span>`
   - Rest muted: `<span className="text-muted-foreground"> in credits left</span>`
   - `flex-1` pushes the actions to the right; `truncate` protects narrow widths.
2. **View usage** — tertiary. `<Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={onOpenUsage}>View usage</Button>` (plain muted text, no border/fill; subtle hover).
3. **Top up** — primary CTA. `<Button size="sm" onClick={onTopUp}>Top up</Button>` (default variant = filled primary pill, the same near-black as the bar in light mode). Render **only when `canTopUp`** (see Non-admins).
4. **Dismiss** — `<Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label="Dismiss low credit alert" onClick={onDismiss}><X className="size-3" /></Button>` (lucide `X`).

### Progress bar (thin, flush to bottom)

```tsx
<Progress
  value={remainingPercentOfFive}      // clamp((availableCents / 500) * 100, 0, 100)
  aria-label="Credits remaining"
  aria-valuetext={`${formatUsdFromCents(availableCents)} of $5.00`}
  className="absolute inset-x-0 bottom-0 rounded-none"
/>
```

- `Progress` is already `h-1` (4px), `w-full`, `bg-muted` track, `bg-primary` indicator. Only overrides needed: **position** (`absolute inset-x-0 bottom-0`) and **square corners** (`rounded-none`); the container's `overflow-hidden rounded-lg` clips the bar to the rounded shape.
- Indicator uses `translateX(-(100 − value)%)`, so `value=100` is full (at $5) and `value=0` is empty (at $0).

**Fill color (decision):** use the default `bg-primary` indicator on the `bg-muted` track. With the zinc theme this is **dark fill in light mode, light fill in dark mode**, and the track is always the opposite tone — so there's always contrast and never a white-bar-on-white-background. It also matches the Top up button and the prototype. If we later want it louder, the smallest change is to add an `indicatorClassName` prop to `Progress` and pass `bg-foreground`; don't do that pre-emptively — ship `bg-primary` and we'll judge it on screen.

### Exhausted state (unchanged, just relocated)

Keep the existing dark inverted card (`bg-foreground text-background`, "You're out of hosted credits this month", including its existing BYOK/admin copy) exactly as in `chat-billing-credit-notice.tsx:33-84`. It is the "disabled-state messaging." It moves to the same above-input slot. It is **not** dismissible. Make sure both states align to the composer width (drop the old `mx-auto max-w-3xl px-4 md:px-6` outer wrapper since the slot now provides width).

---

## Behavior — thresholds & dismissal

Put the threshold math in `chat-credit-status.ts` as **pure, unit-testable** functions; keep the React/storage glue in the component.

### Threshold tiers

```ts
// src/lib/chat-credit-status.ts
export const LOW_CREDIT_THRESHOLDS_CENTS = [500, 250, 100, 10] as const; // $5, $2.50, $1, $0.10

/**
 * The active tier = the smallest threshold strictly greater than the balance.
 * null when balance >= $5 (no alert) or when exhausted (handled separately).
 *   $3.42 (342) -> 500   |  $0.90 (90) -> 100  |  $0.05 (5) -> 10  |  $6.00 -> null
 */
export function activeLowCreditTier(availableCents: number): number | null {
  let tier: number | null = null;
  for (const t of LOW_CREDIT_THRESHOLDS_CENTS) {
    if (availableCents < t && (tier === null || t < tier)) tier = t;
  }
  return tier;
}

/** Show iff there is an active tier AND we are at a lower tier than the one we last dismissed. */
export function shouldShowLowCreditAlert(
  activeTier: number | null,
  dismissedTier: number | null,
): boolean {
  if (activeTier === null) return false;
  return dismissedTier === null || activeTier < dismissedTier;
}
```

### Visibility state machine (in the component)

- Compute `activeTier = activeLowCreditTier(availableCents)` from the loader balance.
- If `availableCents <= 0` (exhausted) → render the exhausted card (no dismissal logic).
- Else read `dismissedTier` from storage (see Storage). Show the rail iff `shouldShowLowCreditAlert(activeTier, dismissedTier)`.
- **Reset on recovery:** whenever `activeTier === null` (balance back ≥ $5), clear `dismissedTier` from storage so the next dip below $5 is a fresh trigger. (This is why the builder must keep returning a status object even when the balance is healthy — see Data Model.)
- **On dismiss:** write `dismissedTier = activeTier`, play the exit animation, then unmount.

Truth table (dismissed at the $5 tier, i.e. `dismissedTier = 500`):

| Balance | activeTier | show? | why |
|---|---|---|---|
| $4.20 | 500 | hidden | dismissed at this tier |
| $2.60 | 500 | hidden | still tier 500 |
| $2.40 | 250 | **show** | dropped below $2.50 (lower tier) |
| (dismiss again → dismissedTier=250) | | | |
| $0.90 | 100 | **show** | dropped below $1.00 |
| $6.00 | null | hidden + reset | back above $5; clears dismissedTier |

**Edge note for the reviewer:** if a user *dismisses* and then *partially* tops up upward but stays below $5 (e.g. dismissed at $1 tier, tops up to $3), the rail stays hidden until they cross a still-lower threshold or rise above $5. The spec's "alert remains with the updated number after a partial top-up" describes the common flow where the user clicked **Top up while the alert was visible (not dismissed)** — there `dismissedTier` is null, so the rail stays visible. Both fall out of the logic above; note it in the PR.

### Storage — cross-tab, per-user + per-org

> **🛠 For the backend agent — please audit this section.** The product requirement is: **dismissing on one tab must not leave the alert showing on another tab.** `sessionStorage` is per-tab and fails this. The plan below uses `localStorage` + the `storage` event, which solves cross-tab within one browser without any backend. If you'd rather make dismissal server-authoritative (cross-device, survives storage clears) via a per-user `UserDO`/KV flag, that's a reasonable alternative — call it. See the tradeoff at the end of this section.

Recommended (frontend-only) mechanism:

- **`localStorage`, keyed by user + org:** `low_credits_alert_dismissed_tier:${userId}:${orgId}` → the dismissed tier in cents (string). Credits are org-scoped, so **do not key by user only**; otherwise a user who dismisses a low-credit alert in org A could suppress org B's alert even though org B has a different balance. Helpers `readDismissedTier(userId, orgId)` / `writeDismissedTier(userId, orgId, tier | null)` should have `typeof window` SSR guards + try/catch, modeled on `legacy-user-banner.tsx:31-62`. Pass `user?.id` and `currentOrg?.id` from `Chat.tsx` into the component. In the dev preview, use stable mock ids.
- **Cross-tab sync:** subscribe to `window.addEventListener('storage', …)`. The `storage` event fires in *other* tabs when one tab writes, so a tab that's currently showing the alert hides it the instant another tab dismisses (and reset-on-recovery propagates the same way). Navigations / new tabs read fresh from `localStorage` on mount, so they're covered too.
- **Hydration:** read in a `useEffect` after mount and gate the first render with an `isReady` flag (like the legacy banner) so SSR and the first client render don't mismatch. If either `userId` or `orgId` is unexpectedly missing, fail closed on persistence: render based on the current in-memory state, but do not write a shared storage key.

**Behavioral consequence (confirm acceptable):** because `localStorage` persists, a dismissal lasts **until the next lower threshold or recovery above $5** for that same browser/profile/user/org — it does *not* re-nag at the start of each new browser session. This matches the stated intent ("show once, don't show again until the next milestone") and is what makes cross-tab work cleanly. If a fresh nag per new session is also wanted, that needs a session-id tag stored alongside the tier, or server-backed per-session state — flag for the backend agent. (Cross-*device* dismissal is likewise out of scope for `localStorage`; only call it in if the team wants it.)

### Dismiss animation

- Appear: `animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none`.
- Dismiss: set a local `isDismissing` state, apply `animate-out fade-out-0 slide-out-to-bottom-1 duration-150 motion-reduce:animate-none`, unmount on `onAnimationEnd` (or a matched `setTimeout`). Write to `localStorage` immediately on click so a re-render mid-animation (or a cross-tab event) doesn't resurrect it.

---

## Interactions — View usage & Top up

### View usage
Keep `onOpenUsage = () => navigate("/settings/organization/usage")` (the user is intentionally leaving chat). No change.

### Top up (in-chat modal — new)

The "Top up" button must open `TopUpDialog` **in chat** rather than navigating to settings.

> **🛠 For the backend agent — please audit the resource route + Stripe piping below** (auth, `returnTo` validation, checkout URL building).

1. **Own the dialog in `Chat.tsx`.** Add `const [topUpOpen, setTopUpOpen] = useState(false)`. The rail's `onTopUp` sets it true. Render `<TopUpDialog open={topUpOpen} onOpenChange={setTopUpOpen} packs={packs} action="/api/billing/credit-packs" returnTo={currentChatPath} loading={packsLoading} />` near the composer.
2. **Lazy-load packs (keep chat load fast).** Do **not** add a Stripe call to the chat loader — `getOrgBillingOverview` is already on the hot path and the chat-perf work guards loader latency. Instead create a tiny resource route and fetch on first open:

   **New file `src/routes/api/billing.credit-packs.ts`** (register in `src/routes.ts`):
   - Before adding the route, extract the duplicated credit-pack formatting from `_app.settings.organization.usage.tsx` into a shared helper (for example `src/lib/billing-credit-packs.ts`, or `src/lib/billing.ts` if the team prefers). The route should not import helper functions from the usage route module.
   - Also extract a shared `canBuyCreditsForBillingState(...)` helper (or similarly named) from the current `canTopUpCredits` rule and reuse it in:
     - `_app.settings.organization.usage.tsx`
     - `src/routes/api/billing.credit-packs.ts`
     - `createCreditsCheckoutSession`'s final server-side eligibility check
     This avoids three copies of the billing-plan/status logic drifting.
   - `loader`: `requireAuthContext`; determine org-admin role from `authContext.orgs` (same rule as chat/settings). If Stripe is configured, return `{ packs: TopUpDialogPack[], canTopUp, unavailableReason? }` using `fetchConfiguredCreditPacks(env)` + the shared formatter. `canTopUp` should mean **admin + Stripe configured + billing state eligible for credit purchase**. Else return `{ packs: [], canTopUp: false, unavailableReason }`. Do not call Stripe when `isStripeBillingConfigured(env)` is false.
   - `action`: handle `intent: "buyCredits"` → `requireOrgAdmin` → `createCreditsCheckoutSession({ env, org, customerEmail, successUrl, cancelUrl, priceId })` → `throw redirect(url)`. The action remains the authority: it must re-check admin, allowed price ids, Stripe configuration, and latest org billing state even if the loader said `canTopUp: true`.
   - Build `successUrl`/`cancelUrl` from a `returnTo` form field using a small pure helper. Validate it as a same-origin **chat path** (default `/chat`): reject external origins, protocol-relative values (`//evil.com`), and non-chat paths. Append `checkout=success` / `checkout=cancelled` while preserving any existing chat query params. This prevents an open redirect while still returning the user to the exact chat.

   In `Chat.tsx`, `const packsFetcher = useFetcher<…>()`; on `onTopUp`, `setTopUpOpen(true)` and, if not already loaded, `packsFetcher.load("/api/billing/credit-packs")`. Pass `packs = packsFetcher.data?.packs ?? []` and `loading = packsFetcher.state !== "idle"`.
3. **`TopUpDialog` changes** (`src/components/billing/top-up-dialog.tsx`):
   - Add optional props `action?: string` (thread into each `<Form action={action}>`; default keeps current same-route behavior so the usage page is unaffected), `returnTo?: string` (hidden `<input name="returnTo">` in each form), `loading?: boolean`, `canTopUp?: boolean`, and `unavailableReason?: string | null`.
   - When `loading && packs.length === 0`, show a small skeleton/spinner row instead of an empty body.
   - When `!loading && (!canTopUp || packs.length === 0)`, show a compact unavailable message and no Buy buttons. Keep it neutral; this is mostly for Stripe/config/eligibility edge cases.
4. **Return + refresh.** Stripe Checkout is a hosted full-page redirect (existing, tested flow — **embedded Checkout is explicitly out of scope**). "Does not leave their current chat" is honored at the **pack-picker** step; payment uses hosted Checkout and returns to the chat URL via `returnTo`. On return, the chat loader re-runs → balance refreshes → if now ≥ $5 the rail is gone (and `dismissedTier` resets); if still low, it shows the updated number. Optionally: on `?checkout=success`, toast "Credits added" and strip only the `checkout` param via `setSearchParams(nextParams, { replace: true })` so existing chat/dev query params are preserved.

### Non-admins
For the rail, when the signed-in user is not an org admin, **omit the Top up button** — the row becomes balance · View usage · Dismiss. (The exhausted card already swaps copy to "Ask an organization admin to top up credits" for non-admins; leave that.)

For admins, the button can open the lazy-loaded dialog. If the resource route returns `canTopUp: false` or no packs (Stripe disabled, free plan not eligible, misconfigured price ids), the dialog should show a compact unavailable state instead of an empty list.

---

## Data Model Changes (`src/lib/chat-credit-status.ts`)

The builder currently returns `null` unless `isLow || isExhausted`, and `isLow` is `usedPercent >= 80`. Change the contract carefully:

1. **Switch the trigger from percent to dollars, and keep returning a status object even when healthy.** Keep the early `null` returns for `enterprise` and BYOK-covered-thread (those never show the alert). **Do not return `null` solely because `total_credit_limit_cents <= 0`**: for credit-based hosted orgs with zero total credits and `available_credits_cents <= 0`, return an exhausted status so the disabled-state card can render. **Remove** the `if (!isLow && !isExhausted) return null;` gate.
   - **Why keep it non-null when healthy?** The component owns dismissal/threshold state and must be able to detect **recovery** (balance ≥ $5) to clear the dismissed tier — otherwise a user who dismissed at $5, topped up above $5, then dipped again would never see a fresh trigger. So the component must mount (and render nothing visually) on healthy balances. The payload is a few ints — negligible, and `getOrgBillingOverview` already runs in the chat loader, so there's no new fetch.
   - **Ordering matters:** compute `hasByokProvider` / BYOK model coverage before returning the healthy status object, so a BYOK-covered thread still returns `null` and does not mount the hosted-credit component.
2. **Trim the type** to what the rail/exhausted card need:
   ```ts
   export interface BillingCreditStatus {
     availableCreditsCents: number;
     totalCreditLimitCents: number; // may be 0 for never-funded exhausted orgs
     isExhausted: boolean;        // availableCreditsCents <= 0
     hasByokProvider: boolean;    // still used by the exhausted card's copy
     // usedPercent / isLow: remove if unused, else mark optional. The low rail
     // uses availableCreditsCents vs $5, NOT usedPercent.
   }
   ```
   Update `getDevBillingCreditStatus` / `applyDevBillingCreditStatusOverride` and any tests.
3. **Dev overrides:** extend `DevChatCreditState` so the dollar tiers are previewable — e.g. balances `450` ($4.50, tier 500), `220` ($2.20, tier 250), `80` ($0.80, tier 100), `5` ($0.05, tier 10), plus `healthy` (≥$5 → renders nothing) and `exhausted`. Update `parseDevChatCreditState` and `dev.chat-credit-states.tsx`'s `PREVIEW_STATES`.

> **🛠 For the backend agent:** current repo search shows `buildBillingCreditStatus` / `billingCreditStatus` touched by the chat thread route, chat index route, `Chat.tsx`, the dev preview, and `tests/chat-credit-status.test.ts`. Update those known consumers and do one final `rg` before flipping the old `null`-when-healthy contract.

---

## Placement (move the alert above the input)

Today both states render at `Chat.tsx:4625-4632`, at the top of the chat panel. Move the render **into the composer**, directly above `<PromptInput>`:

- **Remove** the block at `Chat.tsx:4625-4632`.
- **Insert** the rail as a child of the `max-w-3xl mx-auto w-full flex flex-col` composer container (4719), immediately **after** the `noModelsMessage` block (4738-4742) and **before** `<PromptInput>` (4743). Give it `shrink-0` so it isn't squeezed by the scrollable todos/question region above it.
- Order above the input, top→bottom: pending question / todos → `noModelsMessage` → **credit rail / exhausted card** → `PromptInput`.
- This makes the rail exactly the composer width ("full width of the input container") and visually attached to it. Leave `ChatErrorNotice` (send-blocked inline error) where it currently renders — out of scope.

---

## Accessibility

- **Dismiss:** `aria-label="Dismiss low credit alert"` (already specified).
- **Announce when it appears at a new threshold:** add an `sr-only` live region whose text is keyed to the **tier**, so it announces on first appearance and on each tier change:
  ```tsx
  <span className="sr-only" role="status" aria-live="polite">
    {`Low credit warning. Balance below ${formatUsdFromCents(activeTier)}.`}
  </span>
  ```
  Keep the visible amount/buttons/bar outside any live region.
- **Progress bar:** radix `Progress` already renders `role="progressbar"` with `aria-valuemin/max/now`; add `aria-label="Credits remaining"` and `aria-valuetext="$3.42 of $5.00"` for a meaningful readout. (Confirm radix forwards `aria-valuetext`; if not, set it on the root element.)
- **Tab order:** DOM order must be balance text → View usage → Top up → Dismiss (the row order above already matches). Balance is non-interactive text.
- **Contrast:** `bg-card`/`text-card-foreground`, `text-muted-foreground` (View usage), `bg-primary`/`text-primary-foreground` (Top up), `bg-primary` bar fill on `bg-muted` track — all design-system token pairs that meet contrast in both themes. Verify the muted "View usage" (≥4.5:1) and the 4px bar fill (≥3:1) in dark mode.
- **Reduced motion:** `motion-reduce:animate-none` on enter/exit.

---

## Dev preview updates (`src/routes/dev.chat-credit-states.tsx`)

- Replace the low/byok preview states with the new dollar-tier states (`$4.50`, `$2.20`, `$0.80`, `$0.05`, plus `exhausted` and a `healthy` no-render case). Keep the error-state previews as-is.
- The route already renders the notice directly above the simulated input (lines 197-214) — keep that. Wire mock `onTopUp`/`onOpenUsage`/`onDismiss` no-ops and mock `userId` + `orgId` so the dismissal flow is exercisable. Add a "Top up modal" preview that opens `TopUpDialog` with a couple of fake packs and `loading` toggled, so the in-chat modal can be reviewed without Stripe.
- Verify each tier in light + dark: bar fill proportion, single-line layout at narrow widths, dismiss animation, and that crossing to a lower tier re-shows after dismiss.

---

## Implementation Checklist

1. **`src/lib/chat-credit-status.ts`**
   - Add `LOW_CREDIT_THRESHOLDS_CENTS`, `activeLowCreditTier`, `shouldShowLowCreditAlert` (pure).
   - Remove the `isLow`-percent gate so the builder returns a status for any credit-based, non-enterprise, non-BYOK-covered org; trim the type (drop/optionalize `usedPercent`/`isLow`).
   - Extend dev-state helpers for the new dollar tiers + `healthy`.
2. **`src/components/chat-billing-credit-notice.tsx`**
   - Keep the exhausted branch; rebuild the low branch as the bottom rail (container + single row, no BYOK line + flush `Progress` + sr-only live region).
   - Add props `userId: string | null` and `orgId: string | null`. Compute tier from `availableCreditsCents`; manage `dismissedTier` in `localStorage` keyed by user+org (helpers modeled on `legacy-user-banner.tsx`); subscribe to the `storage` event for cross-tab sync; gate visibility; reset on recovery; animate dismissal.
   - Hide Top up when `!canTopUp`.
3. **`src/components/billing/top-up-dialog.tsx`**
   - Add optional `action?: string`, `returnTo?: string` (hidden input), `loading?: boolean` (skeleton row), `canTopUp?: boolean`, and `unavailableReason?: string | null`. Default behavior unchanged for the usage page.
4. **Shared billing helpers + `src/routes/api/billing.credit-packs.ts`** (new) + register in **`src/routes.ts`**
   - Extract shared credit-pack formatting and credit-purchase eligibility helpers; update the usage page and `createCreditsCheckoutSession` to reuse them.
   - `loader` → `{ packs, canTopUp, unavailableReason? }`; `action` `buyCredits` → Stripe checkout with validated chat `returnTo` success/cancel URLs.
   - Add unit coverage for the `returnTo` sanitizer: external URL rejected, `//host` rejected, `/settings/...` rejected, `/chat/...?...` accepted, existing query params preserved when adding `checkout`.
5. **`src/components/Chat.tsx`**
   - Move the notice render from 4625-4632 to directly above `<PromptInput>` (after `noModelsMessage`), `shrink-0`.
   - Add `topUpOpen` state + `packsFetcher`; wire `onTopUp` to open the dialog and lazy-load packs; render `<TopUpDialog action="/api/billing/credit-packs" returnTo={currentChatPath} …/>`. Derive `currentChatPath` from `useLocation()` as `pathname + search + hash` (internal path only, no origin).
   - Pass the current `user?.id` and `currentOrg?.id` to the notice.
   - Optional: toast + strip only `checkout` from the current search params.
6. **`src/routes/dev.chat-credit-states.tsx`** — new tier states + Top-up modal preview.
7. **Tests**
   - Unit: `activeLowCreditTier` / `shouldShowLowCreditAlert` (the truth table above), and `buildBillingCreditStatus` (healthy → returns object but rail hidden; below each threshold; zero total/zero available → exhausted object; BYOK-covered → null; enterprise → null).
   - Unit: credit purchase eligibility helper and `returnTo` sanitizer.
8. **Smoke**: `bun run typecheck`; walk `/dev/chat-credit-states` tiers in light+dark; in a real chat, dismiss + confirm it stays hidden after navigating to another chat group / opening a second tab, and re-shows only at a lower tier; click Top up → modal opens in chat; verify the bar empties left as the balance drops across tiers.

## Files to Modify

| File | Change |
|---|---|
| `src/lib/chat-credit-status.ts` | Threshold pure fns; drop percent gate (keep non-null when healthy); dollar-tier dev states; type trim. |
| `src/components/chat-billing-credit-notice.tsx` | Rebuild low branch as the dismissible bottom rail (no BYOK line); keep exhausted card; `localStorage` + cross-tab dismissal; flush `Progress`; sr-only announce. |
| `src/components/billing/top-up-dialog.tsx` | Optional `action` / `returnTo` / `loading`. |
| shared billing helper file(s) | Credit-pack dialog formatting; credit-purchase eligibility helper; checkout returnTo sanitizer. |
| `src/routes/api/billing.credit-packs.ts` *(new)* + `src/routes.ts` | Resource route: packs loader + `buyCredits` action with validated return-to-chat. |
| `src/components/Chat.tsx` | Relocate render above input; in-chat `TopUpDialog` + lazy packs; pass `userId` + `orgId`. |
| `src/routes/dev.chat-credit-states.tsx` | New tier previews + Top-up modal preview. |
| tests | Threshold/builder units; credit purchase eligibility; checkout returnTo sanitizer. |

## Out of Scope

- **Live mid-session balance updates** (removed by decision — balance is loader-driven, refreshing on navigation/reload/Stripe return). No `chat-thread-do.ts` / WebSocket changes.
- **Embedded (in-page) Stripe Checkout** — hosted Checkout with return-to-chat is used.
- Changing exhausted-state visuals/copy or disabling `PromptInput` at zero balance (input stays enabled; sending surfaces the existing inline error).
- Enterprise / BYOK-covered threads (builder returns `null`; rail never renders). Never-funded hosted orgs with zero available credits should render the exhausted state, not disappear.
- The send-blocked `ChatErrorNotice` line; the thresholds themselves (fixed at $5 / $2.50 / $1 / $0.10).

## Decisions (locked)

- **Hosted Stripe Checkout**, returns to chat. No embedded Checkout.
- **No live updates** — balance comes from the loader.
- **Drop the BYOK explanation line** in the low rail (single line only).
- **Dismissal = `localStorage` + cross-tab `storage` sync**, keyed by user+org and tier-based; persists until the next lower threshold or recovery above $5. Cross-tab is a hard requirement (dismiss on one tab must not show on another).
- **Bar fill = default `bg-primary`** (dark in light mode, light in dark mode, on a muted track). Will revisit only if it reads too quiet on screen.

## For the backend agent to audit

1. **Dismissal storage** — is `localStorage` + `storage`-event cross-tab sync acceptable, or do you want server-backed (`UserDO`/KV) per-user/per-org dismissal (cross-device / survives storage clears)? (Behavioral tradeoff noted in Storage.)
2. **`api/billing.credit-packs.ts`** — the resource-route loader/action: auth (`requireAuthContext` / `requireOrgAdmin`), shared purchase-eligibility helper, `returnTo` chat-path validation, and `successUrl`/`cancelUrl` construction for hosted Checkout returning to the chat.
3. **`buildBillingCreditStatus` contract flip** — current repo search shows consumers in `Chat.tsx`, `_app.chat.$id.tsx`, `_app.chat._index.tsx`, `dev.chat-credit-states.tsx`, and `tests/chat-credit-status.test.ts`. Confirm no hidden consumer depends on the old "null when healthy" behavior before returning a status object for healthy balances.
