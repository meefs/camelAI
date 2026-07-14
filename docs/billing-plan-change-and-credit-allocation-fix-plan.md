# Billing Plan Changes and Included-Credit Allocation Fix

**Status:** Approved for implementation

**Product contract approved:** July 14, 2026

**Audience:** Coding agent implementing the fix

**Primary surface:** `/settings/organization/billing`

**Related pricing change:** [PR #1007](https://github.com/qaml-ai/chiridion-app/pull/1007)

## Outcome

Make every paid-plan transition deterministic and financially safe:

- The selected Starter, Pro, or Team plan opens a Stripe-hosted confirmation flow with the exact target price and server-computed quantity.
- Paid upgrades invoice the prorated difference immediately and grant the corresponding prorated hosted-model credits exactly once.
- Downgrades work through Stripe again without refunding already-granted credits.
- Full initial and renewal invoices grant the configured monthly allowance exactly once.
- Duplicate, out-of-order, failed, and differently versioned Stripe webhook events cannot double-grant or silently skip credits.
- Stripe API requests and the webhook endpoint move to one current, explicitly pinned API version through a reversible dual-endpoint rollout.
- The billing page no longer implies that camelAI stores card details. The current paid-plan card instead has a primary **Manage in Stripe** action.

This is a correctness change, not just a UI patch. Portal configuration, invoice interpretation, webhook routing, and Durable Object credit persistence must ship together.

## Approved Product Contract

These decisions are final for this implementation. The coding agent should not substitute different proration, credit, refund, or downgrade behavior.

| Situation | Stripe behavior | Credit behavior | App behavior |
| --- | --- | --- | --- |
| Free/Pay as you go -> paid | Stripe Checkout creates the subscription and collects the first payment | A paid `subscription_create` invoice grants the full configured allowance | Webhook activates the paid plan |
| Active paid plan -> more expensive plan | Preserve the billing-cycle anchor and use `proration_behavior=always_invoice` | Grant the positive **net plan allowance delta** represented by the paid proration invoice | Stripe-hosted confirmation shows the amount due now |
| Starter/Pro -> Team | Same immediate proration, using the exact billable member + active-invite count, with the Team minimum enforced | Grant the prorated net delta now; the next full renewal grants `$50 x billed seats` | The user cannot choose an arbitrary seat quantity in Stripe |
| Active paid plan -> less expensive plan | Use `proration_behavior=none`; change the recurring price without an immediate refund or invoice | Grant no new credits and do not claw back already-granted credits | Lower plan/entitlements take effect after Stripe confirms; lower price starts on the next renewal |
| Trialing paid plan -> another paid plan | Continue the existing trial and update the price without invoicing | No paid-subscription allowance until the first paid invoice; preserve any one-time trial-credit rules | Existing direct trial-update behavior remains |
| Past due, unpaid, incomplete, paused, or canceling | Do not start a new plan change; open the management/recovery portal | No credits until an invoice is actually paid | User resolves payment/subscription state in Stripe first |
| Current paid plan card | Open general Stripe management | No credit mutation | User can update payment method, inspect invoices, or cancel |
| Duplicate `invoice.paid` / `invoice.payment_succeeded` deliveries | Treat both as the same invoice operation | One atomic invoice ledger entry; never double-grant | Return success for an already-processed invoice |
| Failed, open, void, or uncollectible invoice | No entitlement grant | Zero credits | Let later paid webhook retry the operation |

### Why upgrades receive prorated, not full, credits

PR #1007 made each default monthly subscription price equal its hosted-credit allowance. Therefore an immediate upgrade should prorate both sides of the exchange. For example, a late-cycle Starter -> Team change should not grant a full `$50 x seats` after collecting only a small prorated amount. The paid update invoice contains a negative unused-time line for the old plan and a positive remaining-time line for the new plan; the grant is the positive net allowance represented by recognized camelAI plan lines. The next renewal grants the full target-plan allowance.

### Downgrade limitation

Stripe's portal can schedule an end-of-period downgrade only between prices on the same Stripe Product. The current code and integration fixtures model Starter, Pro, and Team as distinct products. This plan therefore uses a no-proration Stripe confirmation: no surprise charge or refund, no new credits, and the new recurring amount applies on renewal. A true end-of-period entitlement downgrade would require either consolidating tiers under one Stripe Product or adding an app-owned Subscription Schedule workflow; both are out of scope here.

## Root Causes in the Current Code

### 1. Starter/Pro plan changes depend on a stale Dashboard configuration

[src/lib/billing.server.ts](../src/lib/billing.server.ts) sends Starter/Pro changes through `subscription_update_confirm` while attaching `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`. Stripe portal configurations contain an explicit product/price allowlist. PR #1007 changed the configured Starter and Pro price IDs but did not change that portal configuration ID. A newly selected price can therefore be rejected even though the application configuration is correct.

### 2. Team uses a different, non-invoicing path

`createTeamSubscriptionUpdatePortalConfiguration()` creates a fresh configuration and opens a generic `subscription_update` flow. It does not set `features[subscription_update][proration_behavior]`; Stripe's portal default is `none`. That explains why Team can be selected but the current-cycle difference is not invoiced.

The generic Team flow also lets Stripe choose the target/quantity interactively, whereas the server already has the authoritative billable seat count. This makes the Team path inconsistent with Starter/Pro and risks drifting from member/invitation billing.

### 3. The credit handler intentionally ignores paid update invoices

`applySubscriptionIncludedCreditsFromInvoice()` accepts `subscription_cycle` and a narrow `subscription_create` case. It ignores `subscription_update`, and existing tests assert that behavior. Even after immediate proration is enabled, the current code would collect the upgrade invoice without granting the incremental credits.

Legacy-subscription migration has the inverse problem: `syncOrgSubscriptionFromStripe()` can issue a full manual grant when it sees the subscription update, before the migration invoice is known to be paid. Once normal update invoices start granting credits, leaving that path in place would also create a double-grant risk.

### 4. Invoice parsing is incompatible with newer Stripe payload shapes

The code pins request calls to `2026-02-25.clover`, but its invoice types and helpers still rely on fields moved in Basil-era API shapes:

- `invoice.subscription` moved to `invoice.parent.subscription_details.subscription`.
- `invoice.subscription_details` moved under `invoice.parent.subscription_details`.
- `invoice.lines.data[].price` moved to `invoice.lines.data[].pricing.price_details.price`.
- `invoice.lines.data[].proration` moved to `invoice.lines.data[].parent.subscription_item_details.proration`.

Webhook endpoint versions are independent of the `Stripe-Version` request header. A handler that only understands the old event object can return early and skip even initial or renewal grants.

### 5. Included-credit deduplication is not atomic with the grant

The current flow checks `APP_KV`, reads the org, increments `billing_credit_grant_total_cents`, writes the org, and then writes a KV marker. Concurrent webhook deliveries or a crash between these operations can double-grant. `billing_last_included_credit_invoice_id` only remembers one invoice and cannot serve as a ledger.

### 6. The page fetches and renders card metadata that camelAI does not own

The route loader calls `getStripeDefaultPaymentMethodSummary()`, and the page renders a Payment section with a card-like summary. The only needed behavior is the Stripe portal link. That fetch, its view model, and the section should be removed.

## Target Flow

```text
plan card click
    |
    +-- current paid plan ----------------> management portal
    |
    +-- no subscription ------------------> Checkout
    |
    +-- trialing --------------------------> direct no-proration price update
    |
    +-- active subscription
            |
            +-- server validates price, item, customer, and seat count
            +-- server classifies upgrade vs downgrade by monthly total
            +-- code-owned portal config permits current price catalog
            +-- subscription_update_confirm targets exact price + quantity
                        |
                        +-- upgrade: always_invoice
                        +-- downgrade: none

invoice.paid (and compatibility alias invoice.payment_succeeded)
    -> retrieve canonical invoice + every line from Stripe
    -> retrieve subscription; resolve org/plan/seats without event ordering
    -> classify initial / renewal / paid update
    -> compute grant
    -> OrgDO transaction inserts invoice ledger row and updates credits once
```

## Implementation Architecture

### Phase 1: Make Stripe portal configuration code-owned

Refactor the portal helpers in [src/lib/billing.server.ts](../src/lib/billing.server.ts) around three configuration modes:

```ts
type BillingPortalMode = "management" | "upgrade" | "downgrade";
```

#### Build and validate a canonical paid-plan catalog

Add one helper that loads all configured Starter, Pro, and Team prices and returns their Stripe product IDs, unit amounts, currency, interval, and active status. Reuse/extract the checkout price-validation logic rather than creating a weaker second validator.

Fail before creating a portal session if any target price is:

- missing or inactive;
- not USD;
- not monthly recurring;
- attached to no product; or
- not equal to the amount advertised in `BILLING_PLAN_LIMITS`.

Never hardcode price or product IDs in the helper or tests outside isolated fixtures.

#### Create immutable configurations by catalog fingerprint

Replace `createTeamSubscriptionUpdatePortalConfiguration()` with a general `getOrCreateBillingPortalConfiguration(env, mode)` helper.

The fingerprint/idempotency material must include:

- an application-owned configuration schema version;
- mode (`management`, `upgrade`, or `downgrade`);
- each plan, product ID, price ID, and expected amount;
- allowed updates; and
- proration/cancellation behavior.

Cache the returned configuration ID in `APP_KV` under that fingerprint. Also send a deterministic Stripe idempotency key. KV avoids creating a new configuration after Stripe's idempotency retention expires; the idempotency key reduces concurrent duplicates. If KV is unavailable in a unit-test/dev environment, creation can proceed using only the idempotency key. Duplicate immutable configurations are harmless, but a stale configuration must never be reused for a new catalog fingerprint.

Configuration behavior:

| Mode | `subscription_update` | Allowed changes | Proration | Other features |
| --- | --- | --- | --- | --- |
| `management` | Disabled | None | N/A | Payment-method update, invoice history, and cancellation at period end enabled |
| `upgrade` | Enabled | `price` and `quantity` | `always_invoice`; billing-cycle anchor `unchanged` | Continue trials if Stripe encounters one; payment update/invoices enabled |
| `downgrade` | Enabled | `price` and `quantity` | `none`; billing-cycle anchor `unchanged` | Payment update/invoices enabled |

For update configurations, include the complete current Starter/Pro/Team product/price catalog. Permit `quantity` because the exact-target deep link must change a multi-seat Team item to or from quantity one, but set every product's `adjustable_quantity.enabled=false`. The confirmation receives a server-specified quantity; the portal user does not receive a free-form quantity editor. The credentialed integration test must prove this configuration/session combination against Stripe.

Stop using `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` as the plan-price allowlist. Keep the environment variable for one transition release only if another deployment surface still needs it, then remove it from Wrangler configuration and documentation once searches show no callers.

#### Use one exact-target update flow for all paid plans

Change `createSubscriptionUpdatePortalSession()` so Starter, Pro, and Team all use `flow_data[type]=subscription_update_confirm` with:

- the verified live subscription ID;
- the single verified subscription-item ID;
- the exact configured target price ID; and
- the normalized server-computed quantity.

Before session creation:

1. Reload the org and Stripe subscription.
2. Verify the subscription customer matches the org customer (repair the cached org customer ID only after validating the live subscription).
3. Reject zero/multiple ambiguous billable subscription items rather than updating the first item.
4. Reject a canceled, incomplete-expired, paused, incomplete, unpaid, past-due, or cancel-at-period-end subscription and send the caller to the management portal instead.
5. For Team, call `getBillableTeamSeatCountForOrg()` and normalize to the Team minimum. Do not accept a browser-supplied quantity.
6. Determine upgrade/downgrade from verified monthly totals (`unit_amount x quantity`), not just `PLAN_RANK`; Team quantity makes rank alone insufficient.
7. Attach the corresponding code-owned configuration.

The route should continue to use `updateTrialingStripeSubscriptionPlan()` for a genuinely trialing subscription. If its live-state check reports that the trial ended, reclassify using the fetched Stripe status and only open an update confirmation when the status is active.

Update `createLegacyStripeMigrationPortalSession()` to use the same current-catalog upgrade configuration. It must not retain a hidden dependency on the old Dashboard allowlist.

#### Keep general management separate from plan selection

`createBillingPortalSession()` and the cancellation helper should attach the `management` configuration. This portal is the destination for **Manage in Stripe** and recovery states. It can update payment methods, show invoices, and cancel, but it must not expose a second free-form plan/quantity editor that bypasses the application transition rules.

### Phase 2: Process paid subscription invoices canonically

Refactor the invoice entitlement path into two layers:

1. A Stripe I/O layer that retrieves a canonical invoice, all paginated invoice lines, and the referenced subscription using the explicit request API version.
2. A pure resolver that accepts those canonical objects and returns either an ignored reason or a validated grant command.

Suggested command shape:

```ts
interface SubscriptionInvoiceGrantCommand {
  invoiceId: string;
  subscriptionId: string;
  customerId: string;
  billingReason: "subscription_create" | "subscription_cycle" | "subscription_update";
  source: "initial" | "renewal" | "plan_change" | "legacy_migration";
  plan: "starter" | "pro" | "team";
  seatCount: number;
  grantCents: number; // May be zero for an eligible no-credit result.
}
```

#### Retrieve instead of trusting the webhook snapshot

The webhook handler should use only the verified event type and invoice ID as its trigger. Retrieve `/v1/invoices/{id}` and paginate `/v1/invoices/{id}/lines` until `has_more=false`. Then retrieve the referenced subscription. This avoids:

- truncated line collections;
- webhook endpoint/request API-version differences; and
- dependence on `customer.subscription.updated` arriving first.

Still update the exported Stripe TypeScript types and add compatibility accessors for both legacy and current shapes. Old signed fixtures and replayed events should remain understandable:

- `getInvoiceSubscriptionId()` prefers `parent.subscription_details.subscription`, then falls back to legacy `subscription`.
- `getInvoiceSubscriptionMetadata()` prefers `parent.subscription_details.metadata`, then legacy fields.
- `getInvoiceLinePriceId()` prefers `pricing.price_details.price`, then legacy `price`.
- `isStripeProrationLine()` reads `parent.subscription_item_details.proration`, then the legacy flag.

Make the version upgrade part of this fix, but do it after the compatibility accessors and canonical-fetch tests are green. Change the request header from `2026-02-25.clover` to the latest API version available in Workbench (`2026-06-24.dahlia` at planning time; verify immediately before implementation). Because this integration uses raw HTTP rather than a Stripe SDK, update the local response interfaces and fixtures directly. Keep the legacy accessors for historical event retrieval and reconciliation even after the request version changes.

#### Resolve org, plan, and seats safely

Resolution order:

1. Subscription metadata `org_id` from the live subscription.
2. Invoice subscription metadata.
3. Verified Stripe customer -> org lookup.

Then:

- call `syncOrgSubscriptionFromStripe()` with the live subscription so plan state does not depend on webhook order;
- resolve the target plan from recognized configured price IDs on the invoice/subscription;
- use subscription-item/invoice-line quantity for Team and normalize the minimum;
- allow metadata fallback only for legacy renewal invoices whose old price is no longer configured, and emit a diagnostic event when used; and
- fail with a retryable error when an otherwise eligible paid subscription invoice cannot be mapped safely. Do not return success with zero credits for an unknown price or malformed eligible invoice.

#### Grant calculation

Only an invoice whose status is paid is eligible. `amount_paid=0` is still valid when customer balance or another Stripe credit settled a positive invoice; paid status is the entitlement boundary.

- `subscription_create`: grant the full configured allowance for the recognized plan/quantity. Preserve the existing metadata fallback only for migrated legacy subscriptions.
- `subscription_cycle`: grant the full configured allowance for the plan/quantity on that renewal. Discounts do not reduce included credits, matching existing subscription behavior.
- `subscription_update`: translate each recognized proration line into its allowance equivalent, then sum the signed values. For a line, compute `line.amount / (price.unit_amount * quantity)` to recover the billed fraction of a full monthly plan, then multiply that fraction by `getSubscriptionIncludedCreditCentsForPlan(env, linePlan, quantity)`. Negative old-plan time offsets positive new-plan time. Round down only once after summing and grant `max(0, netAllowanceCents)`. Ignore tax, one-off invoice items, unrelated products, discounts, customer balance, and invoice-total adjustments.
- Paid legacy migration `subscription_update`: preserve the existing migration promotion by granting one full configured current-period allowance, but only after the invoice is paid. Recognize it only when the app-written pending-migration metadata matches the live subscription, org, target plan, and seat count. Use source `legacy_migration`, then clear the pending metadata after the ledger commit.

With the default PR #1007 catalog, this produces the same number as the net recognized proration amount. The ratio is still required: the emergency `BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS` override and a future unequal price/allowance model must not silently over- or under-grant. Reject a recognized line whose full monthly denominator is missing, non-positive, or inconsistent with its verified price.

Never grant on `subscription_update` when the recognized net delta is negative or zero. Record the eligible invoice as processed with `grantCents=0` so duplicate aliases remain no-ops.

Remove both current `applyManualCreditGrant(..., { source: "stripe-migration" })` calls from the direct and webhook-driven legacy migration paths. A subscription update event may synchronize plan state, but it must not provision paid credits. For rollout compatibility, if the deterministic legacy manual-grant ID already exists in `admin_credit_grants`, seed the corresponding invoice ledger row as previously granted instead of granting again.

### Phase 3: Make invoice application atomic in OrgDO

Add the next available OrgDO schema migration in [workers/main/src/identity/org-do.ts](../workers/main/src/identity/org-do.ts) (version 41 if no earlier migration lands first):

```sql
CREATE TABLE IF NOT EXISTS stripe_subscription_invoice_grants (
  invoice_id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  billing_reason TEXT NOT NULL,
  source TEXT NOT NULL,
  plan TEXT NOT NULL,
  seat_count INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

Add a typed `applySubscriptionInvoiceGrant(command)` RPC on OrgDO. In one `transactionSync` block it must:

1. Read an existing row by invoice ID.
2. If present, return `{ applied: false }` without changing credits. If immutable command fields disagree, report an invariant error and still never apply a second grant.
3. Read the current org and reject a missing org.
4. Insert the invoice row, including zero-credit eligible results.
5. Increment `billing_credit_grant_total_cents` only when `amount_cents > 0` and the org is not Enterprise.
6. Update the verified customer ID, plan, seat count, and `billing_credit_usage_started_at` as appropriate. Update `billing_last_included_credit_invoice_id` only for a positive grant; keep it as a compatibility/diagnostic field rather than a dedupe boundary.
7. Persist `org_info` in the same transaction.
8. Dispatch one admin org-upsert event only after an applied transaction.

The SQL invoice ledger, not APP_KV, becomes the correctness boundary. During rollout, preserve backward compatibility with already-processed invoices: if the old APP_KV marker exists, `billing_last_included_credit_invoice_id` equals the incoming invoice ID, or a matching deterministic legacy-migration row already exists in `admin_credit_grants`, atomically seed a zero-value/legacy-processed ledger row and do not grant again. Keep this bridge for at least Stripe's webhook replay horizon before removing the old KV helpers.

Do not reuse `admin_credit_grants`; its semantics and audit surface are for human/admin grants. Do not use generic `updateBillingState()` for the entitlement increment.

### Phase 4: Route both paid event names through the ledger

In [workers/main/src/routes/billing.ts](../workers/main/src/routes/billing.ts):

- Treat `invoice.paid` as the canonical provisioning event.
- Continue accepting `invoice.payment_succeeded` during rollout because existing Stripe endpoint subscriptions may send it and Stripe can deliver both.
- Route both to the same `processPaidSubscriptionInvoice(env, invoiceId)` operation.
- Let the OrgDO invoice primary key deduplicate the aliases and retries.
- Return `500` for a transient Stripe fetch, unknown eligible price, missing org, or persistence failure so Stripe retries.
- Return `200` for deliberately ignored event types, non-paid invoices, non-subscription invoices, and already-processed invoices.

Keep signature verification on the raw request body unchanged. Add structured operational events through the existing observability helper for `processed`, `duplicate`, `ignored`, and `failed`, including only event ID/type, invoice ID, subscription ID, org ID, plan, seat count, grant cents, and error metadata. Do not log raw invoice payloads, card data, customer email, or secrets.

### Phase 5: Upgrade the request and webhook API versions together

Updating only `STRIPE_API_VERSION` does not update the payload version of an existing webhook endpoint. Use a coordinated migration:

1. Inventory every Stripe response field read in `src/lib/billing.server.ts`, not just invoice fields. Add target-Dahlia fixtures for customer, price, Checkout Session, subscription, subscription item, invoice, invoice line, portal configuration/session, and setup/payment objects that remain after the Payment section deletion.
2. Land dual-shape parsing, canonical invoice retrieval, the atomic ledger, and support for two webhook signing secrets before changing external configuration.
3. Change the explicit request header to the verified latest version and run all unit and credentialed Stripe tests against it.
4. In staging, create a second Stripe webhook endpoint at the same route with a version query marker, explicitly pinned to the target version and subscribed to the same required events (including `invoice.paid`). Stripe gives it a distinct signing secret; store that temporarily as `STRIPE_WEBHOOK_SECRET_NEXT`.
5. Update signature verification to choose/accept the correct configured secret without logging it. Initially verify and observe the new endpoint while returning success without entitlement mutation. Then enable normal processing. The invoice ledger makes dual delivery safe once processing is enabled.
6. After target-version events have passed staging and production canaries, disable the old endpoint, promote the new secret to the canonical binding, and remove the temporary secret/query branch.
7. Upgrade the Stripe account default version in Workbench only after explicitly versioned requests and webhooks are stable. Record the rollback deadline shown by Workbench.

Do not mutate the existing webhook endpoint in place. A parallel endpoint preserves a quick rollback path and lets legacy and target payload fixtures be exercised against the same deployed handler.

### Phase 6: Simplify the billing page and move the management CTA

#### Remove the Payment section

In [src/routes/_app.settings.organization.billing.tsx](../src/routes/_app.settings.organization.billing.tsx):

- remove the `CreditCard` import;
- remove the Payment section and its separator;
- remove `paymentMethod` from the loader's `Promise.all` and returned data;
- retain invoices and cancellation UI;
- change metadata/header copy from “plan, payment method, and invoices” to “plan and invoices” (or equivalent).

After confirming there are no other callers, remove from [src/lib/billing.server.ts](../src/lib/billing.server.ts):

- `getStripeDefaultPaymentMethodSummary()`;
- its private payment-method/setup-intent fetch helpers;
- its public summary type; and
- tests/mocks that exist only for that UI.

camelAI should not render or imply ownership of stored payment details. Stripe remains the source and UI for payment methods.

#### Add an opt-in current-plan action

`PlanPicker` is reused by onboarding, the paywall, Team upgrade prompts, and dev/test routes. Do not globally make every current-plan card clickable.

Extend [src/components/billing/plan-picker.tsx](../src/components/billing/plan-picker.tsx) and [src/components/billing/plan-picker-card.tsx](../src/components/billing/plan-picker-card.tsx) with an explicit, opt-in current-plan action, for example:

```ts
type PlanPickerCta =
  | ExistingPlanPickerCta
  | { kind: "manage"; plan: "starter" | "pro" | "team" };

interface PlanPickerProps {
  // ...existing props
  currentPaidPlanAction?: "manage";
}
```

Only the settings Billing `ManagePlanView` passes that prop. For a current Stripe-backed Starter, Pro, or Team plan:

- retain the “Current plan” badge;
- replace the disabled **Current plan** button with an enabled, primary **Manage in Stripe** button; and
- submit `intent=manageBilling`, then redirect to the management portal URL.

Free, Pay as you go, Enterprise, unconfigured Stripe, and non-recoverable subscription states should not receive an enabled Stripe-management CTA merely because their normalized plan matches a card.

Make `intent=manageBilling` enforce the same rule server-side after reloading the org: require a non-Enterprise paid plan and a recoverable Stripe subscription owned by that org. Do not create a new Stripe customer or portal session for a spoofed Free/Pay-as-you-go request.

The existing top-level **Manage plan** entry can remain: it opens the plan picker. The removed Payment-section button's functionality is now represented on the current paid-plan card.

## File-by-File Change Map

| File | Required change |
| --- | --- |
| `src/lib/billing.server.ts` | Canonical price catalog; code-owned portal configurations; exact-target update flow; direction/proration rules; target-version invoice retrieval/parsers; paid-invoice resolver; explicit API-version bump; remove payment summary helpers |
| `src/routes/_app.settings.organization.billing.tsx` | Remove payment-method loader/UI; route recovery states correctly; wire current-plan `manage` CTA; update copy |
| `src/components/billing/plan-picker.tsx` | Add settings-only `manage` CTA without changing other consumers |
| `src/components/billing/plan-picker-card.tsx` | Render enabled primary **Manage in Stripe** for the opt-in current card |
| `workers/main/src/routes/billing.ts` | Handle `invoice.paid` plus compatibility alias; fetch/process by invoice ID; temporary dual-endpoint signing-secret/version rollout; structured outcomes |
| `workers/main/src/identity/org-do.ts` | Schema migration and atomic subscription-invoice ledger RPC |
| `src/types.ts` / generated DO RPC types if required | Add the ledger command/result contract; regenerate rather than hand-edit generated output |
| `tests/billing.test.ts` | Portal configuration, transition, canonical parser, grant calculation, legacy bridge, and failure tests |
| `tests/billing-settings-route.test.ts` | Full route/status/transition matrix and management action |
| `tests/billing-settings-overview-ui.test.tsx` | Payment section absent; current-plan CTA enabled/labeled; no payment helper mock |
| `tests/plan-picker-byok.test.tsx` and other PlanPicker tests | Prove the new action is opt-in and unchanged elsewhere |
| `workers/main/tests/billing-org.test.ts` | Atomic grant, duplicate, zero grant, mismatch, Enterprise, and concurrent invocation tests |
| `tests/stripe-integration.test.ts` | Real test-mode catalog/config/session/update invoice coverage with cleanup |
| `wrangler*.jsonc` / env docs | Remove the static portal configuration ID after the transition release if no callers remain |

## Required Test Matrix

### Pure/unit coverage

Portal/catalog tests in `tests/billing.test.ts`:

- New price IDs from environment are included in created portal configurations; an old static configuration ID is never used for a plan change.
- Starter -> Pro and Starter -> Team both use exact `subscription_update_confirm` targets.
- Pro -> Starter, Team -> Pro, and Team -> Starter use downgrade configuration with `proration_behavior=none`.
- Pro -> Team and Starter -> Team set the server-computed Team quantity.
- Upgrade/downgrade classification compares current and target monthly totals, including Team quantity.
- Portal config permits the exact deep link to change `price` and `quantity`, while `adjustable_quantity` remains disabled for the user.
- Inactive, wrong-currency, non-monthly, wrong-amount, or product-less prices fail closed.
- General management config has no subscription-update feature.
- Legacy migration uses the current catalog configuration.
- Trial changes remain no-proration and do not issue paid credits.
- A legacy subscription update event alone does not grant credits; its paid migration invoice grants the full migration allowance once.

Invoice resolver tests must use legacy pre-Basil fixtures, current Clover fixtures, and a target-Dahlia fixture captured from Stripe test mode:

- New `invoice.parent.subscription_details.subscription` resolves.
- New `line.pricing.price_details.price` resolves.
- Full paid initial invoice grants the configured full allowance.
- Full paid renewal grants Starter `$10`, Pro `$40`, and Team `$50 x quantity` in cents.
- Paid Starter -> Pro and Pro -> Team update invoices grant only the net positive recognized proration delta.
- Team seat count comes from the recognized Team line/subscription item, not stale org metadata.
- Downgrade/negative update invoice records zero and grants zero.
- Tax, discounts, unrelated price lines, one-off items, and customer balance do not alter the nominal plan allowance calculation.
- An unequal price/allowance fixture and the emergency included-credit override both prorate by the line's fraction rather than copying invoice cents.
- Open, failed, void, and uncollectible invoices grant zero and remain eligible for a later paid event.
- Unknown price on an otherwise eligible paid subscription invoice throws and is not marked processed.
- Paginated invoice lines are all included.
- Event ordering does not matter: processing succeeds when no subscription-updated webhook has run first.
- Failed/unpaid legacy migration invoices grant nothing, paid migrations grant once, and an existing deterministic manual migration grant prevents a second grant.
- Every Stripe object field consumed outside the invoice resolver has a target-version fixture or credentialed integration assertion; the version bump is not validated by invoice tests alone.

### OrgDO/worker coverage

In `workers/main/tests/billing-org.test.ts` and a focused webhook route test:

- First command inserts one ledger row and increments once.
- Duplicate same event returns `applied: false`.
- Concurrent `invoice.paid` and `invoice.payment_succeeded` calls increment once.
- A duplicate with conflicting immutable values never increments and emits an invariant failure.
- A zero-credit eligible invoice is recorded once.
- Enterprise orgs never receive subscription grants.
- Transaction failure leaves neither a ledger row nor a credit increment.
- Legacy KV/last-invoice marker seeds a processed row without re-granting.
- A signed webhook with either paid event name reaches the processor.
- Processor errors return `500`; duplicates/ignored events return `200`.

### Route/status coverage

Expand `tests/billing-settings-route.test.ts` to cover:

| Local/live state | Expected action |
| --- | --- |
| No subscription -> Starter/Pro/Team | Checkout with normalized quantity |
| Active Starter -> Pro | Exact upgrade confirmation |
| Active Starter -> Team | Exact upgrade confirmation with billable seats |
| Active Pro -> Starter | Exact downgrade confirmation |
| Active Pro -> Team | Exact upgrade confirmation with billable seats |
| Active Team -> Starter/Pro | Exact downgrade confirmation |
| Trialing -> any paid plan | Direct trial-preserving update |
| Locally trialing but live active | Reclassify and open update confirmation |
| Past due/unpaid/incomplete/paused | Management/recovery portal only |
| Cancel-at-period-end | Management portal only |
| Canceled/incomplete-expired | No existing-subscription update path |
| Current paid plan `manage` | Management portal |
| Free/payg/Enterprise `manage` spoof | Rejected server-side |

The action must remain server-authoritative even if a caller posts a plan or CTA state the UI would not render.

### UI coverage

- The Billing overview contains no Payment heading, card summary, or Add/Update payment-method button.
- Loader data no longer includes `paymentMethod`.
- A current paid plan card shows an enabled primary **Manage in Stripe** CTA and retains its current-plan badge.
- Clicking it submits `manageBilling` and follows the returned portal redirect.
- Non-current cards preserve Subscribe/Upgrade/Downgrade labels.
- Onboarding, paywall, and Team-dialog PlanPicker consumers still show a disabled Current plan button unless they explicitly opt in.
- Stripe-unconfigured and Enterprise states do not show an actionable management button.

### Credentialed Stripe test-mode coverage

Extend the existing opt-in `tests/stripe-integration.test.ts`; do not add secrets or live IDs to fixtures. Read the restricted key only from `STRIPE_INTEGRATION_SECRET_KEY` (or the existing canonical test variable) supplied by the operator/CI secret store.

The integration test should create isolated test-mode products, monthly prices, customer, payment method, and subscription, then clean them up in `finally`:

1. Verify the code-created upgrade and downgrade portal configurations contain the expected prices and proration settings.
2. Verify generated portal sessions are exact-target confirmation sessions. Stripe-hosted user confirmation itself can remain a manual smoke because it cannot be completed through the API.
3. Perform the equivalent Starter -> Pro and Pro -> Team subscription updates through the Stripe API with `always_invoice` to obtain real paid update invoices.
4. Feed the retrieved current-shape invoice and all lines into the resolver; assert the expected grant command.
5. Apply that command twice and assert one ledger entry/one grant.
6. Exercise a failed-payment update and prove no grant occurs.
7. Exercise a paid renewal (a Test Clock is optional if the restricted key permits it) and prove the full target allowance is granted once.
8. Verify a downgrade/no-proration change creates no immediate grant.
9. Assert Stripe request-log responses use the target API version and that a target-version webhook fixture verifies/processes through the new endpoint-secret path.

If the restricted key lacks a required permission, fail with the exact missing Stripe resource/action. Do not silently fall back to a broader secret key.

## Team Seat-Change Audit

This fix directly covers the Starter/Pro -> Team transition. Before shipping, also audit all callers of `syncTeamSubscriptionSeatCount()` because subsequent seat additions create the same charge/credit obligation:

- Every synchronous billable seat increase must use `always_invoice` before the member/invitation mutation is committed.
- A failed immediate seat invoice must not result in a new billable seat or credits.
- The resulting paid `subscription_update` invoice must flow through the same net-proration grant resolver.
- Seat decreases must not claw back credits already granted for the current cycle. Their lower full allowance is used on the next renewal.
- Best-effort reconciliation calls after removals may retain non-immediate proration behavior, but tests must make that choice explicit.

At minimum, add one real/unit case for a Team seat increase and one for a decrease. If the audit finds a route that adds a seat with the default `create_prorations`, fix it in this change rather than leaving a second known no-charge path.

## Rollout and Reconciliation

1. **Add observability first.** Deploy processor outcome metrics/logs without sensitive payloads.
2. **Deploy the OrgDO schema, dual-shape parsers, and code-owned portal helpers to staging.** Configuration creation must use test-mode resources only.
3. **Run unit, worker, type, and credentialed integration tests against the target request version.**
4. **Create and canary the target-version staging webhook endpoint.** Keep the old endpoint and `invoice.payment_succeeded` handling during the compatibility window; enable `invoice.paid` on the new endpoint.
5. **Manually complete Starter -> Pro, Starter -> Team, Pro -> Starter, current-plan Manage in Stripe, payment-method update, and cancellation in Stripe test mode.**
6. **Run a dry-run reconciliation report before production.** For paid subscription invoices since PR #1007, list invoice ID, org, reason, recognized plan/seats, computed grant, old KV marker, last-invoice marker, and new ledger status. Do not print payment details or secrets.
7. **Backfill only demonstrably paid, previously ungranted invoices.** Apply them through the same OrgDO ledger method. Never grant an unpaid invoice and never charge a historic no-proration Team upgrade retroactively without an explicit customer-communication decision.
8. **Repeat the dual-endpoint canary in production, then retire the old webhook endpoint.** Monitor processed/duplicate/failed counts and Stripe webhook retries before promoting the new signing secret.
9. **Upgrade the Stripe account default in Workbench, then remove temporary compatibility configuration** after the rollback/canary window.
10. **Remove the static portal configuration dependency** after confirming all portal entry points use a code-owned mode configuration.
11. **Rotate the restricted test key shared during planning** and store the replacement only in the normal secret manager/CI environment.

The reconciliation tool should default to dry-run, require an explicit apply flag, use invoice ID as its idempotency key, and call the same resolver/OrgDO RPC as webhooks. Do not create a separate arithmetic or grant path.

## Verification Commands

Use focused commands while iterating, followed by the full relevant suites:

```bash
bun run test:run -- billing.test.ts billing-settings-route.test.ts billing-settings-overview-ui.test.tsx plan-picker-byok.test.tsx stripe-integration.test.ts
bun run test:workers -- billing-org.test.ts
bun run typecheck
bun run lint
```

Run the credentialed Stripe test with the key injected through the shell/CI secret environment; never paste the value into a command, test file, `.dev.vars`, plan, transcript, or committed artifact.

## Acceptance Criteria

- Starter -> Pro no longer fails because a Dashboard portal configuration references retired prices.
- Every paid-plan card opens a Stripe-hosted confirmation for exactly the selected price and server-owned quantity.
- Starter/Pro -> Team produces an immediate paid proration invoice when payment succeeds.
- That invoice grants the computed prorated net allowance exactly once; the next renewal grants the full `$50 x seats` allowance exactly once.
- Failed/unpaid invoices never grant credits.
- Duplicate and out-of-order webhook delivery cannot change the grant total twice.
- Both legacy and current Stripe invoice shapes are covered by tests; current production processing retrieves the canonical invoice rather than trusting the event snapshot.
- Explicit Stripe requests and the active webhook endpoint are pinned to the same verified target API version; legacy payloads remain safe to reconcile.
- All six cross-tier paid transitions, Team quantities, trials, recovery states, canceling state, initial checkout, renewal, and duplicate events have automated coverage.
- The Payment section and its loader/API work are gone.
- The current Stripe-backed paid-plan card shows a primary **Manage in Stripe** button that opens the general management portal.
- Other PlanPicker consumers do not gain an unintended current-plan action.
- Existing paid invoices can be reconciled idempotently; historic unpaid/no-proration periods are not surprise-charged.

## Non-Goals

- Rendering or storing payment-method details in camelAI.
- Building a custom card-update or payment-confirmation UI.
- Changing subscription prices or included-credit amounts from PR #1007.
- Clawing back spent credits on downgrade or seat removal.
- Unifying Stripe Products or implementing an app-owned scheduled-downgrade system.
- Refactoring unrelated Stripe product surfaces that do not consume changed target-version fields.

## Stripe References

- [Update a subscription: proration behavior](https://docs.stripe.com/api/subscriptions/update)
- [Customer portal deep links and `subscription_update_confirm`](https://docs.stripe.com/customer-management/portal-deep-links)
- [Create a portal configuration](https://docs.stripe.com/api/customer_portal/configurations/create)
- [Configure subscription updates and scheduled downgrades](https://docs.stripe.com/customer-management/configure-portal)
- [Subscription webhook provisioning](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Webhook delivery and event ordering](https://docs.stripe.com/webhooks)
- [Safely upgrade a webhook endpoint version](https://docs.stripe.com/webhooks/versioning)
- [Stripe API upgrade process](https://docs.stripe.com/upgrades)
- [Basil invoice line-item pricing field migration](https://docs.stripe.com/changelog/basil/2025-03-31/invoice-pricing-configurations)
- [Basil invoice parent-field migration](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects)
