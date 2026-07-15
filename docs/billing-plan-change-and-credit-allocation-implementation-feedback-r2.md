# Billing Plan Change and Credit Allocation Implementation Feedback — Round 2

- Date: July 14, 2026
- Reviewed commit: `f481ea888e` (`Address billing implementation review findings`)
- Previous implementation commit: `4e825a3c5` (`Fix billing plan changes and credit allocation`)
- Branch base: `2f6e99dd4` (`origin/main`)

## Release recommendation

Do not hand this build to staging as the billing-fix candidate yet. The agent resolved the prior review findings well, and every non-credentialed check run during this review passed. Three remaining failure paths can still leave a paid invoice unacknowledged, charge for a Team seat without preserving the seat for retry, or withhold credits for an invoice created immediately before the PR #1007 price migration.

Fix findings 1–3 and add their regression tests before staging sign-off. The credentialed Stripe suite should then be run with a newly rotated test key before or as part of the staging rollout.

## Prior findings now resolved

- Initial and renewal grants use the paid invoice's recurring line rather than the mutable live subscription, and historical invoices no longer overwrite current org plan/seat state.
- Reconciliation preview is read-only; Stripe and OrgDO writes are confined to the apply path.
- Team seat increases now use `proration_behavior=always_invoice` with `payment_behavior=error_if_incomplete`, and failed payment blocks invitation creation.
- Dahlia subscription periods are read from subscription items with a defined compatibility fallback.
- Customer/subscription ownership is validated before creating a Portal session or repairing a missing customer ID.
- The credentialed test matrix is materially broader, including real paid upgrades, downgrade behavior, renewal, duplicate application, Portal configurations, and both webhook endpoints.
- **Manage in Stripe** now has a disabled/loading state.

## Blocking findings

### 1) P1: A legacy-migration invoice stops being replayable as soon as its first application clears the migration metadata

Files:

- `src/lib/billing.server.ts:2922-2962`
- `src/lib/billing.server.ts:3250-3293`
- `src/lib/billing.server.ts:3453-3514`
- `src/lib/billing.server.ts:3548-3555`

`preparePaidSubscriptionInvoice()` resolves and validates a new command before it reads the existing invoice-ledger row. That order is unsafe because resolution depends on mutable Stripe state.

The legacy-migration path has a deterministic failure sequence:

1. The first delivery sees the customer's pending-migration metadata and resolves the paid `subscription_update` invoice as `legacy_migration`.
2. The ledger grant commits, then `bestEffortClearPendingLegacyMigrationCustomerMetadata()` clears the fields that identified the migration.
3. A later delivery of the same invoice — including the other supported alias, `invoice.paid` versus `invoice.payment_succeeded` — no longer qualifies as a migration.
4. The resolver reclassifies it as a normal plan change and encounters the retired legacy price on its proration line. It throws `unknown proration price` before `getSubscriptionInvoiceGrant()` is consulted.
5. The webhook returns 500 forever instead of returning a duplicate 200. Reconciliation of the already-recorded invoice fails for the same reason.

