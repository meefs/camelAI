# QAML Backdoor Usage Credit Grants Plan

## Goal

Add a superuser-only control on `/qaml-backdoor/orgs/:id` that grants usage credits to the current organization. This is needed to test low-credit alert behavior in local, staging, and production.

The implementation must:

- use the existing org credit grant primitive;
- avoid Stripe entirely;
- avoid creating a new externally callable endpoint;
- record every newly applied grant in a queryable ledger;
- show recent grant ledger rows inside the existing **AI Usage & Spend** card;
- add enough tests to prove auth, ledger, idempotency, and Stripe isolation.

## Non-Negotiable Constraints

- Do not create a new `/api/...` route for the qaml-backdoor UI.
- Do not call `/api/admin/...` from the browser.
- Do not expose `ADMIN_API_KEY` or any bearer admin credential to client code.
- Do not use `PUT /api/admin/users/:id/credits` for this UI.
- Do not mutate `billing_credit_purchase_total_cents` from this UI.
- Do not mutate Stripe customer, subscription, invoice, checkout, or billing portal fields from this UI.
- Do not import Stripe helpers into the qaml-backdoor org route for this work.
- Only `requireSuperuser`-authorized users may load or submit this control.

## Existing Credit Mechanisms

There are two existing admin credit mechanisms. Treat the org manual grant primitive as canonical for this feature.

### Org Manual Grant

Use this path.

- API endpoint already exists: `POST /api/admin/orgs/:id/credits`
- Backing method: `OrgDO.applyManualCreditGrant(...)`
- Current input: `amount_cents`, optional `reason`, optional `idempotency_key`
- Current behavior: additively increments `billing_credit_grant_total_cents`
- Current ledger: inserts into `admin_credit_grants`
- Stripe behavior: no Stripe calls

For qaml-backdoor, call the backing OrgDO method server-side from the existing `/qaml-backdoor/orgs/:id` action. Do not make a browser request to the admin API.

### User Credit Setter

Do not use this path.

- API endpoint: `PUT /api/admin/users/:id/credits`
- MCP tool: `set_user_credits`
- It can set visible available credits and raw purchase/grant totals.
- It does not create an `admin_credit_grants` ledger row.
- It is an advanced/debug override and should remain separate from this simple grant UI.

## Data Model Changes

Update `workers/main/src/auth.ts`.

### Grant Row Type

Add this exported type near `ApplyManualCreditGrantResult`:

```ts
export interface ManualCreditGrantRecord {
  grant_id: string;
  amount_cents: number;
  reason: string | null;
  created_at: number;
  created_by: string | null;
  source: string | null;
}
```

Update `ApplyManualCreditGrantResult`:

```ts
export interface ApplyManualCreditGrantResult {
  org: Organization;
  applied: boolean;
  grantId: string;
  amountCents: number;
  reason: string | null;
  createdAt: number;
  createdBy: string | null;
  source: string | null;
}
```

### Ledger Table

Replace the inline `CREATE TABLE IF NOT EXISTS admin_credit_grants (...)` block inside `applyManualCreditGrant` with a private helper on `OrgDO`:

