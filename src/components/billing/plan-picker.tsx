import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { BillingPlan } from "@/types";
import { PlanPickerCard, type PlanCardState } from "./plan-picker-card";
import {
  INDIVIDUAL_PLANS,
  PLAN_CONTENT,
  TEAM_PLANS,
} from "./plan-picker-content";

export type PlanPickerCta =
  | { kind: "byok" }
  | { kind: "payg"; plan: "payg" }
  | { kind: "subscribe"; plan: "starter" | "pro" | "team" }
  | { kind: "manage"; plan: "starter" | "pro" | "team" }
  | { kind: "contact" }
  | { kind: "downgrade"; plan: BillingPlan };

export interface PlanPickerProps {
  defaultBillingMode?: "individual" | "team";
  currentPlan?: BillingPlan | null;
  disabledReason?: string | null;
  highlightedPlan?: BillingPlan | null;
  heading?: { title: string; subtitle?: string } | null;
  showFooter?: boolean;
  byokProviderLabel?: string | null;
  onSelectPlan: (cta: PlanPickerCta) => void;
  pendingPlan?: BillingPlan | null;
  currentPaidPlanAction?: "manage";
}

const DEFAULT_HEADING = {
  title: "Choose your plan",
  subtitle: "Pick the plan that fits how you build.",
};
const PLAN_RANK: Record<BillingPlan, number> = {
  free: 0,
  payg: 1,
  starter: 2,
  pro: 3,
  team: 4,
  enterprise: 5,
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
  currentPaidPlanAction?: "manage",
): PlanPickerCta {
  if (
    state.kind === "current" &&
    currentPaidPlanAction === "manage" &&
    isMigratePlan(plan)
  ) {
    return { kind: "manage", plan };
  }
  if (state.kind === "downgrade") {
    return { kind: "downgrade", plan };
  }
  const ctaKind = PLAN_CONTENT[plan].ctaKind;
  if (ctaKind === "byok") return { kind: "byok" };
  if (ctaKind === "payg") return { kind: "payg", plan: "payg" };
  if (ctaKind === "contact") return { kind: "contact" };
  if (ctaKind === "subscribe") {
    if (isMigratePlan(plan)) {
      return { kind: "subscribe", plan };
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
  byokProviderLabel = null,
  onSelectPlan,
  pendingPlan = null,
  currentPaidPlanAction,
}: PlanPickerProps) {
  const [billingMode, setBillingMode] = useState<"individual" | "team">(
    defaultBillingMode,
  );

  const individualHighlight = highlightedPlan ?? "pro";
  const teamHighlight = highlightedPlan ?? "team";
  const isDisabled = Boolean(disabledReason);

  const renderGrid = (plans: BillingPlan[], highlight: BillingPlan) => (
    <div
      className={cn(
        "grid gap-4",
        plans.length === 4
          ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-4"
          : plans.length === 3
          ? "grid-cols-1 md:grid-cols-3"
          : "mx-auto max-w-2xl grid-cols-1 md:grid-cols-2",
      )}
    >
      {plans.map((plan) => {
        const state = resolveCardState(plan, highlight, currentPlan);
        const cta = ctaForPlan(plan, state, currentPaidPlanAction);
        const disabled =
          (cta.kind === "subscribe" ||
            cta.kind === "payg") &&
          (isDisabled || (pendingPlan !== null && pendingPlan !== plan));
        return (
          <PlanPickerCard
            key={plan}
            plan={plan}
            state={state}
            pending={pendingPlan === plan}
            disabled={disabled}
            byokProviderLabel={byokProviderLabel}
            currentAction={cta.kind === "manage" ? "manage" : null}
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
          {heading.subtitle ? (
            <p className="text-base text-muted-foreground">
              {heading.subtitle}
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
        <div className="space-y-2">
          <p className="text-center text-sm text-muted-foreground">
            Subscription plans include monthly credits that renew each billing period.
          </p>
          <p className="text-center text-sm text-muted-foreground">
            <a
              href="https://camelai.com/docs/plans/overview"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Compare every plan in detail →
            </a>
          </p>
        </div>
      ) : null}
    </div>
  );
}
