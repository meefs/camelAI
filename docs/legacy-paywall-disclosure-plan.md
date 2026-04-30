# Legacy Paywall Disclosure & Migration Flow

## Status

April 30, 2026 — Draft v1

---

## Problem

Today, paying users from our original analytics product (`app.camelai.com`) land on the new `camelai.dev` paywall (`/dev/billing-paywall?state=legacy`) and see two competing surfaces stacked on top of each other:

1. An **embedded migration card** ([legacy-migration-dialog.tsx](src/components/billing/legacy-migration-dialog.tsx) with `variant="embedded"`) whose buttons hit `POST /api/billing/legacy-migration` — this **cancels their old subscription and applies prorated credit** toward a new one.
2. The standard **`PlanPicker`** below, whose `Start 7-day free trial` buttons hit the regular trial-checkout flow — this creates a **net-new subscription** without touching the legacy one.

The result is **6 buttons across two surfaces, with two different Stripe outcomes** for the same intent ("I want to be on the new product"). Users can:
- Pick the wrong path and end up double-billed (legacy sub still active alongside a brand-new trial sub),
- Get confused about why the same plan label appears twice with different copy/prices,
- Miss the disclosure entirely and assume their existing payment carries over silently.

We launch real billing today and need this to be unambiguous.

---

## Goal

A legacy customer landing on the paywall should:

1. **Immediately understand** they're on a new product and that we'll handle the migration for them — no math, no Stripe portal hunting.
2. **See exactly one set of plan buttons** below the disclosure. Whichever they click, we cancel the old sub and prorate the new one in a single Stripe operation.
3. Be able to **re-read the disclosure** without clicking back to a hidden flow, and **bail out** to the legacy product (`app.camelai.com`) if they still need it.

Non-legacy users see no change.

---

## Design

### Recommendation: Modal first-touch + persistent inline alert + unified plan picker

I evaluated three options and recommend a hybrid:

