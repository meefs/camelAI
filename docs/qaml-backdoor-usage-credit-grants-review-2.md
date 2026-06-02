# QAML Backdoor Usage Credit Grants Review 2

## Findings

No blocking findings.

The two prior review findings have been addressed:

1. MCP now has a normal grant path, `grant_org_credits`, that records `created_by` and `source: "admin-mcp"` through `OrgDO.applyManualCreditGrant`.
2. The qaml org detail loader now preserves grant-ledger read failures, and the UI renders `Credit grant history unavailable` instead of conflating failures with an empty grant ledger.

## Prior Feedback Verification

### MCP grant ledger path

The new MCP tool is registered and exposed as `grant_org_credits`.

Relevant implementation:

- `workers/main/src/routes/admin-mcp.ts`

The tool:

- requires `org_id` and positive integer `amount_cents`;
- accepts optional `reason` and `idempotency_key`;
- checks that the org exists;
- calls `orgStub.applyManualCreditGrant(...)`;
- passes `{ createdBy: grant.user_id, source: "admin-mcp" }`;
- returns grant metadata including `created_at`, `created_by`, and `source`.

The old `set_user_credits` tool remains available, but its description now clearly marks it as a debug override that does not create a grant ledger row.

Relevant test coverage:

- `workers/main/tests/admin-mcp-oauth.test.ts`

Covered behaviors:

- tool list includes `grant_org_credits`;
- `set_user_credits` description warns that it bypasses grant ledger rows;
- `grant_org_credits` creates a ledger row with `created_by` and `source: "admin-mcp"`;
- `set_user_credits` remains separate and does not create grant ledger records.

### Grant ledger unavailable state

The qaml org loader now returns:

- `creditGrants`
- `creditGrantsUnavailable`
- `creditGrantsError`

The UI distinguishes:

- unavailable history: `Credit grant history unavailable`;
- true empty history: `No credit grants recorded`.

Relevant implementation:

- `src/routes/_admin.orgs.$id.tsx`

Relevant test coverage:

- `tests/admin-org-credit-grants-route.test.ts`

Covered behavior:

- rejected `listManualCreditGrants` calls return `creditGrantsUnavailable: true` and preserve the error message.

## Non-Blocking Notes

### Component-level rendering coverage is still not present

The route/action/DO/MCP coverage is strong. There is still no component render test for the new `AdminAiUsageSpendCard` UI itself.

This is not blocking because the route data and action behavior are covered, and typecheck/lint passed. A future component test would still be useful for:

- opening the **Grant credits** dialog;
- rendering grant table rows;
- rendering the empty state;
- rendering the unavailable state.

### Generic `admin_api_request` attribution remains coarse

MCP users should use `grant_org_credits` for normal grants. If an MCP user instead uses the generic `admin_api_request` tool to call `POST /api/admin/orgs/:id/credits`, the grant is still recorded, but it will be attributed as the admin API path rather than as `source: "admin-mcp"` with the MCP actor.

This is acceptable with the current implementation because the specialized MCP grant tool exists and is the documented normal path. If exact attribution for generic MCP-admin-API calls becomes required, the admin API bridge will need a trusted internal actor propagation mechanism that cannot be spoofed by ordinary bearer-token API clients.

## Verification Run

All checks below passed:

```bash
bun run test:run -- tests/admin-credit-grants.test.ts tests/admin-org-credit-grants-route.test.ts
bun run test:workers -- workers/main/tests/billing-org.test.ts workers/main/tests/admin-api-billing-credits.test.ts workers/main/tests/admin-mcp-oauth.test.ts
bun run test:run -- tests/chat-credit-status.test.ts tests/billing-credit-packs.test.ts tests/billing.test.ts
bun run typecheck
bun run lint
git diff --check
```

Observed results:

- qaml route/parser tests: 2 files, 21 tests passed.
- worker billing/admin/API/MCP tests: 3 files, 29 tests passed.
- nearby billing/chat-credit tests: 3 files, 72 tests passed.
- Typecheck passed.
- ESLint passed.
- `git diff --check` passed.

## Overall Assessment

The implementation now satisfies the requested security and ledger requirements for the qaml-backdoor grant flow:

- no new externally callable qaml credit endpoint;
- no browser-held admin API token;
- qaml action protected by `requireSuperuser`;
- qaml grants record actor/source;
- MCP normal grants record actor/source;
- debug credit overrides are explicitly labeled as non-ledger overrides;
- Stripe fields and purchase-credit totals remain isolated from manual grants;
- automated coverage is thorough for the backend, route action, MCP, idempotency, audit, and amount parsing paths.
