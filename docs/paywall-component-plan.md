# Paywall Component Plan

## Problem

The paywall is currently inlined into [src/routes/_onboarding.welcome.tsx](src/routes/_onboarding.welcome.tsx) as two stacked panels ("Start the 7-day trial" and "Use your own provider"). It only surfaces the Starter trial and BYOK — Pro, Team, and Enterprise are invisible. We're about to need the same paywall in other surfaces (settings upgrade prompts, mid-flow upgrade nudges from credit-exhaustion, gated features) and we don't want to duplicate or re-style this every time.

## Goal

Ship a reusable `<PlanPicker>` component that:

1. Shows all 5 tiers (Free, Starter, Pro, Team, Enterprise), max 3 columns on screen at once.
2. Has an Individual / Team toggle that swaps which 3 tiers are visible.
3. Matches the camelAI design system (shadcn + Tailwind v4 tokens, `bg-card`, `text-muted-foreground`, etc.).
4. Is a presentation component — it emits a `onSelectPlan(plan)` event and the parent decides what to do (start checkout, open BYOK form, navigate to contact-sales, etc.).
5. Embeds in [src/routes/_onboarding.welcome.tsx](src/routes/_onboarding.welcome.tsx) on first ship, and is structured so [src/routes/_app.settings.organization.billing.tsx](src/routes/_app.settings.organization.billing.tsx) and future modal/page surfaces can drop it in without changes.

---

## ASCII Design

### Individual view (Free, Starter, Pro)

```
                        Choose your plan
              Pick the plan that fits how you build.

                   ┌───────────────────────┐
                   │ Individual │   Team   │   ← Tabs (shadcn)
                   └───────────────────────┘

  ┌────────────────┐  ┌────────────────┐  ┌─[ Most popular ]──┐
  │ Free           │  │ Starter        │  │ Pro                │ ← ring-primary
  │                │  │                │  │                    │
  │ $0 /mo         │  │ $40 /mo        │  │ $150 /mo           │
  │                │  │ + usage after  │  │ + usage after      │
  │ Try the        │  │   credits      │  │   credits          │
  │ platform       │  │ For solo       │  │ For power users    │
  │                │  │   builders     │  │                    │
  │ ┌────────────┐ │  │ ┌────────────┐ │  │ ┌────────────────┐ │
  │ │Add my key  │ │  │ │Start trial │ │  │ │Start trial     │ │ ← Button
  │ └────────────┘ │  │ └────────────┘ │  │ └────────────────┘ │
  │                │  │                │  │                    │
  │ ✓ BYOK         │  │ ✓ $10 credits  │  │ ✓ $30 credits      │
  │ ✓ 1 workspace  │  │ ✓ BYOK         │  │ ✓ BYOK             │
  │ ✓ 3 apps       │  │ ✓ 30 apps      │  │ ✓ 500 apps         │
  │ ✓ 5 GB storage │  │ ✓ 50 GB        │  │ ✓ 100 GB           │
  │ ✓ 2 cron/daily │  │ ✓ 10 cron/hr   │  │ ✓ 50 cron/5-min    │
  │                │  │                │  │ ✓ Email inbox      │
  └────────────────┘  └────────────────┘  └────────────────────┘

  ┌────────────────────────────────────────────────────────────┐
  │ ⓘ Use Claude, Codex, or your own API key                  │
  │                                                            │
  │ Top up credits to use Claude or Codex through us at cost — │
  │ no markup. Or bring your own API key anytime.              │
  └────────────────────────────────────────────────────────────┘

       All paid plans include a 7-day free trial. Cancel anytime.
```

### Team view (Team, Enterprise)

```
                   ┌───────────────────────┐
                   │ Individual │   Team   │
                   └───────────────────────┘

  ┌─[ Most popular ]──┐  ┌────────────────────┐
  │ Team               │  │ Enterprise         │
  │                    │  │                    │
  │ $50 /seat/mo       │  │ Custom             │
  │ + usage after      │  │ Talk to sales      │
  │   credits          │  │                    │
  │ Min 3 seats        │  │                    │
  │                    │  │ ┌────────────────┐ │
  │ ┌────────────────┐ │  │ │ Contact sales↗ │ │
  │ │Start trial     │ │  │ └────────────────┘ │
  │ └────────────────┘ │  │                    │
  │                    │  │ ✓ SSO / SAML       │
  │ ✓ $10/seat credits │  │ ✓ BYOCloud         │
  │ ✓ Everything Pro   │  │ ✓ Multi-workspace  │
  │ ✓ 2 workspaces     │  │ ✓ Dedicated Slack  │
  │ ✓ RBAC             │  │ ✓ HIPAA / SOC 2    │
  └────────────────────┘  └────────────────────┘
```

