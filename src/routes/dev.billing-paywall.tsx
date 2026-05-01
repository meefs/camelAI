import { Link, useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import type { Route } from "./+types/dev.billing-paywall";
import {
  LegacyMigrationDialog,
  type LegacyMigrationDialogData,
} from "@/components/billing/legacy-migration-dialog";
import {
  PlanPicker,
  type PlanPickerCta,
} from "@/components/billing/plan-picker";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  BYOK_PROVIDER_ORDER,
  getByokProviderLabel,
  type OnboardingByokProvider,
} from "@/lib/byok-providers";
import type { BillingPlan } from "@/types";

type PreviewState =
  | "default"
  | "legacy"
  | "legacy-multiple"
  | "trial-used"
  | "byok-configured"
  | "current-starter"
  | "current-pro"
  | "team";

interface PreviewConfig {
  description: string;
  migration: LegacyMigrationDialogData | null;
  trialAvailable: boolean;
  currentPlan: BillingPlan | null;
  defaultBillingMode: "individual" | "team";
  disabledReason: string | null;
  byokProviderLabel: string | null;
}

const PREVIEW_STATES: Array<{ value: PreviewState; label: string }> = [
  { value: "default", label: "New paywall" },
  { value: "legacy", label: "Legacy migration" },
  { value: "legacy-multiple", label: "Manual migration" },
  { value: "trial-used", label: "Trial used" },
  { value: "byok-configured", label: "BYOK connected" },
  { value: "current-starter", label: "Starter upgrade" },
  { value: "current-pro", label: "Pro downgrade" },
  { value: "team", label: "Team default" },
];

function isLocalPreviewRequest(request: Request): boolean {
  void request;
  return import.meta.env.DEV;
}

function parsePreviewState(value: string | null): PreviewState {
  return PREVIEW_STATES.some((state) => state.value === value)
    ? (value as PreviewState)
    : "legacy";
}

function parseByokProvider(value: string | null): OnboardingByokProvider {
  return BYOK_PROVIDER_ORDER.includes(value as OnboardingByokProvider)
    ? (value as OnboardingByokProvider)
    : "openrouter";
}

function getPreviewConfig(
  state: PreviewState,
  byokProvider: OnboardingByokProvider,
): PreviewConfig {
  const base: PreviewConfig = {
    description:
      "A new org must choose hosted billing or bring their own API key before continuing.",
    migration: null,
    trialAvailable: true,
    currentPlan: null,
    defaultBillingMode: "individual",
    disabledReason: null,
    byokProviderLabel: null,
  };

  switch (state) {
    case "legacy":
      return {
        ...base,
        description:
          "A logged-in legacy customer sees the migration modal first, then a slim alert and a switched-over plan picker.",
        migration: {
          eligible: true,
          customerId: "cus_preview",
          activeLegacySubscriptionCount: 1,
          defaultPlan: "pro",
        },
      };
    case "legacy-multiple":
      return {
        ...base,
        description:
          "Customers with multiple active legacy subscriptions are routed to manual migration; the picker is disabled.",
        migration: {
          eligible: true,
          customerId: "cus_preview_multiple",
          activeLegacySubscriptionCount: 2,
          defaultPlan: "team",
        },
        disabledReason:
          "This account has multiple active subscriptions. Contact support@camelai.com to switch over without double billing.",
      };
    case "trial-used":
      return {
        ...base,
        description:
          "After the one org trial has been used, the CTA copy no longer promises another trial.",
        trialAvailable: false,
      };
    case "byok-configured":
      return {
        ...base,
        description:
          "An org with an existing BYOK provider sees Free as a continue path instead of another setup prompt.",
        byokProviderLabel: getByokProviderLabel(byokProvider),
      };
    case "current-starter":
      return {
        ...base,
        description:
          "A Starter org can upgrade to Pro/Team and sees Starter as the current plan.",
        currentPlan: "starter",
      };
    case "current-pro":
      return {
        ...base,
        description:
          "A Pro org sees lower plans as downgrade actions and Pro as the current plan.",
        currentPlan: "pro",
      };
    case "team":
      return {
        ...base,
        description:
          "Team mode starts on the team tab and uses Team as the highlighted plan.",
        defaultBillingMode: "team",
      };
    case "default":
    default:
      return base;
  }
}

