# Billing Plan Change and Credit Allocation Implementation Feedback — Round 3

- Date: July 14, 2026
- Reviewed state: uncommitted working-tree remediation on `f481ea888e`
- Target branch: `origin/main` at `e6e40adde`
- Previous review: `docs/billing-plan-change-and-credit-allocation-implementation-feedback-r2.md`

## Release recommendation

Do not deploy this as the staging billing candidate yet. The round-two implementation is directionally strong and all non-credentialed checks passed, but three remaining paths can still leave a paying customer without credits or remove already-paid Team capacity without a refund.

Fix findings 1–3 and add the listed regressions before staging sign-off. Then integrate the two newer `origin/main` commits and run the credentialed Stripe suite with a rotated test key.

## What the round-two remediation fixed correctly

- The invoice ledger is consulted before catalog-dependent resolution, so an already-recorded invoice no longer depends on cleared migration metadata or later catalog changes.
- Persisted invoice rows are validated against canonical invoice, subscription, customer, reason, plan, seat, and amount fields before being reported as duplicates.
- The four Starter/Pro prices retired by PR #1007 now have an explicit historical mapping, separate from v1-to-v2 migration eligibility.
- Historical renewal credits preserve the old Starter `$10` / Pro `$30` allowance and reject conflicting invoice metadata.
- Team seat synchronization distinguishes unconfirmed Stripe changes from confirmed paid capacity.
- Metadata and OrgDO repair failures after a confirmed quantity update no longer trigger an automatic rollback.
- Invitation creation can temporarily use confirmed Stripe capacity while OrgDO seat repair is pending.
- The new sequential webhook test proves that successful metadata cleanup followed by the other paid-event alias returns a duplicate without granting twice.

## Blocking findings

### 1) P1: A late-paid first invoice on a PR #1007 price is still rejected

Files:

- `src/lib/billing.server.ts:3360-3420`
- `src/lib/billing.server.ts:3544-3576`
- `scripts/migrate-stripe-plan-prices.ts:454-465`
- `docs/pricing-tier-update-plan.md:138-168,232-240`

`recognizedRetiredPricingRolloutRenewalLine()` contains the correct four historical price mappings, but the resolver calls it only when `billing_reason === "subscription_cycle"`. A paid `subscription_create` invoice on the same retired prices still falls through to `has no recognized plan`.

That invoice shape remains possible during this rollout:

1. A Starter or Pro Checkout subscription is created on the old price shortly before PR #1007.
2. Its first payment fails or requires authentication, leaving the subscription `incomplete` and the first invoice open.
3. The pricing migration intentionally leaves `incomplete` subscriptions for manual review because they can activate within roughly 23 hours.
4. After the app switches to the new configured prices, the customer pays that original invoice. Stripe marks the invoice paid and activates the subscription.
5. The canonical invoice still has `billing_reason=subscription_create` and the retired price, so this resolver returns 500 and grants no initial credits.