The Team view renders 2 cards centered (not stretched to fill the 3-column grid) so the cards keep the same width as in the Individual view.

### Current-plan state

When a `currentPlan` prop is passed, the matching tier swaps "Most popular" for a "Current plan" badge (subdued variant) and the CTA disables / shows "Current plan". Used by the settings page; onboarding doesn't pass it.

---

## Component API

```tsx
// src/components/billing/plan-picker.tsx
export type PlanPickerCta =
  | { kind: "byok" }                                              // Free → "Add my API key"
  | { kind: "trial"; plan: "starter" | "pro" | "team" }           // Paid plans → Stripe trial
  | { kind: "contact" }                                           // Enterprise → demo link
  | { kind: "downgrade"; plan: BillingPlan };                     // Settings only → Stripe portal cancel

export interface PlanPickerProps {
  /** Which tab to show on mount. Defaults to "individual". */
  defaultBillingMode?: "individual" | "team";
  /** Current plan — swaps the matching tier's CTA to "Downgrade" (or disables if it's the lowest paid tier already). */
  currentPlan?: BillingPlan | null;
  /** Disables every CTA (Stripe not configured, request in flight, etc.). Reason is shown as helper text below the grid. */
  disabledReason?: string | null;
  /** Optional override for the "Most popular" badge target. Defaults: individual=pro, team=team. */
  highlightedPlan?: BillingPlan | null;
  /** Header copy. Defaults: "Choose your plan" / "Pick the plan that fits how you build." Pass null to hide. */
  heading?: { title: string; subtitle?: string } | null;
  /** Whether to render the bottom info panel + trial footnote. Default true. */
  showFooter?: boolean;
  /** Fires when a CTA is clicked. Parent owns the side effect. */
  onSelectPlan: (cta: PlanPickerCta) => void;
  /** Per-CTA pending state, keyed by plan. Used to show "Opening Stripe…" / spinner. */
  pendingPlan?: BillingPlan | null;
}
```

**Why callback-based, not Form-based:** the Free tier action is BYOK key entry (no POST), the trial CTAs need a Stripe checkout fetch + redirect, Enterprise opens an external demo link, and downgrade opens the Stripe billing portal. A single internal `<Form>` can't model all four. Lifting the action out keeps the component pure presentation.

**Plan data source:** read from [src/lib/billing-plans.ts](src/lib/billing-plans.ts) `BILLING_PLAN_LIMITS`. The component owns its own marketing copy (headlines, feature bullet ordering) — see "Plan content" below — but pulls prices, storage, app caps, cron caps from the canonical limits map so they don't drift.

---

## File Layout

```
src/components/billing/
  plan-picker.tsx              ← main component (Tabs + grid + cards + footer)
  plan-picker-card.tsx         ← single tier card (extracted for clarity)
  plan-picker-content.ts       ← marketing copy: headline, tagline, feature bullets per tier
```

Three files, ~150–200 lines each. Splitting the card and content lets us iterate on copy without touching the layout, and keeps the main component focused on the tabs + grid + state.

---

## shadcn Components Used

| Use | Component |
|---|---|
| Individual / Team toggle | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` from [src/components/ui/tabs.tsx](src/components/ui/tabs.tsx) |
| Tier card container | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` from [src/components/ui/card.tsx](src/components/ui/card.tsx) |
| "Most popular" / "Current plan" badge | `Badge` from [src/components/ui/badge.tsx](src/components/ui/badge.tsx) |
| Plan CTA | `Button` from [src/components/ui/button.tsx](src/components/ui/button.tsx) — `default` for highlighted plan, `outline` for the rest |
| Footer info panel | `Card` (size="sm") with `CardHeader` + `CardContent` |
| Bullet list icons | `Check` from `lucide-react` |
| Pending state | inline `Loader2` from `lucide-react` (no `Spinner` component exists in [src/components/ui/](src/components/ui/)) |
| Class composition | `cn()` from `@/lib/utils` |

