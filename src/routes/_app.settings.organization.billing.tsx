import { useEffect, useRef, useState } from "react";
import {
  Form,
  redirect,
  useFetcher,
  useLoaderData,
  useSearchParams,
} from "react-router";
import { ArrowLeft, CreditCard } from "lucide-react";
import { toast } from "sonner";
import type { Route } from "./+types/_app.settings.organization.billing";
import { requireAuthContext, requireOrgAdmin } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import {
  activatePayAsYouGoPlan,
  createBillingPortalSession,
  createLegacyStripeMigrationPortalSession,
  createSubscriptionCancellationPortalSession,
  createSubscriptionUpdatePortalSession,
  createSubscriptionCheckoutSession,
  getBillableTeamSeatCountForOrg,
  getOrgBillingOverview,
  getLegacyStripeMigrationEligibility,
  getVerifiedLegacyStripeMigrationEligibility,
  getStripeDefaultPaymentMethodSummary,
  getStripeSubscriptionSummary,
  isStaleTrialingSubscriptionStatusError,
  isStripeBillingConfigured,
  listStripeInvoicesForOrg,
  updateTrialingStripeSubscriptionPlan,
} from "@/lib/billing.server";
import {
  BILLING_PLAN_LIMITS,
  getMinimumSeats,
  isBillingPlan,
  normalizeBillingPlan,
  normalizeSeatCount,
} from "@/lib/billing-plans";
import { getByokProviderLabel } from "@/lib/byok-providers";
import { getEffectiveLlmProviderConfig } from "@/lib/selfhost-ai-provider";
import { isSelfhostRuntime } from "@/lib/selfhost-runtime";
import type { BillingPlan, Organization } from "@/types";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SettingsHeader } from "@/components/settings/settings-header";
import {
  PlanPicker,
  type PlanPickerCta,
} from "@/components/billing/plan-picker";
import type { LegacyMigrationDialogData } from "@/components/billing/legacy-migration-dialog";
import {
  LegacyMigrationConfirmDialog,
  type LegacyMigrationConfirmation,
} from "@/components/billing/legacy-migration-confirm-dialog";
import {
  InvoicesTable,
  type InvoiceRow,
} from "@/components/billing/invoices-table";
import { CancelPlanDialog } from "@/components/billing/cancel-plan-dialog";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
});

const EXISTING_STRIPE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
]);

const PORTAL_UPDATABLE_STRIPE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "past_due",
  "unpaid",
]);

const NON_RECOVERABLE_STRIPE_SUBSCRIPTION_STATUSES = new Set([
  "canceled",
  "incomplete_expired",
]);

function hasRecoverableStripeSubscription(
  org: Pick<
    Organization,
    "billing_subscription_id" | "billing_subscription_status" | "billing_status"
  >,
): boolean {
  if (!org.billing_subscription_id?.trim()) return false;
  const rawStatus = org.billing_subscription_status?.trim();
  if (
    rawStatus &&
    NON_RECOVERABLE_STRIPE_SUBSCRIPTION_STATUSES.has(rawStatus)
  ) {
    return false;
  }
  return (
    EXISTING_STRIPE_SUBSCRIPTION_STATUSES.has(rawStatus ?? "") ||
    EXISTING_STRIPE_SUBSCRIPTION_STATUSES.has(org.billing_status)
  );
}

function canUpdateStripeSubscriptionInPortal(
  org: Pick<Organization, "billing_subscription_status" | "billing_status">,
): boolean {
  const rawStatus = org.billing_subscription_status?.trim();
  if (rawStatus) {
    return canUpdateStripeSubscriptionStatusInPortal(rawStatus);
  }
  return canUpdateStripeSubscriptionStatusInPortal(org.billing_status);
}

function canUpdateStripeSubscriptionStatusInPortal(
  status: string | null | undefined,
): boolean {
  return PORTAL_UPDATABLE_STRIPE_SUBSCRIPTION_STATUSES.has(status ?? "");
}

function canRecoverStripeSubscriptionStatusInPortal(
  status: string | null | undefined,
): boolean {
  return status === "paused" || status === "incomplete";
}

