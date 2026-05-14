import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import {
  LegacyMigrationConfirmDialog,
  type LegacyMigrationConfirmation,
} from "@/components/billing/legacy-migration-confirm-dialog";
import {
  LegacyMigrationDialog,
  type LegacyMigrationDialogData,
} from "@/components/billing/legacy-migration-dialog";
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
  trialAvailable: boolean;
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
  legacyMigration: LegacyMigrationDialogData | null;
  currentOrgId?: string | null;
  onPreviewSelectPlan?: (cta: PlanPickerCta) => void;
  planPickerOverrides?: PlanPickerOverrides;
}

const BOOK_DEMO_URL = "https://book-demo--camelai-team-d9e.camelai.app/";
const TRIAL_PLANS = new Set(["starter", "pro", "team"]);

function isTrialPlan(plan: string): plan is "starter" | "pro" | "team" {
  return isBillingPlan(plan) && TRIAL_PLANS.has(plan);
}

function buildLegacyMigrationKey(
  legacyMigration: LegacyMigrationDialogData | null,
): string | null {
  if (!legacyMigration?.eligible) {
    return null;
  }
  return [
    legacyMigration.customerId ?? "unknown-customer",
    legacyMigration.activeLegacySubscriptionCount,
    legacyMigration.defaultPlan,
  ].join(":");
}

export function PaywallTakeover({
  paywallContext,
  legacyMigration,
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
  const [legacyConfirmation, setLegacyConfirmation] =
    useState<LegacyMigrationConfirmation | null>(null);
  const legacyMigrationKey = buildLegacyMigrationKey(legacyMigration);
  const [legacyIntroOpen, setLegacyIntroOpen] = useState(
    () => legacyMigrationKey !== null,
  );
  const legacyDialogKeyRef = useRef<string | null>(legacyMigrationKey);
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
  const migrationFetcher = useFetcher<{
    billingPortalUrl?: string;
    legacyMigrationPreview?: LegacyMigrationConfirmation["preview"];
    success?: boolean;
    error?: string;
  }>();

  const checkoutError =
    checkoutFetcher.state === "idle" ? checkoutFetcher.data?.error : undefined;
  const providerError =
    showProviderError && providerFetcher.state === "idle"
      ? providerFetcher.data?.error
      : undefined;
  const migrationError =
    migrationFetcher.state === "idle"
      ? migrationFetcher.data?.error
      : undefined;
  const pendingCheckoutPlanValue = String(
    checkoutFetcher.formData?.get("plan") || "",
  );
  const pendingCheckoutPlan = isTrialPlan(pendingCheckoutPlanValue)
    ? pendingCheckoutPlanValue
    : pendingCheckoutPlanValue === "payg"
      ? "payg"
    : null;
  const pendingMigrationPlanValue = String(
    migrationFetcher.formData?.get("plan") || "",
  );
  const pendingMigrationPlan = isTrialPlan(pendingMigrationPlanValue)
    ? pendingMigrationPlanValue
    : null;
  const isSavingProvider = providerFetcher.state !== "idle";
  const isStartingCheckout = checkoutFetcher.state !== "idle";
  const isMigrating = migrationFetcher.state !== "idle";

  const subtitle = legacyMigration?.eligible
    ? "Pick a paid plan to switch over from your existing subscription, or bring your own API key to keep using camelAI on the free tier."
    : paywallContext.multiOrg
      ? `${paywallContext.currentOrgName} is on the Free plan with no API key set up. Pick a plan, or switch to an organization with an active plan using the sidebar.`
    : paywallContext.byokProviderLabel
        ? `Your ${paywallContext.byokProviderLabel} API key is connected. Continue on Free, use prepaid hosted credits, or start a subscription.`
        : paywallContext.trialAvailable
          ? "Start a free trial, use prepaid hosted credits, or bring your own API key."
          : "Choose a plan, use prepaid hosted credits, or bring your own API key.";

  const disabledReason =
    planPickerOverrides?.disabledReason ??
    (legacyMigration?.eligible &&
    legacyMigration.activeLegacySubscriptionCount > 1
      ? "This account has multiple active subscriptions. Contact support@camelai.com to switch over without double billing."
      : null);

  useEffect(() => {
    if (!legacyMigrationKey) {
      legacyDialogKeyRef.current = null;
      setLegacyIntroOpen(false);
      return;
    }

    if (legacyDialogKeyRef.current !== legacyMigrationKey) {
      legacyDialogKeyRef.current = legacyMigrationKey;
      setLegacyIntroOpen(true);
    }
  }, [legacyMigrationKey]);

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
    if (migrationFetcher.state !== "idle") {
      return;
    }
    if (migrationFetcher.data?.billingPortalUrl) {
      setLegacyConfirmation({
        billingPortalUrl: migrationFetcher.data.billingPortalUrl,
        preview: migrationFetcher.data.legacyMigrationPreview ?? null,
      });
      return;
    }
    if (!migrationFetcher.data?.success) {
      return;
    }
    window.location.reload();
  }, [migrationFetcher.data, migrationFetcher.state]);

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
    if (cta.kind === "migrate") {
      if (isMigrating) {
        return;
      }
      migrationFetcher.submit(
        { plan: cta.plan },
        {
          method: "post",
          action: "/api/billing/legacy-migration",
        },
      );
      return;
    }
    if (cta.kind === "trial") {
      if (isStartingCheckout) {
        return;
      }
      checkoutFetcher.submit(
        { plan: cta.plan },
        {
          method: "post",
          action: "/api/billing/start-trial",
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
          {legacyMigration?.eligible ? (
            <>
              <LegacyMigrationDialog
                migration={legacyMigration}
                open={legacyIntroOpen}
                onOpenChange={setLegacyIntroOpen}
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
            </>
          ) : null}

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

          {migrationError ? (
            <Alert variant="destructive" className="text-left">
              <AlertDescription>{migrationError}</AlertDescription>
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
            trialAvailable={paywallContext.trialAvailable}
            byokProviderLabel={paywallContext.byokProviderLabel}
            legacyMigration={legacyMigration}
            onLegacyWhyClick={() => setLegacyIntroOpen(true)}
            pendingPlan={
              isStartingCheckout
                ? pendingCheckoutPlan
                : isMigrating
                  ? pendingMigrationPlan
                  : null
            }
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
