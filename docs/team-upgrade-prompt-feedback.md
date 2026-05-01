# Team Upgrade Prompt — Feedback

The implementation is faithful to the plan: loader gates the upgrade dialog on `requiresTeamUpgrade`, the new dialog reuses `PlanPickerCard` for all marketing copy, and the cross-route fetcher to `/settings/organization/billing` is wired correctly. The Stripe-not-configured fallback works, and the legacy migration branch posts to `/api/billing/legacy-migration` as planned.

Six issues — two are real bugs/regressions, three are polish, one is a follow-up question.

---

## 1. Bug: dialog stays open during the Stripe redirect

In [src/components/settings/team-upgrade-dialog.tsx:58-72](src/components/settings/team-upgrade-dialog.tsx#L58), after the fetcher resolves with a `checkoutUrl` or `billingPortalUrl`, the effect calls `window.location.assign(nextUrl)` but doesn't close the dialog first. The browser then takes a few hundred ms to navigate, during which the user sees the dialog still open with the CTA still showing "Opening Stripe…". On a slow network this reads as "did my click do anything?" and they may click again, which fires a second fetcher submit because `pending` flips back to `false` between submits if the first promise has already settled.

**Fix:** close the dialog right before the redirect. Same applies to the `planChanged` branch.

```tsx
useEffect(() => {
  if (fetcher.state !== "idle" || !fetcher.data) return;
  const nextUrl = fetcher.data.checkoutUrl ?? fetcher.data.billingPortalUrl;
  if (nextUrl) {
    onOpenChange(false);
    window.location.assign(nextUrl);
    return;
  }
  if (fetcher.data.planChanged) {
    onOpenChange(false);
    window.location.assign("/settings/organization/team");
    return;
  }
  if (fetcher.data.error) {
    toast.error(fetcher.data.error);
  }
}, [fetcher.data, fetcher.state, onOpenChange]);
```

This also matches how the billing page's own redirect-after-fetcher works ([_app.settings.organization.billing.tsx:766-780](src/routes/_app.settings.organization.billing.tsx#L766)) — there's no dialog there to close, but the same intent (don't leave UI in a weird in-between state during the navigation).

---

## 2. Bug: in-flight fetcher can still redirect after the user cancels

Related to #1 but separate. If the user clicks the upgrade CTA, then immediately clicks `Cancel` (which calls `onOpenChange(false)`), the fetcher promise is still in flight. When it resolves, the `useEffect` runs because `fetcher.data` updates regardless of whether the dialog is open — and `window.location.assign(checkoutUrl)` fires. The user dismissed the modal but lands on Stripe Checkout anyway. Surprising.

**Fix:** track whether the user cancelled mid-flight and skip the redirect.

```tsx
const cancelledRef = useRef(false);

useEffect(() => {
  if (open) {
    cancelledRef.current = false;
  }
}, [open]);

const handleClose = () => {
  if (fetcher.state !== "idle") {
    cancelledRef.current = true;
  }
  onOpenChange(false);
};

useEffect(() => {
  if (fetcher.state !== "idle" || !fetcher.data) return;
  if (cancelledRef.current) return;
  // ... existing redirect logic
}, [fetcher.data, fetcher.state]);
```

Wire `handleClose` to the `Cancel` button and to `Dialog`/`Sheet`'s `onOpenChange`. (Dialog dismissal via Esc/overlay click should also count as a cancel.)

This is more important than #1 because once Stripe Checkout opens, the user has to navigate away from a payment surface — confusing and feels like a bait-and-switch.

---

## 3. Mobile/desktop button order is inconsistent

Desktop dialog footer ([team-upgrade-dialog.tsx:160-165](src/components/settings/team-upgrade-dialog.tsx#L160)):
```
Cancel  |  Compare plans
```

Mobile sheet footer ([team-upgrade-dialog.tsx:138-143](src/components/settings/team-upgrade-dialog.tsx#L138)):
```
Compare plans
Cancel
```

Both surfaces have the same two secondary actions (the primary upgrade CTA lives inside `PlanPickerCard`), so the order should be the same. Pick one and apply it both places.

**Recommendation:** `Compare plans` first, `Cancel` last on both. `Cancel` as the trailing/last action is the standard shadcn/web convention for dismissal — and `Compare plans` is the more "forward-leaning" of the two secondaries, so it should sit closer to the primary CTA. So the desktop order should flip to:

```tsx
<DialogFooter>
  {comparePlansButton}
  <Button variant="outline" onClick={handleClose}>
    Cancel
  </Button>
</DialogFooter>
```

(Note: shadcn's `DialogFooter` already does `flex-col-reverse sm:flex-row` so the visual order on small screens may differ from the source order. Verify in browser at the breakpoints we care about.)

---

## 4. The mobile Sheet adds redundant horizontal padding

[team-upgrade-dialog.tsx:134](src/components/settings/team-upgrade-dialog.tsx#L134) wraps the card content in `<div className="space-y-3 px-6 pt-2">`. shadcn `SheetContent` already applies its own padding (currently `gap-4 p-6` on the content surface — see [src/components/ui/sheet.tsx](src/components/ui/sheet.tsx)), so the extra `px-6` likely double-pads and pushes the card narrower than it needs to be on small phones (320–360px viewports). The desktop dialog version at [team-upgrade-dialog.tsx:156](src/components/settings/team-upgrade-dialog.tsx#L156) doesn't add `px-6` — only `pt-3`. They should match.

**Fix:** drop the `px-6` from the mobile branch:

```tsx
<div className="space-y-3 pt-2">
  <div className="pt-3">{planCard}</div>
  {stripeWarning}
</div>
```

Eyeball at iPhone SE (375px) and Pixel 5 (393px) widths — the card's pricing block and feature list should breathe.

---

## 5. `sm:max-w-md` may be too tight for the team plan card

The DialogContent at [team-upgrade-dialog.tsx:151](src/components/settings/team-upgrade-dialog.tsx#L151) uses `sm:max-w-md` (~28rem / 448px). The `PlanPickerCard` was designed for a 3-column `grid-cols-3` layout where each card gets ~33% of `max-w-5xl` (≈430px), so it'll *fit* — but the title font is `text-4xl` for the price and the "Most popular" badge sits in the negative-Y position above the card, both of which can feel cramped inside a dialog that also has a `DialogTitle` and `DialogDescription` row above it.

**Recommendation:** bump to `sm:max-w-lg` (~32rem / 512px) and verify visually. If the card still feels packed, `sm:max-w-xl` is fine — this is a focused upsell modal and the card content benefits from breathing room. The desktop dialog isn't competing for screen real estate with anything else.

Worth eyeballing the badge clipping specifically — the `-translate-y-1/2` on the "Most popular" badge ([plan-picker-card.tsx:86](src/components/billing/plan-picker-card.tsx#L86)) needs the parent `<div className="relative">` to have enough top room. Inside a dialog with a header above it, there's typically enough margin from `DialogContent`'s default `gap-4`, but verify it doesn't visually collide with the description text.

---

## 6. No test coverage for the new branch

The only test file modified is [tests/team-table-copy-invite-link.test.tsx](tests/team-table-copy-invite-link.test.tsx#L19-L24), and only to add a `Link` mock so the existing tests don't break when `team-table.tsx` imports `TeamUpgradeDialog`. The test renders `TeamTable` without `requiresTeamUpgrade`, so it exercises only the `setInviteOpen(true)` branch.

There's no test that:
- Renders `TeamTable` with `requiresTeamUpgrade={true}` and verifies clicking "Invite member" opens `TeamUpgradeDialog` instead of `InviteMemberDialog`.
- Renders `TeamUpgradeDialog` with each `currentPlan` value and confirms the description text matches.
- Verifies the fetcher submits to the correct route depending on `legacyMigrationEligible`.

**Recommendation:** add `tests/team-upgrade-dialog.test.tsx` covering at minimum:

1. Renders the description with the right plan label for each of `free` / `starter` / `pro`.
2. Clicking the card's CTA submits `{ intent: "changePlan", plan: "team" }` to `/settings/organization/billing` when `legacyMigrationEligible={false}`.
3. Clicking the card's CTA submits `{ plan: "team" }` to `/api/billing/legacy-migration` when `legacyMigrationEligible={true}`.
4. With `stripeConfigured={false}`, the helper text is rendered and the `Compare plans` button is disabled.
5. (Bonus, ties to bug #2) cancelling mid-flight does not navigate.

`team-table.tsx` could also benefit from a one-test extension to the existing file: render with `requiresTeamUpgrade={true}` and assert that clicking the invite button does not call the existing invite fetcher submit.

These tests aren't blocking — the code is straightforward — but the dialog is a billing-adjacent surface, and we have a strong existing pattern of testing fetcher-based flows ([tests/billing.test.ts](tests/billing.test.ts), the existing team-table copy test). Worth adding before merge.

---

## 7. Open question: should description mention pricing?

The current description ([team-upgrade-dialog.tsx:75](src/components/settings/team-upgrade-dialog.tsx#L75)) reads:

> Your Pro plan includes 1 seat. Upgrade to Team to invite teammates and collaborate in shared workspaces.

The pricing ($50/seat/mo, min 3 seats → $150/mo to start) is on the card below it, so this is technically fine. But for a user who's been on Pro at $150/mo and is about to find out Team starts at $150/mo *with the same hosted credits per dollar*, leading with that comparison could remove sticker shock before they read the card. Something like:

> Your Pro plan includes 1 seat. The Team plan starts at 3 seats for $150/mo and adds collaboration, role-based access, and team-shared credits.

Not a required change — possibly out of scope for this PR. Flagging as a follow-up worth A/B'ing if conversion rate matters here.

---

## What looks good

- **Loader gating on `requiresTeamUpgrade`** ([_app.settings.organization.team.tsx:198-215](src/routes/_app.settings.organization.team.tsx#L198)) avoids the Stripe billing-overview fetch on team/enterprise/non-admin renders. Nice optimization that wasn't called out in the plan.
- **`upgradeCurrentPlan` narrowing in `team-table.tsx`** ([team-table.tsx:124-125](src/components/settings/team-table.tsx#L124)) handles the `team`/`enterprise` cases defensively — even though `requiresTeamUpgrade` should be false in those cases, falling back to `"free"` keeps the dialog props well-typed. Reasonable belt-and-braces.
- **`legacyMigrationEligible` derivation** is correct: `Boolean(legacyMigration?.eligible)`. Plumbed cleanly through props rather than passing the whole eligibility object, which the dialog doesn't need.
- **Reusing `PlanPickerCard`** with `state={{ kind: "highlighted" }}` is exactly what the plan asked for. No duplicated marketing copy. The `Most popular` badge, ring-primary outline, and card CTA copy all flow from the canonical source.
- **`isStripeBillingConfigured` short-circuit** properly disables both the card CTA (via the `disabled` prop on `PlanPickerCard`) and the `Compare plans` link, with helper text pointing at support@camelai.com. Clean failure mode.

---

## Suggested order to address

1. **Fix #2** (cancel-during-redirect) first — it's a real "user did X, system did Y" mismatch that's confusing.
2. **Fix #1** (close dialog before redirect) at the same time — same effect block.
3. **Fix #4** (mobile padding) and **#3** (button order) — quick visual cleanup.
4. **Verify #5** (`max-w-md` vs `max-w-lg`) by eyeballing in dev.
5. **Add tests #6** before merge.
6. **Defer #7** unless we want the copy change in this PR.