```ts
private ensureAdminCreditGrantsTable(): void {
  this.sql.exec(`
    CREATE TABLE IF NOT EXISTS admin_credit_grants (
      grant_id TEXT PRIMARY KEY,
      amount_cents INTEGER NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  const columns = new Set(
    this.sql
      .exec<{ name: string }>("PRAGMA table_info(admin_credit_grants)")
      .toArray()
      .map((column) => String(column.name)),
  );

  if (!columns.has("created_by")) {
    this.sql.exec("ALTER TABLE admin_credit_grants ADD COLUMN created_by TEXT");
  }
  if (!columns.has("source")) {
    this.sql.exec("ALTER TABLE admin_credit_grants ADD COLUMN source TEXT");
  }
}
```

Call this helper from both `applyManualCreditGrant` and the new list method.

Existing rows must remain valid. They will have `created_by = null` and `source = null`.

### Apply Grant Signature

Change `applyManualCreditGrant` to:

```ts
applyManualCreditGrant(
  amountCents: number,
  reason?: string | null,
  idempotencyKey?: string | null,
  options: {
    createdBy?: string | null;
    source?: string | null;
  } = {},
): ApplyManualCreditGrantResult | null
```

Normalize inputs inside the method:

- `amountCents`: floor, require positive, return `null` if not positive.
- `reason`: trim, max 500 chars, store `null` when empty.
- `idempotencyKey`: trim, max 200 chars, otherwise generate `manual:${Date.now()}:${crypto.randomUUID()}`.
- `createdBy`: trim, max 200 chars, store `null` when empty.
- `source`: trim, max 100 chars, store `null` when empty.

On duplicate grant id:

- Do not increment credits.
- Do not insert a second ledger row.
- Do not write an audit log event.
- Return the existing row metadata with `applied: false`.

On newly applied grant:

- Increment only `billing_credit_grant_total_cents`.
- Set `billing_credit_usage_started_at` to `Date.now()` only when it is currently nullish.
- Do not touch `billing_credit_purchase_total_cents`.
- Do not touch any Stripe fields.
- Insert `grant_id`, `amount_cents`, `reason`, `created_at`, `created_by`, `source` into `admin_credit_grants`.
- Write an org audit log entry:

```ts
this.log("usage_credit_granted", createdBy ?? source ?? "system-admin", existingOrg.id, {
  grant_id: grantId,
  amount_cents: normalizedAmountCents,
  reason: trimmedReason,
  source: normalizedSource,
});
```

Keep the existing `dispatchAdminEvent(... org_upsert ...)` behavior only when `applied` is true.

### List Grants Method

Add this method to `OrgDO`:

```ts
listManualCreditGrants(limit = 25): ManualCreditGrantRecord[] {
  this.ensureAdminCreditGrantsTable();
  const resolvedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return this.sql
    .exec<ManualCreditGrantRecord>(
      `
      SELECT grant_id, amount_cents, reason, created_at, created_by, source
      FROM admin_credit_grants
      ORDER BY created_at DESC
      LIMIT ?
      `,
      resolvedLimit,
    )
    .toArray()
    .map((row) => ({
      grant_id: String(row.grant_id),
      amount_cents: Number(row.amount_cents),
      reason: typeof row.reason === "string" ? row.reason : null,
      created_at: Number(row.created_at),
      created_by: typeof row.created_by === "string" ? row.created_by : null,
      source: typeof row.source === "string" ? row.source : null,
    }));
}
```

## Existing Caller Updates

Update every existing `applyManualCreditGrant` call to pass an explicit source.

- `workers/main/src/routes/admin/routes.ts`, `POST /orgs/:id/credits`:
  - pass `{ source: "admin-api" }`
  - do not accept `created_by` from the API request body
  - response must include `created_at`, `created_by`, and `source`

- `src/lib/billing.server.ts`, legacy Stripe migration grant calls:
  - pass `{ source: "stripe-migration" }`
  - do not pass a user id unless one is already available in that call path

- Keep `PUT /api/admin/users/:id/credits` unchanged.
  - Do not add ledger rows to that endpoint in this PR.
  - Do not use that endpoint from qaml-backdoor.

Update `workers/main/src/routes/admin/schemas.ts`:

- `GrantOrgCreditsResponseSchema` must include:
  - `created_at`
  - `created_by`
  - `source`

## QAML Backdoor Route Changes

Update `src/routes/_admin.orgs.$id.tsx`.

### Loader

The existing loader already calls `requireSuperuser`. Keep that as the first operation.

Add these fetches to the loader:

1. `orgStub.getUsageLogSum(0, Date.now(), true).catch(() => null)`
2. `orgStub.listManualCreditGrants(10).catch(() => [])`

Compute and return `creditSummary`:

```ts
const purchaseTotalCents = org.billing_credit_purchase_total_cents ?? 0;
const grantTotalCents = org.billing_credit_grant_total_cents ?? 0;
const totalCreditLimitCents = purchaseTotalCents + grantTotalCents;
const chargeableUsageCents = usageLogSum
  ? Math.round(Number(usageLogSum.total_cost_usd ?? 0) * 100)
  : null;
