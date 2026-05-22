# Billing Cancellation Flow Fix Plan

## Goal

Make cancellation feel unambiguous and resilient:

1. Never show the "We couldn't open your cancellation flow" error when Stripe already has the subscription scheduled to cancel.
2. Show the cancellation date from Stripe as a persistent line in the Billing plan summary:

```
Pro plan                                      [ Manage plan ]
Cancels May 8, 2026
$30/month in hosted credits.
```

This plan is for the coding agent implementing the fix. Keep the change scoped to the existing billing settings page, Stripe helpers, and focused regression tests.

## Current Code Path Audit

The cancellation entry point is [src/components/billing/cancel-plan-dialog.tsx](../src/components/billing/cancel-plan-dialog.tsx). On confirm it posts:

```ts
fetcher.submit({ intent: "cancelSubscription" }, { method: "post" });
```

The action handler is in [src/routes/_app.settings.organization.billing.tsx](../src/routes/_app.settings.organization.billing.tsx):

```ts
case "cancelSubscription": {
  if (!billingOrg.billing_subscription_id?.trim()) return { error: ... };
  const url = await createBillingPortalSession({
    env,
    org: billingOrg,
    customerEmail: authContext.user.email,
    returnUrl: billingUrl.toString(),
    cancellationSubscriptionId: billingOrg.billing_subscription_id,
  });
  return { billingPortalUrl: url };
}
```

`createBillingPortalSession()` in [src/lib/billing.server.ts](../src/lib/billing.server.ts) creates a Stripe Billing Portal session with:

```ts
flow_data[type]=subscription_cancel
flow_data[subscription_cancel][subscription]=sub_...
flow_data[after_completion][type]=redirect
```

After Stripe changes a subscription, [workers/main/src/routes/billing.ts](../workers/main/src/routes/billing.ts) handles `customer.subscription.updated` and calls `syncOrgSubscriptionFromStripe()`.

The Billing page loader already fetches `getStripeSubscriptionSummary()` and the UI already hides the Cancellation section when `subscription.cancel_at_period_end === true`. The gap is that the action and dialog do not have a "Stripe already scheduled cancellation" success path. If portal-session creation fails after, or because, Stripe already has `cancel_at_period_end=true`, the UI renders the dialog description plus this error:

```
Your plan stays active until the end of the current billing period and then switches to Free.
We couldn't open your cancellation flow. Please try again in a moment.
```

That exact combined message comes from `CancelPlanDialog`: the first sentence is the dialog description; the second is `fetcher.data.error`.

## Likely Root Cause

I cannot prove the production sequence without Stripe request logs, but the code strongly points to a stale/racy cancellation state:

- The page can still render the Cancel button if local org state says `active` and the live Stripe subscription summary fails, lags, or is not yet reflected in the current render.
- The action tries to open a `subscription_cancel` portal flow using only the local `billing_subscription_id`.
- If Stripe already has the subscription scheduled to cancel, or if a double submit/back-navigation retry happens after a successful cancellation, Stripe can reject opening another cancellation flow.
- The action currently treats that rejection as a hard failure without refreshing the subscription and checking whether cancellation actually succeeded.

There is a second, related hardening issue: `createBillingPortalSession()` calls `ensureStripeCustomerForOrg()`. For cancellation deep links, if local `billing_customer_id` is missing or stale, that helper can create/use a customer that does not own the subscription. Cancellation should fetch the subscription first and use `subscription.customer` as the portal-session customer.

Stripe docs confirm the fields/events we should key off:

- `cancel_at_period_end=true` schedules cancellation at the end of the current period.
- `customer.subscription.updated` fires when `cancel_at_period_end` is set.
- Billing Portal sessions support `flow_data.type=subscription_cancel` and `flow_data.after_completion.redirect.return_url`.

References:
- https://docs.stripe.com/billing/subscriptions/cancel
- https://docs.stripe.com/api/subscriptions/update
- https://docs.stripe.com/api/subscriptions/object
- https://docs.stripe.com/api/customer_portal/sessions/create

## Desired UX

### Normal Active Subscription