No new shadcn primitives need to be installed.

---

## Plan Content

`plan-picker-content.ts` exports a typed table:

```ts
type PlanContent = {
  tagline: string;          // "Try the platform"
  ctaLabel: string;         // "Start 7-day trial"
  ctaKind: PlanPickerCta["kind"];
  features: string[];       // pre-formatted bullet strings
};

export const PLAN_CONTENT: Record<BillingPlan, PlanContent> = {
  free: {
    tagline: "Try the platform",
    ctaLabel: "Add my API key",
    ctaKind: "byok",
    features: [
      "Bring your own API key",
      "1 workspace",
      "3 deployed apps",
      "5 GB storage",
      "2 cron jobs (daily)",
    ],
  },
  starter: { /* ... */ },
  pro: { /* ... */ },
  team: { /* ... */ },
  enterprise: {
    tagline: "Talk to sales",
    ctaLabel: "Contact sales",
    ctaKind: "contact",
    features: [
      "SSO / SAML",
      "BYOCloud",
      "Multiple workspaces",
      "Dedicated Slack support",
      "HIPAA / SOC 2",
    ],
  },
};
```

Pricing strings are derived from `BILLING_PLAN_LIMITS[plan].monthlyPriceCents` (formatted as `$40 /mo`, `$50 /seat/mo` for team, `Custom` for enterprise null). The "+ usage after credits" subtitle is rendered for all paid plans (starter, pro, team).

The 7-day trial footnote, the "Use Claude, Codex, or your own API key" info panel, and the heading copy live in `plan-picker.tsx` directly — they are component chrome, not per-tier content.

---

## Behavior Details

### Tab toggle

- `Tabs` defaults to `value="individual"` unless `defaultBillingMode="team"` is passed.
- Switching tabs only changes which `<TabsContent>` is visible — both render once. No data fetch.
- The tab control is centered above the grid.

### Card grid

- Individual tab: `grid grid-cols-1 md:grid-cols-3 gap-4` with Free, Starter, Pro.
- Team tab: `grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto` with Team, Enterprise.
- Highlighted plan card gets `ring-2 ring-primary` (replaces the default `ring-foreground/10` from the Card primitive). The "Most popular" badge sits in the top-left, slightly overlapping the card edge: `-translate-y-1/2 absolute top-0 left-4`.
- Cards have a fixed min-height so the CTAs align horizontally regardless of bullet count: `min-h-[28rem]` on `md:` and up.

### CTA states

- Default: `Button` (variant `default` for highlighted plan, `outline` otherwise).
- Pending (`pendingPlan === plan`): button shows `<Loader2 className="animate-spin" />` + label "Opening Stripe…" and is disabled.
- Disabled (`disabledReason` set): all buttons disabled. Helper text rendered below the grid: `<p className="text-sm text-muted-foreground text-center">{disabledReason}</p>`.
- Current plan (`currentPlan === plan`): button disabled, label "Current plan", `variant="secondary"`. Card shows a "Current plan" badge instead of "Most popular".
- Lower than current plan (downgrade): button label "Downgrade", `variant="outline"`. Fires `onSelectPlan({ kind: "downgrade", plan })` — parent opens the Stripe billing portal so the user can cancel/downgrade their subscription.

### Footer panel

- Renders when `showFooter !== false`.
- Uses `Card size="sm"` with a muted background (`bg-muted/40`).
- Contains the info paragraph and, below the card, the centered "All paid plans include a 7-day free trial. Cancel anytime." footnote in `text-xs text-muted-foreground`.

---

## Onboarding Integration

[src/routes/_onboarding.welcome.tsx](src/routes/_onboarding.welcome.tsx) currently renders the paywall as two ad-hoc panels gated on `isBillingChoiceRequired`. After the change, that branch renders `<PlanPicker>` plus a collapsible BYOK form that expands when the user picks Free.

### Layout impact