const availableCreditsCents =
  chargeableUsageCents === null
    ? null
    : Math.max(0, totalCreditLimitCents - chargeableUsageCents);
```

Return:

```ts
creditSummary: {
  purchaseTotalCents,
  grantTotalCents,
  totalCreditLimitCents,
  chargeableUsageCents,
  availableCreditsCents,
}
```

Resolve grant creators:

- Collect distinct non-null `created_by` values from recent grants.
- Fetch each user profile through `authEnv.USER.get(...).getProfile()`.
- Return a `creditGrantUsers` array with `{ id, email, name }`.
- If a profile lookup fails, omit that user from the array and let the UI display the raw id.

### Amount Parser

Create `src/lib/admin-credit-grants.ts`.

Export:

```ts
export const MAX_QAML_CREDIT_GRANT_CENTS = 1_000_000; // $10,000.00

export function parseCreditGrantAmountCents(value: FormDataEntryValue | null): {
  amountCents?: number;
  error?: string;
}
```

Parser rules:

- Accept strings like `5`, `5.00`, `$5`, `$5.00`, `0.10`.
- Reject empty input.
- Reject negative values.
- Reject zero.
- Reject more than two decimal places.
- Reject non-numeric strings.
- Reject values above `MAX_QAML_CREDIT_GRANT_CENTS`.
- Use string parsing, not floating-point multiplication.

Implementation shape:

```ts
const raw = typeof value === "string" ? value.trim().replace(/^\$/, "") : "";
if (!raw) return { error: "Credit amount is required" };
if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
  return { error: "Enter a valid dollar amount with up to two decimals" };
}
const [dollarsPart, centsPart = ""] = raw.split(".");
const amountCents =
  Number(dollarsPart) * 100 + Number(centsPart.padEnd(2, "0"));
if (amountCents <= 0) return { error: "Credit amount must be greater than $0.00" };
if (amountCents > MAX_QAML_CREDIT_GRANT_CENTS) {
  return { error: "Credit amount cannot exceed $10,000.00" };
}
return { amountCents };
```

### Action

Add an `intent === "grantCredits"` branch.

Rules:

- Keep `const authContext = await requireSuperuser(request, context);` at the start of the action.
- Parse `amount` using `parseCreditGrantAmountCents`.
- Trim `reason` to max 500 chars; store `null` when empty.
- Read `idempotencyKey`; require a non-empty string no longer than 200 chars.
- Call `orgStub.applyManualCreditGrant(amountCents, reason, idempotencyKey, { createdBy: authContext.user.id, source: "qaml-backdoor" })`.
- Return `{ success: true, creditGrant: ... }` on success.
- Return `{ error: "..." }` on validation or grant failure.
- Do not redirect after this action.
- Do not call Stripe helpers.
- Do not call the bearer-token admin API from this action.

## UI Changes

Update the existing **AI Usage & Spend** card in `src/routes/_admin.orgs.$id.tsx`.

Refactor the inline card into a local component named `AdminAiUsageSpendCard` in the same file. Pass:

- `orgId`
- `usageSpend`
- `usageLog`
- `creditSummary`
- `creditGrants`
- `creditGrantUsers`

### Card Header

Keep:

- title: `AI Usage & Spend`
- existing lifetime spend description

Add a top-right button:

- label: `Grant credits`
- `variant="outline"`
- `size="sm"`
- opens the dialog

Use `CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0"` so it matches the existing admin card header style.

### Grant Credits Dialog

Use existing shadcn primitives:

- `Dialog`
- `DialogContent`
- `DialogHeader`
- `DialogTitle`
- `DialogDescription`
- `Input`
- `Label`
- `Textarea` if available; otherwise use `Input` for reason
- `Button`

Dialog copy:

- title: `Grant usage credits`
- description: `Add credits to this organization without creating a Stripe transaction.`

Fields:

