import { useState } from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
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
  | { kind: "trial"; plan: "starter" | "pro" | "team" }
  | { kind: "contact" }
  | { kind: "downgrade"; plan: BillingPlan };

export interface PlanPickerProps {
  defaultBillingMode?: "individual" | "team";
  currentPlan?: BillingPlan | null;
  disabledReason?: string | null;
  highlightedPlan?: BillingPlan | null;
  heading?: { title: string; subtitle?: string } | null;
  showFooter?: boolean;
  onSelectPlan: (cta: PlanPickerCta) => void;
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
): PlanPickerCta {
  if (state.kind === "downgrade") {
    return { kind: "downgrade", plan };
  }
  const ctaKind = PLAN_CONTENT[plan].ctaKind;
  if (ctaKind === "byok") return { kind: "byok" };
  if (ctaKind === "contact") return { kind: "contact" };
  if (ctaKind === "trial") {
    if (plan === "starter" || plan === "pro" || plan === "team") {
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
  onSelectPlan,
  pendingPlan = null,
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
        plans.length === 3
          ? "grid-cols-1 md:grid-cols-3"
          : "mx-auto max-w-2xl grid-cols-1 md:grid-cols-2",
      )}
    >
      {plans.map((plan) => {
        const state = resolveCardState(plan, highlight, currentPlan);
        const cta = ctaForPlan(plan, state);
        const disabled =
          cta.kind === "trial" &&
          (isDisabled || (pendingPlan !== null && pendingPlan !== plan));
        return (
          <PlanPickerCard
            key={plan}
            plan={plan}
            state={state}
            pending={pendingPlan === plan}
            disabled={disabled}
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
        <div className="space-y-4">
          <div className="rounded-xl bg-muted/40 px-5 py-4">
            <p className="text-base font-semibold text-foreground">
              Use Claude, Codex, Open Routner, or your own API key
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Top up credits to use any model through us at cost, no
              markup. Or bring your own API key anytime.
            </p>
          </div>
          <p className="text-center text-sm text-muted-foreground">
            All paid plans include a 7-day free trial. Cancel anytime.
          </p>
        </div>
      ) : null}
    </div>
  );
}
