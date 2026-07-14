# Pricing Tier Update — $10 Starter / $40 Pro / $50 Team, credits match price

**Date:** 2026-07-14
**Primary owner:** `src/lib/billing-plans.ts`
**Audience:** the coding agent implementing this change. Section 6 is an operator runbook for a human with Stripe dashboard access — do **not** attempt those steps, do not invent Stripe price IDs, and do not edit `wrangler.prod.jsonc` / `wrangler.staging.jsonc` (the operator fills in the new price IDs at rollout).

## 1. Product decision

Every paid tier's included monthly credit grant now equals its sticker price, and Starter/Pro get cheaper:

| Plan | Price today | Price new | Included credits today | Included credits new |
| --- | --- | --- | --- | --- |
| Starter | $40/mo | **$10/mo** | $10/mo | $10/mo (unchanged) |
| Pro | $150/mo | **$40/mo** | $30/mo | **$40/mo** |
| Team | $50/seat/mo | $50/seat/mo (unchanged) | $10/seat/mo | **$50/seat/mo** |

Existing subscribers keep their current period exactly as already billed and simply pay the new lower price from their **next** invoice. No refunds, no proration credits, no retroactive credit grants for the current period. Everything else stays the same: trial mechanics, credit packs, seat minimums (Team min 3), plan limits, enterprise, free/PAYG.

Because Team's Stripe price does not change, only **Starter and Pro** need new Stripe prices and a subscription migration. Team's credit increase is entirely app-side.

## 2. How pricing flows through the system today

Two decoupled sources of truth:

