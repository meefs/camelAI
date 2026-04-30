# Legacy Paywall Disclosure — Implementation Feedback (Round 1)

## Status

April 30, 2026 — Review of branch `style-paywall-for-existing-users-apr-26`

The agent's implementation matches the structural plan: modal first, slim alert second, unified plan picker that routes paid CTAs through `/api/billing/legacy-migration`. The wiring is correct in [_onboarding.welcome.tsx](src/routes/_onboarding.welcome.tsx), [_app.tsx](src/routes/_app.tsx), and the dev preview. The changes below are copy / styling polish, not structural rework.

---

## Required changes

### 1. Drop the "Existing subscriber" badge from the modal — both variants

**File:** [src/components/billing/legacy-migration-dialog.tsx:60-62](src/components/billing/legacy-migration-dialog.tsx#L60-L62)

The badge feels random and decorative — the modal title already establishes the context. Remove it from both the single-sub and the multi-sub variants.

```tsx
// Remove this block from DialogHeader:
<Badge variant="outline" className="self-start">
  Existing subscriber
</Badge>
```

Also remove the now-unused `Badge` import at the top of the file.

### 2. Remove "One switch, no double billing." line from the modal

**File:** [src/components/billing/legacy-migration-dialog.tsx:114-116](src/components/billing/legacy-migration-dialog.tsx#L114-L116)

The line below the checklist is redundant with the checklist itself and adds visual noise.

```tsx
// Delete this paragraph entirely:
<p className="text-sm font-medium text-foreground">
  One switch, no double billing.
</p>
```

After removing it, the surrounding `<div className="space-y-3">` only wraps the `<ul>`. Drop the `<div>` wrapper too and render the `<ul>` directly so the spacing stays consistent with the rest of the modal body.

### 3. Rewrite the third checklist bullet — "Bill you nothing extra until that credit runs out" is misleading

**File:** [src/components/billing/legacy-migration-dialog.tsx:107-112](src/components/billing/legacy-migration-dialog.tsx#L107-L112)

The new product is more expensive than the old one, so the prorated credit will *not* fully cover the new plan in most cases. Telling the user "we won't bill you extra until the credit runs out" reads as a free-period promise we're not making. Stripe's checkout screen will show the actual amount due — that's where the truth lives.

**Replace bullet 3** with something honest about *where* the math becomes clear, e.g.:

> *"Apply that credit to your first invoice. Stripe will show your exact charge before you confirm."*

The second version is tighter and folds bullet 2 and bullet 3 together — leaving us with two bullets total instead of three, which I think reads cleaner anyway. Pick whichever the implementing agent prefers, but make sure the final copy:

- does **not** imply a free period,
- does **not** quantify the credit (we don't know it ahead of time),
- explicitly points to the Stripe checkout screen as the source of truth.

### 4. Replace the inline alert with a "Why am I seeing this?" link in the picker subtitle

**Files:**
- [src/components/billing/legacy-migration-alert.tsx](src/components/billing/legacy-migration-alert.tsx) — delete this file
- [src/routes/_onboarding.welcome.tsx:433-437](src/routes/_onboarding.welcome.tsx#L433-L437) — drop the `<LegacyMigrationAlert>` mount
- [src/routes/dev.billing-paywall.tsx:232-235](src/routes/dev.billing-paywall.tsx#L232-L235) — drop the `<LegacyMigrationAlert>` mount
- [src/components/billing/plan-picker.tsx](src/components/billing/plan-picker.tsx) — extend the heading/subtitle area to support a trailing reopen action

The `<Alert>` floats above the picker and visually clashes with the rest of the page. Its body also restates what the picker subtitle already says, so it reads as duplication. The piece worth keeping is **just the "Why am I seeing this?" link** — folding it into the picker subtitle keeps the typography consistent and removes the boxy alert entirely.

#### Recommended approach

Add an optional `subtitleAction` slot to `PlanPicker`'s `heading` prop (or, simpler: a sibling `onWhyClick?: () => void` prop on the picker itself, used only when `legacyMigration?.eligible` is true). When present, render a `Button variant="link"` directly after the subtitle text, on the same line on desktop, wrapping below on narrow widths.

```
                       Choose your plan
   Pick a paid plan to switch over from your existing subscription,
   or bring your own API key to keep using camelAI on the free tier.
                  [ Why am I seeing this? ]
```

The link button uses `Button` `variant="link"` `size="sm"` `className="px-0 h-auto"` so it inherits muted-foreground sizing and doesn't look like a separate UI element.

#### Multi-sub case

The current alert's multi-sub variant points to `mailto:support@camelai.com`. That information should not disappear. Two options:

- **(preferred)** Keep the existing `disabledReason` paragraph below the picker grid ([plan-picker.tsx:189-191](src/components/billing/plan-picker.tsx#L189-L191)) and add the support mailto into that string. It already renders as small muted-foreground text below the picker, which is exactly the right weight.
- Alternatively, render the support link inline in the subtitle after the "Why am I seeing this?" link, gated on `requiresManualReview`.

Either way, the floating `<Alert>` component goes away.

#### What to delete

- `src/components/billing/legacy-migration-alert.tsx` (whole file)
- The `<LegacyMigrationAlert>` import + JSX in `_onboarding.welcome.tsx` and `dev.billing-paywall.tsx`
- The corresponding test cases that assert on the alert's visible text in `tests/legacy-migration-dialog.test.tsx` and `tests/onboarding-welcome-legacy-migration.test.tsx` — replace them with assertions that:
  - the picker subtitle contains the "Why am I seeing this?" link, and
  - clicking it reopens the modal.

---

## Out of scope (no change requested)

The following are working correctly and should be left alone:

- The `Recommended` ribbon swap on the highlighted card in legacy mode.
- The `Switch to {Plan}` CTA labels and `Switching…` pending state.
- The `migrate` CTA shape on `PlanPickerCta` and the migration-fetcher wiring in `_onboarding.welcome.tsx`.
- The footer line `"Picking a paid plan cancels your old subscription and applies unused balance."` — this stays.
- The "Still need the analytics tool? It's still live at app.camelai.com." block in the modal — this stays.
- The decision to not persist modal acknowledgment across sessions.
- The `_app.tsx` floating-modal mount with the `primaryAction` that navigates to `/settings/organization/billing`. (The `Existing subscriber` badge removal applies here too via the shared component.)

---

## Implementation order

1. Edit `legacy-migration-dialog.tsx`: remove the badge, drop the "One switch, no double billing." line, rewrite the third checklist bullet (or fold bullets 2+3 together).
2. Add `onWhyClick` (or equivalent) to `PlanPicker` and render the link in the heading area; thread it through `_onboarding.welcome.tsx` and `dev.billing-paywall.tsx` to call `setLegacyIntroOpen(true)` / `setIntroOpen(true)`.
3. Delete `legacy-migration-alert.tsx` and remove all references.
4. Update / replace alert-related test cases.
5. Run `bun run typecheck` and the relevant Vitest files. Manually verify `/dev/billing-paywall?state=legacy` and `?state=legacy-multiple` look correct.