| Option | Pros | Cons |
|---|---|---|
| **Inline-only** (today's design) | Pricing visible immediately. | Disclosure competes with the plan picker; two button sets create the double-billing footgun. |
| **Modal-only** | Forces acknowledgment of the migration. | Pricing hidden behind a click; nothing reminds them after dismiss. |
| **Modal + slim inline alert** ✅ | Forced first-touch acknowledgment, pricing fully visible after one dismiss, persistent reminder on the page, single Stripe flow. | Slightly more components to build. |

The modal handles the *disclosure*; the inline alert handles *persistence*; the plan picker handles the *single Stripe action*. The user's instinct in the prompt is right — once they've dismissed the modal, every button on the paywall should perform the same migration operation.

---

### Layer 1 — Intro Modal (first paint)

Renders on top of the paywall via shadcn `Dialog`. Auto-opens for any legacy-eligible user who hasn't yet acknowledged it in this session. Single primary CTA dismisses it.

**Single-subscription variant** (`activeLegacySubscriptionCount === 1`):

```
┌──────────────────────────────────────────────────────────────┐
│                                                          ✕   │
│  ┌────────┐                                                  │
│  │ Badge  │ Existing subscriber                              │
│  └────────┘                                                  │
│                                                              │
│  Welcome back. camelAI is a new product now.                 │
│                                                              │
│  You're paying for our original analytics tool. We've        │
│  rebuilt camelAI as a coding-agent platform — same team,     │
│  new product.                                                │
│                                                              │
│  When you pick a paid plan on the next screen, Stripe will:  │
│                                                              │
│    ✓  Cancel your existing subscription                      │
│    ✓  Apply your unused balance as prorated credit toward    │
│       your new plan                                          │
│    ✓  Bill you nothing extra until that credit runs out      │
│                                                              │
│  One switch, no double billing.                              │
│                                                              │
│  ─────────────────────────────────────────────────────────   │
│                                                              │
│  Still need the analytics tool? It's still live at           │
│  app.camelai.com ↗                                           │
│                                                              │
│                                          [ See plans  →  ]   │
└──────────────────────────────────────────────────────────────┘
```

**Multiple-subscription variant** (`activeLegacySubscriptionCount > 1`) — manual review required:

```
┌──────────────────────────────────────────────────────────────┐
│                                                          ✕   │
│  ┌────────┐                                                  │
│  │ Badge  │ Existing subscriber                              │
│  └────────┘                                                  │
│                                                              │
│  Let's migrate this one manually.                            │
│                                                              │
│  Your account has more than one active subscription on       │
│  the original camelAI. To make sure nothing gets billed      │
│  twice, we'd like to move you over directly rather than      │
│  through self-checkout.                                      │
│                                                              │
│  Still need the analytics tool? It's still live at           │
│  app.camelai.com ↗                                           │
│                                                              │
│                       [ Contact support ]   [ Not now ]      │
└──────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Auto-opens when `legacyMigration.eligible === true` and the user hasn't dismissed it this session.
- Dismiss = ✕, Esc, click outside, or "See plans" — all mark the same in-memory flag (`acknowledgedLegacyIntro=true`).
- We do **not** persist dismissal across sessions: the disclosure is too important to vanish on a refresh while billing decisions are still in flight. (If we want to suppress it after they've actually migrated, the migration completing already changes `billing_status` and the eligibility check returns `null` — no extra plumbing required.)
- Multiple-subs variant has no "See plans" path; the plan picker stays disabled (see Layer 3).

---

### Layer 2 — Slim inline alert (post-dismiss)

After the modal closes, a one-line `Alert` sits above the `PlanPicker` for the rest of the session:

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⓘ  You're on a paid plan from the original camelAI. Picking a paid  │
│    plan below cancels it and applies your unused balance.            │
│                                          [ Why am I seeing this? ]   │
└──────────────────────────────────────────────────────────────────────┘
```

- shadcn `Alert` (default variant), single line on desktop, wraps on mobile.
- Copy is conditional on the user picking a paid plan — it doesn't promise anything will happen if they go BYOK / free, since that path doesn't touch the legacy subscription.
- The "Why am I seeing this?" right-side link reopens the intro modal — gives users a way back to the full explanation without forcing it on them every paint.
- For the multi-subs case, copy switches to: *"This account has multiple active subscriptions. Contact support to switch over without double billing."* with `[ Contact support ]` instead of the modal-reopen link.

---

### Layer 3 — Unified `PlanPicker` (single Stripe flow)

The existing `PlanPicker` is reused, but in legacy mode it routes every paid-plan CTA through `POST /api/billing/legacy-migration` instead of the trial-checkout endpoint. The card grid layout stays identical to the non-legacy paywall — no new visual primitives — only the CTA copy and the action change.

```
                          Choose your plan
       Pick a paid plan to switch over from your existing subscription,
       or bring your own API key to keep using camelAI on the free tier.

                         [ Individual ] [ Team ]

      ┌──────────────┐    ┌─────────────────┐    ┌──────────────┐
      │              │    │ ⭐ Recommended   │    │              │
      │   Starter    │    │   Pro           │    │   Team       │
      │   $20 /mo    │    │   $50 /mo       │    │  $50 /seat   │
      │              │    │                 │    │              │
      │ • $10 model  │    │ • $30 model     │    │ • Everything │
      │   credits    │    │   credits       │    │   in Pro     │
      │ • 30 apps    │    │ • Unlimited     │    │ • 2 wkspaces │
      │ ...          │    │ ...             │    │ ...          │
      │              │    │                 │    │              │
      │  [ Switch    │    │  [ Switch to    │    │  [ Switch to │
      │   to Starter]│    │     Pro      ]  │    │     Team   ] │
      └──────────────┘    └─────────────────┘    └──────────────┘

         Picking a paid plan cancels your old subscription and applies unused balance.
```

**Behavior:**
- The `Most popular` ribbon on the recommended card is replaced with `Recommended` (matches the language we already used in the embedded migration card) when in legacy mode, and the highlighted plan defaults to `legacyMigration.defaultPlan` (`pro` or `team`) instead of `pro`.
- Trial-related copy is suppressed for legacy users:
  - Heading subtitle changes (see ASCII above).
  - Card CTA labels become `Switch to {Plan}` instead of `Start 7-day free trial` for the paid cards. The Free / BYOK card keeps its existing `Add my API key` label — going BYOK does **not** touch the legacy subscription, so its CTA stays neutral.
  - The footer line `All paid plans include one 7-day free trial per org.` is replaced with `Picking a paid plan cancels your old subscription and applies unused balance.` — `migrateLegacyStripeSubscription` does not grant a trial, so promising one is wrong, and the cancellation language is scoped to paid plans only.
- The current downgrade / current-plan logic stays as-is (legacy users have no `billing_plan`, so the `downgrade` and `current` states never trigger here in practice).
- Multi-subs case: the picker renders disabled with `disabledReason="This account has multiple active subscriptions. Contact support to switch over."` — reusing the existing `disabledReason` prop. CTA buttons stay greyed out so users can still see pricing but can't self-serve.

---

### Full layout (post-dismiss, single-sub)

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │ ⓘ  You're on a paid plan from the original camelAI. Picking a paid  │
  │    plan below cancels it and applies your unused balance.            │
  │                                          [ Why am I seeing this? ]   │
  └──────────────────────────────────────────────────────────────────────┘

                            Choose your plan
       Pick a paid plan to switch over from your existing subscription,
       or bring your own API key to keep using camelAI on the free tier.

                           [ Individual ] [ Team ]

      ┌──────────────┐    ┌─────────────────┐    ┌──────────────┐
      │              │    │ ⭐ Recommended   │    │              │
      │   Starter    │    │   Pro           │    │   Team       │
      │      …       │    │       …         │    │      …       │
      │  [ Switch ]  │    │   [ Switch ]    │    │  [ Switch ]  │
      └──────────────┘    └─────────────────┘    └──────────────┘

  Use Claude, Codex, OpenRouter, or your own API key.
  Top up credits to use any model through us at cost. Or bring your
  own API key anytime.

  Picking a paid plan cancels your old subscription and applies unused balance.
```

---

## Implementation

### Files to change

| File | Change |
|---|---|
| [src/components/billing/legacy-migration-dialog.tsx](src/components/billing/legacy-migration-dialog.tsx) | **Rewrite.** Replace the embedded-card body with a `Dialog`-based modal. Drop `variant` prop. Drop the in-card plan buttons (the picker now owns plan choice). Keep `LegacyMigrationDialogData` exported — type is reused by the picker and route loaders. |
| [src/components/billing/legacy-migration-alert.tsx](src/components/billing/legacy-migration-alert.tsx) | **New.** Slim `Alert` rendered above the picker; takes an `onLearnMore` callback that reopens the modal. Single-sub and multi-sub copy variants. |
| [src/components/billing/plan-picker.tsx](src/components/billing/plan-picker.tsx) | Add `legacyMigration?: LegacyMigrationDialogData \| null` prop. When set, swap CTA labels (`Switch to {Plan}`), default the highlight to `legacyMigration.defaultPlan`, replace footer copy, and emit a new CTA shape (see below). |
| [src/components/billing/plan-picker-card.tsx](src/components/billing/plan-picker-card.tsx) | Accept a `legacyMode` boolean (or read from a derived state on the card) so the CTA label and the highlighted ribbon (`Recommended` instead of `Most popular`) can flip. Trial-pending state still uses the existing `pending` prop. |
| [src/components/billing/plan-picker-content.ts](src/components/billing/plan-picker-content.ts) | No structural change — but the picker now overrides `ctaLabel` for legacy mode rather than mutating this file. Keep the trial labels intact for the normal path. |
| [src/routes/_onboarding.welcome.tsx](src/routes/_onboarding.welcome.tsx) | Replace the embedded `LegacyMigrationDialog` with: (a) modal mount, (b) inline alert, (c) `<PlanPicker legacyMigration={...} />`. The picker's `onSelectPlan` for legacy users posts to `/api/billing/legacy-migration` (existing endpoint — no new route needed). Keep BYOK / contact-sales paths unchanged for non-trial CTAs. |
| [src/routes/_app.tsx](src/routes/_app.tsx) | The legacy migration is also surfaced as a floating card in the app shell ([_app.tsx:147](src/routes/_app.tsx#L147)). Replace `<LegacyMigrationDialog>` here with the new modal too, gated on the same eligibility flag. (See "Open question" below.) |
| [src/routes/dev.billing-paywall.tsx](src/routes/dev.billing-paywall.tsx) | Update preview wiring: pass `legacyMigration` directly into `PlanPicker`, render the new modal + alert in the `legacy` and `legacy-multiple` preview states. Remove the old embedded card. |

No changes to backing endpoints — `POST /api/billing/legacy-migration` already accepts `{ plan }` and does the right thing.

### New CTA shape from `PlanPicker`

Add a fourth case to `PlanPickerCta`:

```ts
export type PlanPickerCta =
  | { kind: "byok" }
  | { kind: "trial"; plan: "starter" | "pro" | "team" }
  | { kind: "migrate"; plan: "starter" | "pro" | "team" }   // NEW
  | { kind: "contact" }
  | { kind: "downgrade"; plan: BillingPlan };
```

`ctaForPlan` returns `migrate` instead of `trial` whenever `legacyMigration` is provided and the resolved card state is not `current` or `downgrade`. The welcome route's `onSelectPlan` handler routes:
- `migrate` → `migrationFetcher.submit({ plan }, { method: "post", action: "/api/billing/legacy-migration" })`
- `trial` → unchanged (only fires for non-legacy users now)
- everything else → unchanged.

### Modal component shape (new `LegacyMigrationDialog`)

```tsx
interface LegacyMigrationDialogProps {
  migration: LegacyMigrationDialogData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

- shadcn `Dialog` + `DialogContent` (max width ~`28rem`, `sm:max-w-lg`).
- Uses `DialogHeader` / `DialogTitle` / `DialogDescription` for the heading + body.
- Body: `Existing subscriber` `Badge`, three-bullet checklist, the "still need the analytics tool" pointer to `app.camelai.com`.
- Footer: single `Button` (`See plans →`) for single-sub; `Contact support` + `Not now` (variant `ghost`) for multi-sub.
- No plan buttons inside the dialog — that's the picker's job now.
- Keep the existing `LegacyMigrationDialogData` interface exported here so loaders / preview / `PlanPicker` import from one place.

### Inline alert component shape (new `LegacyMigrationAlert`)

```tsx
interface LegacyMigrationAlertProps {
  migration: LegacyMigrationDialogData;
  onLearnMore: () => void;     // reopens the modal
}
```

- shadcn `Alert` (default variant, no destructive coloring).
- `Info` icon (Lucide).
- Single-sub copy: *"Switching from your existing camelAI subscription. Pick any plan below — we'll cancel the old one and apply your unused balance."* + right-aligned `Button variant="link"` "Why am I seeing this?"
- Multi-sub copy: *"This account has multiple active subscriptions. Contact support to switch over without double billing."* + `Button asChild` mailto.

### Wiring in `_onboarding.welcome.tsx`

```tsx
const [introOpen, setIntroOpen] = useState(
  context.legacyMigration?.eligible ?? false,
);
const migrationFetcher = useFetcher<MigrationFetcherData>();

// inside JSX, where the embedded dialog used to be:
{context.legacyMigration?.eligible ? (
  <>
    <LegacyMigrationDialog
      migration={context.legacyMigration}
      open={introOpen}
      onOpenChange={setIntroOpen}
    />
    <LegacyMigrationAlert
      migration={context.legacyMigration}
      onLearnMore={() => setIntroOpen(true)}
    />
  </>
) : null}

<PlanPicker
  legacyMigration={context.legacyMigration}
  pendingPlan={
    isStartingCheckout
      ? pendingCheckoutPlan
      : pendingMigrationPlan  // derived from migrationFetcher.formData
  }
  onSelectPlan={(cta) => {
    if (cta.kind === "migrate") {
      migrationFetcher.submit(
        { plan: cta.plan },
        { method: "post", action: "/api/billing/legacy-migration" },
      );
      return;
    }
    // ...existing handlers for byok / trial / contact / downgrade
  }}
  // ...rest unchanged
/>
```

The `migrationFetcher` should reload the page on success (the existing legacy dialog already does this — copy the `useEffect` that calls `window.location.reload()` when `fetcher.data?.success`). On error, surface `fetcher.data.error` as a destructive `Alert` above the picker, matching the existing `checkoutError` pattern.

---

## Edge Cases & Decisions

- **Multiple active legacy subs (`activeLegacySubscriptionCount > 1`).** Modal switches to the manual-review variant. The inline alert reads "Contact support…" with a `mailto:`. The `PlanPicker` is rendered **disabled** via the existing `disabledReason` prop so they can still browse pricing — the API would reject the migration anyway (see [billing.server.ts:1470](src/lib/billing.server.ts#L1470)).
- **`activeLegacySubscriptionCount === 0`.** `getLegacyStripeMigrationEligibility` returns `null` so this UI never renders. No special-case needed.
- **Legacy user already on a paid plan.** `getLegacyStripeMigrationEligibility` short-circuits when `billing_status` is `active`/`trialing`/`enterprise` ([billing.server.ts:664](src/lib/billing.server.ts#L664)). After a successful migration, the next paint sees `null` eligibility and the modal/alert disappear.
- **Modal + a/x escape behavior.** All four ways out (✕, Esc, overlay click, primary CTA) are equivalent — they close the modal and reveal the picker. We're not gating "did they read it"; the persistent alert + reopen link is the safety net.
- **BYOK / free tier does not touch the legacy subscription.** The `Bring your own key` CTA on the Free card stays unchanged for legacy users — it skips Stripe entirely, which means their original subscription is left alone if they pick this path. All disclosure copy (modal, alert, picker subtitle, footer) is therefore scoped to "if you pick a paid plan" rather than "whichever plan you pick" so we don't promise a cancellation that won't happen on the free path. If a legacy user wants to drop to free *and* cancel the old sub, they'll need to do that through Stripe / support — out of scope for this flow.
- **Floating in-app dialog ([_app.tsx:147](src/routes/_app.tsx#L147)).** This currently renders the *embedded card* as a floating one for users who already finished onboarding. It needs the same modal-only treatment (the new component, opened automatically once per session). Without this, a user who skipped through onboarding can still encounter the old confusing UI in the app shell.
- **Trial copy on `PlanPicker`'s footer.** The hardcoded "All paid plans include one 7-day free trial per org." line ([plan-picker.tsx:187](src/components/billing/plan-picker.tsx#L187)) lies for legacy users (migration doesn't grant a trial). Replace it conditionally on `legacyMigration` being set.
- **Pricing accuracy.** `migrateLegacyStripeSubscription` uses `proration_behavior: "always_invoice"` — Stripe issues an immediate invoice with the proration credit applied. The modal copy ("we'll apply your unused balance as prorated credit") matches that behavior. Double-check with whoever owns Stripe wiring before shipping if there's any ambiguity.

---

## Open Questions

1. **Should the modal also block the in-app floating dialog use case in [_app.tsx](src/routes/_app.tsx)?** That surface today is a non-modal floating card; switching it to a modal is more disruptive but consistent. *Recommendation:* yes — the disclosure value is the same, and inconsistency between the paywall path and the in-app path is what created this confusion in the first place.
2. **Do we want telemetry on modal dismissal vs migration completion?** Out of scope for this plan, but we'll likely want to know what % of legacy users actually convert. Easy follow-up if billing analytics are wired.

## Decisions

- **Modal acknowledgment is not persisted across sessions.** It re-opens on refresh / new session for any user who is still legacy-eligible. Once the migration completes, `getLegacyStripeMigrationEligibility` returns `null` and the modal stops appearing on its own — no extra plumbing.
- **Disclosure copy is scoped to paid plans only.** The free / BYOK path skips Stripe and leaves the legacy subscription alone, so we say *"picking a paid plan cancels your old subscription"* rather than *"whichever plan you pick, we'll switch you over"*. This avoids implying we'll cancel their sub if they go BYOK.

---

## Implementation Order

1. Rewrite `LegacyMigrationDialog` to be a true `Dialog`-based modal with the new prop shape.
2. Add `LegacyMigrationAlert` component.
3. Extend `PlanPicker` / `PlanPickerCard` with legacy mode (CTA copy, `Recommended` ribbon, footer copy, `migrate` CTA shape).
4. Update [_onboarding.welcome.tsx](src/routes/_onboarding.welcome.tsx) wiring (modal + alert + picker + migration fetcher + error surface).
5. Update [_app.tsx](src/routes/_app.tsx) to use the new modal in the floating slot.
6. Update [dev.billing-paywall.tsx](src/routes/dev.billing-paywall.tsx) preview to render the new flow for both `legacy` and `legacy-multiple` states. Verify all PREVIEW_STATES still render correctly.
7. Manual QA: visit `/dev/billing-paywall?state=legacy` and `?state=legacy-multiple`, confirm modal opens, dismisses, plan-picker CTAs render correctly, "Why am I seeing this?" reopens, multi-sub disables the picker. Run `bun run typecheck`.

---

## Not in Scope

- New backing endpoints (existing `/api/billing/legacy-migration` covers everything).
- Email outreach to legacy users about the transition (separate initiative; covered by [legacy-user-notification-plan.md](docs/legacy-user-notification-plan.md)).
- Analytics / conversion tracking for the migration funnel.
- Removing legacy customer records from the migration KV after a sunset window (future cleanup).
- Visual changes to the non-legacy paywall — the standard onboarding paywall keeps its current copy and CTAs.