Stripe explicitly does not guarantee webhook ordering and retries unsuccessful deliveries, so duplicate processing must remain valid after surrounding Stripe metadata changes: [Stripe webhook event ordering and retries](https://docs.stripe.com/webhooks#event-ordering).

Required fix:

1. After canonical invoice/subscription/customer ownership and org resolution, read the invoice ledger before running command resolution that depends on mutable catalog or migration metadata.
2. When a row already exists, validate its immutable `subscription_id`, `customer_id`, and billing reason against the canonical Stripe objects, then return/report a deterministic duplicate from the persisted row. Do not attempt to reclassify or recompute the invoice.
3. The apply path may still synchronize the current live subscription and repair the compatibility KV marker, but it must not re-credit the invoice.
4. Preserve fail-closed behavior for an unprocessed invoice whose prices or ownership cannot be resolved.
5. Add a sequential regression test: process a paid legacy migration once, make the next customer fetch return only the surviving `org_id` metadata, then process the same invoice through the other event alias. The second response must be 200/duplicate with zero new credits. Assert the dry-run report also works after metadata cleanup.

This should be implemented as a general ledger-first duplicate path, not as a special case that leaves other recorded invoices vulnerable to later catalog or metadata changes.

### 2) P1: A successful Team-seat charge can be undone locally after a later app failure, without refunding the charge

Files:

- `src/lib/billing.server.ts:1369-1430`
- `src/routes/_app.settings.organization.team.tsx:298-339`
- `src/routes/api/orgs.$id.invite.ts:68-88`

The failed-payment case is fixed, but the successful-payment sequence is still not failure-safe:

1. The subscription-item update succeeds, immediately invoices the proration, and confirms the new quantity.
2. A later subscription-metadata POST, OrgDO update, or `createInvitations()` call fails.
3. The route returns an error and creates no invitation.
4. The single-invite route, and the bulk route after an invitation-creation failure, call `bestEffortSyncTeamSubscriptionSeatCount()`. It recomputes capacity from current members/invitations and reduces Stripe back to the old quantity with `proration_behavior=none`.
5. The customer retains the successful proration charge, but the paid capacity is removed and there is no invitation to consume it. If the bulk route instead fails during the post-charge metadata or OrgDO update, `billingExpanded` is still false: no downward reconciliation runs, but the route still returns without an invitation or a reliable local seat entitlement.

`error_if_incomplete` correctly prevents a quantity update when payment itself fails; it cannot compensate for failures after a successful Stripe response. Stripe documents those request semantics in [Update a subscription item](https://docs.stripe.com/api/subscription_items/update).

Required fix:

1. Treat a confirmed Stripe quantity increase as paid capacity that must be preserved for retry. Do not run downward reconciliation from an invitation-creation catch after that point.
2. Make the subscription metadata restamp repairable/best-effort after the charge. It must not turn a successful payment into a terminal invitation failure. Ensure OrgDO's billed seat count can be repaired from the confirmed Stripe quantity without issuing another charge.
3. If invitation creation fails after payment, keep the target Stripe/Org seat capacity. A retry should observe the already-paid quantity, skip another item update/invoice, and create the invitation against that capacity.
4. Distinguish failures before payment from failures after confirmed payment in the function result/error contract so callers cannot accidentally invoke the wrong compensation behavior.
5. Add route-level tests for:
   - subscription-item success followed by subscription-metadata POST failure;
   - subscription-item success followed by OrgDO seat-state failure;
   - subscription-item success followed by `createInvitations()` failure; and
   - retry after each failure, proving no second charge and eventual invitation creation.

If the team chooses refunds instead of preserving paid capacity, implement an explicit, idempotent, auditable refund/credit-note path. A no-proration quantity decrease is not compensation for an already-collected charge.

### 3) P1: Renewals created on the immediately retired PR #1007 prices are not in the renewal fallback

Files:

- `src/lib/billing.server.ts:320-332`
- `src/lib/billing.server.ts:3341-3362`
- `docs/pricing-tier-update-plan.md:232-240`

The new full-cycle resolver intentionally accepts configured current prices or a narrow retired-price fallback. The fallback currently checks only the older v1 legacy-migration allowlists. It omits the Starter and Pro prices retired by PR #1007 itself:

- Staging Starter: `price_1TS5SoGvliMKf4vHohXqB19x`
- Staging Pro: `price_1TS5SoGvliMKf4vHmzDcxSXF`
- Production Starter: `price_1TRzJ5GvliMKf4vHt5P6ODiY`
- Production Pro: `price_1TRzJDGvliMKf4vHiCvInGpn`

This is not merely historical cleanup. The pricing rollout explicitly says that a past-due invoice at an old price may be paid later. Such an invoice now fails with `has no recognized plan`, returns webhook 500, and grants no included credits. It also prevents the planned reconciliation of paid invoices spanning the PR #1007 rollout.

Required fix:

1. Add a dedicated, explicit retired-renewal mapping for the four PR #1007 price IDs. Keep it separate from the v1-to-v2 migration eligibility allowlist; the concepts have different lifetimes and semantics.
2. Resolve plan and quantity from the retired invoice line plus invoice-time metadata. Do not fall back to the current live subscription.
3. Preserve the pricing rollout's no-retroactive-adjustment contract for invoices that were already issued. In particular, an old Pro renewal should use its validated invoice-time included-credit allowance (or an explicit historical allowance mapping), while the first renewal on the new Pro price grants the new `$40` allowance.
4. Continue failing closed for all other unknown prices.
5. Add fixtures for all four retired IDs and a delayed-payment test in which the live subscription has already moved to the new price. Assert the historical invoice grants exactly once and current org state remains on the new subscription.

## Verification performed

Passed:

```text
bun run test:run -- tests/billing.test.ts tests/billing-settings-route.test.ts tests/billing-settings-overview-ui.test.tsx tests/plan-picker-byok.test.tsx tests/org-invite-api-route.test.ts tests/team-settings-bulk-invitations-route.test.ts
  6 files, 120 tests passed

bun run test:workers -- billing-org.test.ts
  1 file, 16 tests passed

bun run test:workers -- billing-webhook.test.ts
  1 file, 3 tests passed

bun run test:workers -- admin-api-billing-reconciliation.test.ts
  1 file, 2 tests passed

bun run typecheck
  passed

bun run lint
  passed
```

Not executed against Stripe:

```text
bun run test:run -- tests/stripe-integration.test.ts
  1 file skipped, 8 tests skipped
```

The opt-in environment variables were not present. The restricted key previously disclosed in chat was not copied into a command, file, or environment variable; rotate it and provide the replacement only through the normal secret manager or CI environment.

`git diff --check origin/main...HEAD` reports only three Markdown hard-break lines already committed in the round-one feedback file. There are no whitespace errors in production or test code.

## Before the next review

1. Fix findings 1–3 and add the focused regression tests above.
2. Run the credentialed Stripe suite with a rotated restricted test key.
3. Rerun the focused unit/worker suites, typecheck, lint, and diff check.
4. Return the revised diff for review before deploying the billing fix to staging.