function isTrialingStripeSubscription(
  org: Pick<Organization, "billing_subscription_status" | "billing_status">,
): boolean {
  const rawStatus = org.billing_subscription_status?.trim();
  return rawStatus
    ? rawStatus === "trialing"
    : org.billing_status === "trialing";
}

function planSubtitle(plan: BillingPlan): string {
  switch (plan) {
    case "free":
      return "Bring your own API key. No included credits.";
    case "payg":
      return "No subscription. Buy credits before hosted usage.";
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
  if (isSelfhostRuntime(env)) {
    throw redirect("/settings/organization/usage");
  }

  const stripeConfigured = isStripeBillingConfigured(env);

  const [overview, paymentMethod, invoices, subscription] = await Promise.all([
    getOrgBillingOverview(env, authContext.currentOrg),
    stripeConfigured
      ? getStripeDefaultPaymentMethodSummary(
          env,
          authContext.currentOrg,
        ).catch(() => null)
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
  const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
    env,
    authContext.currentOrgLlmProviderConfig,
  );

  const invoiceRows: InvoiceRow[] = invoices.map((invoice) => ({
    id: invoice.id,
    createdAtMs: (invoice.created ?? 0) * 1000,
    totalCents: invoice.total ?? invoice.amount_due ?? invoice.amount_paid ?? 0,
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
    byokProviderLabel: getByokProviderLabel(effectiveLlmProviderConfig?.provider),
    legacyMigration: await getVerifiedLegacyStripeMigrationEligibility({
      env,
      org: authContext.currentOrg,
      userEmail: authContext.user.email,
    }),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  if (isSelfhostRuntime(env)) {
    return { error: "Billing is disabled in self-host mode." };
  }
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const orgStub = env.ORG.get(env.ORG.idFromName(authContext.currentOrg.id));
  const billingOrg =
    (await orgStub.getInfo().catch(() => null)) ?? authContext.currentOrg;

  const billingUrl = new URL("/settings/organization/billing", request.url);

  switch (intent) {
    case "manageBilling": {
      const url = await createBillingPortalSession({
        env,
        org: billingOrg,
        customerEmail: authContext.user.email,
        returnUrl: billingUrl.toString(),
      });
      throw redirect(url);
    }
    case "changePlan": {
      const rawPlan = String(formData.get("plan") || "").trim();
      if (!isBillingPlan(rawPlan)) {
        return { error: "Choose a valid billing plan." };
      }
      if (rawPlan === "enterprise") {
        return { error: "Contact sales to set up Enterprise." };
      }

      if (rawPlan === "payg") {
        if (hasRecoverableStripeSubscription(billingOrg)) {
          return {
            error:
              "Cancel the current subscription before switching to Pay as you go.",
          };
        }
        try {
          await activatePayAsYouGoPlan({
            env,
            org: billingOrg,
          });
          return {
            planChanged: true,
            redirectTo: "/settings/organization/usage?action=topup",
          };
        } catch (error) {
          console.error("[billing] failed to activate pay as you go", {
            orgId: billingOrg.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            error:
              error instanceof Error
                ? error.message
                : "We couldn't activate Pay as you go. Please try again in a moment.",
          };
        }
      }

      const legacyMigration = getLegacyStripeMigrationEligibility({
        env,
        org: billingOrg,
        userEmail: authContext.user.email,
      });
      if (legacyMigration?.eligible && rawPlan !== "free") {
        try {
          const seatCount =
            rawPlan === "team"
              ? await getBillableTeamSeatCountForOrg(
                  env,
                  authContext.currentOrg.id,
                )
              : getMinimumSeats(rawPlan);
          const migrationSession = await createLegacyStripeMigrationPortalSession({
            env,
            org: billingOrg,
            userEmail: authContext.user.email,
            returnUrl: billingUrl.toString(),
            plan: rawPlan,
            seatCount,
          });
          return {
            billingPortalUrl: migrationSession.billingPortalUrl,
            legacyMigrationPreview: migrationSession.preview,
          };
        } catch (error) {
          console.error("[billing] failed to migrate legacy subscription", {
            orgId: billingOrg.id,
            plan: rawPlan,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            error:
              error instanceof Error
                ? error.message
                : "We couldn't migrate your legacy subscription. Please try again in a moment.",
          };
        }
      }

      const hasActiveStripeSubscription =
        hasRecoverableStripeSubscription(billingOrg);

      if (hasActiveStripeSubscription) {
        if (rawPlan !== "free" && isTrialingStripeSubscription(billingOrg)) {
          try {
            const seatCount =
              rawPlan === "team"
                ? await getBillableTeamSeatCountForOrg(
                    env,
                    authContext.currentOrg.id,
                  )
                : getMinimumSeats(rawPlan);
            await updateTrialingStripeSubscriptionPlan({
              env,
              org: billingOrg,
              plan: rawPlan,
              seatCount,
            });
            return { planChanged: true };
          } catch (error) {
            if (
              isStaleTrialingSubscriptionStatusError(error) &&
              canUpdateStripeSubscriptionStatusInPortal(
                error.stripeSubscriptionStatus,
              )
            ) {
              try {
                const seatCount =
                  rawPlan === "team"
                    ? await getBillableTeamSeatCountForOrg(
                        env,
                        authContext.currentOrg.id,
                      )
                    : getMinimumSeats(rawPlan);
                const url = await createSubscriptionUpdatePortalSession({
                  env,
                  org: billingOrg,
                  customerEmail: authContext.user.email,
                  returnUrl: billingUrl.toString(),
                  plan: rawPlan,
                  seatCount,
                });
                return { billingPortalUrl: url };
              } catch (portalError) {
                console.error(
                  "[billing] failed to create Stripe portal session after stale trial status",
                  {
                    orgId: billingOrg.id,
                    plan: rawPlan,
                    stripeStatus: error.stripeSubscriptionStatus,
                    error:
                      portalError instanceof Error
                        ? portalError.message
                        : String(portalError),
                  },
                );
              }
            }

            if (
              isStaleTrialingSubscriptionStatusError(error) &&
              canRecoverStripeSubscriptionStatusInPortal(
                error.stripeSubscriptionStatus,
              )
            ) {
              try {
                const url = await createBillingPortalSession({
                  env,
                  org: billingOrg,
                  customerEmail: authContext.user.email,
                  returnUrl: billingUrl.toString(),
                });
                return { billingPortalUrl: url };
              } catch (portalError) {
                console.error(
                  "[billing] failed to create Stripe recovery portal session after stale trial status",
                  {
                    orgId: billingOrg.id,
                    plan: rawPlan,
                    stripeStatus: error.stripeSubscriptionStatus,
                    error:
                      portalError instanceof Error
                        ? portalError.message
                        : String(portalError),
                  },
                );
              }
            }

            console.error(
              "[billing] failed to update trialing Stripe subscription plan",
              {
                orgId: billingOrg.id,
                plan: rawPlan,
                error: error instanceof Error ? error.message : String(error),
              },
            );
            return {
              error:
                "We couldn't change your subscription plan. Please try again in a moment.",
            };
          }
        }

        if (
          rawPlan !== "free" &&
          canUpdateStripeSubscriptionInPortal(billingOrg)
        ) {
          try {
            const seatCount =
              rawPlan === "team"
                ? await getBillableTeamSeatCountForOrg(
                    env,
                    authContext.currentOrg.id,
                  )
                : getMinimumSeats(rawPlan);
            const url = await createSubscriptionUpdatePortalSession({
              env,
              org: billingOrg,
              customerEmail: authContext.user.email,
              returnUrl: billingUrl.toString(),
              plan: rawPlan,
              seatCount,
            });
            return { billingPortalUrl: url };
          } catch (error) {
            console.error(
              "[billing] failed to create Stripe subscription update portal session",
              {
                orgId: billingOrg.id,
                plan: rawPlan,
                error: error instanceof Error ? error.message : String(error),
              },
            );
            return {
              error:
                "We couldn't change your plan. Please try again in a moment.",
            };
          }
        }

        try {
          const url = await createBillingPortalSession({
            env,
            org: billingOrg,
            customerEmail: authContext.user.email,
            returnUrl: billingUrl.toString(),
          });
          return { billingPortalUrl: url };
        } catch (error) {
          console.error("[billing] failed to create billing portal session", {
            orgId: billingOrg.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            error:
              "We couldn't open your billing portal. Please try again in a moment.",
          };
        }
      }

      if (rawPlan === "free") {
        const currentPlan = normalizeBillingPlan(
          billingOrg.billing_plan,
          billingOrg.billing_status,
        );
        if (currentPlan !== "payg" || billingOrg.billing_subscription_id) {
          await orgStub.updateBillingState({
            billing_status: "inactive",
            billing_plan: "payg",
            billing_seat_count: 1,
            billing_subscription_id: null,
            billing_subscription_status: null,
          });
          return { planChanged: true };
        }
        return { error: "You are already on Pay as you go." };
      }

      try {
        const seatCount =
          rawPlan === "team"
            ? await getBillableTeamSeatCountForOrg(
                env,
                authContext.currentOrg.id,
              )
            : 1;
        const checkoutUrl = await createSubscriptionCheckoutSession({
          env,
          org: billingOrg,
          customerEmail: authContext.user.email,
          successUrl: billingUrl.toString(),
          cancelUrl: billingUrl.toString(),
          plan: rawPlan,
          seatCount,
        });
        return { checkoutUrl };
      } catch (error) {
        console.error("[billing] failed to create subscription checkout", {
          orgId: billingOrg.id,
          plan: rawPlan,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          error:
            "We couldn't start checkout for that plan. Please try again in a moment.",
        };
      }
    }
    case "cancelSubscription": {
      if (!billingOrg.billing_subscription_id?.trim()) {
        return {
          error:
            "We couldn't find an active Stripe subscription for this organization.",
        };
      }
      try {
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
      } catch (error) {
        console.error(
          "[billing] failed to create cancellation portal session",
          {
            orgId: billingOrg.id,
            subscriptionId: billingOrg.billing_subscription_id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return {
          error:
            "We couldn't open your cancellation flow. Please try again in a moment.",
        };
      }
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
    byokProviderLabel,
    legacyMigration,
  } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const showPlansView = searchParams.get("view") === "plans";

  const [view, setView] = useState<View>(() =>
    showPlansView ? "manage" : "overview",
  );
  const [cancelOpen, setCancelOpen] = useState(false);
  const cancelledToastShownRef = useRef(false);

  const isEnterprise = overview.billing_status === "enterprise";
  const plan: BillingPlan = normalizeBillingPlan(
    overview.billing_plan,
    overview.billing_status,
  );
  const planLimits = BILLING_PLAN_LIMITS[plan];
  const planHeading =
    plan === "team"
      ? `${planLimits.label} plan - ${normalizeSeatCount(
          "team",
          overview.billing_seat_count,
        ).toLocaleString()} seats`
      : `${planLimits.label} plan`;

  const subscriptionStatus = overview.billing_subscription_status;
  const hasActiveSubscription =
    !isEnterprise &&
    (subscriptionStatus === "active" ||
      subscriptionStatus === "trialing" ||
      subscriptionStatus === "past_due");

  const renewalLabel = subscription?.current_period_end_ms
    ? dateFormatter.format(new Date(subscription.current_period_end_ms))
    : null;
  const cancellationLabel = subscription?.cancellation_date_ms
    ? dateFormatter.format(new Date(subscription.cancellation_date_ms))
    : null;
  const isCanceling = subscription?.is_canceling ?? false;

  const planSummaryLines: string[] = isEnterprise
    ? [planSubtitle("enterprise")]
    : [
        isCanceling && cancellationLabel
          ? `Cancels ${cancellationLabel}`
          : null,
        planSubtitle(plan),
        !isCanceling && hasActiveSubscription && renewalLabel
          ? `Renews ${renewalLabel}.`
          : null,
      ].filter((line): line is string => Boolean(line));

  useEffect(() => {
    if (showPlansView) {
      setView("manage");
    }
  }, [showPlansView]);

  useEffect(() => {
    if (
      cancelledToastShownRef.current ||
      searchParams.get("cancelled") !== "1"
    ) {
      return;
    }
    cancelledToastShownRef.current = true;
    if (isCanceling) {
      toast.success(
        cancellationLabel
          ? `Plan cancels ${cancellationLabel}.`
          : "Plan cancellation is scheduled.",
      );
    }
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("cancelled");
    window.history.replaceState(
      window.history.state,
      "",
      `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`,
    );
  }, [cancellationLabel, isCanceling, searchParams]);

  if (view === "manage") {
    return (
      <ManagePlanView
        currentPlan={plan}
        stripeConfigured={stripeConfigured}
        byokProviderLabel={byokProviderLabel}
        legacyMigration={legacyMigration}
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
            <h2 className="text-lg font-semibold">{planHeading}</h2>
            <div className="space-y-0.5 text-sm text-muted-foreground">
              {planSummaryLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
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
                  <input type="hidden" name="intent" value="manageBilling" />
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
                    <input type="hidden" name="intent" value="manageBilling" />
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

          {hasActiveSubscription && !isCanceling ? (
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
  byokProviderLabel,
  legacyMigration,
  onBack,
}: {
  currentPlan: BillingPlan;
  stripeConfigured: boolean;
  byokProviderLabel: string | null;
  legacyMigration: LegacyMigrationDialogData | null;
  onBack: () => void;
}) {
  const fetcher = useFetcher<{
    checkoutUrl?: string;
    billingPortalUrl?: string;
    redirectTo?: string;
    legacyMigrationPreview?: LegacyMigrationConfirmation["preview"];
    planChanged?: boolean;
    success?: boolean;
    error?: string;
  }>();
  const [legacyConfirmation, setLegacyConfirmation] =
    useState<LegacyMigrationConfirmation | null>(null);
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
    if (cta.kind === "migrate") {
      fetcher.submit(
        { plan: cta.plan },
        {
          method: "post",
          action: "/api/billing/legacy-migration",
        },
      );
      return;
    }
    if (cta.kind === "payg") {
      fetcher.submit(
        { intent: "changePlan", plan: cta.plan },
        { method: "post" },
      );
      return;
    }
    fetcher.submit(
      { intent: "changePlan", plan: cta.plan },
      { method: "post" },
    );
  }

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const nextUrl =
      fetcher.data?.checkoutUrl ??
      fetcher.data?.billingPortalUrl ??
      fetcher.data?.redirectTo;
    if (
      fetcher.data?.billingPortalUrl &&
      Object.prototype.hasOwnProperty.call(
        fetcher.data,
        "legacyMigrationPreview",
      )
    ) {
      setLegacyConfirmation({
        billingPortalUrl: fetcher.data.billingPortalUrl,
        preview: fetcher.data.legacyMigrationPreview ?? null,
      });
      return;
    }
    if (nextUrl) {
      window.location.assign(nextUrl);
      return;
    }
    if (fetcher.data?.planChanged) {
      window.location.assign(
        fetcher.data.redirectTo ?? "/settings/organization/billing",
      );
      return;
    }
    if (fetcher.data?.success) {
      window.location.assign("/settings/organization/billing");
    }
  }, [fetcher.data, fetcher.state]);

  const legacyDisabledReason =
    legacyMigration?.eligible &&
    legacyMigration.activeLegacySubscriptionCount > 1
      ? "This account has multiple active subscriptions. Contact support@camelai.com to switch over without double billing."
      : null;

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
        byokProviderLabel={byokProviderLabel}
        legacyMigration={legacyMigration}
        heading={
          legacyMigration?.eligible
            ? {
                title: "Choose your plan",
                subtitle:
                  "Pick a paid plan to switch over from your existing subscription, or bring your own API key to keep using camelAI on the free tier.",
              }
            : undefined
        }
        disabledReason={
          legacyDisabledReason ??
          (stripeConfigured ? null : "Stripe billing is not configured.")
        }
      />
      <LegacyMigrationConfirmDialog
        confirmation={legacyConfirmation}
        onOpenChange={(open) => {
          if (!open) setLegacyConfirmation(null);
        }}
        onContinue={() => {
          if (legacyConfirmation?.billingPortalUrl) {
            window.location.assign(legacyConfirmation.billingPortalUrl);
          }
        }}
      />
      {fetcher.data &&
      typeof fetcher.data === "object" &&
      "error" in fetcher.data ? (
        <p className="text-sm text-destructive">{String(fetcher.data.error)}</p>
      ) : null}
    </div>
  );
}
