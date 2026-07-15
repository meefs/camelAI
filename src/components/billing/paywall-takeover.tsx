import { useCallback, useEffect, useState } from "react";
import { useFetcher } from "react-router";
import {
  PlanPicker,
  type PlanPickerCta,
} from "@/components/billing/plan-picker";
import { ByokKeyDialog } from "@/components/onboarding/byok-key-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type OnboardingByokProvider } from "@/lib/byok-providers";
import { isBillingPlan } from "@/lib/billing-plans";
import { useOptionalAuthData } from "@/hooks/use-auth-data";
import type { BillingPlan } from "@/types";

export interface PaywallTakeoverContext {
  currentOrgName: string;
  multiOrg: boolean;
  byokProviderLabel: string | null;
}

interface PlanPickerOverrides {
  currentPlan?: BillingPlan | null;
  defaultBillingMode?: "individual" | "team";
  disabledReason?: string | null;
  highlightedPlan?: BillingPlan | null;
}

interface PaywallTakeoverProps {
  paywallContext: PaywallTakeoverContext;
  currentOrgId?: string | null;
  onPreviewSelectPlan?: (cta: PlanPickerCta) => void;
  planPickerOverrides?: PlanPickerOverrides;
}

const BOOK_DEMO_URL = "https://book-demo--camelai-team-d9e.camelai.app/";
const SUBSCRIPTION_PLANS = new Set(["starter", "pro", "team"]);

function isSubscriptionPlan(plan: string): plan is "starter" | "pro" | "team" {
  return isBillingPlan(plan) && SUBSCRIPTION_PLANS.has(plan);
}

