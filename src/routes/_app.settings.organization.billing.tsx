import { useState } from "react";
import {
  Form,
  redirect,
  useFetcher,
  useLoaderData,
} from "react-router";
import { ArrowLeft, CreditCard } from "lucide-react";
import type { Route } from "./+types/_app.settings.organization.billing";
import { requireAuthContext, requireOrgAdmin } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import {
  createBillingPortalSession,
  getOrgBillingOverview,
  getStripeDefaultPaymentMethodSummary,
  getStripeSubscriptionSummary,
  isStripeBillingConfigured,
  listStripeInvoicesForOrg,
} from "@/lib/billing.server";
import { BILLING_PLAN_LIMITS, normalizeBillingPlan } from "@/lib/billing-plans";
import type { BillingPlan } from "@/types";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SettingsHeader } from "@/components/settings/settings-header";
import { PlanPicker, type PlanPickerCta } from "@/components/billing/plan-picker";
import {
  InvoicesTable,
  type InvoiceRow,
} from "@/components/billing/invoices-table";
import { CancelPlanDialog } from "@/components/billing/cancel-plan-dialog";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
});

function planSubtitle(plan: BillingPlan): string {
  switch (plan) {
    case "free":
      return "Bring your own API key. No included credits.";
    case "starter":
      return "$10/month in hosted credits.";
    case "pro":
      return "$30/month in hosted credits.";
    case "team":
      return "$10/seat/month in hosted credits.";
    case "enterprise":
      return "Custom enterprise plan billed outside Stripe.";
  }
}

export function meta() {
  return [
    { title: "Billing - Settings - camelAI" },
    {
      name: "description",
      content: "Manage your plan, payment method, and invoices.",
    },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);

  const stripeConfigured = isStripeBillingConfigured(env);

  const [overview, paymentMethod, invoices, subscription] = await Promise.all([
    getOrgBillingOverview(env, authContext.currentOrg),
    stripeConfigured
      ? getStripeDefaultPaymentMethodSummary(env, authContext.currentOrg).catch(
          () => null,
        )
      : Promise.resolve(null),
    stripeConfigured
      ? listStripeInvoicesForOrg(env, authContext.currentOrg).catch(() => [])
      : Promise.resolve([]),
    stripeConfigured
      ? getStripeSubscriptionSummary(env, authContext.currentOrg).catch(
          () => null,
        )
      : Promise.resolve(null),
  ]);

  const invoiceRows: InvoiceRow[] = invoices.map((invoice) => ({
    id: invoice.id,
    createdAtMs: (invoice.created ?? 0) * 1000,
    amountPaidCents: invoice.amount_paid ?? 0,
    currency: invoice.currency ?? "usd",
    status: invoice.status ?? "",
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
  }));

  return {
    org: authContext.currentOrg,
    overview,
    stripeConfigured,
    paymentMethod,
    invoices: invoiceRows,
    subscription,
  };
}

// FIXME(billing-stripe): Plan upgrades, downgrades, and cancellations are not
// wired to Stripe yet. Today this route:
//   - Disables the per-card CTA in <PlanPicker> when stripeConfigured is false
//     (see ManagePlanView's `disabledReason`).
//   - Stubs `changePlan` and `cancelSubscription` to redirect-only (below).
//
// To complete the wiring, the next engineer needs to:
//   1. Implement createSubscriptionCheckoutSession() / upgradeSubscription() /
//      downgradeSubscription() helpers in src/lib/billing.server.ts and call
//      them from the `changePlan` case.
//   2. Implement cancelStripeSubscription() (cancel at period end) and call it
//      from the `cancelSubscription` case.
//   3. Once those helpers exist, remove the `disabledReason` argument from
//      <ManagePlanView>'s <PlanPicker> render so the card CTAs are enabled
//      whenever stripeConfigured is true (or remove the gate entirely if the
//      Stripe wiring is mandatory).
//   4. Verify webhook handling in `/api/billing/stripe/webhook` updates
//      org.billing_plan / billing_status correctly after each transition.
export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  const billingUrl = new URL("/settings/organization/billing", request.url);

  switch (intent) {
    case "manageBilling": {
      const url = await createBillingPortalSession({
        env,
        org: authContext.currentOrg,
        customerEmail: authContext.user.email,
        returnUrl: billingUrl.toString(),
      });
      throw redirect(url);
    }
    case "changePlan": {
      // FIXME(billing-stripe): see top-of-file FIXME block. Currently a no-op
      // redirect — implement the actual Stripe subscription transition here.
      throw redirect(billingUrl.toString());
    }
    case "cancelSubscription": {
      // FIXME(billing-stripe): see top-of-file FIXME block. Currently a no-op
      // redirect — implement Stripe cancel-at-period-end here.
      throw redirect(billingUrl.toString());
    }
    default:
      return { error: "Unknown billing action" };
  }
}

type View = "overview" | "manage";