| Source | Controls | Where |
| --- | --- | --- |
| `BILLING_PLAN_LIMITS` | Displayed prices, seat-add cost math, and the included-credit formula `includedCreditCentsBase + includedCreditCentsPerSeat × seats` (`getIncludedCreditCentsForPlan`) | [billing-plans.ts:34-137](src/lib/billing-plans.ts#L34-L137), [billing-plans.ts:183-192](src/lib/billing-plans.ts#L183-L192) |
| Stripe price IDs in env vars | What Stripe actually charges | `STRIPE_STARTER_PRICE_ID`, `STRIPE_SUBSCRIPTION_PRICE_ID` (legacy fallback for Starter), `STRIPE_PRO_PRICE_ID`, `STRIPE_TEAM_PRICE_ID` in [wrangler.prod.jsonc:48-51](wrangler.prod.jsonc#L48-L51) / [wrangler.staging.jsonc:47-50](wrangler.staging.jsonc#L47-L50), resolved by `getConfiguredSubscriptionPriceId` ([billing.server.ts:954-978](src/lib/billing.server.ts#L954-L978)) |

Load-bearing mechanics (verified against current code):

- **Renewal credit grant** — `applySubscriptionIncludedCreditsFromInvoice` ([billing.server.ts:2986-3060](src/lib/billing.server.ts#L2986)) runs on `invoice.payment_succeeded`. Plan comes from invoice/subscription `metadata.billing_plan` (never from the price ID). If an invoice line's price matches `getConfiguredSubscriptionPriceId(env, plan)`, the grant is **recomputed live** from `billing-plans.ts` using the line's seat quantity; otherwise it falls back to the subscription's stored `metadata.subscription_included_credit_cents`. Idempotent per invoice (org field `billing_last_included_credit_invoice_id` + KV marker), so webhook replays are safe.
- **Metadata stamping** — checkout stamps `billing_plan`, `seat_count`, `subscription_included_credit_cents`, `initial_included_credit_cents` onto the subscription ([billing.server.ts:1518-1529](src/lib/billing.server.ts#L1518-L1529)), and `bestEffortSyncStripeSubscriptionBillingMetadata` re-stamps them on every subscription webhook sync ([billing.server.ts:2633-2684](src/lib/billing.server.ts#L2633), called at [billing.server.ts:2841](src/lib/billing.server.ts#L2841)).
- **Unknown price IDs are safe** — `getPlanFromConfiguredPrice` returns `null` for unrecognized prices and `syncOrgSubscriptionFromStripe` falls back to `metadata.billing_plan` ([billing.server.ts:2816-2822](src/lib/billing.server.ts#L2816)). Since checkout always stamps `billing_plan`, subscriptions on old price IDs keep the right plan during the migration window.
- **No trials; credits require payment.** No product flow creates a Stripe trial: checkout never sets a trial period and stamps `trial_credit_cents: "0"` ([billing.server.ts:1496](src/lib/billing.server.ts#L1496)), and every included-credit grant requires a **paid** invoice (`invoice.payment_succeeded`) or a paid credit checkout. The trial-credit plumbing (`getDefaultTrialCreditCentsForPlan`, [billing.server.ts:377-385](src/lib/billing.server.ts#L377)) is dormant — it activates only if a subscription is manually put into `trialing` via the Stripe dashboard — and is intentionally untouched by this change. `DEFAULT_TRIAL_CREDIT_CENTS` / `DEFAULT_SUBSCRIPTION_INCLUDED_CREDIT_CENTS` ([billing.server.ts:27-28](src/lib/billing.server.ts#L27-L28)) stay `1000`, and the global env overrides `BILLING_TRIAL_CREDIT_CENTS` / `BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS` stay unset.
- **No active-subscription price swap exists.** Only trialing subs can change price today (`updateTrialingStripeSubscriptionPlan`, `proration_behavior: "none"` at [billing.server.ts:2067](src/lib/billing.server.ts#L2067)). The migration script in §5 is net-new; reuse that proration pattern.

## 3. Code changes — constants and copy

### 3.1 `src/lib/billing-plans.ts` (4 value edits, nothing else)

| Line | Field | Old | New |
| --- | --- | --- | --- |
| 72 | `starter.monthlyPriceCents` | `4000` | `1000` |
| 89 | `pro.monthlyPriceCents` | `15000` | `4000` |
| 94 | `pro.includedCreditCentsBase` | `3000` | `4000` |
| 110 | `team.includedCreditCentsPerSeat` | `1000` | `5000` |

Unchanged on purpose: `starter.includedCreditCentsBase: 1000` (L77), `team.monthlyPriceCents: 5000` (L106), `team.minimumSeats: 3` (L107), everything for free/payg/enterprise.

This single edit propagates to: plan-card prices (`formatPlanPrice`), seat-add cost previews (`getBillableTeamInviteSeatChange*`, invite dialog, team settings), checkout metadata amounts, renewal grant recomputation, trial credit amounts, and the legacy v1→v2 migration preview.

### 3.2 `src/components/billing/plan-picker-content.ts` — hardcoded feature bullets (2 string edits)

These strings are prose, not derived — they must be edited by hand:

| Line | Old | New |
| --- | --- | --- |
| 61 (pro) | `"$30 of model credits / mo (at cost)"` | `"$40 of model credits / mo (at cost)"` |
| 74 (team) | `"$10 of model credits / seat / mo"` | `"$50 of model credits / seat / mo"` |

Line 47 (starter) `"$10 of model credits / mo (at cost)"` is already correct — leave it. Do not change any other bullet, tagline, `upsellPrefix`, or CTA label.

### 3.3 `src/routes/_app.settings.organization.billing.tsx` — `planSubtitle()` (2 string edits)

In `planSubtitle()` (lines 136-151):

| Line | Old | New |
| --- | --- | --- |
| 145 (pro) | `"$30/month in hosted credits."` | `"$40/month in hosted credits."` |
| 147 (team) | `"$10/seat/month in hosted credits."` | `"$50/seat/month in hosted credits."` |

Line 143 (starter) `"$10/month in hosted credits."` stays. No other changes in this route.

### 3.4 `src/lib/billing.server.ts` — align the grant path with the documented contract (1-line fix)

`getInvoiceLineItemSeatQuantity` ([billing.server.ts:2954-2969](src/lib/billing.server.ts#L2954)) previously fell back to `lines[0]?.quantity` when no invoice line matched the configured price, which routed non-matching invoices (migration-window renewals, custom dashboard prices) into the live-recompute path with a possibly-wrong quantity and left the metadata fallback nearly unreachable. Drop the fallback (`matchingLine?.quantity` only) so non-matching invoices use the stamped `subscription_included_credit_cents` metadata, exactly as §2 documents and §4.2's scenario 3 asserts.

### 3.5 `AGENTS.md` — keep the agent guide accurate

In the **Stripe Billing And Credits** section, update:

> Hosted credit allowances come from `src/lib/billing-plans.ts`: Starter includes $10/month, Pro includes $30/month, and Team includes $10/month per paid seat.

to:

> Hosted credit allowances come from `src/lib/billing-plans.ts`: Starter includes $10/month, Pro includes $40/month, and Team includes $50/month per paid seat.

### 3.6 `src/lib/billing.server.ts` — checkout price guard (fail closed on config drift)

`createSubscriptionCheckoutSession` now fetches the configured price (`fetchStripePriceSummary`) before creating a session and throws unless it is active-config-consistent: `unit_amount === BILLING_PLAN_LIMITS[plan].monthlyPriceCents`, `currency: usd`, `recurring.interval: month`, `interval_count: 1`. A deploy where the plan constants and the configured Stripe price IDs disagree — in either direction — turns into a loud checkout error instead of silently advertising one price and charging another. The extra `GET /v1/prices/{id}` adds one Stripe round-trip per checkout-session creation and no new availability dependency (the session POST already requires Stripe). Portal plan changes and the trialing plan swap are deliberately not guarded: the Stripe-hosted portal shows the real amount to the user before they confirm.

## 4. Tests

### 4.1 Update existing assertions

| File | What changes |
| --- | --- |
| [tests/billing.test.ts](tests/billing.test.ts) | L143-145: `getIncludedCreditCentsForPlan("pro", 1)` `3000`→`4000`; `("team", 4)` `4000`→`20000`; `("starter", 1)` stays `1000`. Plan-matrix snapshot L223-287: starter `monthlyPriceCents` `4000`→`1000`; pro `monthlyPriceCents` `15000`→`4000` and `includedCreditCentsBase` `3000`→`4000`; team `includedCreditCentsPerSeat` `1000`→`5000` (team `monthlyPriceCents 5000` stays). Leave the overview-math seeds at L204-220 alone (test-local values, not plan constants). |
| [tests/billing-settings-overview-ui.test.tsx](tests/billing-settings-overview-ui.test.tsx) | L133: expect `"$40/month in hosted credits."` for Pro. |
| [tests/billing-legacy-migration-route.test.ts](tests/billing-legacy-migration-route.test.ts) | Pro preview: `monthlyPriceCents` `15000`→`4000`, `includedCreditCents` `3000`→`4000` (L66-72, L96-102); adjust the proration mock values to stay internally consistent. |
| [tests/stripe-integration.test.ts](tests/stripe-integration.test.ts) | Test-price creation L430-443: starter `unitAmount` `4000`→`1000`, pro `15000`→`4000` (team `5000`, credit `1000` stay). L507: `subscription_included_credit_cents` for 25 Team seats `"25000"`→`"125000"`. L554/591/621/644: pro plan-sync credits `3000`→`4000` (starter `1000` stays). L691-693: Team 4-seat metadata `"4000"`→`"20000"`. (Runs only under `bun run test:stripe` with a test-mode key.) |
| [workers/main/tests/billing-org.test.ts](workers/main/tests/billing-org.test.ts) | Starter fixture `unit_amount: 4000` → `1000` (L50-51, L78-79) for price realism. All the `1000` trial/included-credit assertions stay — Starter credits are unchanged. |

Untouched (verify no accidental edits): `tests/billing-plans.test.ts` (references constants, no literals), `tests/chat-credit-status.test.ts`, `tests/billing-chat-credit-status-route.test.ts`, `tests/billing-credit-packs.test.ts`, credit-grant admin tests.

### 4.2 New regression test — line-match recompute beats stale metadata

This is the invariant the whole rollout leans on: once env price IDs and constants ship, renewal invoices whose line matches the configured price must grant the **new** amounts even while the subscription still carries old metadata. Add to [tests/billing.test.ts](tests/billing.test.ts) alongside the existing webhook/grant coverage, following its existing ORG-stub mocking pattern, exercising `applySubscriptionIncludedCreditsFromInvoice`:

1. **Pro, stale metadata:** paid invoice, `billing_reason: "subscription_cycle"`, one line with the configured pro price, quantity 1, invoice/subscription metadata `billing_plan: "pro"`, `subscription_included_credit_cents: "3000"` (stale) → grant recorded is **4000**.
2. **Team, stale metadata:** same shape with the configured team price, quantity 3, stale metadata `"3000"` → grant is **15000**.
3. *(Cuttable)* **Migration-window fallback:** line price does *not* match any configured price, metadata `subscription_included_credit_cents: "3000"` → grant is 3000 (documents the fallback used while a sub is still on an old price).
4. **Checkout price guard (§3.6):** with the configured pro price returning `unit_amount: 15000` from Stripe, `createSubscriptionCheckoutSession` rejects with `does not match the advertised` and never POSTs `/checkout/sessions`. The existing checkout tests serve matching `/prices/{id}` responses from their fetch stubs (amounts per `BILLING_PLAN_LIMITS`) and keep passing.

## 5. New migration script — `scripts/migrate-stripe-plan-prices.ts`

Break-glass one-off (same category as `scripts/migrate-to-workspaces.ts`), run locally with Bun by the operator. Moves every Starter/Pro subscription from the old price to the new price **effective next invoice, with no proration**, and re-stamps billing metadata in the same call.

Constraints:

- No new dependencies. Use raw `fetch` against `https://api.stripe.com/v1/...` with `URLSearchParams` form bodies (mirror the `stripeRequest` style). Do **not** import `src/lib/billing.server.ts` (worker-typed); **do** import `getIncludedCreditCentsForPlan` and `normalizeSeatCount` from `src/lib/billing-plans.ts` (pure module) so the stamped amounts can never drift from the app.
- CLI: `--mode test|live` (required; hard-fail unless `STRIPE_SECRET_KEY` prefix matches the mode, same semantics as `isStripeSecretKeyAllowedForMode`), `--starter-old <id> --starter-new <id>`, `--pro-old <id> --pro-new <id>` (each pair optional, but old/new must come together), `--team-restamp <id>` (optional metadata-only pass), `--execute` (default is dry-run), `--page-size <n>` (default 100).

Example invocation:

```bash
STRIPE_SECRET_KEY=sk_live_... bun scripts/migrate-stripe-plan-prices.ts \
  --mode live \
  --starter-old price_1TRzJ5GvliMKf4vHt5P6ODiY --starter-new <NEW_STARTER_PRICE_ID> \
  --pro-old price_1TRzJDGvliMKf4vHiCvInGpn --pro-new <NEW_PRO_PRICE_ID> \
  --team-restamp price_1TRzJPGvliMKf4vH3btUUY1d \
  --execute
```

Behavior, per `--*-old/--*-new` pair:

1. **Preflight:** `GET /v1/prices/{new}` — must be `active`, `currency: usd`, `recurring.interval: month` with `interval_count: 1` and `usage_type: licensed`, and `unit_amount === BILLING_PLAN_LIMITS[plan].monthlyPriceCents` (hard fail otherwise; this catches pasted-wrong IDs, quarterly prices, and metered prices). Warn (don't fail) if the old price's `unit_amount` isn't the legacy value (4000 starter / 15000 pro). **Hard-fail if the old and new prices are on different products** — Stripe coupons and portal configuration can be product-scoped, so a different-product price could silently strip existing customer discounts; the runbook creates the new price on the same product.
2. **Enumerate:** `GET /v1/subscriptions?price={old}&status=all&limit={page-size}` with `starting_after` pagination until `has_more` is false.
3. **Per subscription:**
   - Skip (count only) **terminal** statuses `canceled` and `incomplete_expired`.
   - Flag `incomplete` for **manual review**, never a silent skip: Stripe can activate an incomplete subscription within ~23 hours of creation, and a silently-skipped one would stay on the old price forever. Rerun the script after the activation window until none remain (each will have become `active` → migrated, or `incomplete_expired` → terminal skip).
   - Flag for manual review (log, no update): subscription has a `schedule`, or zero/multiple items match the old price.
   - Otherwise `POST /v1/subscriptions/{id}` with exactly: `items[0][id]={item.id}`, `items[0][price]={new}`, `items[0][quantity]={item.quantity}`, `proration_behavior=none`, `metadata[billing_plan]={plan}`, `metadata[seat_count]={normalizeSeatCount(plan, item.quantity)}`, `metadata[subscription_included_credit_cents]={getIncludedCreditCentsForPlan(plan, seats)}`. Send nothing else — never touch `trial_end`, `cancel_at_period_end`, `pause_collection`, discounts. Trialing subs are updated too (trial is preserved; first real invoice bills the new price). Subs with `cancel_at_period_end` are updated anyway (harmless; correct if they resume).
4. **`--team-restamp` pass:** enumerate subs on the team price the same way; where `metadata.subscription_included_credit_cents` differs from the computed value, POST a metadata-only update (`billing_plan`, `seat_count`, `subscription_included_credit_cents`) — no items, no proration param. This is belt-and-braces: Team renewals recompute from the line-match path regardless (§2), and `bestEffortSyncStripeSubscriptionBillingMetadata` heals metadata on the next webhook anyway.
5. **Logging:** one line per subscription — id, `metadata.org_id`, status, old→new price, quantity, metadata credits old→new, action (`updated` | `dry-run` | `skipped:<reason>`); summary counts at the end. Exit non-zero if anything was flagged for manual review.
6. **Idempotent:** enumeration by old price naturally excludes already-migrated subs, so re-runs converge. The summary reports `actionable = updated + dry-run + manual-review` per pass; **completion means a final dry-run reports `actionable=0`**. (`status=all` enumeration will keep listing canceled/`incomplete_expired` subs that retain the old price forever — that terminal residue is expected and shows up only under `skipped`.) Sequential requests; on HTTP 429 honor `Retry-After` once, then fail loudly.

Side effects to expect (safe): each update fires `customer.subscription.updated` → `syncOrgSubscriptionFromStripe` resolves the plan via the *new* configured price, refreshes org billing state, and the metadata no-ops. No credit grants fire from sync for active subs; the trialing one-time trial grant is idempotency-guarded (covered by `workers/main/tests/billing-org.test.ts`).

## 6. Operator runbook (human with Stripe access — NOT the coding agent)

The release must be **atomic**: the merged PR carries both the new plan constants and the new price IDs, so a normal deploy can never advertise one price while charging another. New Stripe prices are inert until something references them, so they are created **before** merge. The checkout guard (§3.6) backstops this mechanically — a deploy with mismatched price config fails checkout loudly instead of mischarging.

0. **Before merge — create all four prices and fill the IDs into this PR.** Find the product IDs behind the old prices (`GET /v1/prices/{id}`, field `product`), then create the new Starter/Pro prices on those **same products**, in **both** test and live mode (copy `tax_behavior` if the old price sets it):

   ```bash
   curl https://api.stripe.com/v1/prices -u "$STRIPE_SECRET_KEY:" \
     -d product=<STARTER_PRODUCT_ID> -d currency=usd -d unit_amount=1000 \
     -d "recurring[interval]=month" -d nickname="Starter $10/mo (2026-07)"
   # same for Pro with unit_amount=4000
   ```

   Then edit [wrangler.staging.jsonc:47-49](wrangler.staging.jsonc#L47-L49) (test-mode IDs) and [wrangler.prod.jsonc:48-50](wrangler.prod.jsonc#L48-L50) (live-mode IDs) **in this PR**: `STRIPE_SUBSCRIPTION_PRICE_ID` **and** `STRIPE_STARTER_PRICE_ID` → the new starter ID (they stay in sync), `STRIPE_PRO_PRICE_ID` → the new pro ID, `STRIPE_TEAM_PRICE_ID` unchanged. **Do not merge while either wrangler config still points at the old prices** — with the constants changed, checkout on such a deploy fails closed (§3.6) until the config is fixed.
1. **Staging rehearsal (test mode).** Deploy `bun run deploy:main:staging`. Smoke: plan picker shows $10/$40/$50, a test-card checkout charges the new amount and the org receives the matching grant. Run the §5 script dry-run then `--execute` with the test key; re-run dry-run → `actionable=0`.
2. **Billing portal configs** (staging `bpc_1TS5SyGvliMKf4vHI6CvOx6n`, prod `bpc_1TRzFFGvliMKf4vHONtqkRyn`): if the configuration's `subscription_update` feature has a product/price allowlist, add the new prices. Verify a plan switch through the portal in staging.
3. **Production.** Deploy `bun run deploy:main:prod`, then immediately run the script: dry-run, review the list/counts, then `--execute`. Between prod deploy and script completion, not-yet-migrated Starter/Pro renewals still bill the old price and Pro grants can fall back to stale metadata — keep that gap to minutes and pick a low-renewal window (check upcoming invoices in Stripe).
4. **Verify.** A dry-run rerun reports `actionable=0` for every pass (terminal canceled/`incomplete_expired` residue stays under `skipped` — expected). If any subscriptions were flagged `manual-review-incomplete-may-activate`, rerun the script after ~24h until they have either activated (and migrated) or expired. Spot-check one migrated subscription in the dashboard (new price, no pending proration items, upcoming invoice at the new amount); watch the webhook logs for `customer.subscription.updated` sync errors.
5. **Cleanup (optional).** Archive the old Starter/Pro prices in both modes so nothing can sell them again — no code references them after the env swap.

## 7. UI end state

**No layout, component, or styling changes.** Every price digit on the cards renders from `BILLING_PLAN_LIMITS` via `formatPlanPrice`; the only hand-edited UI text is the four strings in §3.2/§3.3. The mockups below are the expected *rendered result* for verification, not a redesign. Badges ("Most popular" / "Current plan"), CTA states, tab behavior, and the picker footer are unchanged.

Plan picker (`PlanPicker` → `PlanPickerCard`), Individual tab:

```
┌──────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────────────┐
│ Pay as you go            │ │ Starter                  │ │ Pro          [badge]     │
│                          │ │                          │ │                          │
│ $0 /mo                   │ │ $10 /mo                  │ │ $40 /mo                  │
│ prepaid credits          │ │ + usage after credits    │ │ + usage after credits    │
│ Try it out               │ │ Solo builders            │ │ Power users              │
│                          │ │                          │ │                          │
│ [ Continue ]             │ │ [ Subscribe ]            │ │ [ Subscribe ]            │
│                          │ │                          │ │                          │
│ ✓ Pay only for what you  │ │ Everything in Pay as you │ │ Everything in Starter,   │
│   use, or bring your own │ │ go, plus:                │ │ plus:                    │
│   API key                │ │ ✓ $10 of model credits   │ │ ✓ $40 of model credits   │
│ ✓ 3 deployed apps        │ │   / mo (at cost)         │ │   / mo (at cost)         │
│ ✓ 1 automated task daily │ │ ✓ 30 deployed apps       │ │ ✓ Unlimited deployed apps│
│ ✓ 5 GB storage           │ │ ✓ 10 custom domains      │ │ ✓ Unlimited custom       │
│                          │ │ ✓ 1 automated task hourly│ │   domains                │
│                          │ │ ✓ 50 GB storage          │ │ ✓ Automations every 5 min│
│                          │ │ ✓ Workspace email inbox  │ │ ✓ 100 GB storage         │
└──────────────────────────┘ └──────────────────────────┘ └──────────────────────────┘
```

Team tab:

```
┌──────────────────────────┐ ┌──────────────────────────┐
│ Team                     │ │ Enterprise               │
│                          │ │                          │
│ $50 /seat/mo             │ │ Custom                   │
│ + usage after credits    │ │ For larger teams         │
│ Teams shipping together  │ │                          │
│ Min 3 seats              │ │ [ Contact sales ]        │
│                          │ │                          │
│ [ Subscribe ]            │ │ Everything in Team, plus:│
│                          │ │ ✓ SSO / SAML             │
│ Everything in Pro for    │ │ ✓ BYOCloud …             │
│ every seat, plus:        │ │                          │
│ ✓ $50 of model credits   │ │                          │
│   / seat / mo            │ │                          │
│ ✓ 2 shared workspaces    │ │                          │
│ ✓ Role-based access      │ │                          │
│   (admin / member)       │ │                          │
└──────────────────────────┘ └──────────────────────────┘
```

Billing settings overview (`/settings/organization/billing`), per plan:

```
Starter plan                      Pro plan                        Team plan - 4 seats
$10/month in hosted credits.      $40/month in hosted credits.    $50/seat/month in hosted credits.
Renews Jun 8, 2026.               Renews Jun 8, 2026.             Renews Jun 8, 2026.
```

Surfaces that update automatically (verify, don't edit): the paywall takeover (`paywall-takeover.tsx` wraps `PlanPicker`), onboarding `/onboarding` plan choice, the manage-plan view (`?view=plans`), the Team upgrade dialog (embeds `PlanPickerCard plan="team"` — will show $50/seat + the new bullet), invite-member seat-cost lines (computed from `monthlyPriceCents`, unchanged for Team), and the dev preview at `/dev/billing-paywall` (use it to eyeball all card states without Stripe).

## 8. Behavior notes and edge cases

- **No retroactive adjustments.** Current-period grants and already-issued invoices stay as-is; existing Pro subscribers see $40 credits starting with their first invoice after migration. Do not add any top-up/backfill logic.
- **Team self-heals without a Stripe migration.** Its price ID is unchanged, so renewal invoice lines keep matching the configured price and grants recompute at $50/seat from the first renewal after deploy. The `--team-restamp` pass and webhook-driven `bestEffortSync` just keep metadata cosmetically consistent.
- **Migration window is safe for plan identity.** Subs still on old price IDs resolve their plan from `metadata.billing_plan` (stamped at checkout), so nothing misclassifies to Starter; only the *grant amount* can briefly use stale metadata, which the immediate migration closes.
- **Discounts/promo codes persist** through a price swap (Stripe keeps subscription-level coupons). No action.
- **Past-due invoices at the old price** may still get paid later — they were billed before the change; that's expected under "no returns".
- **Org-stored `subscription_included_credit_cents`** refreshes on the next subscription webhook (immediately for migrated Starter/Pro subs; next event for Team). Balances are unaffected — grants are computed at invoice time.
- **Legacy v1→v2 migration flow** (`migrateLegacyStripeSubscription`, `LEGACY_INDIVIDUAL_PRICE_IDS`/`LEGACY_TEAM_PRICE_IDS`) automatically targets the new configured prices/credits; do not touch its allowlists.
- **`isStripeBillingConfigured`** only checks that a Starter price and a credit price exist — unaffected.

## 9. Files changed

**Modified (code PR):**
- `src/lib/billing-plans.ts` — 4 constants (§3.1)
- `src/components/billing/plan-picker-content.ts` — 2 strings (§3.2)
- `src/routes/_app.settings.organization.billing.tsx` — 2 strings (§3.3)
- `src/lib/billing.server.ts` — grant-path alignment, 1 line (§3.4)
- `AGENTS.md` — credit-allowance sentence (§3.5)
- `tests/billing.test.ts`, `tests/billing-settings-overview-ui.test.tsx`, `tests/billing-legacy-migration-route.test.ts`, `tests/stripe-integration.test.ts`, `workers/main/tests/billing-org.test.ts` (§4.1)

**New (code PR):**
- `scripts/migrate-stripe-plan-prices.ts` (§5)
- Regression test cases in `tests/billing.test.ts` (§4.2)

**Operator-filled before merge (part of this PR):** `wrangler.staging.jsonc` L47-49 and `wrangler.prod.jsonc` L48-50 receive the new price IDs once the operator creates the Stripe prices (§6 step 0). Stripe price creation and portal-config changes stay dashboard work.

## 10. Verification

```bash
bun run typecheck
bun run test:run tests/billing.test.ts tests/billing-plans.test.ts \
  tests/billing-settings-overview-ui.test.tsx tests/billing-legacy-migration-route.test.ts \
  tests/billing-credit-packs.test.ts tests/chat-credit-status.test.ts
bun run test:workers -- billing-org
# Optional, needs a test-mode Stripe key in env (creates its own throwaway prices):
bun run test:stripe
```

Visual check: `bun run dev` → `/dev/billing-paywall` shows the §7 card copy in every preview state.

## 11. Out of scope / resolved decisions

- **External marketing site** and the plan-comparison page linked from the picker footer (`https://camelai.com/docs/plans/overview`) live outside this repo — the operator must update them separately.
- **Credit packs** (`STRIPE_CREDIT_PRICE_IDS`) are unchanged.
- **No annual prices exist** anywhere in the system; nothing to add.
- **Proration decision:** `proration_behavior: "none"` for the migration — current period stays as billed, next invoice at the new price, no credit notes (the "no returns" requirement).
- **Rollout ordering decision:** prices created pre-merge and IDs shipped in the PR, deploy is atomic, migrate immediately after (§6) — keeps checkout/UI correct from the moment of deploy and closes the grant-fallback gap within minutes.
- **Checkout fails closed on price-config drift** (§3.6): if `BILLING_PLAN_LIMITS` and the configured Stripe price ever disagree, new-subscription checkout throws instead of selling at an unadvertised amount. Portal plan changes and the trialing swap are deliberately unguarded — Stripe's hosted portal shows the real amount before the user confirms.
- **`STRIPE_SUBSCRIPTION_PRICE_ID` stays** as a Starter alias, always set to the same value as `STRIPE_STARTER_PRICE_ID`; do not remove the fallback.
- **No trials exist and none are added.** A user must pay to receive credits: checkout charges immediately and all grants come from paid invoices or paid checkouts (§2). The dormant, dashboard-only trial path is out of scope.
- **Team `minimumSeats: 3`** and all non-credit plan limits are untouched.
