import { Form, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/_app.settings.organization.billing";
import { requireAuthContext, requireOrgAdmin } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import {
  createBillingPortalSession,
  createCreditsCheckoutSession,
  createSubscriptionCheckoutSession,
  fetchConfiguredCreditPacks,
  fetchConfiguredSubscriptionPlans,
  getOrgBillingOverview,
  isStripeBillingConfigured,
} from "@/lib/billing.server";
import { BILLING_PLAN_LIMITS, isBillingPlan } from "@/lib/billing-plans";
import type { BillingPlan } from "@/types";
import {
  billingStatusBadgeVariant,
  billingStatusLabel,
  formatCreditBalance,
  getBillingStatusDescription,
} from "@/lib/billing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SettingsHeader } from "@/components/settings/settings-header";

function formatTimestamp(value: number | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toLocaleString();
}

function formatPriceLabel(
  price: {
    unit_amount: number | null;
    currency: string;
    recurring?: { interval: string; interval_count?: number } | null;
  } | null,
): string | null {
  if (!price?.unit_amount) return null;

  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: price.currency.toUpperCase(),
  }).format(price.unit_amount / 100);

  if (!price.recurring) {
    return amount;
  }

  const intervalCount = price.recurring.interval_count ?? 1;
  const intervalLabel =
    intervalCount === 1
      ? price.recurring.interval
      : `${intervalCount} ${price.recurring.interval}s`;
  return `${amount}/${intervalLabel}`;
}

function formatCreditPackLabel(price: {
  unit_amount: number | null;
  currency: string;
}): string | null {
  if (!price.unit_amount) return null;
  return `${(price.unit_amount / 100).toFixed(2)} credits`;
}