export default function BillingPage() {
  const {
    org,
    overview,
    stripeConfigured,
    paymentMethod,
    invoices,
    subscription,
  } = useLoaderData<typeof loader>();

  const [view, setView] = useState<View>("overview");
  const [cancelOpen, setCancelOpen] = useState(false);

  const isEnterprise = org.billing_status === "enterprise";
  const plan: BillingPlan = normalizeBillingPlan(
    overview.billing_plan,
    overview.billing_status,
  );
  const planLimits = BILLING_PLAN_LIMITS[plan];

  const subscriptionStatus = overview.billing_subscription_status;
  const hasActiveSubscription =
    !isEnterprise &&
    (subscriptionStatus === "active" ||
      subscriptionStatus === "trialing" ||
      subscriptionStatus === "past_due");

  const renewalLabel = subscription?.current_period_end_ms
    ? dateFormatter.format(new Date(subscription.current_period_end_ms))
    : null;
  const cancelAtPeriodEnd = subscription?.cancel_at_period_end ?? false;

  const planSummarySubtitle = (() => {
    if (isEnterprise) {
      return planSubtitle("enterprise");
    }
    const baseline = planSubtitle(plan);
    if (cancelAtPeriodEnd && renewalLabel) {
      return `${baseline} Cancels on ${renewalLabel}.`;
    }
    if (hasActiveSubscription && renewalLabel) {
      return `${baseline} Renews ${renewalLabel}.`;
    }
    return baseline;
  })();

  if (view === "manage") {
    return (
      <ManagePlanView
        currentPlan={plan}
        stripeConfigured={stripeConfigured}
        onBack={() => setView("overview")}
      />
    );
  }

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Billing"
        description="Manage your plan, payment method, and invoices."
      />
      <Separator />

      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">{planLimits.label} plan</h2>
            <p className="text-sm text-muted-foreground">
              {planSummarySubtitle}
            </p>
          </div>
          {isEnterprise ? null : (
            <Button variant="outline" onClick={() => setView("manage")}>
              {plan === "free" ? "Choose a plan" : "Manage plan"}
            </Button>
          )}
        </div>
      </section>

      {!isEnterprise ? (
        <>
          <Separator />
          <section className="space-y-3">
            <h2 className="text-base font-semibold">Payment</h2>
            {paymentMethod ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3 text-sm">
                  <CreditCard
                    className="size-5 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span>
                    <span className="capitalize">{paymentMethod.brand}</span>{" "}
                    ending in {paymentMethod.last4}
                  </span>
                </div>
                <Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="manageBilling"
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={!stripeConfigured}
                  >
                    Update
                  </Button>
                </Form>
              </div>
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted-foreground">
                  No payment method on file.
                </p>
                {stripeConfigured && hasActiveSubscription ? (
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="manageBilling"
                    />
                    <Button type="submit" variant="outline">
                      Add payment method
                    </Button>
                  </Form>
                ) : null}
              </div>
            )}
          </section>

          <Separator />
          <section className="space-y-3">
            <h2 className="text-base font-semibold">Invoices</h2>
            <InvoicesTable invoices={invoices} />
          </section>

          {hasActiveSubscription && !cancelAtPeriodEnd ? (
            <>
              <Separator />
              <section className="space-y-3">
                <h2 className="text-base font-semibold">Cancellation</h2>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <p className="text-sm">Cancel plan</p>
                    <p className="text-xs text-muted-foreground">
                      Your plan stays active until the end of the current
                      billing period.
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    onClick={() => setCancelOpen(true)}
                  >
                    Cancel
                  </Button>
                </div>
              </section>
            </>
          ) : null}
        </>
      ) : null}

      <CancelPlanDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        planLabel={planLimits.label}
        periodEndLabel={renewalLabel}
      />
    </div>
  );
}

function ManagePlanView({
  currentPlan,
  stripeConfigured,
  onBack,
}: {
  currentPlan: BillingPlan;
  stripeConfigured: boolean;
  onBack: () => void;
}) {
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";
  const pendingPlan = isSubmitting
    ? ((fetcher.formData?.get("plan") as BillingPlan | null) ?? null)
    : null;

  function handleSelectPlan(cta: PlanPickerCta) {
    if (cta.kind === "contact") {
      window.open("mailto:sales@camelai.com", "_blank");
      return;
    }
    if (cta.kind === "byok") {
      fetcher.submit(
        { intent: "changePlan", plan: "free" },
        { method: "post" },
      );
      return;
    }
    fetcher.submit(
      { intent: "changePlan", plan: cta.plan },
      { method: "post" },
    );
  }

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to billing
      </button>

      <PlanPicker
        currentPlan={currentPlan}
        onSelectPlan={handleSelectPlan}
        pendingPlan={pendingPlan}
        // FIXME(billing-stripe): `disabledReason` disables every paid-plan CTA when
        // Stripe isn't configured locally. Once Stripe wiring is complete, either:
        //   - keep this as-is (Stripe is required to upgrade), or
        //   - drop the `disabledReason` prop entirely and rely on the action handler
        //     to surface configuration errors via the fetcher's `data.error` channel.
        disabledReason={
          stripeConfigured ? null : "Stripe billing is not configured."
        }
      />
    </div>
  );
}