The onboarding layout container is `max-w-2xl` ([src/components/onboarding/onboarding-layout.tsx](src/components/onboarding/onboarding-layout.tsx#L31)). A 3-column paywall needs more room — the prototype reads at ~`max-w-5xl`. Two options:

1. **(Recommended)** Add a `contentClassName` opt-in on `OnboardingLayout` (already supported — see [onboarding-layout.tsx:6](src/components/onboarding/onboarding-layout.tsx#L6)) and pass `max-w-5xl` from the welcome route when the paywall is showing. Layout stays narrow for the verification / team-welcome variants.
2. Hardcode `max-w-5xl` only inside `PlanPicker` and let the layout overflow. Worse — leaves a narrow center column with cards bleeding past it.

Go with option 1.

### Welcome route changes

In [src/routes/_onboarding.welcome.tsx](src/routes/_onboarding.welcome.tsx):

- Delete the inline "Start the 7-day trial" panel (lines ~362–377) and the BYOK panel (lines ~379–441).
- Replace with:

  ```tsx
  <PlanPicker
    defaultBillingMode="individual"
    pendingPlan={isStartingCheckout ? "starter" : null}
    disabledReason={null}
    onSelectPlan={(cta) => {
      if (cta.kind === "byok") {
        setShowByokForm(true);
        return;
      }
      if (cta.kind === "trial" && cta.plan === "starter") {
        // Existing wired path: posts intent=startTrial, hits createSubscriptionCheckoutSession with plan=starter
        checkoutFetcher.submit({ intent: "startTrial" }, { method: "post" });
        return;
      }
      if (cta.kind === "trial" && (cta.plan === "pro" || cta.plan === "team")) {
        // FIXME(billing): wire Pro and Team trial Stripe checkout — different engineer is owning the Stripe piping.
        // Team checkout will land on a Stripe page that asks for seat count, so onboarding does not need to collect it.
        return;
      }
      if (cta.kind === "contact") {
        window.open("https://book-demo--camelai-team-d9e.camelai.app/", "_blank");
      }
    }}
  />

  {showByokForm ? <ByokProviderForm ... /> : null}
  ```

- Hoist the existing `RadioGroup` + `Input` BYOK chunk into a small `ByokProviderForm` component (still under [src/components/onboarding/](src/components/onboarding/) since it's onboarding-specific) so the welcome route stays readable.
- **Stripe piping is out of scope for this PR.** Only the Starter trial CTA is wired (it reuses the existing `intent=startTrial` action which already calls `createSubscriptionCheckoutSession({ plan: "starter", seatCount: 1 })` at [_onboarding.welcome.tsx:135](src/routes/_onboarding.welcome.tsx#L135)). The Pro and Team CTAs land on a `FIXME(billing):` no-op — a different engineer will wire them. Do **not** modify the action signature or `createSubscriptionCheckoutSession` calls.

### What stays in the welcome route

- The non-paywall paths (`emailVerificationRequired`, team-welcome variant, post-billing "Get Started" button) are untouched. The `<PlanPicker>` only renders inside the existing `isBillingChoiceRequired` branch.

### Stripe-not-configured

When `isStripeBillingConfigured(env)` is false, the loader returns a flag and the route passes `disabledReason="Hosted plans aren't configured in this environment — use BYOK for now."` to `<PlanPicker>`. The Free CTA stays enabled.

---

## Settings Integration (proof the API generalizes — not in this PR)

The intended call from [src/routes/_app.settings.organization.billing.tsx](src/routes/_app.settings.organization.billing.tsx) once we adopt it:

```tsx
<PlanPicker
  defaultBillingMode={isTeamPlan(org.billing_plan) ? "team" : "individual"}
  currentPlan={org.billing_plan}
  heading={null}
  showFooter={false}
  onSelectPlan={(cta) => {
    if (cta.kind === "trial") {
      submitForm("startSubscription", { plan: cta.plan });
    } else if (cta.kind === "downgrade") {
      // Opens Stripe billing portal where the user can cancel / change plan
      submitForm("manageBilling");
    } else if (cta.kind === "contact") {
      window.open("https://book-demo--camelai-team-d9e.camelai.app/", "_blank");
    }
  }}
/>
```

The Free tier is shown in settings too — clicking it fires `{ kind: "downgrade", plan: "free" }`, which opens the Stripe portal so the user can cancel their subscription. Plans below the user's current tier (e.g. Starter when on Pro) also fire `downgrade` and route to the same portal.

No changes to `PlanPicker` should be needed for that integration. If they are, the API in this plan is wrong — flag during implementation.

---

## Files Changed

### New
| File | Purpose |
|---|---|
| `src/components/billing/plan-picker.tsx` | Main component: Tabs, grid, footer, heading |
| `src/components/billing/plan-picker-card.tsx` | Single tier card: badge, price, CTA, feature list |
| `src/components/billing/plan-picker-content.ts` | Per-plan tagline, CTA label, feature bullets |
| `src/components/onboarding/byok-provider-form.tsx` | Extracted BYOK provider radio + key input from welcome.tsx |

### Modified
| File | Change |
|---|---|
| `src/routes/_onboarding.welcome.tsx` | Replace inline paywall with `<PlanPicker>` + `<ByokProviderForm>`; widen layout via `contentClassName="max-w-5xl"` when paywall is visible. Starter trial CTA reuses the existing `intent=startTrial` action; Pro/Team/Enterprise CTAs are `FIXME(billing):` no-ops |

No changes to:
- [src/lib/billing.server.ts](src/lib/billing.server.ts) — Stripe piping is out of scope; a different engineer will wire Pro and Team trial checkout in a follow-up
- [src/routes/_onboarding.welcome.tsx](src/routes/_onboarding.welcome.tsx) action signature — keep the existing hardcoded `plan: "starter", seatCount: 1` call to `createSubscriptionCheckoutSession`
- [src/lib/billing-plans.ts](src/lib/billing-plans.ts) — already has all the limits data the cards need
- [src/components/onboarding/onboarding-layout.tsx](src/components/onboarding/onboarding-layout.tsx) — `contentClassName` prop already exists

---

## Implementation Order

1. **Add `plan-picker-content.ts`** — pure data, easy to review marketing copy in isolation.
2. **Add `plan-picker-card.tsx`** — single card with all states (default, highlighted, current, pending, disabled). Storybook-style: drop a few instances on a scratch route to eyeball.
3. **Add `plan-picker.tsx`** — Tabs + grid + footer. At this point the component renders end-to-end with `onSelectPlan` logging to console.
4. **Extract `byok-provider-form.tsx`** from welcome.tsx — pure refactor, no behavior change.
5. **Wire `<PlanPicker>` into welcome.tsx** — replace the two inline panels, plumb the Starter CTA through the existing `checkoutFetcher` (intent=startTrial), add `FIXME(billing):` no-ops for Pro and Team trial CTAs, wire Enterprise to `window.open("https://book-demo--camelai-team-d9e.camelai.app/", "_blank")`, add `contentClassName="max-w-5xl"` when the paywall is showing. Do not modify the welcome.tsx action.
6. **Manual test** — start dev, walk both Individual and Team tabs: Free expands BYOK form, Starter opens Stripe checkout, Pro/Team are no-ops (verify the FIXME comment fires nothing), Enterprise opens the demo booking page in a new tab.
7. **`bun run typecheck`** and a focused `bun run test:run` of any onboarding-touching tests.

---

## Resolved Decisions

1. **Enterprise CTA** — opens `https://book-demo--camelai-team-d9e.camelai.app/` in a new tab.
2. **Team seat count at trial start** — onboarding does not collect it. The Stripe checkout page handles seat selection. The Team trial CTA is a `FIXME(billing):` no-op until that Stripe page is wired up by the billing engineer.
3. **"Most popular"** — Pro on Individual, Team on Team.
4. **Free tier in settings** — Free is shown alongside the other tiers in settings. Picking a plan below the user's current one fires `{ kind: "downgrade" }`, which the parent routes to the Stripe billing portal (where the user can cancel or change plan). The `PlanPicker` itself does not call any cancel/downgrade API directly.

---

## Not in Scope

- **Stripe piping for Pro and Team trial CTAs.** A different engineer is wiring `createSubscriptionCheckoutSession` for those plans. The CTAs land on `FIXME(billing):` no-ops in this PR; the only wired paid-trial CTA is Starter, which reuses the existing `intent=startTrial` action.
- Changes to the Stripe webhook flow, credit grant logic, or plan-switch logic in [src/lib/billing.server.ts](src/lib/billing.server.ts).
- Migrating the settings billing page to use `<PlanPicker>` — that's a follow-up; this plan only proves the API supports it.
- A "compare plans" expanded feature matrix view. The card bullets are intentionally short (5–6 features) to fit the 3-column layout. A longer comparison table can be a separate component later.
- Localization. All copy is en-US literal strings.
