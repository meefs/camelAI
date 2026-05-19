# Paywall Tier Copy Iteration — Feedback

The implementation matches the plan accurately: canonical bullet order is preserved across PayG/Starter/Pro, PayG is kept slim (4 bullets, no headline, no prefix), the `free` stub is left in place with a clarifying comment, "automations" replaced "cron jobs", and the docs link landed in the footer. Two copy revisions and one cleanup pass.

---

## 1. Remove the headline field entirely

The headlines add a full sentence of marketing prose above the bullet list on every paid card. After looking at them next to the bullets, they're redundant — every claim is already in the bullets — and the extra text crowds the card.

Audit of what each headline says vs what the bullets already cover:

| Tier | Headline | Covered in bullets? |
|---|---|---|
| Starter | "Real subscription with model credits, custom domains, and more headroom." | Credits = bullet 1. Custom domains = bullet 3. "More headroom" = the upsellPrefix already says "Everything in Pay as you go, plus" + the larger numbers in bullets 2/4/5. ✓ |
| Pro | "3× the credits, unlimited apps and domains, and a workspace inbox." | Credits = bullet 1 ($30 vs Starter's $10, both visible in the same row across cards). Unlimited apps/domains = bullets 2/3. Inbox = bullet 6. ✓ |
| Team | "Shared workspaces with roles, billed per seat." | Shared workspaces = bullet 2. Roles = bullet 3. Per-seat = price label + bullet 1. ✓ |
| Enterprise | "SSO, your own cloud, and dedicated support — built for procurement." | All four claims = bullets 1, 2, 5. "Built for procurement" is salesy framing without load-bearing info. ✓ |

Every headline is already saying what the bullets say. The only thing we lose is the comparative framing on Pro ("3× the credits") — but the absolute numbers ($10 → $30) sit on the same row across cards now, so users can do the comparison themselves. No information is lost.

### Changes

**[src/components/billing/plan-picker-content.ts:13-14](src/components/billing/plan-picker-content.ts#L13-L14)** — delete the `headline` field from the `PlanContent` interface:

```ts
export interface PlanContent {
  tagline: string;
  // delete: headline?: string;
  /** Optional "Everything in X, plus:" prefix shown above the bullet list. Renders muted, no checkmark. */
  upsellPrefix?: string;
  ctaLabel: string;
  ctaKind: PlanPickerCtaKind;
  features: string[];
}
```

**[src/components/billing/plan-picker-content.ts](src/components/billing/plan-picker-content.ts)** — delete the `headline:` line from `starter`, `pro`, `team`, and `enterprise` in `PLAN_CONTENT`. Keep everything else (tagline, upsellPrefix, ctaLabel, ctaKind, features) untouched.

**[src/components/billing/plan-picker-card.tsx:158-163](src/components/billing/plan-picker-card.tsx#L158-L163)** — delete the headline render block. The features `<CardContent>` should read:

```tsx
<CardContent className="flex-1 space-y-3">
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

Keep `space-y-3` on the wrapping `CardContent` — with the headline gone, it still gives the upsellPrefix room above the bullet list.

**Keep the `upsellPrefix` field and rendering.** It's short ("Everything in Starter, plus:"), it's not prose, and it does load-bearing work — it makes the ladder framing visible at a glance. The user's feedback was specifically about removing the headline (full-sentence marketing copy), not the prefix.

---

## 2. PayG tagline: "Try it out"

Change PayG's tagline from `"Free — no subscription"` to `"Try it out"`.

**[src/components/billing/plan-picker-content.ts:34](src/components/billing/plan-picker-content.ts#L34)**:

```ts
payg: {
  tagline: "Try it out",
  ctaLabel: "Continue",
  // ...rest unchanged
},
```

The "$0 /mo" price and "prepaid credits" subtitle already telegraph that this is the free entry point, so we don't need the tagline to do that work too. "Try it out" is friendlier and action-oriented.

**Also update the stub `free` entry's tagline to match**, for consistency (even though it isn't rendered):

**[src/components/billing/plan-picker-content.ts:26](src/components/billing/plan-picker-content.ts#L26)**:

```ts
free: {
  // ...existing comment
  tagline: "Try it out",
  // ...rest unchanged
},
```

---

## 3. Verification after the changes

Re-run the dev preview at `/dev/billing-paywall` and confirm:

- **`default`** — Starter, Pro both show their upsellPrefix line directly above the bullets (no headline above it). PayG tagline reads `Try it out`. Cards are visibly shorter than the previous round.
- **`team`** — Team card shows its upsellPrefix above bullets, no headline.
- **`current-starter` / `current-pro`** — downgrade states still render cleanly with the shorter card body.
- Bullet alignment across PayG/Starter/Pro still holds row-by-row (the headline removal doesn't change bullet positions, just the wrapper height).

Then `bun run typecheck` to confirm the type field removal didn't leave any orphan references (none expected — nothing else in the codebase reads `content.headline`).

---

## What stays

Don't change anything else from the prior round:

- Canonical bullet order across tiers ✓
- PayG at 4 bullets, no upsell prefix ✓
- `upsellPrefix` field + rendering ✓
- `free` stub in `PLAN_CONTENT` ✓
- "Automations" terminology ✓
- Footer docs link ✓
- All CTAs, trial copy, Stripe wiring ✓

The limit discrepancy flag from the original plan (PayG/Starter automation caps in `BILLING_PLAN_LIMITS` disagree with the user-direction copy) is still open — not in scope for this revision, but don't lose track of it.