```
Billing
Manage your plan, payment method, and invoices.
------------------------------------------------------------

Pro plan                                      [ Manage plan ]
$30/month in hosted credits.
Renews June 8, 2026.

------------------------------------------------------------
Payment
...

------------------------------------------------------------
Cancellation

Cancel plan                                      [ Cancel ]
Your plan stays active until the end of the current billing period.
```

### Cancellation Scheduled

```
Billing
Manage your plan, payment method, and invoices.
------------------------------------------------------------

Pro plan                                      [ Manage plan ]
Cancels May 8, 2026
$30/month in hosted credits.

------------------------------------------------------------
Payment
...

------------------------------------------------------------
Invoices
...
```

No Cancellation section is shown once Stripe reports a pending cancellation.

The cancellation line should be the first line of the subheader under the plan heading, using the same `text-sm text-muted-foreground` styling as the current subtitle. Do not make it a badge, alert, or new card.

## Implementation Plan

### 1. Extend Stripe subscription summary data

In [src/lib/billing.server.ts](../src/lib/billing.server.ts):

Extend `StripeSubscription`:

```ts
cancel_at?: number | null;
canceled_at?: number | null;
```

Extend `StripeSubscriptionSummary`:

```ts
cancel_at_ms: number | null;
cancellation_date_ms: number | null;
is_canceling: boolean;
```

Add small helpers near the Stripe subscription functions:

```ts
function getSubscriptionCancellationDateMs(
  subscription: StripeSubscription,
): number | null {
  const seconds =
    subscription.cancel_at ??
    (subscription.cancel_at_period_end
      ? subscription.current_period_end ?? subscription.trial_end ?? null
      : null);
  return seconds ? seconds * 1000 : null;
}

function isSubscriptionCanceling(subscription: StripeSubscription): boolean {
  return (
    subscription.cancel_at_period_end === true ||
    Boolean(subscription.cancel_at) ||
    subscription.status === "canceled"
  );
}
```

Update `getStripeSubscriptionSummary()` to populate the new fields. For the UI, `cancellation_date_ms` should be the single field to display.

### 2. Add a cancellation-specific portal helper

Do not keep using generic `createBillingPortalSession()` for the cancellation flow. Add a dedicated helper, for example:

```ts
export type StripeCancellationPortalResult =
  | {
      kind: "portal";
      billingPortalUrl: string;
    }
  | {
      kind: "already_scheduled";
      cancellationDateMs: number | null;
      subscriptionStatus: string;
    };

export async function createSubscriptionCancellationPortalSession(args: {
  env: StripeBillingEnv;
  org: Organization;
  customerEmail: string | null | undefined;
  returnUrl: string;
  afterCompletionReturnUrl?: string;
}): Promise<StripeCancellationPortalResult> {
  ...
}
```

Behavior:

1. Load latest org with `getLatestOrgInfo()`.
2. Require `billing_subscription_id`.
3. Fetch the Stripe subscription before creating a portal session.
4. If `isSubscriptionCanceling(subscription)` is already true:
   - call `syncOrgSubscriptionFromStripe(env, subscription).catch(...)`;
   - return `{ kind: "already_scheduled", cancellationDateMs, subscriptionStatus }`;
   - do not create a Billing Portal session.
5. Get the customer from `subscription.customer`.
   - If it is a string, use it directly.
   - If expanded, use `subscription.customer.id`.
   - If missing, throw a clear error.
6. Best-effort sync `billing_customer_id` onto the org if local state differs.
7. Create the Billing Portal session using that subscription-owned customer.
8. If creating the portal session throws, fetch the subscription again. If the refreshed subscription is now canceling, treat it as success and return `already_scheduled`. Only rethrow if Stripe still does not show cancellation.

This is the critical regression guard: portal failure after successful cancellation becomes success, not an error.

Use `afterCompletionReturnUrl` for `flow_data[after_completion][redirect][return_url]`. Set it to `/settings/organization/billing?cancelled=1` from the route action. Keep the normal portal `return_url` as `/settings/organization/billing` so a user backing out of Stripe without completing cancellation does not get success treatment.

### 3. Route action changes

In [src/routes/_app.settings.organization.billing.tsx](../src/routes/_app.settings.organization.billing.tsx), import the new helper.

