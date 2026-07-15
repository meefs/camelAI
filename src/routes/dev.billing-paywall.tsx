import { Link, useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import type { Route } from "./+types/dev.billing-paywall";
import { PaywallTakeover } from "@/components/billing/paywall-takeover";
import { type PlanPickerCta } from "@/components/billing/plan-picker";
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
  | "byok-configured"
  | "current-starter"
  | "current-pro"
  | "team";

interface PreviewConfig {
  description: string;
  orgName: string;
  multiOrg: boolean;
  currentPlan: BillingPlan | null;
  defaultBillingMode: "individual" | "team";
  disabledReason: string | null;
  byokProviderLabel: string | null;
}

const PREVIEW_STATES: Array<{ value: PreviewState; label: string }> = [
  { value: "default", label: "New paywall" },
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
    : "default";
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
    orgName: "Org B",
    multiOrg: true,
    currentPlan: null,
    defaultBillingMode: "individual",
    disabledReason: null,
    byokProviderLabel: null,
  };

  switch (state) {
    case "byok-configured":
      return {
        ...base,
        description:
          "An org with an existing BYOK provider sees Free as a continue path instead of another setup prompt.",
        multiOrg: false,
        byokProviderLabel: getByokProviderLabel(byokProvider),
      };
    case "current-starter":
      return {
        ...base,
        description:
          "A Starter org can upgrade to Pro/Team and sees Starter as the current plan.",
        multiOrg: false,
        currentPlan: "starter",
      };
    case "current-pro":
      return {
        ...base,
        description:
          "A Pro org sees lower plans as downgrade actions and Pro as the current plan.",
        multiOrg: false,
        currentPlan: "pro",
      };
    case "team":
      return {
        ...base,
        description:
          "Team mode starts on the team tab and uses Team as the highlighted plan.",
        multiOrg: false,
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
    case "payg":
      return "Pay as you go selected";
    case "subscribe":
      return `Start checkout for ${cta.plan}`;
    case "manage":
      return `Manage ${cta.plan} in Stripe`;
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

  useEffect(() => {
    setLastAction(null);
  }, [state]);

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
            to inspect paywall UI without setting up a customer.
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

      <section className="min-h-[80vh] overflow-hidden rounded-lg border">
        <PaywallTakeover
          currentOrgId="org_preview"
          paywallContext={{
            currentOrgName: config.orgName,
            multiOrg: config.multiOrg,
            byokProviderLabel: config.byokProviderLabel,
          }}
          onPreviewSelectPlan={(cta) => {
            setLastAction(describeCta(cta));
          }}
          planPickerOverrides={{
            currentPlan: config.currentPlan,
            defaultBillingMode: config.defaultBillingMode,
            disabledReason: config.disabledReason,
            highlightedPlan: state === "team" ? "team" : undefined,
          }}
        />
      </section>
    </main>
  );
}