function describeCta(cta: PlanPickerCta): string {
  switch (cta.kind) {
    case "byok":
      return "BYOK selected";
    case "trial":
      return `Start checkout for ${cta.plan}`;
    case "migrate":
      return `Legacy migration to ${cta.plan}`;
    case "contact":
      return "Contact sales selected";
    case "downgrade":
      return `Downgrade to ${cta.plan}`;
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  if (!isLocalPreviewRequest(request)) {
    throw new Response("Not found", { status: 404 });
  }

  return null;
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "Billing paywall preview - camelAI" }];
}

export default function DevBillingPaywallPreviewRoute() {
  const [searchParams] = useSearchParams();
  const state = parsePreviewState(searchParams.get("state"));
  const byokProvider = parseByokProvider(searchParams.get("provider"));
  const config = getPreviewConfig(state, byokProvider);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [introOpen, setIntroOpen] = useState(
    config.migration?.eligible ?? false,
  );

  useEffect(() => {
    setIntroOpen(config.migration?.eligible ?? false);
    setLastAction(null);
  }, [config.migration?.eligible, state]);

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-3 border-b pb-5 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline">Local preview</Badge>
            <Badge>{state}</Badge>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Billing paywall states
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            This route uses fake billing state and does not call Stripe. Use it
            to inspect paywall and migration UI without setting up a customer.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/onboarding">Back to onboarding</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>State</CardTitle>
          <CardDescription>{config.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {PREVIEW_STATES.map((previewState) => (
            <Button
              key={previewState.value}
              asChild
              variant={previewState.value === state ? "default" : "outline"}
            >
              <Link
                to={
                  previewState.value === "byok-configured"
                    ? `/dev/billing-paywall?state=${previewState.value}&provider=${byokProvider}`
                    : `/dev/billing-paywall?state=${previewState.value}`
                }
              >
                {previewState.label}
              </Link>
            </Button>
          ))}
          {state === "byok-configured" ? (
            <div className="ml-0 flex w-full flex-wrap gap-2 pt-2">
              {BYOK_PROVIDER_ORDER.map((provider) => {
                const label = getByokProviderLabel(provider) ?? provider;
                return (
                  <Button
                    key={provider}
                    asChild
                    variant={provider === byokProvider ? "default" : "outline"}
                    size="sm"
                  >
                    <Link
                      to={`/dev/billing-paywall?state=byok-configured&provider=${provider}`}
                    >
                      {label}
                    </Link>
                  </Button>
                );
              })}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {lastAction ? (
        <Alert>
          <AlertDescription>{lastAction}</AlertDescription>
        </Alert>
      ) : null}

      <section className="space-y-5 text-left">
        {config.migration?.eligible ? (
          <LegacyMigrationDialog
            migration={config.migration}
            open={introOpen}
            onOpenChange={setIntroOpen}
          />
        ) : null}

        <PlanPicker
          currentPlan={config.currentPlan}
          defaultBillingMode={config.defaultBillingMode}
          disabledReason={config.disabledReason}
          heading={{
            title: "Choose your plan",
            subtitle: config.migration?.eligible
              ? "Pick a paid plan to switch over from your existing subscription, or bring your own API key to keep using camelAI on the free tier."
              : config.byokProviderLabel
                ? `Your ${config.byokProviderLabel} API key is connected. Continue on Free, or start a paid plan for hosted credits.`
                : config.trialAvailable
                  ? "Start a free trial with model credits, or use your own API key."
                  : "Choose a plan, or use your own API key.",
          }}
          highlightedPlan={state === "team" ? "team" : undefined}
          trialAvailable={config.trialAvailable}
          byokProviderLabel={config.byokProviderLabel}
          legacyMigration={config.migration}
          onLegacyWhyClick={() => setIntroOpen(true)}
          onSelectPlan={(cta) => setLastAction(describeCta(cta))}
        />
      </section>
    </main>
  );
}