Change `case "cancelSubscription"` to call `createSubscriptionCancellationPortalSession()`:

```ts
const cancelledUrl = new URL(billingUrl.toString());
cancelledUrl.searchParams.set("cancelled", "1");

const result = await createSubscriptionCancellationPortalSession({
  env,
  org: billingOrg,
  customerEmail: authContext.user.email,
  returnUrl: billingUrl.toString(),
  afterCompletionReturnUrl: cancelledUrl.toString(),
});

if (result.kind === "already_scheduled") {
  return {
    cancellationScheduled: true,
    cancellationDateMs: result.cancellationDateMs,
    subscriptionStatus: result.subscriptionStatus,
  };
}

return { billingPortalUrl: result.billingPortalUrl };
```

Keep the existing user-facing error only for the real failure case, after the helper has already rechecked Stripe:

```ts
return {
  error: "We couldn't open your cancellation flow. Please try again in a moment.",
};
```

### 4. Dialog behavior changes

In [src/components/billing/cancel-plan-dialog.tsx](../src/components/billing/cancel-plan-dialog.tsx):

Update the fetcher data type:

```ts
{
  billingPortalUrl?: string;
  cancellationScheduled?: boolean;
  cancellationDateMs?: number | null;
  error?: string;
}
```

On `billingPortalUrl`, keep `window.location.assign()` as today.

On `cancellationScheduled`, do not render an error. Close the dialog, revalidate the Billing loader, and show a success toast:

```ts
toast.success(
  cancellationDateMs
    ? `Plan cancels ${dateFormatter.format(new Date(cancellationDateMs))}.`
    : "Plan cancellation is scheduled.",
);
```

Add a local `dateFormatter` matching the billing route, or export/reuse a shared date formatter if the implementer prefers. Use `useRevalidator()` from React Router. This avoids a full reload and lets the persistent plan summary update immediately.

Only render `fetcher.data.error` when `!fetcher.data.cancellationScheduled`.

### 5. Billing page summary UI changes

In [src/routes/_app.settings.organization.billing.tsx](../src/routes/_app.settings.organization.billing.tsx):

Replace `planSummarySubtitle` with line-oriented data:

```ts
const renewalLabel = subscription?.current_period_end_ms
  ? dateFormatter.format(new Date(subscription.current_period_end_ms))
  : null;
const cancellationLabel = subscription?.cancellation_date_ms
  ? dateFormatter.format(new Date(subscription.cancellation_date_ms))
  : null;
const isCanceling = subscription?.is_canceling ?? false;

const planSummaryLines = isEnterprise
  ? [planSubtitle("enterprise")]
  : [
      isCanceling && cancellationLabel ? `Cancels ${cancellationLabel}` : null,
      planSubtitle(plan),
      !isCanceling && hasActiveSubscription && renewalLabel
        ? `Renews ${renewalLabel}.`
        : null,
    ].filter(Boolean);
```

Render as separate lines using existing styling:

```tsx
<div className="space-y-0.5 text-sm text-muted-foreground">
  {planSummaryLines.map((line) => (
    <p key={line}>{line}</p>
  ))}
</div>
```

Update `cancelAtPeriodEnd` to use the new semantic field:

```ts
const cancelAtPeriodEnd = subscription?.is_canceling ?? false;
```

The Cancellation section remains gated on:

```tsx
{hasActiveSubscription && !cancelAtPeriodEnd ? ... : null}
```

Handle `?cancelled=1` with a small `useEffect`:

- If `subscription?.is_canceling` is true, show the same success toast.
- Clean the URL with `window.history.replaceState`.
- Do not show a toast if Stripe does not report cancellation; this avoids false success if the user backed out.
- The toast is secondary. The persistent `Cancels <date>` line is the durable success signal.

### 6. Pending trial cancellation status

Audit `mapStripeSubscriptionBillingStatus()` in [src/lib/billing.server.ts](../src/lib/billing.server.ts). It currently maps `status === "trialing" && cancel_at_period_end === true` to local `"canceled"`, which causes `syncOrgSubscriptionFromStripe()` to switch the org to Pay as you go immediately.

