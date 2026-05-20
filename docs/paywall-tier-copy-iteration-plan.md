# Paywall Tier Copy Iteration Plan

## Problem

The paywall ships every tier with a flat list of bullets, but none of the copy answers the question every user is actually asking: **"why would I pay more?"** Today each card is a feature inventory ("30 deployed apps", "$10 of model credits / mo") with no relative framing. A user reading the Starter card has no idea what they'd be giving up by staying on Pay as you go, or what specifically they'd unlock by jumping to Pro.

Three concrete symptoms:

1. **Differentiators are buried.** Custom domains (none → 10 → unlimited) and cron frequency (daily → hourly → 5-min) are huge unlocks on paid plans. Custom domains aren't on the cards at all. Cron frequency is parenthetical: `10 cron jobs (hourly)`.
2. **Tiers read independently, not as a ladder.** There's no "Everything in Starter, plus…" framing, so the user has to mentally diff six cards to find the delta. They won't.
3. **Bullet order drifts between tiers.** Starter leads with credits → apps → storage → cron; Pro leads with credits → apps → storage → cron → inbox. Storage and cron flip places card-to-card. Visual scanning to compare two tiers side-by-side doesn't work because the same row across cards isn't the same feature.

We also need to surface the public pricing docs (`https://camelai.com/docs/plans/overview`) so users who want full detail have somewhere to go without us cluttering the cards.

## Goal

Rewrite the tier copy in `plan-picker-content.ts` and make a small layout change in `plan-picker-card.tsx` so that:

1. Every paid tier card opens with a one-line **headline** that sells the tier (not its features).
2. Every upsell tier (Starter, Pro, Team, Enterprise) shows a `Everything in [Previous], plus:` prefix above its feature list — so the ladder is visible at a glance.
3. **Bullets are in the same canonical order across every tier**, so a user scanning vertically down a row sees apples-to-apples (custom domains on every card sits in the same row).
4. A single `Compare every plan in detail →` link below the grid points at the public docs for users who want depth.

This is a copy + light-layout iteration. No CTA, Stripe, or limits changes.

---

## Tier Model — Important Context

