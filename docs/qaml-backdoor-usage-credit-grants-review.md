# QAML Backdoor Usage Credit Grants Review

## Findings

### 1. MCP/user credit setter can still issue credits without a grant ledger row

Severity: Medium

The new qaml-backdoor path records grants correctly through `OrgDO.applyManualCreditGrant`, but the existing admin MCP `set_user_credits` tool still calls `PUT /api/admin/users/:id/credits`, and that route directly rewrites `billing_credit_grant_total_cents` through `orgStub.updateBillingState(...)`.

Relevant locations:

- `workers/main/src/routes/admin-mcp.ts:973`
- `workers/main/src/routes/admin/routes.ts:608`

This means the system still has a production admin path that can increase credits without creating an `admin_credit_grants` row or `usage_credit_granted` audit event. If the product requirement is “usage credits issued by admins are recorded,” this is still a gap.

Prescriptive fix:

- Add a separate MCP tool for normal grants, for example `grant_org_credits`, that requires `org_id`, `amount_cents`, optional `reason`, and optional `idempotency_key`, and routes to `POST /api/admin/orgs/:id/credits` or directly to `applyManualCreditGrant`.
- Include the OAuth admin MCP actor id as `createdBy` when available and `source: "admin-mcp"`.
- Keep `set_user_credits` as an explicitly named override/debug tool, but add warning language to its description that it bypasses the grant ledger.
- Add tests proving MCP normal grants create ledger rows and override/debug updates do not masquerade as grant records.

### 2. Grant ledger read failures are silently rendered as “No credit grants recorded”

Severity: Medium

The org detail loader catches `listManualCreditGrants(10)` failures and returns `[]`. The UI then renders the same empty state used for a legitimately empty ledger.

Relevant locations:

- `src/routes/_admin.orgs.$id.tsx:192`
- `src/routes/_admin.orgs.$id.tsx:942`

That hides the exact recordkeeping failure this feature is meant to surface. For admin/audit data, an unavailable ledger should be visible as unavailable, not indistinguishable from “no grants exist.”

Prescriptive fix:

- Change the loader to preserve the failure state:

```ts
const creditGrantsResult = await orgStub
  .listManualCreditGrants(10)
  .then((grants) => ({ grants, error: null }))
  .catch((error) => ({
    grants: [],
    error: error instanceof Error ? error.message : "Failed to load credit grants",
  }));
```

- Return `creditGrantsUnavailable: Boolean(error)` and `creditGrantsError`.
- In the table, render `Credit grant history unavailable` instead of `No credit grants recorded` when the read fails.
- Add a route loader test for the failure state.

## Coverage Assessment

The implementation has good coverage for the new qaml action, amount parsing, admin API metadata, Durable Object ledger behavior, idempotency, audit creation, and Stripe-field isolation.

Tests added or updated include:

- `tests/admin-credit-grants.test.ts`
- `tests/admin-org-credit-grants-route.test.ts`
- `workers/main/tests/admin-api-billing-credits.test.ts`
- `workers/main/tests/billing-org.test.ts`

Recommended additional coverage:

- A component/render test for `AdminAiUsageSpendCard` that verifies:
  - the **Grant credits** button opens the dialog;
  - the recent credit grants table renders amount, reason, actor/source, and timestamp;
  - the empty state and unavailable state are distinct.
- MCP grant coverage if the normal MCP grant path is added.

## Verification Run

All checks below passed:

```bash
bun run test:run -- tests/admin-credit-grants.test.ts tests/admin-org-credit-grants-route.test.ts
bun run test:workers -- workers/main/tests/billing-org.test.ts workers/main/tests/admin-api-billing-credits.test.ts
bun run test:run -- tests/chat-credit-status.test.ts tests/billing-credit-packs.test.ts tests/billing.test.ts
bun run typecheck
bun run lint
git diff --check
```

Observed results:

- qaml route/parser tests: 2 files, 20 tests passed.
- worker billing/admin tests: 2 files, 16 tests passed.
- nearby billing/chat-credit tests: 3 files, 72 tests passed.
- Typecheck passed.
- ESLint passed.
- `git diff --check` passed.

## Positive Notes

- The qaml form posts to the existing protected org detail route action, not to a browser-accessible admin API token path.
- The route action uses `requireSuperuser` before parsing or applying grants.
- The qaml action ignores forged `created_by`/`source` form fields and uses the authenticated superuser id with `source: "qaml-backdoor"`.
- The grant primitive increments only `billing_credit_grant_total_cents`; tests cover purchased-credit and Stripe-field isolation.
- Duplicate idempotency keys return the existing grant and do not double-increment credits or double-log audit entries.