For this cancellation UI, pending cancellation should not be treated as terminal. Access should remain whatever Stripe says (`trialing` or `active`) until Stripe sends `customer.subscription.deleted` or the subscription status is actually `canceled`.

Recommended change:

```ts
function mapStripeSubscriptionBillingStatus(subscription: Pick<StripeSubscription, "status">): BillingStatus {
  return mapStripeSubscriptionStatus(subscription.status);
}
```

Keep terminal handling in `isTerminalStripeSubscriptionStatus(subscription.status)`, not in `cancel_at_period_end`.

Add a test so a trialing subscription with `cancel_at_period_end=true` remains `trialing` locally but has cancellation metadata in the summary.

## Regression Tests

### `tests/billing.test.ts`

Add helper-level tests:

1. `getStripeSubscriptionSummary()` returns:
   - `is_canceling: true`
   - `cancellation_date_ms` from `cancel_at` when present
   - fallback to `current_period_end` when `cancel_at_period_end=true`
2. `createSubscriptionCancellationPortalSession()` returns `already_scheduled` and does not call `/billing_portal/sessions` when the fetched subscription already has `cancel_at_period_end=true`.
3. Portal creation failure is converted to `already_scheduled` when a refresh fetch shows `cancel_at_period_end=true`.
4. Portal creation failure still throws when the refresh fetch does not show cancellation.
5. The cancellation portal session uses the Stripe subscription's customer id, not a newly-created customer from `ensureStripeCustomerForOrg()`.
6. `syncOrgSubscriptionFromStripe()` keeps active/trialing pending-cancel subscriptions non-terminal until actual Stripe status is `canceled`.

### `tests/billing-settings-route.test.ts`

Add route action tests:

1. Active subscription returns `{ billingPortalUrl }` as today.
2. Already scheduled subscription returns `{ cancellationScheduled: true, cancellationDateMs }` and no `error`.
3. Portal failure after a successful Stripe refresh returns `cancellationScheduled` and no `error`.
4. Real portal failure returns the existing error copy.

Mock the new helper rather than reproducing Stripe fetches in the route test.

### `tests/cancel-plan-dialog.test.tsx`

Keep the existing redirect test. Add:

1. When fetcher data has `cancellationScheduled: true`, the dialog calls `onOpenChange(false)`, revalidates, and does not render the error paragraph.
2. When fetcher data has both `cancellationScheduled: true` and an accidental `error`, success wins and the error is not rendered.
3. When fetcher data has only `error`, the error still renders.

### `tests/billing-settings-overview-ui.test.tsx`

Add UI tests for the page summary:

1. Pending cancellation renders `Cancels May 8, 2026` as its own line under `Pro plan`.
2. Pending cancellation still renders the plan subtitle on the next line.
3. Pending cancellation hides the Cancellation section.
4. Non-canceling active subscription renders `Renews ...` and still shows the Cancellation section.

## Manual QA

Run:

```bash
bun run typecheck
bun run test:run -- billing.test.ts billing-settings-route.test.ts cancel-plan-dialog.test.tsx billing-settings-overview-ui.test.tsx
```

Then verify in dev or staging with Stripe test mode:

1. Active Pro subscription:
   - Billing page shows `Renews ...`.
   - Cancellation section is visible.
   - Clicking Cancel opens Stripe's cancellation flow.
2. Complete the Stripe cancellation:
   - Redirects back to Billing.
   - Plan summary shows `Cancels <date>` as the first subheader line.
   - Cancellation section is gone.
   - No error appears.
3. Repeat-click or retry after cancellation:
   - The app treats the action as success.
   - No "couldn't open cancellation flow" error appears.
4. Force a real Stripe portal-session failure while the subscription is not canceling:
   - The existing error still appears.

## Non-Goals

- Do not replace the Stripe Billing Portal cancellation flow with a direct API cancellation unless product explicitly decides to skip Stripe's hosted cancellation/retention experience.
- Do not redesign the Billing page.
- Do not add a new card, badge, or alert for the cancellation date. The requested UI is a solo line in the existing plan subheader.
- Do not change terminal cancellation behavior for `customer.subscription.deleted`: final cancellation should still move the org to Pay as you go and clear the subscription id.