Stripe documents that an incomplete subscription can become active when its first invoice is paid within that window: [Stripe subscription lifecycle](https://docs.stripe.com/billing/subscriptions/overview#subscription-statuses). The repository's own pricing migration explicitly preserves this case for follow-up rather than rewriting it.

Required fix:

1. Generalize the exact retired-price resolver to support both `subscription_create` and `subscription_cycle` invoices. Do not create a broad unknown-price fallback.
2. Continue deriving the plan and quantity from the historical invoice line and validating invoice-snapshot metadata. For an initial invoice, also validate `initial_included_credit_cents` when it is present.
3. Grant the historical invoice-time allowance (`$10` Starter / `$30` Pro), not the current live subscription allowance, and do not overwrite current org plan/seat state.
4. Add delayed initial-payment fixtures for retired Starter and Pro prices in test and live mode. Make the fetched live subscription use the replacement price to prove there is no mutable-live fallback.
5. Exercise the same case through `processPaidSubscriptionInvoice()` and reconciliation, asserting one grant, one ledger row, duplicate safety, and a 200 webhook response.

### 2) P1: A failed migration-metadata cleanup is never retried once the ledger row exists

Files:

- `src/lib/billing.server.ts:3061-3099`
- `src/lib/billing.server.ts:3762-3787`
- `src/lib/billing.server.ts:3847-3872`

The ledger-first duplicate path fixes reclassification, but it returns before the legacy-migration cleanup block. `bestEffortClearPendingLegacyMigrationCustomerMetadata()` deliberately catches Stripe failures, so this sequence now leaves stale migration state indefinitely:

1. The paid legacy migration is credited and recorded atomically.
2. The customer-metadata POST fails transiently; the helper logs the error and the webhook still returns success.
3. The second paid-event alias finds the ledger row and correctly returns `duplicate`.
4. Because the duplicate branch returns at line 3872, it never retries the failed cleanup.

Stale `v2_mig_*` data can later make an unrelated `subscription_update` back to the same plan and seat count look like a fresh legacy migration, producing a full-period grant instead of the prorated incremental grant.

Required fix:

1. When an existing ledger row has persisted source `legacy_migration`, retry `bestEffortClearPendingLegacyMigrationCustomerMetadata()` before returning the duplicate result. This remains safe and idempotent.
2. Keep duplicate credit application disabled; cleanup repair must not call the grant RPC again.
3. Clear the legacy alias `pending_legacy_migration_included_credit_cents` along with the other `pending_legacy_migration_*` fields while touching this helper.
4. Extend the webhook regression so the first cleanup POST returns 503 and the second event alias succeeds. Assert the second delivery is still duplicate/zero-credit, performs a second cleanup POST, and leaves only `org_id` metadata.
5. Add a later normal plan-change invoice to that test (or a focused resolver test) to prove stale migration metadata cannot turn it into a full `legacy_migration` grant.

### 3) P1: A partial retry can reduce previously charged Team capacity with no refund

Files:

- `src/lib/billing.server.ts:1413-1482`
- `src/routes/_app.settings.organization.team.tsx:252-345`
- `src/routes/api/orgs.$id.invite.ts:68-92`
- `src/routes/api/invitations.$orgId.$invitationId.ts:89-100`

The implementation preserves capacity after a one-seat invitation failure and a retry of that same one seat. It does not preserve a multi-seat charge when the user retries only part of the failed batch.

Concrete sequence:

1. An org has three occupied/paid seats and submits two invitations.
2. Stripe successfully increases quantity from 3 to 5 and charges the proration.
3. The atomic invitation write fails, so no invitation exists; Stripe and usually OrgDO remain at five seats.
4. The user retries only one address, or uses the legacy single-invite API. The requested target is four seats.
5. `syncTeamSubscriptionSeatCount()` sees Stripe quantity five and treats target four as a decrease, posting quantity four with `proration_behavior=none`.
6. The unconditional post-create `bestEffortSyncTeamSubscriptionSeatCount()` and the invitation-acceptance syncs can make the same occupancy-based decrease.

The user paid for two incremental seats but now retains only one seat of capacity, with no refund or credit. Stripe's `proration_behavior=none` prevents a proration; it does not compensate the earlier charge: [Update a subscription item](https://docs.stripe.com/api/subscription_items/update).

Required fix:

1. Separate **ensure capacity at least N** from **reconcile quantity exactly to occupancy**. Invitation creation, retry, and acceptance must use the former and must never implicitly decrease confirmed paid capacity.
2. In the ensure-capacity path, use `max(requestedTarget, currentStripeQuantity)` as the effective target. Return that effective target to callers.
3. After invitation persistence, repair metadata/OrgDO against the confirmed effective target rather than invoking an occupancy-based reconciliation that can lower it.
4. Reserve exact downward reconciliation for explicit capacity-release events such as member removal or invitation deletion. If automatic abandonment/expiry of paid recovery capacity is desired, persist a recovery reservation and define an explicit expiry/refund-or-next-renewal policy; do not infer abandonment from a partial retry.
5. Audit both before/after invitation-acceptance syncs so accepting one recovered invitation cannot discard another paid-but-unused seat.
6. Add a regression with a 3-to-5 paid increase, failed two-invite transaction, and a one-address retry through each invitation surface. Assert:
   - no request lowers Stripe from five to four;
   - no second charge occurs;
   - one invitation consumes one seat while five-seat paid capacity remains available;
   - accepting that invitation does not lower quantity; and
   - a later retry can consume the remaining paid seat.

The current one-seat retry tests should remain; add this multi-seat partial-retry case rather than replacing them.

## Verification performed

Passed:

```text
bun run test:run -- tests/billing.test.ts tests/billing-settings-route.test.ts tests/billing-settings-overview-ui.test.tsx tests/plan-picker-byok.test.tsx tests/org-invite-api-route.test.ts tests/team-settings-bulk-invitations-route.test.ts
  6 files, 133 tests passed

bun run test:workers -- billing-org.test.ts billing-webhook.test.ts admin-api-billing-reconciliation.test.ts
  3 files, 22 tests passed

bun run typecheck
  passed

bun run lint
  passed

git diff --check
  passed for the tracked implementation diff
```

Not executed against Stripe:

```text
bun run test:run -- tests/stripe-integration.test.ts
  1 file skipped, 8 tests skipped
```

The opt-in Stripe variables were not present. Do not reuse the restricted key previously exposed in chat; rotate it, review its Workbench activity, and supply the replacement only through the normal secret manager or CI environment.

## Repository state before staging

- The round-two implementation is still uncommitted in the working tree.
- `HEAD` and `origin/main` have diverged: this branch has the two billing commits, while `origin/main` has two newer commits (`212c7db47`, `e6e40adde`).
- Integrate `origin/main` without dropping the working-tree remediation, then rerun all checks above on the integrated tree.

## Before the next review

1. Fix findings 1–3 and add the focused regression tests.
2. Integrate the current `origin/main` and rerun non-credentialed checks.
3. Run the credentialed Stripe suite with a newly rotated restricted test key.
4. Return the revised diff for review before deploying the billing fix to staging.