The picker today renders **three individual tiers — Pay as you go, Starter, Pro — and two team tiers — Team, Enterprise** (see [plan-picker-content.ts:115-120](src/components/billing/plan-picker-content.ts#L115-L120)).

**Pay as you go *is* the free tier.** It costs $0/mo. The user gets to camelAI for free in one of two ways:

- Bring an API key from a provider they already use (Anthropic, OpenAI, OpenRouter, Bedrock), or
- Top up prepaid credits with us (in $5 / $10 / etc. packs) and we route their requests to hosted models at cost.

Either way no subscription is involved. **Do not introduce a separate "Free" card.** The `free` slot in `PLAN_CONTENT` (required by the `Record<BillingPlan, PlanContent>` type) is never rendered through the picker — `INDIVIDUAL_PLANS` is `["payg", "starter", "pro"]`. Leave the `free:` entry as a minimal stub; it exists only to satisfy the type.

---

## Explicit Non-Goals

- **Do not remove the 7-day trial.** The trial is being removed in a separate change. Leave every trial mention as-is for now:
  - `Start 7-day free trial` CTA labels in [plan-picker-content.ts:45, 57, 70](src/components/billing/plan-picker-content.ts)
  - `"Subscription plans include one 7-day free trial per org."` footer in [plan-picker.tsx:223](src/components/billing/plan-picker.tsx)
  - All trial-related conditionals in [plan-picker-card.tsx](src/components/billing/plan-picker-card.tsx) and [paywall-takeover.tsx](src/components/billing/paywall-takeover.tsx)
- Do not change `PlanPickerCta`, `PlanCardState`, the CTA `ctaKind`/`ctaLabel`, or any wiring in `paywall-takeover.tsx` / `_app.settings.organization.billing.tsx` / `team-upgrade-dialog.tsx`. Card consumers must not need updates.
- Do not change `BILLING_PLAN_LIMITS` in [src/lib/billing-plans.ts](src/lib/billing-plans.ts). See **Limit discrepancies to confirm** below for an open question, but make no code changes there in this pass.
- Do not change pricing strings (`$40 /mo`, `$50 /seat/mo`, etc.) — those derive from `BILLING_PLAN_LIMITS` and are correct.
- Do not change the legacy-migration paywall behavior (`legacyMode` branches in `plan-picker.tsx` / `plan-picker-card.tsx`). The new headline + upsell-prefix render the same way in legacy mode; only the `Recommended` badge swap stays as today.
- Do not add a `free` plan card. PayG is the entry tier.

---

## Canonical Bullet Order

Every rendered card uses this canonical order. **If a tier doesn't have a row, skip it — do not reorder.** Tier-specific bullets (unique to that tier, no analogue in other tiers) sit at the bottom in a fixed order.

| Position | Pay as you go | Starter | Pro | Team | Enterprise |
|---|---|---|---|---|---|
| 1. Model usage | Pay only for what you use, or bring your own API key | $10 of model credits / mo (at cost) | $30 of model credits / mo (at cost) | $10 of model credits / seat / mo | _(inherited via prefix)_ |
| 2. Deployed apps | 3 deployed apps | 30 deployed apps | Unlimited deployed apps | _(inherited)_ | _(inherited)_ |
| 3. Custom domains | _— skip_ | 10 custom domains | Unlimited custom domains | _(inherited)_ | _(inherited)_ |
| 4. Automations | 1 automated task daily | 1 automated task hourly | Automations every 5 minutes | _(inherited)_ | _(inherited)_ |
| 5. Storage | 5 GB storage | 50 GB storage | 100 GB storage | _(inherited)_ | _(inherited)_ |
| 6. Workspaces | _— skip_ | _— skip_ | _— skip_ | 2 shared workspaces | Multiple workspaces |
| 7. Tier-specific | _— skip_ | _— skip_ | Workspace email inbox | Role-based access (admin / member) | SSO / SAML; Bring your own cloud (BYOCloud); HIPAA / SOC 2; Dedicated Slack support |

**Note that "1 workspace" never appears as a bullet.** It's the silent baseline for PayG/Starter/Pro/Team-per-seat. Workspaces only show up on Team (where the user genuinely gets 2 shared ones) and Enterprise (multiple). Per direction: not a perk, don't surface it.

PayG intentionally has fewer bullets than the paid tiers (4 vs 5–6). That's a feature, not a bug — the entry tier should feel sparse so paid tiers visibly add things.

---

## ASCII Design

### Individual tab — PayG, Starter, Pro (Pro highlighted)

```
┌───────────────────────┐  ┌───────────────────────┐  ┌─[Most popular]─────────┐
│ Pay as you go         │  │ Starter               │  │ Pro                     │
│                       │  │                       │  │                         │
│ $0 /mo                │  │ $40 /mo               │  │ $150 /mo                │
│ prepaid credits       │  │ + usage after credits │  │ + usage after credits   │
│ Free — no subscription│  │ Solo builders         │  │ Power users             │
│                       │  │                       │  │                         │
│ [ Continue ]          │  │ [ Start 7-day trial ] │  │ [ Start 7-day trial ]   │
│                       │  │                       │  │                         │
│                       │  │ Real subscription w/  │  │ 3× the credits, no app  │  ← headline
│                       │  │ credits & domains.    │  │ or domain limits.       │     (only on
│                       │  │                       │  │                         │      paid tiers)
│                       │  │ Everything in Pay as  │  │ Everything in Starter,  │  ← upsell prefix
│                       │  │ you go, plus:         │  │ plus:                   │
│                       │  │                       │  │                         │
│ ✓ Pay only for what   │  │ ✓ $10 model credits/mo│  │ ✓ $30 model credits/mo  │  ← pos 1: credits
│   you use, or bring   │  │   (at cost)           │  │   (at cost)             │
│   your own API key    │  │                       │  │                         │
│ ✓ 3 deployed apps     │  │ ✓ 30 deployed apps    │  │ ✓ Unlimited deployed    │  ← pos 2: apps
│                       │  │                       │  │   apps                  │
│                       │  │ ✓ 10 custom domains   │  │ ✓ Unlimited custom      │  ← pos 3: domains
│                       │  │                       │  │   domains               │
│ ✓ 1 automated task    │  │ ✓ 1 automated task    │  │ ✓ Automations every     │  ← pos 4: automations
│   daily               │  │   hourly              │  │   5 minutes             │
│ ✓ 5 GB storage        │  │ ✓ 50 GB storage       │  │ ✓ 100 GB storage        │  ← pos 5: storage
│                       │  │                       │  │ ✓ Workspace email inbox │  ← pos 7: tier-specific
└───────────────────────┘  └───────────────────────┘  └─────────────────────────┘
```

Scanning down any row across the three cards reads the same feature each time: apps on row 2, automations on row 4, storage on row 5. That's the alignment win.

### Team tab — Team (highlighted), Enterprise

```
┌─[Most popular]─────────┐  ┌─────────────────────────┐
│ Team                    │  │ Enterprise              │
│                         │  │                         │
│ $50 /seat/mo            │  │ Custom                  │
│ + usage after credits   │  │                         │
│ Teams · Min 3 seats     │  │ For larger teams        │
│                         │  │                         │
│ [ Start 7-day trial ]   │  │ [ Contact sales ]       │
│                         │  │                         │
│ Shared workspaces with  │  │ SSO, your own cloud,    │  ← headline
│ roles, billed per seat. │  │ and dedicated support.  │
│                         │  │                         │
│ Everything in Pro for   │  │ Everything in Team,     │  ← upsell prefix
│ every seat, plus:       │  │ plus:                   │
│                         │  │                         │
│ ✓ $10 model credits/    │  │ ✓ SSO / SAML            │
│   seat/mo               │  │ ✓ Bring your own cloud  │
│ ✓ 2 shared workspaces   │  │ ✓ Multiple workspaces   │
│ ✓ Role-based access     │  │ ✓ HIPAA / SOC 2         │
│   (admin / member)      │  │ ✓ Dedicated Slack       │
│                         │  │   support               │
└─────────────────────────┘  └─────────────────────────┘
```

### Footer (new — adds below existing trial footnote)

```
       Subscription plans include one 7-day free trial per org.                  (existing)

            Compare every plan in detail  →                                      (new — opens docs)
```

---

## Files Changed

### Modified

| File | Change |
|---|---|
| `src/components/billing/plan-picker-content.ts` | Rewrite `tagline` and `features` for every tier. Add new optional `headline` and `upsellPrefix` fields to `PlanContent`. |
| `src/components/billing/plan-picker-card.tsx` | Render `headline` (if present) and `upsellPrefix` (if present) in the features `<CardContent>`. No prop signature changes. |
| `src/components/billing/plan-picker.tsx` | Append a single `Compare every plan in detail →` link below the existing trial footnote, hidden when `showFooter === false`. |

### Not modified

- `src/components/billing/paywall-takeover.tsx`
- `src/components/settings/team-upgrade-dialog.tsx`
- `src/routes/_app.settings.organization.billing.tsx`
- `src/routes/_onboarding.welcome.tsx`
- `src/routes/dev.billing-paywall.tsx` (existing preview states keep working as-is)
- `src/lib/billing-plans.ts`

---

## Detailed Content

All copy below is final. Drop it in verbatim.

### `PlanContent` type — add two optional fields

In [src/components/billing/plan-picker-content.ts:11](src/components/billing/plan-picker-content.ts#L11):

```ts
export interface PlanContent {
  tagline: string;
  /** Optional one-line "why this tier" pitch shown directly above the upsellPrefix / features. */
  headline?: string;
  /** Optional "Everything in X, plus:" prefix shown above the bullet list. Renders muted, no checkmark. */
  upsellPrefix?: string;
  ctaLabel: string;
  ctaKind: PlanPickerCtaKind;
  features: string[];
}
```

Both new fields are optional so existing call sites don't need updates. PayG omits both (entry tier, no upgrade story). Starter/Pro/Team/Enterprise use both.

### `PLAN_CONTENT` — replace the whole map

Replace the entire `PLAN_CONTENT` constant in [src/components/billing/plan-picker-content.ts:18-92](src/components/billing/plan-picker-content.ts#L18-L92) with:

```ts
export const PLAN_CONTENT: Record<BillingPlan, PlanContent> = {
  free: {
    // Not rendered by the picker — INDIVIDUAL_PLANS does not include "free".
    // Exists only to satisfy Record<BillingPlan, PlanContent>. Pay as you go is
    // the actual free tier shown to users.
    tagline: "Free — no subscription",
    ctaLabel: "Continue",
    ctaKind: "payg",
    features: [],
  },
  payg: {
    tagline: "Free — no subscription",
    ctaLabel: "Continue",
    ctaKind: "payg",
    features: [
      "Pay only for what you use, or bring your own API key",
      "3 deployed apps",
      "1 automated task daily",
      "5 GB storage",
    ],
  },
  starter: {
    tagline: "Solo builders",
    headline: "Real subscription with model credits, custom domains, and more headroom.",
    upsellPrefix: "Everything in Pay as you go, plus:",
    ctaLabel: "Start 7-day free trial",
    ctaKind: "trial",
    features: [
      "$10 of model credits / mo (at cost)",
      "30 deployed apps",
      "10 custom domains",
      "1 automated task hourly",
      "50 GB storage",
    ],
  },
  pro: {
    tagline: "Power users",
    headline: "3× the credits, unlimited apps and domains, and a workspace inbox.",
    upsellPrefix: "Everything in Starter, plus:",
    ctaLabel: "Start 7-day free trial",
    ctaKind: "trial",
    features: [
      "$30 of model credits / mo (at cost)",
      "Unlimited deployed apps",
      "Unlimited custom domains",
      "Automations every 5 minutes",
      "100 GB storage",
      "Workspace email inbox",
    ],
  },
  team: {
    tagline: "Teams shipping together",
    headline: "Shared workspaces with roles, billed per seat.",
    upsellPrefix: "Everything in Pro for every seat, plus:",
    ctaLabel: "Start 7-day free trial",
    ctaKind: "trial",
    features: [
      "$10 of model credits / seat / mo",
      "2 shared workspaces",
      "Role-based access (admin / member)",
    ],
  },
  enterprise: {
    tagline: "For larger teams",
    headline: "SSO, your own cloud, and dedicated support — built for procurement.",
    upsellPrefix: "Everything in Team, plus:",
    ctaLabel: "Contact sales",
    ctaKind: "contact",
    features: [
      "SSO / SAML",
      "Bring your own cloud (BYOCloud)",
      "Multiple workspaces",
      "HIPAA / SOC 2",
      "Dedicated Slack support",
    ],
  },
};
```

**Why the specific choices:**

- **PayG** has 4 bullets, no headline, no upsell prefix. Tagline "Free — no subscription" + the first bullet "Pay only for what you use, or bring your own API key" together explain the free-tier model in two lines. We drop `1 workspace` (per direction: not a perk, baseline only). We drop the standalone `Bring your own API key` bullet because it's folded into bullet 1 — repeating it would steal a row that better belongs to apps/automations/storage.
- **Starter / Pro / Team** bullets follow the canonical order from the table above so users scanning vertically across cards see the same feature in the same row. Custom domains are now visible everywhere they exist; cron is consistently "automations" (per direction); storage stays at the bottom of the shared rows.
- **Team** uses the upsell prefix to inherit Pro's apps/domains/automations/storage/inbox lines, then surfaces only what's distinctly team-shaped: per-seat credits, shared workspaces, RBAC. Three bullets is the right density — it telegraphs "Team is about people, not limits."
- **Enterprise** is sold differently (procurement, security, infra), so its bullets are tier-specific rather than rate-card. The upsell prefix still hooks it to Team so the ladder framing holds.

### Card render — `plan-picker-card.tsx`

In [src/components/billing/plan-picker-card.tsx:158-170](src/components/billing/plan-picker-card.tsx#L158-L170), replace the features `<CardContent>` block with:

```tsx
<CardContent className="flex-1 space-y-3">
  {content.headline ? (
    <p className="text-sm text-foreground/90">{content.headline}</p>
  ) : null}
  {content.upsellPrefix ? (
    <p className="text-xs font-medium text-muted-foreground">
      {content.upsellPrefix}
    </p>
  ) : null}
  <ul className="space-y-2 text-sm text-foreground/80">
    {content.features.map((feature) => (
      <li key={feature} className="flex items-start gap-2">
        <Check
          className="mt-0.5 size-4 shrink-0 text-foreground/70"
          aria-hidden="true"
        />
        <span>{feature}</span>
      </li>
    ))}
  </ul>
</CardContent>
```

Notes:

- Headline uses `text-foreground/90` (slightly stronger than the muted feature text) so it reads as the lead sentence without competing with the price or CTA.
- `upsellPrefix` is `text-xs` and `font-medium` — small, secondary, but visible. No checkmark; it's metadata about the bullets, not a bullet itself.
- `space-y-3` on the wrapping `CardContent` gives the headline + prefix + list visible breathing room without breaking card alignment.
- PayG omits both — no headline, no prefix, just bullets.
- The existing `min-h-[6.75rem]` on the *upper* `CardContent` ([plan-picker-card.tsx:113](src/components/billing/plan-picker-card.tsx#L113)) keeps the tagline/price area aligned across cards. The lower features block is `flex-1` so cards stretch to match the tallest in the row — no additional min-height needed.

### Footer docs link — `plan-picker.tsx`

In [src/components/billing/plan-picker.tsx:217-227](src/components/billing/plan-picker.tsx#L217-L227), inside the existing `showFooter` block, add a second line below the trial footnote:

```tsx
{showFooter ? (
  <div className="space-y-2">
    <p className="text-center text-sm text-muted-foreground">
      {legacyMode
        ? LEGACY_FOOTER_COPY
        : trialAvailable
          ? "Subscription plans include one 7-day free trial per org."
          : "Your free trial has already been used for this org."}
    </p>
    <p className="text-center text-sm text-muted-foreground">
      <a
        href="https://camelai.com/docs/plans/overview"
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:text-foreground"
      >
        Compare every plan in detail →
      </a>
    </p>
  </div>
) : null}
```

The link is omitted when `showFooter={false}` — the team-upgrade dialog and any future single-card embed stay clean.

### Heading subtitle — leave it alone

The default `DEFAULT_HEADING` in [plan-picker.tsx:37-40](src/components/billing/plan-picker.tsx#L37-L40) is overridden by every real caller (`paywall-takeover.tsx`, `_app.settings.organization.billing.tsx`). The takeover-level subtitles already do the "why" framing for their context. Touching those threads through six branches in `paywall-takeover.tsx` and is out of scope for this pass — we can iterate on them in a follow-up if the per-card story isn't enough.

---

## Limit Discrepancies to Confirm Before Merge

The automation copy in this plan reflects the user's stated direction, which disagrees with current values in `BILLING_PLAN_LIMITS`. Before shipping, confirm with the user which side is authoritative.

| Tier | Copy in this plan | `maxCronJobsPerWorkspace` in code today |
|---|---|---|
| Pay as you go | "1 automated task daily" | 2, daily ([billing-plans.ts:63-65](src/lib/billing-plans.ts#L63-L65)) |
| Starter | "1 automated task hourly" | 10, hourly ([billing-plans.ts:80-82](src/lib/billing-plans.ts#L80-L82)) |
| Pro | "Automations every 5 minutes" | 50, 5-min ([billing-plans.ts:97-99](src/lib/billing-plans.ts#L97-L99)) |
| Team | _(inherited via prefix)_ | 50 per user, 5-min ([billing-plans.ts:114-116](src/lib/billing-plans.ts#L114-L116)) |

**Two options:**

a) **Update copy to match limits.** Use `2 automated tasks daily` / `10 automated tasks hourly` / `50 automated tasks every 5 minutes`. Loses the "max one automation" framing the user wanted but matches what users actually get.

b) **Update limits to match copy.** Lower the caps in `BILLING_PLAN_LIMITS` so PayG → 1 daily, Starter → 1 hourly. This is a billing/enforcement change, **not** included in this plan — would need its own ticket and migration consideration for any user currently over the new cap.

**Recommendation:** ship copy as written (option b's user-facing wording) and open a parallel ticket to lower the actual limits. But surface this to the user before merging so they can pick.

Also of note: "automations" replaces "cron jobs" in the paywall copy per direction. Other surfaces (settings UI, error messages, BILLING_PLAN_LIMITS field names) still say "cron jobs." That terminology drift is fine for this PR — flag it for a follow-up sweep but don't touch other surfaces here.

---

## Implementation Order

1. **Update `PlanContent` type** in [plan-picker-content.ts:11](src/components/billing/plan-picker-content.ts#L11) — add optional `headline` and `upsellPrefix`.
2. **Replace `PLAN_CONTENT`** in [plan-picker-content.ts:18-92](src/components/billing/plan-picker-content.ts#L18-L92) with the new map. Pure data swap — no consumer needs updating because both new fields are optional.
3. **Update the features `<CardContent>`** in [plan-picker-card.tsx:158-170](src/components/billing/plan-picker-card.tsx#L158-L170) to render `headline` and `upsellPrefix` when present.
4. **Add the docs link** to the `showFooter` block in [plan-picker.tsx:217-227](src/components/billing/plan-picker.tsx#L217-L227).
5. **Verify visually** in the dev preview at `/dev/billing-paywall` (the route is dev-only, see [dev.billing-paywall.tsx:181-187](src/routes/dev.billing-paywall.tsx#L181-L187)). Cycle through every `state` query param:
   - `default` — new copy, Pro highlighted, docs link visible. **Confirm the canonical bullet order: row 2 says "deployed apps" across all three cards, row 3 says "custom domains" on Starter and Pro (PayG skips), row 4 says "automated task" / "automations" on all three, row 5 says "storage" on all three.**
   - `legacy` — `Recommended` badge instead of `Most popular`; legacy footer copy wins over the trial footnote; docs link still visible.
   - `legacy-multiple` — picker disabled, copy still renders.
   - `trial-used` — trial footer copy swaps to "already used"; CTA copy on cards swaps to `Choose plan`.
   - `byok-configured` — PayG CTA still reads `Continue` (the `Continue with [Provider]` branch in [plan-picker-card.tsx:58-61](src/components/billing/plan-picker-card.tsx#L58-L61) only fires for the `free` plan, which isn't rendered).
   - `current-starter` — Starter shows `Current plan` badge; PayG shows `Downgrade`; Pro is selectable.
   - `current-pro` — Pro `Current plan`; Starter & PayG show `Downgrade`.
   - `team` — Team tab default; Team highlighted; `Everything in Pro for every seat, plus:` prefix visible.
6. **Verify the team-upgrade dialog** at `/settings/organization/team` (or wherever `<TeamUpgradeDialog>` is triggered — see [team-upgrade-dialog.tsx:117-127](src/components/settings/team-upgrade-dialog.tsx#L117-L127)). It renders a single Team card via `<PlanPickerCard plan="team" state={{ kind: "highlighted" }} />`. Confirm:
   - Headline appears.
   - `Everything in Pro for every seat, plus:` prefix appears.
   - Bullets render correctly.
   - `showFooter` is not passed → no docs link, no trial footnote — clean inside a dialog.
7. **Verify the settings billing page** at `/settings/organization/billing?view=plans` — same `<PlanPicker>` instance, confirm the cards match the dev preview.
8. **`bun run typecheck`** — should pass; the new `PlanContent` fields are optional so no existing consumer breaks.
9. **`bun run lint`**.

No tests need to change. The existing tests (if any) cover `PlanPicker` structure and CTA wiring, not marketing copy.

---

## Risk / Edge Cases

- **Card height**: the new layout adds 1–2 short lines (headline + upsell prefix) to most paid cards. Cards in a row stretch to match the tallest, so adding lines to Pro will push the others (PayG, Starter) taller too. Spot-check at `md:` breakpoint (where the 3-column grid first appears). Cards should still fit above the fold on a 1280px-wide screen.
- **PayG with fewer bullets**: PayG has 4 bullets, Starter/Pro have 5–6. Because cards stretch to match the tallest, PayG will have visible empty space at the bottom. **This is intentional per direction** — the entry tier should look sparse so the upgrade visibly adds things. Do not pad PayG with filler.
- **Single-card embeds** (team-upgrade dialog): the Team card has both a headline *and* an upsell prefix. Inside a `sm:max-w-lg` Dialog (~32rem), the headline can wrap to 2 lines. That's fine — design accepts it. Just confirm visually.
- **Long upsell prefix on Team**: `Everything in Pro for every seat, plus:` is the longest of the four. At a card width of ~16rem (3-col layout on a `max-w-4xl` container), this should not wrap. If it does in QA, shorten to `Everything in Pro, per seat, plus:`. Keep the comparison-to-previous-tier framing.
- **Legacy mode footer**: the legacy footer copy (`Picking a paid plan starts a subscription switch…`) wins over the trial footnote today. The new docs link should still render below it in legacy mode — verify that's not weird tonally. If it is, gate the docs link on `!legacyMode`.

---

## What's Coming Next (informational — not in this PR)

- The 7-day trial copy is slated for removal in a follow-up plan. Once that ships, the CTAs (`Start 7-day free trial` → `Start subscription`) and the trial footer line will be updated together. The headline / upsell-prefix / feature copy from this plan is written to read naturally with or without trial framing, so no rewrite needed when that change lands.
- The "automations" vs "cron jobs" terminology drift between paywall and other surfaces (settings, error messages, code) should be reconciled in a follow-up sweep.
- The settings page heading subtitle and the multi-branch subtitles in `paywall-takeover.tsx:142-150` can be tuned in a small follow-up if the per-card copy from this pass doesn't carry the "why upgrade" story far enough. Hold off until we have feedback on this iteration.
- If the user picks option (b) above (lower the automation limits to match the new copy), that's a separate billing/enforcement ticket with migration considerations for any current user over the new cap.
