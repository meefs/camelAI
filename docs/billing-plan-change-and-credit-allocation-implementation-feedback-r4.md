# Billing Plan Change and Credit Allocation Implementation Feedback — Round 4

- Date: July 14, 2026
- Reviewed state: uncommitted round-three remediation on `501cf7551`
- Target branch: `origin/main` at `b2afd9c38`
- Previous review: `docs/billing-plan-change-and-credit-allocation-implementation-feedback-r3.md`

## Release recommendation

Do not deploy this billing candidate to staging yet. The agent correctly resolved all three round-three findings, and every available non-credentialed check passes. However, two remaining billing paths can still charge or reduce Team capacity incorrectly, and an older invitation endpoint now rejects organizations for which Team seat billing is intentionally not applicable.

Fix findings 1–3 and add the focused regressions below. After that, rerun the credentialed Stripe suite with a rotated test key and return the diff for a short final review.

## What the round-three remediation fixed correctly

- The exact four Starter/Pro prices retired by PR #1007 are now accepted for both `subscription_create` and `subscription_cycle` invoices.
- Historical initial and renewal grants are derived from the paid invoice line and invoice-snapshot metadata, not the replacement price on the live subscription.
- Delayed initial invoices are covered for Starter and Pro in both Stripe modes, including processing, reconciliation, ledger replay, and webhook routing.
- An existing `legacy_migration` ledger row now retries customer-metadata cleanup while remaining a zero-credit duplicate.
- Cleanup includes both the compact `v2_mig_*` fields and every long-form `pending_legacy_migration_*` alias, including the previously omitted included-credit field.
- Team seat logic now distinguishes an exact reconciliation from “ensure at least N” capacity.
- Sequential multi-seat failure and partial-retry paths preserve the larger paid Stripe quantity through invitation creation and acceptance.
- Explicit release events—member removal and invitation deletion—remain the only call sites that request exact downward reconciliation.
- The Stripe API pin is on the repository upgrade guide's Dahlia target, and the existing subscription-period compatibility work remains intact.

## Blocking findings

### 1) P1: The plan-change Portal configuration now lets customers edit the server-owned quantity

Files:

- `src/lib/billing.server.ts:2038-2121`
- `tests/billing.test.ts:1920-2002,3068-3155`
- `tests/stripe-integration.test.ts:945-993`
- `docs/billing-plan-change-and-credit-allocation-fix-plan.md:155-183,398-405`

The approved architecture sends an exact price and server-computed quantity through `subscription_update_confirm`. The customer should confirm that update, not select another quantity. The current remediation changes every product in both upgrade and downgrade Portal configurations to:

```text
adjustable_quantity.enabled = true
Starter maximum = 2
Pro maximum = 2
Team maximum = 999999
```