export function meta() {
  return [
    { title: "Billing - Settings - camelAI" },
    {
      name: "description",
      content: "Manage billing, subscription status, and usage credits.",
    },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);

  const [overview, subscriptionPlans, creditPacks] = await Promise.all([
    getOrgBillingOverview(env, authContext.currentOrg),
    fetchConfiguredSubscriptionPlans(env),
    fetchConfiguredCreditPacks(env),
  ]);

  return {
    org: authContext.currentOrg,
    overview,
    stripeConfigured: isStripeBillingConfigured(env),
    subscriptionPlans: subscriptionPlans.map((plan) => ({
      plan: plan.plan,
      label: plan.limits.label,
      priceLabel: formatPriceLabel(plan.price),
      includedCreditsLabel: formatCreditBalance(
        plan.limits.includedCreditCentsBase ||
          plan.limits.includedCreditCentsPerSeat,
      ),
      minimumSeats: plan.limits.minimumSeats,
      emailInbox: plan.limits.emailInbox,
    })),
    creditPacks: creditPacks.map((pack) => ({
      id: pack.id,
      priceLabel: formatPriceLabel(pack),
      creditsLabel: formatCreditPackLabel(pack),
    })),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  const billingUrl = new URL("/settings/organization/billing", request.url);
  const successUrl = new URL(
    "/settings/organization/billing?checkout=success",
    request.url,
  ).toString();
  const cancelUrl = new URL(
    "/settings/organization/billing?checkout=cancelled",
    request.url,
  ).toString();

  switch (intent) {
    case "startSubscription": {
      const rawPlan = String(formData.get("plan") || "starter");
      const plan: BillingPlan = isBillingPlan(rawPlan) ? rawPlan : "starter";
      const orgStub = env.ORG.get(
        env.ORG.idFromName(authContext.currentOrg.id),
      );
      const memberCount = await orgStub.getMemberCount();
      const seatCount =
        plan === "team"
          ? Math.max(BILLING_PLAN_LIMITS.team.minimumSeats, memberCount)
          : 1;
      const url = await createSubscriptionCheckoutSession({
        env,
        org: authContext.currentOrg,
        customerEmail: authContext.user.email,
        successUrl,
        cancelUrl,
        plan,
        seatCount,
      });
      throw redirect(url);
    }
    case "buyCredits": {
      const selectedPriceId = String(formData.get("priceId") || "");
      const url = await createCreditsCheckoutSession({
        env,
        org: authContext.currentOrg,
        customerEmail: authContext.user.email,
        successUrl,
        cancelUrl,
        priceId: selectedPriceId,
      });
      throw redirect(url);
    }
    case "manageBilling": {
      const url = await createBillingPortalSession({
        env,
        org: authContext.currentOrg,
        customerEmail: authContext.user.email,
        returnUrl: billingUrl.toString(),
      });
      throw redirect(url);
    }
    default:
      return { error: "Unknown billing action" };
  }
}

export default function BillingPage() {
  const { org, overview, stripeConfigured, subscriptionPlans, creditPacks } =
    useLoaderData<typeof loader>();

  const trialEndsLabel = formatTimestamp(overview.billing_trial_ends_at);
  const isEnterprise = org.billing_status === "enterprise";

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Billing"
        description="Start your subscription, buy credits, and manage payment details."
      />
      <Separator />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Subscription</CardDescription>
            <CardTitle className="flex items-center gap-3 text-xl">
              <span>{billingStatusLabel(org.billing_status)}</span>
              <Badge variant={billingStatusBadgeVariant(org.billing_status)}>
                {billingStatusLabel(org.billing_status)}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {getBillingStatusDescription(org)}
            </p>
            {trialEndsLabel ? (
              <p className="text-sm text-muted-foreground">
                Trial ends {trialEndsLabel}.
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              Plan: {BILLING_PLAN_LIMITS[overview.billing_plan].label}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Available Credits</CardDescription>
            <CardTitle className="text-xl">
              {formatCreditBalance(overview.available_credits_cents)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Purchased:{" "}
              {formatCreditBalance(
                overview.billing_credit_purchase_total_cents,
              )}
            </p>
            <p>
              Included:{" "}
              {formatCreditBalance(overview.billing_credit_grant_total_cents)}
            </p>
            <p>
              Billable usage:{" "}
              {formatCreditBalance(overview.chargeable_usage_cents)}
            </p>
            {creditPacks.length > 0 ? (
              <p>{creditPacks.length} credit pack options available.</p>
            ) : null}
            <p>
              Subscription grant:{" "}
              {formatCreditBalance(overview.subscription_included_credit_cents)}
              /billing period.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Lifetime Usage</CardDescription>
            <CardTitle className="text-xl">
              {formatCreditBalance(overview.lifetime_spend_cents)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Chargeable requests:{" "}
              {overview.chargeable_request_count.toLocaleString()}
            </p>
            <p>
              {isEnterprise
                ? "Enterprise access bypasses Stripe subscription and credit deductions."
                : `Trial includes ${formatCreditBalance(
                    overview.trial_credit_allowance_cents,
                  )} in hosted LLM credits.`}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Plans</CardTitle>
          <CardDescription>
            {isEnterprise
              ? "This organization is billed outside Stripe."
              : `Use Free with your own API key, or start a paid plan for capped hosted LLM credits.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          {isEnterprise ? (
            <p className="text-sm text-muted-foreground">
              Hosted usage is enabled without a Stripe subscription or credit
              balance for this organization.
            </p>
          ) : (
            <>
              {subscriptionPlans.map((plan) => (
                <Form
                  method="post"
                  key={plan.plan}
                  className="rounded-lg border p-4"
                >
                  <input
                    type="hidden"
                    name="intent"
                    value="startSubscription"
                  />
                  <input type="hidden" name="plan" value={plan.plan} />
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{plan.label}</p>
                    <p className="text-sm text-muted-foreground">
                      {plan.priceLabel ?? "Not configured"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {plan.plan === "team"
                        ? `${plan.includedCreditsLabel}/seat in hosted credits`
                        : `${plan.includedCreditsLabel}/month in hosted credits`}
                    </p>
                    {plan.minimumSeats > 1 ? (
                      <p className="text-sm text-muted-foreground">
                        {plan.minimumSeats} seat minimum.
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="submit"
                    disabled={!stripeConfigured}
                    className="mt-4 w-full"
                  >
                    Start {plan.label}
                  </Button>
                </Form>
              ))}
            </>
          )}
        </CardContent>
      </Card>

      {!isEnterprise ? (
        <Form method="post">
          <input type="hidden" name="intent" value="manageBilling" />
          <Button type="submit" variant="outline" disabled={!stripeConfigured}>
            Open Billing Portal
          </Button>
        </Form>
      ) : null}

      {!isEnterprise ? (
        <Card>
          <CardHeader>
            <CardTitle>Buy Credits</CardTitle>
            <CardDescription>
              Choose how many credits to add. Credits are consumed by chargeable
              hosted model usage once included credits are used.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            {creditPacks.map((pack) => (
              <Form
                method="post"
                key={pack.id}
                className="rounded-lg border p-4"
              >
                <input type="hidden" name="intent" value="buyCredits" />
                <input type="hidden" name="priceId" value={pack.id} />
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {pack.creditsLabel ?? "Credits"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {pack.priceLabel ?? pack.id}
                  </p>
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={!stripeConfigured}
                  className="mt-4 w-full"
                >
                  Buy {pack.creditsLabel ?? "Credits"}
                </Button>
              </Form>
            ))}
            {creditPacks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No credit packs are configured.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {!stripeConfigured ? (
        <p className="text-sm text-muted-foreground">
          Stripe billing is not configured yet. Set `STRIPE_SECRET_KEY`,
          subscription price IDs, `STRIPE_CREDIT_PRICE_IDS`, and
          `STRIPE_WEBHOOK_SECRET` before using these actions.
        </p>
      ) : null}
    </div>
  );
}
