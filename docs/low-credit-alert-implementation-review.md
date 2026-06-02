# Low Credit Alert Implementation Review

Scope reviewed: low-credit alert, chat placement/top-up modal, billing credit-pack route/helpers, and related tests. I intentionally ignored the separate admin usage-credit grant work. There are also unrelated connections diffs in this workspace; those are outside this review.

## Findings

### 1. Lower-threshold re-alerts are stale during the same chat session

**Severity: high**

The implementation still treats `billingCreditStatus` as loader-only data. After an agent turn consumes credits, the chat UI does not refresh this status unless the user navigates, reloads, or returns from Stripe. The completed-turn paths in `src/components/Chat.tsx` update messages/loading state, but they do not revalidate or fetch fresh billing status:

- Codex/runtime completion: `src/components/Chat.tsx:2580-2612`
- SDK/result completion: `src/components/Chat.tsx:3029-3054`
- The notice only receives the loader snapshot at `src/components/Chat.tsx:4774-4783`

That means a user can dismiss the alert at one tier and then spend through a lower tier without the component ever seeing the new balance. This is a likely explanation for "I dismissed it and it did not pop up again later."

Decision / recommended patch:

We should solve this staleness with a **single lightweight post-turn billing-status refresh**, not live updates and not broad route revalidation.

Rationale:

- Dropping live updates should mean "do not stream the balance/bar every few cents," not "the alert can stay wrong for an entire long chat session."
- Credits are charged by completed turns, so one refresh when a turn completes is the right granularity.
- Broadening the buckets is not enough. A user can start around `$1.20`, dismiss the `$1` alert, run one expensive turn, and land below `$0.50` without navigating. Broader thresholds make the bug less visible, but do not make the alert correct.
- Full route revalidation after every turn is riskier because chat uses optimistic/deferred/streaming local state. Prefer a small resource route that only returns the billing-credit status payload.

Implementation shape:

1. Keep the low-credit thresholds as `$5.00`, `$2.50`, `$1.00`, and `$0.50` (see finding #2 for replacing the current `$0.10` tier).
2. Add a lightweight resource route, for example `src/routes/api/billing.chat-credit-status.ts`, registered as `/api/billing/chat-credit-status`.
3. Route contract:
   - `loader`: `requireAuthContext(request, context)`.
   - Read the active model from a query param such as `?model=${selectedThreadModel}` and validate it with the existing model helpers (`isLlmModel` if available in the route's import graph). If invalid/missing, pass `null` to the builder rather than trusting arbitrary input.
   - Fetch `getOrgBillingOverview(env, authContext.currentOrg)`.
   - Fetch the org's LLM provider config from `OrgDO` so BYOK-covered models can still return `null`, matching the chat loader's behavior.
   - Return `{ billingCreditStatus: buildBillingCreditStatus(overview, llmProviderConfig?.provider, model) }`.
   - On failures, log and return `{ billingCreditStatus: null }` or a typed `{ error }`; do not break chat rendering.
4. In `Chat.tsx`, keep local state initialized from the loader:
   ```tsx
   const [currentBillingCreditStatus, setCurrentBillingCreditStatus] =
     useState(billingCreditStatus);

   useEffect(() => {
     setCurrentBillingCreditStatus(billingCreditStatus);
   }, [billingCreditStatus]);
   ```
5. Render `BillingCreditNotice` from `currentBillingCreditStatus`, not directly from the loader prop.
6. After each completed assistant turn, trigger one refresh:
   - Codex/runtime completion path around `src/components/Chat.tsx:2580-2612`
   - SDK/result completion path around `src/components/Chat.tsx:3029-3054`
   - Any other completion path that marks the turn idle and clears pending messages
7. Use a helper such as `refreshBillingCreditStatusAfterTurn()` that guards duplicate calls for the same completion if multiple terminal events can fire for one turn.
8. Use `useFetcher` or `fetch`; either is fine. If using `fetch`, abort/ignore stale responses on unmount or when a newer request wins.
9. Refresh after **every completed hosted-capable turn**, not only when the previous balance was already below `$5`, because one expensive turn can cross from healthy to low. It is acceptable if the route returns `null` for enterprise/BYOK-covered cases.

Suggested client-side fetcher sketch:

```tsx
const billingStatusFetcher = useFetcher<{
  billingCreditStatus: BillingCreditStatus | null;
}>();

useEffect(() => {
  if (!billingStatusFetcher.data) return;
  setCurrentBillingCreditStatus(billingStatusFetcher.data.billingCreditStatus);
}, [billingStatusFetcher.data]);

const refreshBillingCreditStatusAfterTurn = useCallback((completionKey: string) => {
  if (lastBillingRefreshCompletionKeyRef.current === completionKey) return;
  lastBillingRefreshCompletionKeyRef.current = completionKey;
  const params = new URLSearchParams();
  if (selectedThreadModel) params.set("model", selectedThreadModel);
  billingStatusFetcher.load(`/api/billing/chat-credit-status?${params}`);
}, [billingStatusFetcher, selectedThreadModel]);
```

Regression coverage:

- Helper: dismissed tier `250`, refreshed balance `80` shows again.
- Helper after threshold update: dismissed tier `100`, refreshed balance below `50` shows again.
- Component or route-level test if practical: loader status hidden after dismiss, post-turn resource response updates `currentBillingCreditStatus`, and the notice reappears for the lower tier without navigation.

### 2. The lowest threshold should move from 10 cents to 50 cents

**Severity: medium**

The current implementation keeps the original `10` cent threshold:

- `src/lib/chat-credit-status.ts:12`
- Tests encode the current behavior at `tests/chat-credit-status.test.ts:47-48`

Product feedback from testing is that 10 cents is too small. Change the threshold list from:

```ts
export const LOW_CREDIT_THRESHOLDS_CENTS = [500, 250, 100, 10] as const;
```

to:

```ts
export const LOW_CREDIT_THRESHOLDS_CENTS = [500, 250, 100, 50] as const;
```

Then update:

- `DevChatCreditState`: rename `low-10` to `low-50`
- dev preview labels and balances in `src/routes/dev.chat-credit-states.tsx`
- `tests/chat-credit-status.test.ts` expectations

Note: the helper intentionally fires when balance is **below** a threshold (`availableCents < threshold` at `src/lib/chat-credit-status.ts:27`). If product language is "at 50 cents remaining," change the comparison to `<=` and update all boundary tests. If the desired behavior is "below 50 cents," keep `<`.

### 3. Initial top-up modal can briefly show an unavailable state before the pack fetch starts

**Severity: low**

In `Chat.tsx`, `handleBillingTopUp()` sets `topUpOpen` and starts `creditPacksFetcher.load(...)`, while the dialog derives:

- `packs={creditPacksFetcher.data?.packs ?? []}`
- `loading={creditPacksFetcher.state !== "idle"}`
- `canTopUp={creditPacksFetcher.data?.canTopUp ?? Boolean(isAdmin)}`

See `src/components/Chat.tsx:4815-4825`.

On the first render after opening, there is a possible transient state where the dialog is open, packs are empty, `canTopUp` is true, and `loading` is false, which makes `TopUpDialog` show "Top-up is not available right now." before the fetcher state flips to loading.

Recommended patch:

- Track a local `hasRequestedCreditPacks` boolean, or derive `loading` as true while the dialog is open and no fetcher data has arrived yet.
- Example shape: `loading={topUpOpen && !creditPacksFetcher.data ? true : creditPacksFetcher.state !== "idle"}`.

## User-Reported Slow/Disappearing Interim Messages

I do not see evidence that the low-credit alert diff directly causes interim chat messages to disappear. The `Chat.tsx` changes in this diff are limited to checkout query handling, top-up fetcher state, moving the billing notice, and rendering `TopUpDialog`. They do not modify the streaming/deferred message update logic.

The low-credit implementation does expose one adjacent issue: because billing status is not refreshed after completed turns, the alert can lag behind actual usage. Fixing that should be done with a lightweight billing-status refresh rather than a broad route revalidation until someone validates the chat streaming path under revalidation.

## What Looks Sound

- Dismissal is correctly keyed by `userId + orgId`, so one org's dismissal does not suppress another org's alert.
- Cross-tab dismissal uses `localStorage` plus the `storage` event and local same-tab state updates.
- Checkout return paths are sanitized to same-origin chat paths and preserve existing query params while adding `checkout`.
- The resource route keeps the chat loader free of Stripe credit-pack fetches.
- Exhausted zero-credit orgs now return a status object instead of disappearing.

## Verification Run

Focused tests passed:

```bash
bun run test:run tests/chat-credit-status.test.ts tests/billing-credit-packs.test.ts
```

Result: 2 test files passed, 13 tests passed.

---

# UI Review (added by the UI reviewer)

Scope: visual / UX / copy audit of the implemented diff. The backend agent's logic findings (#1–#3) stand. The items below are UI-specific, ordered by priority. The overall implementation tracks the plan well — placement, dismissal keying, cross-tab sync, dev preview, and dismiss animation all look right (see "What Looks Sound — UI" at the end).

## UI-1. Usage page copy: "prepaid" and "included" are inaccurate — **Severity: medium (user-flagged)**

On `/settings/organization/usage` the credit-balance block reads, e.g.:

> **Available prepaid credits** — $1.25 used of $1.00 **included**.

Both highlighted words are wrong for a pay-as-you-go user who simply loaded $1: that $1 isn't "included" in any plan, and the displayed balance mixes prepaid top-ups *and* admin-granted credits, so "prepaid" doesn't always apply either. Fix the two labels in `src/routes/_app.settings.organization.usage.tsx`:

1. **Balance label** (line 274): drop "prepaid".
   ```tsx
   // before
   {billingPlan === "payg" ? "Available prepaid credits" : "Available this billing period"}
   // after
   {billingPlan === "payg" ? "Available credits" : "Available this billing period"}
   ```
2. **Usage line** (lines 280–281): drop "included" **and** the `$` (see UI-2). Render as credits, keeping the unit on the total only so it doesn't read "X credits used of Y credits":
   ```tsx
   // before
   {formatUsdFromCents(usageCents)} used of {formatUsdFromCents(totalLimitCents)} included.
   // after  →  "1.25 used of 1.00 credits. Resets …"
   {(usageCents / 100).toFixed(2)} used of {formatCreditBalance(totalLimitCents)}.
   ```

Lower-priority / judgment calls (same file):
- Line 313 — "…roll over alongside any monthly **included** balance." This "included" *is* contextually correct (it refers to subscription-plan monthly credits, not the prepaid balance). Leave it, or reword to "…alongside any monthly plan credits." if you want to purge the word entirely. Not required.
- Do **not** blanket-replace "prepaid" elsewhere: `_onboarding.welcome.tsx:581-582` and `billing/paywall-takeover.tsx:146-147` say "use prepaid hosted credits," which describes the act of pre-loading credits and is accurate in that context. Scope this fix to the usage-page balance block.
- Separate observation (not a copy fix): when usage exceeds the loaded amount the line renders "1.25 used of 1.00 credits" (used > total) — numerically odd. It's real data, but if it's common for loaded-credit users, consider a clearer treatment when `usageCents >= totalLimitCents` (e.g. show the balance at 0.00 and a "limit reached" note). Optional, flag for product.

## UI-2. Drop the "$" from credit amounts — credits aren't US dollars — **Severity: medium (user-flagged)**

Credits must not be displayed with a `$`; it wrongly implies they're US dollars. Today the alert renders "**$3.42** in credits left" via `formatUsdFromCents`. Show a plain amount with the "credits" unit instead. Keep `$` **only** where the number is a real USD charge the user pays (Stripe pack `priceLabel` like "$5.00", invoice totals) — do not strip those.

**Alert — `src/components/chat-billing-credit-notice.tsx`** (drop `formatUsdFromCents` from this file entirely):
- Add a 2-decimal, no-symbol formatter, or reuse `formatCreditAmount` / `formatCreditBalance` from `@/lib/billing`, which already render `"N.NN credits"` with no `$`:
  ```tsx
  const creditAmountFormatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const formatCredits = (cents: number) =>
    creditAmountFormatter.format(Math.max(0, cents) / 100);
  ```
- Balance label (lines 224–227) → "**3.42** credits left":
  ```tsx
  <span className="font-semibold text-foreground">{formatCredits(status.availableCreditsCents)}</span>
  <span className="text-muted-foreground"> credits left</span>
  ```
  Dropping "in" reads more naturally once the symbol is gone; "`{n}` in credits left" also works if you prefer the minimal change.
- sr-only message (line 220): `Balance below ${formatCreditAmount(activeTier / 100)}.` → "…below 5.00 credits."
- `aria-valuetext` (line 259): `` `${formatCredits(status.availableCreditsCents)} of ${formatCreditAmount(500 / 100)}` `` → "3.42 of 5.00 credits."
- Remove the now-unused `formatUsdFromCents` import.

**Usage page** — the `$` only appears on the "used of" line; UI-1's replacement already removes it (`formatCreditBalance` / plain number). The big balance number (line 270, `formatCreditBalance`) and the Recent-requests "Credits" column (line 371, `formatCreditsFromUsd`) already render without `$` — no change.

**Scope check:** grep other surfaces that label a value "credits" while formatting it with `formatUsdFromCents`, and apply the same treatment. Leave genuine USD displays (Stripe checkout / pack prices, invoice amounts) with their `$`.

## UI-3. Top-up modal can flash "Top-up is not available right now" before the fetch starts — **Severity: medium**

Reinforces backend finding #3 from the UX side — this flash is user-visible every time an admin opens the modal. In `Chat.tsx:4815-4825`, `loading={creditPacksFetcher.state !== "idle"}` is `false` on the first render after `handleBillingTopUp()` opens the dialog but before the fetcher transitions to "loading". With `canTopUp` defaulting to `Boolean(isAdmin)` (true) and `packs` empty, `TopUpDialog` computes `showUnavailable = true` (`top-up-dialog.tsx:39`) and briefly shows the unavailable message before snapping to the skeleton.

Fix at the call site so the dialog reads as loading until data arrives:
```tsx
loading={topUpOpen && !creditPacksFetcher.data ? true : creditPacksFetcher.state !== "idle"}
```
(Backend #3 proposes the same; calling it out here because it's a visible UI defect, not just an edge case.)

## UI-4. First-appearance screen-reader announcement may be unreliable — **Severity: low–medium**

The `sr-only` live region (`chat-billing-credit-notice.tsx:219-221`) is rendered **with its text already present** only when the rail mounts. `aria-live="polite"` regions announce *changes* to a region that already exists; a region that appears with content in the same commit is announced inconsistently across SR/browser combinations, so "announced when it first appears at each new threshold" (a plan requirement) isn't guaranteed. Two robust options:
- Keep a persistent (always-mounted) `aria-live="polite"` element high in the notice and only set its text when the active threshold changes; or
- Use `role="alert"` for the appearance announcement. (Polite/`status` is tonally preferable for a low-credit nudge, so the persistent-region approach is better if it announces reliably.)

Worth a quick VoiceOver/NVDA check across two tiers before considering this done.

## UI-5. Mid-session staleness — decision resolved

Decision: implement backend #1's **single post-turn billing-status refresh**.

This is not a return to "live updates." The UI should not stream every balance change or animate the bar while a turn is running. Instead, after a completed assistant turn, refresh the compact billing-credit status once and let the existing threshold/dismissal logic decide whether the rail should reappear.

Expected UX after this patch:

- User sees `$1.00` tier, dismisses it.
- User runs a long/expensive turn without navigating.
- Turn completes and the client refreshes billing status once.
- If the refreshed balance is below the next lower tier (`$0.50` after finding #2 is applied), the alert reappears in the composer slot.
- If the refreshed balance is still in the dismissed tier, it stays hidden.

Do not use full route revalidation as the first implementation. Chat rendering relies on optimistic/deferred/streaming state, and the user has already seen potentially funky interim-message behavior. Keep this fix scoped to a small billing-status resource fetch so the message stream and transcript state are not disturbed.

## What Looks Sound — UI

- Placement is correct: the rail now renders inside the composer's `max-w-3xl` column, after `noModelsMessage`, directly above `PromptInput` (`Chat.tsx:4774-4784`) with `mb-2 shrink-0` — full width of the input, visually attached.
- Faithful to the mock: balance amount emphasized + muted suffix, ghost/tertiary "View usage", primary "Top up", `icon-sm` ghost dismiss with `aria-label`, thin `bg-primary`-on-`bg-muted` bar anchored to 5 credits. BYOK aside correctly dropped from the low rail; exhausted card keeps its copy and relocated cleanly.
- Dismiss animation handles reduced motion (`motion-reduce:animate-none`) and has a `setTimeout` fallback for the no-`animationend` case — good catch.
- Dev preview (`dev.chat-credit-states.tsx`) is thorough: every tier, healthy (renders nothing), exhausted ±BYOK, the in-chat top-up modal, and a dedicated loading-state preview. (Once backend #2 renames the 10¢ tier to 50¢, update the `low-10` → `low-50` state value and its "$0.05 left" label here too.)
- Top up correctly opens the modal in-chat and keeps Stripe redirect/return wiring; "View usage" still navigates out, as intended.
