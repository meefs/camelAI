# Billing Plan Change and Credit Allocation Implementation Feedback

Date: July 14, 2026  
Reviewed commit: `565ba4ad2` (`Fix billing plan changes and credit allocation`)  
Branch base: `022c75fdf`  
Target branch: `origin/main`

## Release recommendation

**Not ready to deploy to staging as the billing-fix candidate.** The UI and Stripe Portal direction are sound, and all non-credentialed checks run during this review passed. However, there are five release-blocking correctness/security findings below. The most serious can overgrant or undergrant credits when a paid invoice is delivered late, make the advertised reconciliation dry-run mutate Stripe and OrgDO state, and create a Team invitation even when the immediate seat charge fails.

Fix findings 1–5 and add the credentialed coverage in finding 6 before staging sign-off.

## What looks good

- The Payment section is removed, while the current paid plan card now retains its badge and exposes a primary **Manage in Stripe** CTA.
- Active paid plan changes use an exact `subscription_update_confirm` Portal flow instead of a generic plan picker.
- Upgrade/downgrade classification uses verified monthly totals, including Team quantity.
- Upgrade and downgrade Portal configurations encode the agreed `always_invoice` and `none` behaviors, respectively.
- General subscription management is separated from plan-change configuration.
- The webhook uses the signed event only as a trigger and retrieves the canonical invoice plus all paginated lines.
- Both `invoice.paid` and `invoice.payment_succeeded` converge on one processor.
- The new OrgDO invoice ledger is transactionally idempotent and is the right foundation for exactly-once credit grants.
- The old direct legacy-migration credit grants were removed from subscription-update handling.

## Blocking findings

### 1) P1: Initial and renewal grants are calculated from the mutable live subscription, not the paid invoice

Files:

- `src/lib/billing.server.ts:3123-3218`
- `workers/main/src/identity/org-do.ts:2742-2751`

`resolveSubscriptionInvoiceGrant()` calls `recognizedSubscriptionItem(subscription, catalog)` and uses that live item for `subscription_create` and `subscription_cycle`. The canonical invoice lines are not used to determine the plan and quantity for those grants.

This breaks delayed, retried, and reconciliation processing:

1. A Starter renewal invoice is paid.
2. Before its webhook retry/reconciliation runs, the subscriber upgrades to Pro.
3. The invoice still represents a Starter renewal, but the fetched live subscription now contains the Pro price.
4. The resolver grants the Pro allowance (`$40`) instead of Starter (`$10`).

The inverse transition undergrants. Team quantity changes can similarly use a later seat count instead of the paid invoice quantity.

It also makes duplicate delivery non-deterministic. If the invoice was originally recorded as Starter and the same invoice is retried after the live subscription becomes Pro, the newly resolved command conflicts with the immutable ledger row. The webhook then returns 500 forever instead of recognizing a duplicate.

There is a second-order state bug: `applySubscriptionInvoiceGrant()` writes the command's historical `plan` and `seatCount` back into `org_info`. Once the resolver is corrected to use invoice-time values, replaying an older invoice can regress a currently active subscription's plan/seat state.

Required fix:

1. For `subscription_create` and `subscription_cycle`, derive the entitlement plan and quantity from exactly one recognized, non-proration recurring invoice line. Treat the live subscription only as the source of current ownership/state.
2. Keep the explicit, diagnostic legacy-price fallback for genuinely retired prices. Fail closed when an invoice cannot be mapped unambiguously.
3. Make the invoice-ledger RPC own only ledger insertion and credit/marker mutation. It must not overwrite current `billing_plan`, `billing_seat_count`, or subscription identity with historical invoice-time values; the separately fetched live subscription sync owns current billing state.
4. Add tests where a Starter/Pro/Team renewal invoice is processed after a later plan or seat change. Assert invoice-time credits are granted once while current org plan/seats remain unchanged.

### 2) P1: Reconciliation “dry-run” mutates Stripe and OrgDO state

Files:

- `src/lib/billing.server.ts:3265-3369`
- `src/lib/billing.server.ts:3418-3437`
- `src/lib/billing.server.ts:2902-3004`

