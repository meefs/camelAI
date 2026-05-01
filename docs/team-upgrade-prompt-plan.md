# Team Upgrade Prompt Plan

## Problem

When a user on a Free, Starter, or Pro plan clicks **Invite member** on the team page, the invite dialog opens, the form posts, and the server-side seat check at [workers/main/src/auth.ts:2463-2493](workers/main/src/auth.ts#L2463) throws `"Your current billing plan includes 1 seat."`. That string is propagated through the action and displayed as a Sonner `toast.error` (see [src/components/settings/invite-member-dialog.tsx:96](src/components/settings/invite-member-dialog.tsx#L96)).

This is a dead-end:
- The user has typed an email, picked a role, and pressed Send before learning anything is wrong.
- The toast is a top-right destructive banner that disappears in a few seconds.
- Nothing in the UI tells them *why* their plan blocks this, what plan they need, or how to upgrade.

The path *should* still be blocked — Free/Starter/Pro genuinely don't include collaborators — but we should redirect that energy into a one-click upgrade to Team.

## Goal

Replace the toast-on-failure flow with a focused **TeamUpgradeDialog** that opens *instead of* the invite dialog when an org's plan can't host more than 1 seat. The dialog explains the limit, pitches the Team plan, and submits a one-click upgrade that delegates to the existing `/settings/organization/billing` `changePlan` action so all the Stripe edge cases (legacy migration, trialing subscription, paid subscription update via portal, brand-new checkout) are handled by the canonical code path.

Non-goals: do not change the server-side seat check, do not change how the existing invite dialog behaves on Team plans, do not introduce new Stripe plumbing.

---

## When to Show the Upgrade Dialog vs. the Invite Dialog

Only one input matters: `getOrgSeatLimit(org)` from [src/lib/billing-plans.ts:185](src/lib/billing-plans.ts#L185).

| Plan | `getOrgSeatLimit` | Behavior on **Invite member** click |
|---|---|---|
| free | 1 | **TeamUpgradeDialog** |
| starter | 1 | **TeamUpgradeDialog** |
| pro | 1 | **TeamUpgradeDialog** |
| team | dynamic seat count (≥3) | InviteMemberDialog (existing) |
| enterprise | `null` (unlimited) | InviteMemberDialog (existing) |

The decision is computed in the team route loader and passed to `TeamTable` as a single boolean `requiresTeamUpgrade`. The button's onClick branches on that flag.

The button itself stays visually unchanged — no disabled state, no warning badge. We want the upgrade prompt to be discoverable, not preemptively hidden behind a dimmed control. (Considered alternatives: a persistent "Upgrade to invite teammates" banner above the table; a disabled button with a tooltip. Both add visual clutter on every render for a moment of friction that only matters at click time. Reject.)

The server-side check at [workers/main/src/auth.ts:2463](workers/main/src/auth.ts#L2463) stays untouched as a defense-in-depth backstop — direct API hits, stale clients, and deep-linked invite forms still return the existing error.

---

## ASCII Design

### Desktop (Dialog)

```
┌──────────────────────────────────────────────────────────────────┐
│  Upgrade to Team to invite teammates                          ✕  │
│                                                                  │
│  Your Pro plan includes 1 seat. Upgrade to Team to invite        │
│  teammates and collaborate in shared workspaces.                 │
│                                                                  │
│       ┌─[ Most popular ]──┐                                      │
│  ┌─────│──────────────────│────────────────────────────────────┐ │
│  │ Team                                                         │ │
│  │                                                              │ │
│  │ $50  /seat/mo                                                │ │
│  │ + usage after credits                                        │ │
│  │ For teams shipping together · Min 3 seats                    │ │
│  │                                                              │ │
│  │ ┌────────────────────────────────────────────────────────┐  │ │
│  │ │             Start 7-day free trial                     │  │ │   ← <PlanPickerCard /> (reused)
│  │ └────────────────────────────────────────────────────────┘  │ │
│  │                                                              │ │
│  │ ✓ $10 of model credits / seat / mo                           │ │
│  │ ✓ Everything in Pro                                          │ │
│  │ ✓ 2 workspaces                                               │ │
│  │ ✓ Role-based access                                          │ │
│  │ ✓ Email inbox                                                │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────┐  ┌─────────────────────────────┐│
│  │ Cancel                     │  │ Compare plans               ││
│  └────────────────────────────┘  └─────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

The card body — pricing, "Most popular" badge, feature list, primary CTA, and pending/disabled states — is rendered by [src/components/billing/plan-picker-card.tsx](src/components/billing/plan-picker-card.tsx) (the same component used in the onboarding paywall and billing settings). The dialog only adds the title, description, and the secondary `Cancel` / `Compare plans` row underneath. There is no second copy of the team marketing card to maintain.

### Mobile (Sheet, side="bottom")

```
┌──────────────────────────────────┐
│ ─                                │  ← drag handle
│ Upgrade to Team                  │
│ Your Pro plan includes 1 seat.   │
│ Upgrade to Team to invite        │
│ teammates and collaborate.       │
│                                  │
│ ┌──────────────────────────────┐ │
│ │ Team        [Most popular]   │ │
│ │                              │ │
│ │ $50 /seat/mo                 │ │
│ │ + usage after credits        │ │
│ │ For teams shipping together  │ │
│ │ · Min 3 seats                │ │
│ │                              │ │
│ │ ┌──────────────────────────┐ │ │   ← <PlanPickerCard /> (reused)
│ │ │  Start 7-day free trial  │ │ │
│ │ └──────────────────────────┘ │ │
│ │                              │ │
│ │ ✓ $10/seat/mo credits        │ │
│ │ ✓ Everything in Pro          │ │
│ │ ✓ 2 workspaces               │ │
│ │ ✓ Role-based access          │ │
│ │ ✓ Email inbox                │ │
│ └──────────────────────────────┘ │
│                                  │
│ ┌──────────────────────────────┐ │
│ │   Compare plans              │ │
│ └──────────────────────────────┘ │
│ ┌──────────────────────────────┐ │
│ │   Cancel                     │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```

### CTA copy

The primary CTA lives **inside `PlanPickerCard`** and the dialog does not override it. The card already derives the right label from `trialAvailable` and `legacyMode` ([plan-picker-card.tsx:62-74](src/components/billing/plan-picker-card.tsx#L62)):

| Card state | What `PlanPickerCard` renders |
|---|---|
| `trialAvailable === true`, not legacy | "Start 7-day free trial" |
| `trialAvailable === false`, not legacy | "Choose plan" |
| `legacyMode === true` (legacy migration eligible) | "Switch to Team" |
| `pending === true`, not legacy | "Opening Stripe…" with `Loader2` |
| `pending === true`, legacy | "Switching…" with `Loader2` |
| `disabled === true` (e.g. Stripe not configured) | Button disabled, label unchanged |

The dialog passes `state={{ kind: "highlighted" }}` (so the "Most popular" badge and `ring-primary` style render), `trialAvailable` and `legacyMode` as derived from loader props, and an `onSelect` callback that handles the fetcher submit.

**Important:** Per the user's feedback, an org gets exactly one 7-day trial — total, not per plan. The `trialAvailable` flag must come from `!hasOrgUsedSubscriptionTrial(overview)` (already used by [_app.settings.organization.billing.tsx:194](src/routes/_app.settings.organization.billing.tsx#L194)), so a Starter or Pro user who already burned their trial sees "Choose plan", not "Start 7-day free trial". No trial footnote text appears in the dialog body — the card's CTA copy is sufficient.

When `stripeConfigured === false`, the dialog passes `disabled={true}` to `PlanPickerCard` and renders helper text below the card: `Hosted billing isn't configured in this environment. Contact support@camelai.com.`

---

## Component API

```tsx
// src/components/settings/team-upgrade-dialog.tsx
export interface TeamUpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** User's current plan — used to render the explainer line ("Your Pro plan includes 1 seat..."). */
  currentPlan: "free" | "starter" | "pro";
  /** Whether the org still has a 7-day trial available. Drives CTA label. */
  trialAvailable: boolean;
  /** Whether Stripe billing is configured in this environment. Disables the CTA when false. */
  stripeConfigured: boolean;
  /** True when the org has a legacy Stripe subscription. Switches CTA copy to "Switch to Team". */
  legacyMigrationEligible: boolean;
}
```

The dialog owns its own `useFetcher` and posts cross-route to `/settings/organization/billing` with `intent=changePlan, plan=team`. The team page does not need to handle any new action intents.

**Why no `onConfirm` callback:** the upgrade flow is a Stripe redirect (or, in the legacy/portal cases, a different Stripe URL). The dialog handles `window.location.assign(checkoutUrl)` itself; lifting that out would force the team page to know about Stripe response shapes. Better to keep it self-contained.

---

## Behavior Details

### Trigger

In [team-table.tsx:262](src/components/settings/team-table.tsx#L262) the `Invite member` button currently does `onClick={() => setInviteOpen(true)}`. Change to:

```tsx
<Button onClick={() => {
  if (requiresTeamUpgrade) {
    setUpgradeOpen(true);
  } else {
    setInviteOpen(true);
  }
}}>
```

Both dialogs are mounted; only one is open at a time. State for the new dialog: `const [upgradeOpen, setUpgradeOpen] = useState(false)`.

### Dialog content

- **Title:** `Upgrade to Team to invite teammates`
- **Description (DialogDescription):** template — `Your ${planLimits.label} plan includes 1 seat. Upgrade to Team to invite teammates and collaborate in shared workspaces.`
- **Plan card:** `<PlanPickerCard plan="team" state={{ kind: "highlighted" }} ... />`. Same component used in onboarding and billing settings. The dialog does **not** ship a second copy of the team plan card — pricing, features, badges, and CTA copy are owned by `PlanPickerCard` so we never have to update Team marketing in two places.
- **Footer buttons (desktop, right-aligned):** `Cancel` (outline) → `Compare plans` (outline link). The primary upgrade CTA lives inside `PlanPickerCard` itself; the dialog footer only carries dismissal and "compare" actions.
- **Footer buttons (mobile):** stacked. The card's primary CTA is the top action; `Compare plans` and `Cancel` stack below it.

### Plan card usage

```tsx
import { PlanPickerCard } from "@/components/billing/plan-picker-card";

<PlanPickerCard
  plan="team"
  state={{ kind: "highlighted" }}      // shows "Most popular" badge and ring-primary
  pending={fetcher.state !== "idle"}
  disabled={!stripeConfigured}
  trialAvailable={trialAvailable}      // from loader, drives "Start 7-day free trial" vs "Choose plan"
  legacyMode={legacyMigrationEligible} // drives "Switch to Team" vs the trial/choose copy
  onSelect={() => handleUpgrade()}
/>
```

Note: `PlanPickerCard`'s `onSelect` signature is `(cta: { kind, plan }) => void`. The dialog can ignore the cta argument since it always means "upgrade to team" in this surface — just call `handleUpgrade()`.

### Compare plans button

`<Button variant="outline" asChild><Link to="/settings/organization/billing?view=plans">Compare plans</Link></Button>`

The billing route already supports `?view=plans` to deep-link into ManagePlanView ([_app.settings.organization.billing.tsx:534](src/routes/_app.settings.organization.billing.tsx#L534)).

### Submission flow (primary CTA)

```tsx
const fetcher = useFetcher<{
  checkoutUrl?: string;
  billingPortalUrl?: string;
  planChanged?: boolean;
  error?: string;
}>();

function handleUpgrade() {
  if (legacyMigrationEligible) {
    // The PlanPicker uses a separate /api/billing/legacy-migration POST for migrate CTAs.
    // Mirror that here so the action handles legacy correctly.
    fetcher.submit(
      { plan: "team" },
      { method: "post", action: "/api/billing/legacy-migration" },
    );
    return;
  }
  fetcher.submit(
    { intent: "changePlan", plan: "team" },
    { method: "post", action: "/settings/organization/billing" },
  );
}

useEffect(() => {
  if (fetcher.state !== "idle") return;
  const nextUrl = fetcher.data?.checkoutUrl ?? fetcher.data?.billingPortalUrl;
  if (nextUrl) {
    window.location.assign(nextUrl);
    return;
  }
  if (fetcher.data?.planChanged) {
    // Plan flipped server-side without a Stripe redirect (e.g. legacy migration completed).
    // Reload the team page so it re-evaluates `requiresTeamUpgrade` and re-renders the invite flow.
    window.location.assign("/settings/organization/team");
    return;
  }
  if (fetcher.data?.error) {
    toast.error(fetcher.data.error);
  }
}, [fetcher.data, fetcher.state]);
```

This mirrors the redirect logic in [_app.settings.organization.billing.tsx:766-780](src/routes/_app.settings.organization.billing.tsx#L766) so the upgrade behaves identically whether kicked off from billing or team.

### CTA states

The primary CTA's appearance and label are owned by `PlanPickerCard`. The dialog only flips the props:

- **Default:** `pending={false}, disabled={false}` — card renders the trial/choose/switch label.
- **Pending (`fetcher.state !== "idle"`):** `pending={true}` — card renders "Opening Stripe…" or "Switching…" with `Loader2`. `Cancel` and `Compare plans` in the dialog footer stay enabled so users can back out mid-flight.
- **Stripe not configured:** `disabled={true}` — card's button is disabled with its existing label. Helper text below the card: `Hosted billing isn't configured in this environment. Contact support@camelai.com.` `Compare plans` link is disabled too.

### Closing

`onOpenChange(false)` resets nothing — fetcher state is keyed by route so re-opening starts clean. If the user cancels mid-redirect (between fetcher idle and `window.location.assign`), the next open re-submits cleanly because we don't memoize fetcher.data across opens (just rely on it inside the `useEffect`).

### Accessibility

- `DialogTitle` and `DialogDescription` are present so screen readers announce the dialog purpose.
- The primary CTA receives `autoFocus` so keyboard users can press Enter.
- `ESC` and overlay click both call `onOpenChange(false)` — standard shadcn behavior; nothing to override.

---

## File Layout

### New
| File | Purpose |
|---|---|
| `src/components/settings/team-upgrade-dialog.tsx` | The dialog/sheet component (responsive via `useIsMobile`). ~150 lines. |

### Modified
| File | Change |
|---|---|
| `src/routes/_app.settings.organization.team.tsx` | Loader: compute `requiresTeamUpgrade`, `currentPlan`, `trialAvailable`, `stripeConfigured`, `legacyMigrationEligible` and pass through to `TeamTable`. |
| `src/components/settings/team-table.tsx` | Accept new props, mount `TeamUpgradeDialog`, branch the Invite button onClick. |

No changes to:
- [workers/main/src/auth.ts](workers/main/src/auth.ts) — server-side seat check stays as defense-in-depth.
- [src/components/settings/invite-member-dialog.tsx](src/components/settings/invite-member-dialog.tsx) — invite dialog itself is correct; we just don't open it on non-team plans.
- [src/routes/_app.settings.organization.billing.tsx](src/routes/_app.settings.organization.billing.tsx) — `changePlan` action already does everything we need.
- [src/components/billing/plan-picker.tsx](src/components/billing/plan-picker.tsx) and friends — we read `PLAN_CONTENT.team` and `formatPlanPrice` but don't change them.

---

## Loader Changes — `_app.settings.organization.team.tsx`

Add the imports and reuse the same helpers the billing loader uses:

```tsx
import { isStripeBillingConfigured, getOrgBillingOverview, hasOrgUsedSubscriptionTrial, getLegacyStripeMigrationEligibility } from "@/lib/billing.server";
import { getOrgBillingPlan, getOrgSeatLimit } from "@/lib/billing-plans";
```

In `loader`, after the existing `Promise.all` for members/invitations/workspaces, fetch the billing context. Wrap each in `.catch(() => null)` so a Stripe blip doesn't take down the team page:

```tsx
const stripeConfigured = isStripeBillingConfigured(env);
const overview = await getOrgBillingOverview(env, authContext.currentOrg).catch(() => null);
const trialAvailable = overview ? !hasOrgUsedSubscriptionTrial(overview) : true;
const legacyMigration = getLegacyStripeMigrationEligibility({
  env,
  org: authContext.currentOrg,
  userEmail: authContext.user.email,
});
const seatLimit = getOrgSeatLimit(authContext.currentOrg);
const currentPlan = getOrgBillingPlan(authContext.currentOrg);
const requiresTeamUpgrade =
  canManageMembers && seatLimit !== null && seatLimit <= 1; // free, starter, pro
```

Return them in the loader payload alongside the existing fields. Plumb them down through `TeamTable` to `TeamUpgradeDialog`.

`requiresTeamUpgrade` is gated on `canManageMembers` so non-admin members (who can't see the Invite button anyway) don't trigger any of this.

---

## shadcn Components Used

| Use | Component |
|---|---|
| Dialog (desktop) | `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter` from [src/components/ui/dialog.tsx](src/components/ui/dialog.tsx) |
| Sheet (mobile) | `Sheet`, `SheetContent`, `SheetHeader`, `SheetTitle`, `SheetDescription`, `SheetFooter` from [src/components/ui/sheet.tsx](src/components/ui/sheet.tsx) |
| Team plan card (pricing, features, badge, primary CTA) | `PlanPickerCard` from [src/components/billing/plan-picker-card.tsx](src/components/billing/plan-picker-card.tsx) — **reused, not reimplemented** |
| Secondary buttons (Compare plans, Cancel) | `Button` (`outline` variant) from [src/components/ui/button.tsx](src/components/ui/button.tsx) |
| Mobile detection | `useIsMobile` from [src/hooks/use-mobile.ts](src/hooks/use-mobile.ts) (matches the pattern in [invite-member-dialog.tsx:54](src/components/settings/invite-member-dialog.tsx#L54)) |
| Class composition | `cn()` from `@/lib/utils` |
| Cross-route fetcher | `useFetcher` from `react-router` |
| Internal nav for "Compare plans" | `Link` from `react-router` |
| Toasts (error fallback) | `toast.error` from `sonner` |

No new shadcn primitives need to be installed.

---

## Implementation Order

1. **Loader + props plumbing.** Update `_app.settings.organization.team.tsx` loader to compute and return the five new fields. Update `TeamTable` to accept them (pass them through unchanged for now). Run `bun run typecheck` — passing here means the prop wiring is correct before we build the UI.
2. **Build `TeamUpgradeDialog`.** Static — render with hardcoded props on a scratch route or in Storybook-style isolation if the team uses one. Eyeball desktop and mobile layouts. Confirm trial-available vs trial-used copy swaps correctly.
3. **Wire submission.** Add the `useFetcher` cross-route POST and the redirect `useEffect`. Test by clicking the CTA in dev — should land on a Stripe checkout page (or billing portal, depending on starting state).
4. **Wire the Invite button.** In `team-table.tsx`, branch the onClick on `requiresTeamUpgrade` and mount `TeamUpgradeDialog` alongside `InviteMemberDialog`. Confirm Team plan users still see the invite dialog (no regression).
5. **Manual test matrix.** See below.
6. **Typecheck + targeted tests.** `bun run typecheck`, then `bun run test:run -- src/routes/_app.settings.organization.team` if any tests exist for that route. No new test scaffolding required for this PR — the dialog is presentational and the action it posts to is already covered by billing tests.

---

## Manual Test Matrix

| Setup | Click "Invite member" | Expected |
|---|---|---|
| Free plan, admin, trial unused | TeamUpgradeDialog opens | Description references "Your Free plan", `PlanPickerCard` renders "Start 7-day free trial" |
| Starter plan, admin, trial unused | TeamUpgradeDialog opens | Description says "Your Starter plan", `PlanPickerCard` renders "Start 7-day free trial" — Stripe trial reuses the org's single trial allowance |
| Starter plan, admin, trial already used | TeamUpgradeDialog opens | `PlanPickerCard` renders "Choose plan" (no trial copy anywhere). Clicking goes through the Stripe update-portal path because there's an active subscription |
| Pro plan with active Stripe subscription, trial used | TeamUpgradeDialog opens, click primary | fetcher hits `changePlan, plan=team`, action returns `billingPortalUrl` (Stripe update portal), browser redirects |
| Free plan, brand-new (no subscription), trial unused | TeamUpgradeDialog opens, click primary | fetcher returns `checkoutUrl` (Stripe Checkout with 7-day trial), browser redirects |
| Pro plan with legacy Stripe subscription | TeamUpgradeDialog opens, `PlanPickerCard` renders "Switch to Team" | fetcher hits `/api/billing/legacy-migration`, action returns `planChanged: true`, browser reloads `/settings/organization/team`, `requiresTeamUpgrade` is now false, Invite button opens InviteMemberDialog |
| Team plan, admin | InviteMemberDialog opens (existing behavior, no regression) | Form submits and creates invitation as before |
| Enterprise plan, admin | InviteMemberDialog opens | Same as today |
| Free plan, member (non-admin) | (Invite button is not rendered) | No regression; loader's `canManageMembers` already hides the button |
| Stripe not configured | TeamUpgradeDialog opens, `PlanPickerCard` button disabled, helper text shown | Compare plans link still works |

---

## Resolved Decisions

1. **Dialog vs. inline page upsell.** Dialog only — the page should not carry a persistent upgrade banner. The friction point is the click; that's where the upsell belongs. Avoids visual clutter for the 99% of renders where the user isn't trying to invite.
2. **Reuse `PlanPickerCard` vs. bespoke team card.** **Reuse** `PlanPickerCard`. It already accepts `plan="team"`, handles the highlighted/pending/disabled/legacy/trial-vs-no-trial states, and pulls all marketing copy from the shared `PLAN_CONTENT` and `BILLING_PLAN_LIMITS` sources. A bespoke card would force us to update Team marketing in two places. Skip the full `PlanPicker` because it's built for `max-w-5xl` and shows all five tiers — too wide and too noisy for a focused upgrade prompt; users who want to compare click "Compare plans" and land on the existing billing manage view.

3. **Trial copy.** An org gets one 7-day trial total, not one per plan ([_app.settings.organization.billing.tsx:194](src/routes/_app.settings.organization.billing.tsx#L194), `hasOrgUsedSubscriptionTrial`). The previous draft of this plan included "All paid plans include one 7-day free trial per org" footnote text — that's misleading because a Starter or Pro user upgrading to Team has likely already burned their trial. Removed. The CTA label inside `PlanPickerCard` already reflects trial state correctly: "Start 7-day free trial" only when `trialAvailable` is true.
4. **Where the upgrade POSTs.** Cross-route to `/settings/organization/billing` (`intent=changePlan, plan=team`) — and `/api/billing/legacy-migration` for legacy users — instead of duplicating Stripe logic in the team route's action. The billing action already handles every Stripe edge case correctly.
5. **Post-upgrade landing page.** Default Stripe `successUrl` (the billing page). Considered passing a custom `returnPath=/settings/organization/team` through the action, but it requires changing `createSubscriptionCheckoutSession`'s callsite, validating same-origin, and threading the path through legacy migration too. Out of scope for this PR; the user lands on billing, sees "Team plan", and navigates back to Team in one click. Note as a possible follow-up.
6. **Server-side check.** Stays as-is. The toast-on-error path is no longer the primary UX, but it remains a correct backstop for direct API hits and stale clients.

---

## Not in Scope

- Changing the server-side seat-limit error string at [workers/main/src/auth.ts:2490](workers/main/src/auth.ts#L2490).
- Custom post-upgrade redirect back to `/settings/organization/team` (would require server changes; flagged as a possible follow-up).
- Auto-opening the InviteMemberDialog after the user upgrades and lands back on the team page (pleasant, but adds URL-param state to the team page; defer).
- Localization. All copy is en-US literal strings.
- Touching the Team plan invite-with-billing-impact alert in [invite-member-dialog.tsx:105](src/components/settings/invite-member-dialog.tsx#L105) — that flow is for users *already on Team* and is correct.
- A "compare plans" expanded view inside the dialog. The Compare plans button links out to the existing PlanPicker view; this dialog stays focused on Team.
