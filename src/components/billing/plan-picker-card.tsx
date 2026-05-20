import { Check, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BILLING_PLAN_LIMITS } from "@/lib/billing-plans";
import { cn } from "@/lib/utils";
import type { BillingPlan } from "@/types";
import {
  PLAN_CONTENT,
  formatPlanPrice,
  type PlanPickerCtaKind,
} from "./plan-picker-content";

export type PlanCardState =
  | { kind: "default" }
  | { kind: "highlighted" }
  | { kind: "current" }
  | { kind: "downgrade" };

export interface PlanPickerCardProps {
  plan: BillingPlan;
  state: PlanCardState;
  pending: boolean;
  disabled: boolean;
  trialAvailable: boolean;
  byokProviderLabel?: string | null;
  legacyMode?: boolean;
  onSelect: (cta: { kind: PlanPickerCtaKind; plan: BillingPlan }) => void;
}

export function PlanPickerCard({
  plan,
  state,
  pending,
  disabled,
  trialAvailable,
  byokProviderLabel = null,
  legacyMode = false,
  onSelect,
}: PlanPickerCardProps) {
  const limits = BILLING_PLAN_LIMITS[plan];
  const content = PLAN_CONTENT[plan];
  const price = formatPlanPrice(plan);
  const isHighlighted = state.kind === "highlighted";
  const isCurrent = state.kind === "current";
  const isDowngrade = state.kind === "downgrade";

  const ctaKind: PlanPickerCtaKind = isDowngrade
    ? "downgrade"
    : content.ctaKind;
  const isPaidLegacyCta = legacyMode && ctaKind === "trial";
  const freeByokCtaLabel =
    plan === "free" && byokProviderLabel
      ? `Continue with ${byokProviderLabel}`
      : content.ctaLabel;
  const ctaLabel = isCurrent
    ? "Current plan"
    : isDowngrade
      ? "Downgrade"
      : pending
        ? isPaidLegacyCta
          ? "Switching…"
          : ctaKind === "payg"
            ? "Setting up…"
            : "Opening Stripe…"
        : isPaidLegacyCta
          ? `Switch to ${limits.label}`
          : ctaKind === "trial" && !trialAvailable
            ? "Choose plan"
            : freeByokCtaLabel;
  const ctaVariant: "default" | "outline" | "secondary" = isCurrent
    ? "secondary"
    : isHighlighted
      ? "default"
      : "outline";

  return (
    <div className="relative">
      {isHighlighted ? (
        <Badge
          variant="default"
          className="absolute top-0 left-4 z-10 -translate-y-1/2"
        >
          {legacyMode ? "Recommended" : "Most popular"}
        </Badge>
      ) : null}
      {isCurrent ? (
        <Badge
          variant="secondary"
          className="absolute top-0 left-4 z-10 -translate-y-1/2"
        >
          Current plan
        </Badge>
      ) : null}
      <Card
        className={cn(
          "flex h-full flex-col gap-5 py-6",
          isHighlighted && "ring-2 ring-primary",
        )}
      >
        <CardHeader>
          <CardTitle className="text-lg font-semibold">
            {limits.label}
          </CardTitle>
        </CardHeader>

        <CardContent className="min-h-[6.75rem] space-y-1">
          <div className="flex items-baseline justify-start gap-1">
            <span className="font-[family-name:var(--font-display)] text-4xl font-normal text-foreground">
              {price.amount}
            </span>
            {price.suffix ? (
              <span className="text-sm text-muted-foreground">
                {price.suffix}
              </span>
            ) : null}
          </div>
          <p
            className={cn(
              "text-sm",
              price.subtitle
                ? "text-primary"
                : "invisible select-none text-primary",
            )}
            aria-hidden={price.subtitle ? undefined : true}
          >
            {price.subtitle ?? "placeholder"}
          </p>
          <p className="text-sm text-muted-foreground">
            {plan === "team"
              ? `${content.tagline} · Min ${limits.minimumSeats} seats`
              : content.tagline}
          </p>
        </CardContent>

        <CardFooter>
          <Button
            type="button"
            size="lg"
            className="w-full"
            variant={ctaVariant}
            disabled={disabled || isCurrent || pending}
            onClick={() => onSelect({ kind: ctaKind, plan })}
          >
            {pending ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : null}
            <span>{ctaLabel}</span>
          </Button>
        </CardFooter>

        <CardContent className="flex-1 space-y-3">
          {content.upsellPrefix ? (
            <p className="text-xs font-medium text-muted-foreground">
              {content.upsellPrefix}
            </p>
          ) : null}
          <ul className="space-y-2 text-sm text-foreground/80">
            {content.features.map((feature) => (
              <li key={feature} className="flex items-start gap-2">
                <Check
                  className="mt-0.5 size-4 shrink-0 text-foreground/70"
                  aria-hidden="true"
                />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