`reconcilePaidSubscriptionInvoice(..., { apply: false })` still calls `preparePaidSubscriptionInvoice()`, which unconditionally calls `syncOrgSubscriptionFromStripe()`.

That sync is not read-only. It can:

- POST corrected metadata to the Stripe subscription through `bestEffortSyncStripeSubscriptionBillingMetadata()`;
- update the organization's billing status, plan, seats, customer, and subscription fields; and
- grant one-time trial credits through `syncSubscriptionBillingState()`.

The CLI and admin endpoint both advertise the default as a dry-run. An operator could therefore change production Stripe and OrgDO state merely by previewing a reconciliation report.

Required fix:

1. Split canonical retrieval/pure resolution from state synchronization/application.
2. The preview path may perform Stripe GETs and read org/ledger state only. It must perform no Stripe POST, OrgDO billing sync, credit mutation, KV marker write, or ledger insert.
3. The apply/webhook path may sync the verified live subscription and then invoke the atomic ledger RPC.
4. Add a dry-run test with an eligible paid invoice that snapshots org state and request methods. Assert zero Stripe POSTs and no changes to org fields, credits, ledger rows, or KV markers.

### 3) P1: A failed immediate Team-seat payment can still create the seat/invitation

Files:

- `src/lib/billing.server.ts:1336-1351`
- `src/routes/_app.settings.organization.team.tsx:298-327`
- `src/routes/api/orgs.$id.invite.ts:68-83`

Seat increases set `proration_behavior=always_invoice`, but the subscription-item update does not set `payment_behavior`. Stripe's default is `allow_incomplete`: if payment is required but fails or needs customer action, Stripe can return success while moving the subscription to `past_due`. The code then updates local seat metadata and creates the invitation.

That violates the implementation plan's invariant that a failed immediate seat invoice must not create a billable seat or credits. The paid-invoice guard protects credits, but it does not protect the invitation/entitlement mutation.