- `Amount`
  - name: `amount`
  - placeholder: `5.00`
  - helper text: `Enter dollars, for example 5.00 for $5.00.`
- `Reason`
  - name: `reason`
  - optional
  - placeholder: `Low-credit alert testing`

Hidden fields:

- `intent=grantCredits`
- `idempotencyKey=<current modal idempotency key>`

Idempotency key behavior:

- Generate `crypto.randomUUID()` when the dialog opens.
- Keep the same key while the dialog remains open.
- Reset the key after a successful grant or after closing the dialog.
- This protects against duplicate browser submits/retries.

Success behavior:

- Close dialog.
- Toast `Credits granted`.
- Allow React Router revalidation to refresh summary and table.

Error behavior:

- Keep dialog open.
- Toast the returned error.

### Credit Summary

At the top of the card body, before the recent requests table, render a compact summary grid:

- Available
- Total credits
- Granted credits
- Purchased credits
- Chargeable usage

Use `formatUsdFromCents` from `src/lib/billing.ts` for all non-null cent values. When `availableCreditsCents` or `chargeableUsageCents` is `null`, show `Unavailable`.

### Recent Requests Table

Keep the existing recent requests table behavior and styling.

### Recent Credit Grants Table

Add this below the recent requests table with `mt-6` spacing.

Heading:

- `Recent credit grants`

Columns:

- `Granted`
  - `formatUsdFromCents(grant.amount_cents)`
- `Reason`
  - reason or `-`
- `Created by`
  - if `created_by` resolves to a user, link to `/qaml-backdoor/users/:id` and show name/email plus short id
  - if `created_by` exists but does not resolve, show short id in monospace
  - otherwise show `grant.source ?? "system"`
- `Time`
  - existing `formatTimestamp(grant.created_at)`

Empty state:

- one table row with `No credit grants recorded`

## Security Requirements

Implement and test these exact security properties:

- The qaml-backdoor loader and action both require `requireSuperuser`.
- The browser form posts only to the current `/qaml-backdoor/orgs/:id` route action.
- The browser never calls `/api/admin/orgs/:id/credits`.
- The qaml action does not use or expose `ADMIN_API_KEY`.
- The qaml action does not accept `created_by` or `source` from form data.
- The qaml action always uses `createdBy: authContext.user.id` and `source: "qaml-backdoor"`.
- The existing admin API remains protected by its bearer token behavior.
- Existing admin API callers cannot spoof `created_by` through request JSON.
- Non-superusers cannot grant credits through the qaml action.

## Stripe Isolation Requirements

Implement and test these exact billing properties:

- Granting credits from qaml-backdoor changes `billing_credit_grant_total_cents`.
- Granting credits from qaml-backdoor does not change `billing_credit_purchase_total_cents`.
- Granting credits from qaml-backdoor does not change:
  - `billing_customer_id`
  - `billing_subscription_id`
  - `billing_subscription_status`
  - `billing_last_included_credit_invoice_id`
  - `billing_trial_credit_grant_cents`
  - `billing_trial_credit_granted_at`
- Granting credits from qaml-backdoor does not call:
  - `createCreditsCheckoutSession`
  - `stripeRequest`
  - any billing portal helper

## Test Plan

Add or update all tests below.

### Worker Tests

Update `workers/main/tests/billing-org.test.ts`.

Add tests:

1. `applyManualCreditGrant stores created_by and source`
   - create org
   - call `applyManualCreditGrant(2500, "test grant", "grant-1", { createdBy: userId, source: "qaml-backdoor" })`
   - assert grant total increased by 2500
   - assert result includes `createdAt`, `createdBy`, `source`
   - assert `listManualCreditGrants()` returns the row

2. `applyManualCreditGrant duplicate idempotency key does not double grant or double audit`
   - apply same grant id twice
   - assert second result has `applied: false`
   - assert grant total increased only once
   - assert `listManualCreditGrants()` has one row for the id
   - assert org audit log has one `usage_credit_granted` entry

3. `manual grants do not mutate purchased or stripe billing fields`
   - initialize org billing fields with purchase total and fake Stripe ids
   - apply grant
   - assert only grant total and maybe usage-start changed
   - assert purchase and Stripe fields are unchanged

