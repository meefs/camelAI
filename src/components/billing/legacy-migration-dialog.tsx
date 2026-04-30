import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { ArrowRight, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BILLING_PLAN_LIMITS } from "@/lib/billing-plans";
import { cn } from "@/lib/utils";
import type { BillingPlan } from "@/types";

type MigrationPlan = Exclude<BillingPlan, "free" | "enterprise">;

export interface LegacyMigrationDialogData {
  eligible: boolean;
  customerId: string | null;
  activeLegacySubscriptionCount: number;
  defaultPlan: MigrationPlan;
}

interface LegacyMigrationDialogProps {
  migration: LegacyMigrationDialogData | null;
  onSelectPlan?: (plan: MigrationPlan) => void;
  variant?: "floating" | "embedded";
}

interface MigrationFetcherData {
  success?: boolean;
  error?: string;
}

const MIGRATION_PLANS: MigrationPlan[] = ["starter", "pro", "team"];

function planLabel(plan: MigrationPlan): string {
  return BILLING_PLAN_LIMITS[plan].label;
}

function planPrice(plan: MigrationPlan): string {
  const cents = BILLING_PLAN_LIMITS[plan].monthlyPriceCents ?? 0;
  const amount = cents / 100;
  const suffix = plan === "team" ? "/seat/mo" : "/mo";
  return `$${amount}${suffix}`;
}

function orderedMigrationPlans(defaultPlan: MigrationPlan): MigrationPlan[] {
  return [
    defaultPlan,
    ...MIGRATION_PLANS.filter((plan) => plan !== defaultPlan),
  ];
}

export function LegacyMigrationDialog({
  migration,
  onSelectPlan,
  variant = "floating",
}: LegacyMigrationDialogProps) {
  const fetcher = useFetcher<MigrationFetcherData>();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!migration?.eligible) {
      setDismissed(false);
    }
  }, [migration?.eligible]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.success) return;
    window.location.reload();
  }, [fetcher.data, fetcher.state]);

  const pendingPlan = useMemo(() => {
    const value = String(fetcher.formData?.get("plan") || "");
    return MIGRATION_PLANS.includes(value as MigrationPlan)
      ? (value as MigrationPlan)
      : null;
  }, [fetcher.formData]);

  if (!migration?.eligible || dismissed) return null;

  const isSubmitting = fetcher.state !== "idle";
  const error =
    fetcher.state === "idle" && fetcher.data?.error ? fetcher.data.error : null;
  const requiresManualReview = migration.activeLegacySubscriptionCount > 1;
  const planOptions = orderedMigrationPlans(migration.defaultPlan);
  const [recommendedPlan, ...alternatePlans] = planOptions;

  const selectPlan = (plan: MigrationPlan) => {
    if (onSelectPlan) {
      onSelectPlan(plan);
      return;
    }
    fetcher.submit(
      { plan },
      {
        method: "post",
        action: "/api/billing/legacy-migration",
      },
    );
  };

  const renderPlanButton = (
    plan: MigrationPlan,
    options: { recommended?: boolean } = {},
  ) => {
    const pending = pendingPlan === plan;
    return (
      <Button
        key={plan}
        type="button"
        size={options.recommended ? "lg" : "default"}
        variant={options.recommended ? "default" : "outline"}
        disabled={isSubmitting}
        onClick={() => selectPlan(plan)}
        className={cn(
          "h-auto min-h-12 justify-between gap-3 px-3 py-3 text-left",
          options.recommended && "min-h-16",
        )}
      >
        <span className="min-w-0">
          <span className="block truncate font-medium">
            {options.recommended
              ? `Switch to ${planLabel(plan)}`
              : planLabel(plan)}
          </span>
          <span
            className={cn(
              "block text-xs",
              options.recommended
                ? "text-primary-foreground/75"
                : "text-muted-foreground",
            )}
          >
            {planPrice(plan)}
          </span>
        </span>
        {pending ? (
          <Loader2
            className="size-4 shrink-0 animate-spin"
            aria-hidden="true"
          />
        ) : (
          <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
        )}
      </Button>
    );
  };

  return (
    <Card
      role="dialog"
      aria-labelledby="legacy-migration-title"
      aria-describedby="legacy-migration-description"
      className={cn(
        "overflow-visible shadow-lg",
        variant === "floating"
          ? "fixed bottom-4 right-4 z-50 w-[min(38rem,calc(100vw-2rem))]"
          : "w-full border-border bg-card shadow-sm",
      )}
    >
      <CardContent
        className={cn(
          "relative grid gap-4 p-4",
          variant === "embedded" && "md:grid-cols-[minmax(0,1fr)_22rem]",
        )}
      >
        {variant === "floating" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-3 top-3"
            onClick={() => setDismissed(true)}
            disabled={isSubmitting}
            aria-label="Dismiss legacy subscription migration"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Existing subscriber</Badge>
            {!requiresManualReview ? (
              <Badge variant="secondary">
                Recommended: {planLabel(migration.defaultPlan)}
              </Badge>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <h2 id="legacy-migration-title" className="text-lg font-semibold">
              Move your legacy subscription to camelAI
            </h2>
            <p
              id="legacy-migration-description"
              className="max-w-2xl text-sm text-muted-foreground"
            >
              Switch your existing subscription to the new product. This is not
              a new trial or a second subscription; Stripe applies the unused
              balance from your current billing period.
            </p>
          </div>
          {!requiresManualReview ? (
            <p className="text-xs text-muted-foreground">
              You can still choose a different plan.
            </p>
          ) : null}
          {requiresManualReview ? (
            <p className="text-sm text-muted-foreground">
              We found multiple active legacy subscriptions. We should move this
              manually so nothing is billed twice.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col justify-center gap-2">
          {requiresManualReview ? (
            <Button asChild size="lg">
              <a href="mailto:support@camelai.com?subject=Legacy%20subscription%20migration">
                Contact us
              </a>
            </Button>
          ) : (
            <>
              {renderPlanButton(recommendedPlan, { recommended: true })}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">
                {alternatePlans.map((plan) => renderPlanButton(plan))}
              </div>
            </>
          )}
          {variant === "floating" ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDismissed(true)}
              disabled={isSubmitting}
            >
              Not now
            </Button>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      </CardContent>
    </Card>
  );
}