Stripe documents the relevant behavior and the `error_if_incomplete`/`pending_if_incomplete` alternatives in [Update a subscription item](https://docs.stripe.com/api/subscription_items/update).

Required fix:

1. For synchronous seat increases, use a payment behavior that does not commit the update when the invoice cannot be paid (most directly, `error_if_incomplete`), or implement a verified pending-update flow.
2. Do not update OrgDO seat state or create invitations until Stripe has confirmed the paid update under the chosen strategy.
3. Preserve `proration_behavior=none` for decreases and the no-credit-clawback policy.
4. Cover both the bulk Team settings route and `api/orgs.$id.invite.ts`.
5. Add a failing-payment test proving that Stripe/OrgDO quantity, invitations, and credits remain unchanged. Add a successful paid seat increase test proving the proration invoice grants only incremental seat credits once.

### 4) P1: The Dahlia API bump still reads a removed subscription-level period field

File: `src/lib/billing.server.ts:71-104,586-597,3597-3620`

The implementation sends `Stripe-Version: 2026-06-24.dahlia`, but `StripeSubscription`, `getSubscriptionCancellationDateMs()`, and `getStripeSubscriptionSummary()` still read top-level `subscription.current_period_end`.

Stripe removed `current_period_start`/`current_period_end` from the Subscription object in Basil and moved them to each subscription item. Dahlia therefore does not provide the field this code expects. Renewal dates and cancel-at-period-end dates can render as missing or incorrect. See [Stripe's breaking-change note](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end).

The tests currently use the old top-level fixture (`tests/billing.test.ts:1327-1678`), so they cannot catch the incompatibility.

Required fix:

1. Add `current_period_start`/`current_period_end` to `StripeSubscriptionItem`.
2. Read the recognized paid-plan item's period for the billing-page renewal date. For cancellation fallback, use the app's single paid-plan item (or a clearly defined earliest-item fallback).
3. Retain the old top-level field only as a compatibility fallback for historical fixtures/replays.
4. Replace/add tests with an actual target-version subscription shape that has period fields only on `items.data[]`.

### 5) P1: Missing cached customer ID bypasses Portal ownership validation

File: `src/lib/billing.server.ts:1877-1893`

`verifySubscriptionCustomerOwnership()` fetches and validates Stripe customer metadata only when `org.billing_customer_id` exists and differs from the live subscription's customer. If the cached customer ID is absent, it trusts the subscription customer and writes that ID to the org without validating that the customer belongs to the org.

A stale or cross-linked `billing_subscription_id` can therefore mint a Customer Portal session for another Stripe customer. That Portal can expose invoices, payment-method management, and cancellation controls.

Required fix:

1. Reject a subscription whose `metadata.org_id`, when present, differs from the current org.
2. If the cached customer ID is missing or differs, fetch the live customer and require verified `metadata.org_id === org.id` before repairing local state.
3. Add tests for a missing cached customer ID with matching metadata (repair succeeds), mismatching metadata (hard failure and no write/session), and a mismatching subscription `org_id`.

## Required test/rollout gap

### 6) P2: Credentialed tests do not exercise the feature's charge-and-credit path

File: `tests/stripe-integration.test.ts`

The opt-in suite now uses the exported Dahlia version and creates a real management Portal session, which is useful. It does not yet implement the credentialed matrix from the approved plan:

- It does not create and retrieve the code-owned upgrade and downgrade configurations for assertion.
- It does not create an exact-target update Portal session.
- Its plan changes use trial subscriptions and direct `proration_behavior=none` item updates, not paid `always_invoice` upgrades.
- It does not retrieve a real paid update invoice/lines and feed them through the resolver/ledger.
- It does not test failed payment, paid renewal, downgrade/no-proration, duplicate application, or the next webhook endpoint.
- Code-created Portal configurations are no longer tracked/deactivated during cleanup.

These omissions are material because the suite's current mocks encode the same assumptions behind findings 1, 3, and 4.

Implement the credentialed matrix in the approved plan before staging sign-off. If the restricted key lacks a required permission, fail with the missing resource/action rather than silently skipping that portion. Track and deactivate test Portal configurations during cleanup.

## Non-blocking polish

### 7) P3: “Manage in Stripe” has no submitting state

Files:

- `src/routes/_app.settings.organization.billing.tsx:799-829`
- `src/components/billing/plan-picker.tsx:149-168`

`pendingPlan` is derived from the submitted `plan` form field, but `manageBilling` submits no plan. The current-plan button therefore remains enabled with no spinner while the request is in flight and can be clicked repeatedly.

Track the pending CTA/intent independently (or submit the current plan alongside the intent) so the button disables and shows the existing loading treatment.

## Verification performed

Passed:

```text
bun run test:run -- tests/billing.test.ts tests/billing-settings-route.test.ts tests/billing-settings-overview-ui.test.tsx tests/plan-picker-byok.test.tsx
  4 files, 98 tests passed

bun run test:workers -- workers/main/tests/billing-org.test.ts workers/main/tests/billing-webhook.test.ts workers/main/tests/admin-api-billing-reconciliation.test.ts
  3 files, 21 tests passed

bun run test:run -- tests/team-settings-bulk-invitations-route.test.ts
  1 file, 5 tests passed

bun run typecheck
  passed

bun run lint
  passed

git diff --check 022c75fdf..HEAD
  passed
```

Not executed against Stripe:

```text
bun run test:run -- tests/stripe-integration.test.ts
  1 file skipped, 4 tests skipped
```

`STRIPE_INTEGRATION_SECRET_KEY` was not present in the review environment. The restricted key disclosed in chat was deliberately not copied into a command, file, or environment variable.

## Before the next review

1. Fix findings 1–5.
2. Add the focused regression tests described under each finding and the credentialed matrix in finding 6.
3. Synchronize this branch with `origin/main`; it is currently two commits behind (`ca6591996`, `2f6e99dd4`). Then rerun the checks above on the integrated tree.
4. Rotate the restricted Stripe test key that was shared in chat and supply its replacement only through the normal secret manager/CI environment.
5. Return the revised diff for review before staging deployment.