4. `listManualCreditGrants returns newest first and limits results`
   - apply at least three grants
   - assert order newest first
   - assert `listManualCreditGrants(2)` returns two rows

Update `workers/main/tests/admin-api-billing-credits.test.ts`.

Add tests:

1. `admin API grant response includes ledger metadata`
   - assert response includes `created_at`, `created_by: null`, `source: "admin-api"`

2. `admin API ignores attempted created_by spoofing`
   - send JSON with `created_by: "attacker"` and `source: "fake"`
   - assert stored row has `created_by: null`, `source: "admin-api"`

3. `admin API still requires bearer auth`
   - request without `Authorization`
   - assert `handleAdminApi(...)` returns `null` or existing fallthrough behavior
   - request with wrong bearer token
   - assert 401

### Route and UI Tests

Create `tests/admin-org-credit-grants-route.test.ts`.

Mock `requireSuperuser`, `getAuthEnv`, and the OrgDO stub in the same style as existing route tests.

Add tests:

1. `loader returns credit summary and recent credit grants`
   - mock org with purchase/grant totals
   - mock chargeable usage sum
   - mock `listManualCreditGrants`
   - assert returned `creditSummary` and grant rows

2. `action rejects non-superuser through requireSuperuser`
   - make `requireSuperuser` reject/redirect
   - assert `applyManualCreditGrant` is not called

3. `action grants credits with authenticated superuser as created_by`
   - post `intent=grantCredits`, `amount=5.00`, reason, idempotency key
   - assert `applyManualCreditGrant(500, reason, key, { createdBy: superuserId, source: "qaml-backdoor" })`

4. `action rejects invalid amounts`
   - empty, zero, negative, too many decimals, over max
   - assert returned errors
   - assert `applyManualCreditGrant` is not called

5. `action ignores forged created_by and source form fields`
   - include `created_by=attacker` and `source=admin-api`
   - assert method receives only authenticated user id and `qaml-backdoor`

Create `tests/admin-credit-grants.test.ts`.

Test `parseCreditGrantAmountCents`:

- `5` -> 500
- `5.00` -> 500
- `$5.00` -> 500
- `0.10` -> 10
- reject empty
- reject `0`
- reject `-1`
- reject `1.234`
- reject `abc`
- reject amount over `$10,000.00`

### Manual Verification

1. Run `bun run typecheck`.
2. Run `bun run test:workers -- workers/main/tests/billing-org.test.ts workers/main/tests/admin-api-billing-credits.test.ts`.
3. Run `bun run test:run -- tests/admin-credit-grants.test.ts tests/admin-org-credit-grants-route.test.ts`.
4. Start local dev with `bun run dev`.
5. Open `/qaml-backdoor/orgs/:id`.
6. Confirm **AI Usage & Spend** shows the credit summary.
7. Click **Grant credits**.
8. Grant `$5.00` with reason `Low-credit alert testing`.
9. Confirm:
   - modal closes
   - success toast appears
   - available/total/granted credits update
   - recent credit grants table shows amount, reason, current superuser, timestamp
   - org audit log includes `usage_credit_granted`
10. Confirm Stripe dashboard/test logs show no checkout, customer, subscription, invoice, or portal activity from the grant.

## Acceptance Criteria

- A superuser can grant org usage credits from `/qaml-backdoor/orgs/:id`.
- The control is inside the existing **AI Usage & Spend** card.
- The browser never receives an admin API token.
- No new externally callable credit grant endpoint is added.
- Every newly applied qaml grant creates exactly one ledger row.
- Duplicate idempotency keys do not double-grant credits.
- Recent grant ledger rows are visible below recent usage requests.
- Grant rows include amount, reason, timestamp, source, and creator id when available.
- QAML grants only increment `billing_credit_grant_total_cents`.
- Stripe billing fields and Stripe APIs are untouched.
- Non-superusers cannot grant credits.
- The test suite covers security, ledger integrity, idempotency, and Stripe isolation.