export function PaywallTakeover({
  paywallContext,
  currentOrgId,
  onPreviewSelectPlan,
  planPickerOverrides,
}: PaywallTakeoverProps) {
  const authData = useOptionalAuthData();
  const activeOrgId = currentOrgId ?? authData?.currentOrg?.id ?? null;
  const [error, setError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] =
    useState<OnboardingByokProvider>("openrouter");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [awsRegion, setAwsRegion] = useState("us-east-1");
  const [byokDialogOpen, setByokDialogOpen] = useState(false);
  const [paygChoiceOpen, setPaygChoiceOpen] = useState(false);
  const [showProviderError, setShowProviderError] = useState(true);
  const checkoutFetcher = useFetcher<{
    checkoutUrl?: string;
    redirectTo?: string;
    success?: boolean;
    error?: string;
  }>();
  const providerFetcher = useFetcher<{
    success?: boolean;
    error?: string;
  }>();

  const checkoutError =
    checkoutFetcher.state === "idle" ? checkoutFetcher.data?.error : undefined;
  const providerError =
    showProviderError && providerFetcher.state === "idle"
      ? providerFetcher.data?.error
      : undefined;
  const pendingCheckoutPlanValue = String(
    checkoutFetcher.formData?.get("plan") || "",
  );
  const pendingCheckoutPlan = isSubscriptionPlan(pendingCheckoutPlanValue)
    ? pendingCheckoutPlanValue
    : pendingCheckoutPlanValue === "payg"
      ? "payg"
      : null;
  const isSavingProvider = providerFetcher.state !== "idle";
  const isStartingCheckout = checkoutFetcher.state !== "idle";
  const subtitle = paywallContext.multiOrg
    ? `${paywallContext.currentOrgName} is on the Free plan with no API key set up. Pick a plan, or switch to an organization with an active plan using the sidebar.`
    : paywallContext.byokProviderLabel
      ? `Your ${paywallContext.byokProviderLabel} API key is connected. Continue on Free, use prepaid hosted credits, or start a subscription.`
      : "Choose a plan, use prepaid hosted credits, or bring your own API key.";

  const disabledReason = planPickerOverrides?.disabledReason ?? null;

  useEffect(() => {
    if (checkoutFetcher.state !== "idle") {
      return;
    }
    const nextUrl =
      checkoutFetcher.data?.checkoutUrl ?? checkoutFetcher.data?.redirectTo;
    if (!nextUrl) return;
    window.location.assign(nextUrl);
  }, [checkoutFetcher.data, checkoutFetcher.state]);

  useEffect(() => {
    if (providerFetcher.state !== "idle" || !providerFetcher.data?.success) {
      return;
    }
    setByokDialogOpen(false);
    setError(null);
    setShowProviderError(false);
  }, [providerFetcher.data, providerFetcher.state]);

  const saveProviderAndContinue = useCallback(() => {
    if (!activeOrgId) {
      setError(
        "We couldn't identify the current organization. Refresh and try again.",
      );
      return;
    }
    if (!providerApiKey.trim()) {
      setError("Enter an API key to continue with your own provider.");
      return;
    }
    setError(null);
    setShowProviderError(true);

    const providerPayload: Record<string, string> = {
      intent: "setProvider",
      provider: selectedProvider,
    };

    if (selectedProvider === "bedrock") {
      providerPayload.bearer_token = providerApiKey.trim();
      providerPayload.aws_region = awsRegion;
    } else {
      providerPayload.api_key = providerApiKey.trim();
    }

    providerFetcher.submit(providerPayload, {
      method: "POST",
      action: `/api/orgs/${activeOrgId}/llm-provider`,
      encType: "application/json",
    });
  }, [
    activeOrgId,
    awsRegion,
    providerApiKey,
    providerFetcher,
    selectedProvider,
  ]);

  const startPayAsYouGoWithCredits = useCallback(() => {
    setPaygChoiceOpen(false);
    if (onPreviewSelectPlan) {
      onPreviewSelectPlan({ kind: "payg", plan: "payg" });
      return;
    }
    if (isStartingCheckout) {
      return;
    }
    checkoutFetcher.submit(
      { plan: "payg" },
      {
        method: "post",
        action: "/api/billing/start-payg",
      },
    );
  }, [checkoutFetcher, isStartingCheckout, onPreviewSelectPlan]);

  const continueWithOwnApiKey = useCallback(() => {
    setPaygChoiceOpen(false);
    setShowProviderError(false);
    if (onPreviewSelectPlan) {
      onPreviewSelectPlan({ kind: "byok" });
    }
    setByokDialogOpen(true);
  }, [onPreviewSelectPlan]);

  const handleSelectPlan = (cta: PlanPickerCta) => {
    setError(null);

    if (cta.kind === "byok") {
      continueWithOwnApiKey();
      return;
    }
    if (cta.kind === "payg") {
      setPaygChoiceOpen(true);
      return;
    }
    if (onPreviewSelectPlan) {
      onPreviewSelectPlan(cta);
      return;
    }
    if (cta.kind === "subscribe") {
      if (isStartingCheckout) {
        return;
      }
      checkoutFetcher.submit(
        { plan: cta.plan },
        {
          method: "post",
          action: "/api/billing/start-subscription",
        },
      );
      return;
    }
    if (cta.kind === "contact") {
      window.open(BOOK_DEMO_URL, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="m-auto w-full max-w-4xl px-4 py-8 sm:px-6">
        <div className="space-y-5 text-left">
          {error && !byokDialogOpen ? (
            <Alert variant="destructive" className="text-left">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {checkoutError ? (
            <Alert variant="destructive" className="text-left">
              <AlertDescription>{checkoutError}</AlertDescription>
            </Alert>
          ) : null}

          <PlanPicker
            currentPlan={planPickerOverrides?.currentPlan}
            defaultBillingMode={
              planPickerOverrides?.defaultBillingMode ?? "individual"
            }
            disabledReason={disabledReason}
            heading={{
              title: "Choose your plan",
              subtitle,
            }}
            highlightedPlan={planPickerOverrides?.highlightedPlan}
            byokProviderLabel={paywallContext.byokProviderLabel}
            pendingPlan={isStartingCheckout ? pendingCheckoutPlan : null}
            onSelectPlan={handleSelectPlan}
          />

          <ByokKeyDialog
            open={byokDialogOpen}
            onOpenChange={(open) => {
              setByokDialogOpen(open);
              if (!open) {
                setError(null);
                setShowProviderError(false);
              }
            }}
            selectedProvider={selectedProvider}
            onProviderChange={(provider) => {
              setSelectedProvider(provider);
              setError(null);
              setShowProviderError(false);
            }}
            apiKey={providerApiKey}
            onApiKeyChange={(key) => {
              setProviderApiKey(key);
              setError(null);
              setShowProviderError(false);
            }}
            awsRegion={awsRegion}
            onAwsRegionChange={(region) => {
              setAwsRegion(region);
              setError(null);
              setShowProviderError(false);
            }}
            onSubmit={saveProviderAndContinue}
            isSubmitting={isSavingProvider}
            errorMessage={error ?? providerError ?? null}
          />

          <Dialog open={paygChoiceOpen} onOpenChange={setPaygChoiceOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Continue with Pay as you go</DialogTitle>
                <DialogDescription>
                  Choose how to connect an LLM provider. Purchase credits and
                  camelAI will provide hosted models, or bring your own API key.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={continueWithOwnApiKey}
                >
                  Bring your own API key
                </Button>
                <Button
                  type="button"
                  disabled={isStartingCheckout}
                  onClick={startPayAsYouGoWithCredits}
                >
                  Purchase credits
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