Stripe documents `adjustable_quantity.enabled=true` as allowing the customer to change the quantity, and describes quantity updates as a self-service Portal capability. That contradicts the exact-target invariant: [Portal configuration API](https://docs.stripe.com/api/customer_portal/configurations/create), [Portal configuration guide](https://docs.stripe.com/customer-management/configure-portal), and [exact update confirmation deep links](https://docs.stripe.com/customer-management/portal-deep-links).

This is financially unsafe for the individual tiers. Starter and Pro allowances are fixed base credits, so a quantity of two charges twice the recurring price while still granting only `$10` or `$40` at renewal. For Team, the Portal can replace the server-computed member/invitation quantity with an arbitrary larger value. The credentialed test currently asserts this permissive configuration instead of rejecting it.

Required fix:

1. Restore a non-adjustable exact-target confirmation. Keep the ability for the deep link to change the item from a multi-seat Team quantity to the server-specified target, but do not expose a customer quantity editor.
2. If Dahlia rejects `subscription_update_confirm.items[].quantity` when the product has `adjustable_quantity.enabled=false`, do not silently broaden the Portal configuration. Use a Stripe-supported flow that still locks the update to the server-owned quantity, and prove its behavior with the credentialed test.
3. Bump `BILLING_PORTAL_CONFIGURATION_SCHEMA_VERSION` again so no cached permissive configuration is reused.
4. Change both mocked and credentialed assertions to prove that customers cannot alter Starter, Pro, or Team quantity in this flow. The integration test should still prove that Team-to-individual and individual-to-Team exact quantities are accepted by Stripe.
5. Add a defensive resolver test for a Starter/Pro recurring invoice with quantity greater than one. Either reject it with an actionable invariant error or define an explicit entitlement policy; do not silently charge multiple units for one fixed allowance.

### 2) P1: Concurrent “ensure capacity” calls can still overwrite a larger paid quantity with a smaller stale target

Files:

- `src/lib/billing.server.ts:1395-1580`
- `src/routes/_app.settings.organization.team.tsx:300-349`
- `src/routes/api/orgs.$id.invite.ts:69-94`
- `tests/billing.test.ts:5151-5225`

`ensureTeamSubscriptionSeatCapacity()` preserves a larger quantity only when its initial Stripe GET observes that larger quantity. The GET, target calculation, and subscription-item POST are not serialized or fenced.

A concrete overlap still violates the paid-capacity invariant:

1. Stripe quantity is three.
2. A two-address batch and a one-address request both fetch quantity three.
3. The batch computes five; the single request computes four.
4. The five-seat POST succeeds and charges first.
5. The four-seat POST executes second. Because that request compared four with its stale snapshot of three, it sends `quantity=4` with `always_invoice` and accepts Stripe's quantity-four response.
6. Metadata and OrgDO can then also be restamped to four. The larger paid reservation has been lost, and Stripe can create an unintended negative proration or credit while this code reports an increase.

The per-request UUID idempotency keys do not prevent this. Stripe idempotency makes a single operation safe to retry; different keys do not impose ordering or compare-and-swap semantics: [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests). Stripe also calculates proration from the quantity at execution time, not the application's earlier GET: [Update a subscription item](https://docs.stripe.com/api/subscription_items/update).

Required fix:

1. Serialize Team subscription quantity mutations per organization/subscription through a durable, org-scoped coordinator. Do not use a process-local mutex; Worker isolates do not provide a global lock.
2. Give ensure operations a monotonic paid-capacity floor. A smaller ensure request must never be allowed to write below a larger reserved or confirmed target, even when both requests began from the same Stripe snapshot.
3. Run exact release operations through the same coordinator. Recompute authoritative occupancy after acquiring the mutation right so a concurrent member removal cannot lower quantity beneath a newly created invitation.
4. Fence metadata and OrgDO repair with the same operation revision/target so a slower stale request cannot overwrite newer seat state after the Stripe mutation finishes.
5. Add controlled-overlap tests that pause both requests after they read quantity three, then release the five-seat and four-seat writes in the dangerous order. Assert final Stripe quantity, subscription metadata, and OrgDO state remain at least five; no lower write or unintended credit/refund occurs; and the paid incremental invoice is granted once.
6. Add the inverse overlap between an explicit removal/deletion reconciliation and a new invitation reservation. Final quantity must cover final authoritative occupancy without a double charge.

### 3) P2: The legacy invitation POST now treats “Team billing not applicable” as a fatal error

File:

- `src/routes/api/orgs.$id.invite.ts:60-94`
- `tests/org-invite-api-route.test.ts`

The route unconditionally computes a Team seat target and requires `ensureTeamSubscriptionSeatCapacity()` to return `capacity_confirmed`. The helper intentionally returns `not_applicable/billing_not_syncable` for non-Team and enterprise organizations. The route therefore returns HTTP 500 before `createInvitations()` for every such organization.

This changes the old helper contract. Previously, `syncTeamSubscriptionSeatCount()` returned the unchanged organization when Team billing did not apply, so enterprise invitations could continue. Starter/Pro/free limits should still be enforced by OrgDO, but they should not fail because a Team-only billing helper reported “not applicable.”

Required fix:

1. Load and classify the organization before running the strict paid-seat path.
2. Require `capacity_confirmed` only for a syncable, Stripe-backed Team organization that needs the reservation.
3. Let enterprise invitations bypass Stripe seat synchronization. Preserve OrgDO's existing seat-limit enforcement for non-Team, non-enterprise plans.
4. Add an enterprise POST regression proving invitation creation succeeds and no Stripe helper is called.
5. Keep the existing Team tests proving a failed immediate charge creates no invitation and a successful charge precedes invitation persistence.

## Verification performed

Passed:

```text
bun run test:run -- tests/billing.test.ts tests/billing-settings-route.test.ts tests/billing-settings-overview-ui.test.tsx tests/plan-picker-byok.test.tsx tests/org-invite-api-route.test.ts tests/team-settings-bulk-invitations-route.test.ts tests/invitation-accept-route.test.ts
  7 files, 144 tests passed

bun run test:workers -- billing-org.test.ts billing-webhook.test.ts admin-api-billing-reconciliation.test.ts
  3 files, 23 tests passed

bun run typecheck
  passed

bun run lint
  passed

git diff --check
  passed for the current tracked working-tree implementation
```

Not executed against Stripe:

```text
bun run test:run -- tests/stripe-integration.test.ts
  1 file skipped, 8 tests skipped
```

The opt-in Stripe variables were not present. Do not reuse the restricted key previously exposed in chat. Rotate it, review its Workbench activity, and provide the replacement only through the normal secret manager or CI environment.

## Repository state before the next review

- The round-two and round-three remediation remains uncommitted in the working tree, including the new invitation-acceptance test.
- The branch contains three commits not on `origin/main` and is two commits behind the current target branch.
- Integrate the current `origin/main` without dropping the working-tree remediation, then rerun the checks above.
- The full branch diff has three trailing-space warnings in the already committed round-one Markdown feedback file; production and test code have no `git diff --check` errors.

## Before the next review

1. Fix findings 1–3 and add the listed regressions.
2. Integrate the current `origin/main`.
3. Run the credentialed Stripe suite with a newly rotated restricted test key.
4. Return the revised diff for final review before deploying the billing fix to staging.
