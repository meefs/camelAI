import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { BillingPlan } from "@/types";
import type { LegacyMigrationDialogData } from "./legacy-migration-dialog";
import { PlanPickerCard, type PlanCardState } from "./plan-picker-card";
import {
  INDIVIDUAL_PLANS,
  PLAN_CONTENT,
  TEAM_PLANS,
} from "./plan-picker-content";

export type PlanPickerCta =
  | { kind: "byok" }
  | { kind: "trial"; plan: "starter" | "pro" | "team" }
  | { kind: "migrate"; plan: "starter" | "pro" | "team" }
  | { kind: "contact" }
  | { kind: "downgrade"; plan: BillingPlan };

export interface PlanPickerProps {
  defaultBillingMode?: "individual" | "team";
  currentPlan?: BillingPlan | null;
  disabledReason?: string | null;
  highlightedPlan?: BillingPlan | null;
  heading?: { title: string; subtitle?: string } | null;
  showFooter?: boolean;
  trialAvailable?: boolean;
  byokProviderLabel?: string | null;
  legacyMigration?: LegacyMigrationDialogData | null;
  onSelectPlan: (cta: PlanPickerCta) => void;
  onLegacyWhyClick?: () => void;
  pendingPlan?: BillingPlan | null;
}

const DEFAULT_HEADING = {
  title: "Choose your plan",
  subtitle: "Pick the plan that fits how you build.",
};

const PLAN_RANK: Record<BillingPlan, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  team: 3,
  enterprise: 4,
};

function isMigratePlan(plan: BillingPlan): plan is "starter" | "pro" | "team" {
  return plan === "starter" || plan === "pro" || plan === "team";
}

function resolveCardState(
  plan: BillingPlan,
  highlightedPlan: BillingPlan,
  currentPlan: BillingPlan | null | undefined,
): PlanCardState {
  if (currentPlan && plan === currentPlan) {
    return { kind: "current" };
  }
  if (
    currentPlan &&
    PLAN_RANK[plan] < PLAN_RANK[currentPlan] &&
    plan !== "enterprise"
  ) {
    return { kind: "downgrade" };
  }
  if (plan === highlightedPlan) {
    return { kind: "highlighted" };
  }
  return { kind: "default" };
}

function ctaForPlan(
  plan: BillingPlan,
  state: PlanCardState,
  legacyMode: boolean,
): PlanPickerCta {
  if (state.kind === "downgrade") {
    return { kind: "downgrade", plan };
  }
  const ctaKind = PLAN_CONTENT[plan].ctaKind;
  if (ctaKind === "byok") return { kind: "byok" };
  if (ctaKind === "contact") return { kind: "contact" };
  if (ctaKind === "trial") {
    if (isMigratePlan(plan)) {
      if (legacyMode) {
        return { kind: "migrate", plan };
      }
      return { kind: "trial", plan };
    }
  }
  return { kind: "downgrade", plan };
}

export function PlanPicker({
  defaultBillingMode = "individual",
  currentPlan = null,
  disabledReason = null,
  highlightedPlan,
  heading = DEFAULT_HEADING,
  showFooter = true,
  trialAvailable = true,
  byokProviderLabel = null,
  legacyMigration = null,
  onSelectPlan,
  onLegacyWhyClick,
  pendingPlan = null,
}: PlanPickerProps) {
  const [billingMode, setBillingMode] = useState<"individual" | "team">(
    defaultBillingMode,
  );

  const legacyMode = Boolean(legacyMigration?.eligible);
  const legacyDefault = legacyMigration?.defaultPlan;
  const individualHighlight =
    highlightedPlan ??
    (legacyMode && legacyDefault && legacyDefault !== "team"
      ? legacyDefault
      : "pro");
  const teamHighlight = highlightedPlan ?? "team";
  const isDisabled = Boolean(disabledReason);

  const renderGrid = (plans: BillingPlan[], highlight: BillingPlan) => (
    <div
      className={cn(
        "grid gap-4",
        plans.length === 3
          ? "grid-cols-1 md:grid-cols-3"
          : "mx-auto max-w-2xl grid-cols-1 md:grid-cols-2",
      )}
    >
      {plans.map((plan) => {
        const state = resolveCardState(plan, highlight, currentPlan);
        const cta = ctaForPlan(plan, state, legacyMode);
        const disabled =
          (cta.kind === "trial" || cta.kind === "migrate") &&
          (isDisabled || (pendingPlan !== null && pendingPlan !== plan));
        return (
          <PlanPickerCard
            key={plan}
            plan={plan}
            state={state}
            pending={pendingPlan === plan}
            disabled={disabled}
            trialAvailable={trialAvailable}
            byokProviderLabel={byokProviderLabel}
            legacyMode={legacyMode}
            onSelect={() => onSelectPlan(cta)}
          />
        );
      })}
    </div>
  );

  return (
    <div className="space-y-5">
      {heading ? (
        <div className="space-y-2 text-center">
          <h2 className="font-[family-name:var(--font-display)] text-3xl font-normal tracking-tight">
            {heading.title}
          </h2>
          {heading.subtitle || (legacyMode && onLegacyWhyClick) ? (
            <p className="text-base text-muted-foreground">
              {heading.subtitle ? <span>{heading.subtitle}</span> : null}
              {legacyMode && onLegacyWhyClick ? (
                <>
                  {heading.subtitle ? " " : null}
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto px-0 align-baseline text-base"
                    onClick={onLegacyWhyClick}
                  >
                    Why am I seeing this?
                  </Button>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}

      <Tabs
        value={billingMode}
        onValueChange={(value) =>
          setBillingMode(value as "individual" | "team")
        }
        className="items-center"
      >
        <TabsList>
          <TabsTrigger value="individual">Individual</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
        </TabsList>
        <TabsContent value="individual" className="mt-5 w-full">
          {renderGrid(INDIVIDUAL_PLANS, individualHighlight)}
        </TabsContent>
        <TabsContent value="team" className="mt-5 w-full">
          {renderGrid(TEAM_PLANS, teamHighlight)}
        </TabsContent>
      </Tabs>

      {disabledReason ? (
        <p className="text-sm text-muted-foreground">{disabledReason}</p>
      ) : null}

      {showFooter ? (
        <div className="space-y-4">
          <div className="rounded-xl bg-muted/40 px-5 py-4">
            <p className="text-base font-semibold text-foreground">
              {byokProviderLabel
                ? `${byokProviderLabel} API key connected`
                : "Use Claude, Codex, OpenRouter, or your own API key"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {byokProviderLabel
                ? "Stay on Free using your own key, or start a paid plan to use hosted credits through camelAI."
                : "Top up credits to use any model through us at cost, no markup. Or bring your own API key anytime."}
            </p>
          </div>
          <p className="text-center text-sm text-muted-foreground">
            {legacyMode
              ? "Picking a paid plan cancels your old subscription and applies unused balance."
              : trialAvailable
                ? "All paid plans include one 7-day free trial per org."
                : "Your free trial has already been used for this org."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
