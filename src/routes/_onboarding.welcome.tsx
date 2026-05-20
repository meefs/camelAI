import { useCallback, useEffect, useRef, useState } from "react";
import {
  redirect,
  useFetcher,
  useLoaderData,
  useOutletContext,
} from "react-router";
import type { Route } from "./+types/_onboarding.welcome";
import {
  getAuthEnv,
  requireAuthContext,
  requireOrgAdmin,
  requireSession,
} from "@/lib/auth.server";
import {
  activatePayAsYouGoPlan,
  createCreditsCheckoutSession,
  createSubscriptionCheckoutSession,
  fetchConfiguredCreditPacks,
  getBillableTeamSeatCountForOrg,
  isStripeBillingConfigured,
} from "@/lib/billing.server";
import { isBillingPlan } from "@/lib/billing-plans";
import { getEnv } from "@/lib/cloudflare.server";
import { OnboardingLayout } from "@/components/onboarding/onboarding-layout";
import { LegacyMigrationDialog } from "@/components/billing/legacy-migration-dialog";
import {
  LegacyMigrationConfirmDialog,
  type LegacyMigrationConfirmation,
} from "@/components/billing/legacy-migration-confirm-dialog";
import {
  TopUpDialog,
  type TopUpDialogPack,
} from "@/components/billing/top-up-dialog";
import { PlanPicker } from "@/components/billing/plan-picker";
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
import {
  getByokProviderLabel,
  type OnboardingByokProvider,
} from "@/lib/byok-providers";
import type { OnboardingRouteContext } from "./_onboarding";

interface TeamContext {
  memberCount: number;
  appCount: number;
  integrations: string[];
}

interface WelcomeLoaderData {
  orgId: string;
  orgName: string;
  teamContext: TeamContext;
  byokProviderLabel: string | null;
  stripeConfigured: boolean;
  creditPacks: TopUpDialogPack[];
}

const BOOK_DEMO_URL = "https://book-demo--camelai-team-d9e.camelai.app/";
const SUBSCRIPTION_PLANS = new Set(["starter", "pro", "team"]);

function isSubscriptionPlan(plan: string): plan is "starter" | "pro" | "team" {
  return isBillingPlan(plan) && SUBSCRIPTION_PLANS.has(plan);
}

function formatPriceLabel(price: {
  unit_amount: number | null;
  currency: string;
}): string | null {
  if (!price.unit_amount) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: price.currency.toUpperCase(),
  }).format(price.unit_amount / 100);
}

function formatCreditPackLabel(price: {
  unit_amount: number | null;
}): string | null {
  if (!price.unit_amount) return null;
  return `${(price.unit_amount / 100).toFixed(2)} credits`;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sessionContext = await requireSession(request, context);
  const url = new URL(request.url);
  const teamMode = url.searchParams.get("team") === "1";
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgId = sessionContext.session.org_id;
  const workspaceId = sessionContext.session.workspace_id;
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const stripeConfigured = isStripeBillingConfigured(env);
  const [orgInfo, llmProviderConfig, creditPacks] = await Promise.all([
    orgStub.getInfo().catch(() => null),
    orgStub.getLlmProviderConfig().catch(() => null),
    stripeConfigured
      ? fetchConfiguredCreditPacks(env).catch(() => [])
      : Promise.resolve([]),
  ]);
  const byokProviderLabel = getByokProviderLabel(llmProviderConfig?.provider);
  const formattedCreditPacks = creditPacks.map((pack) => ({
    id: pack.id,
    priceLabel: formatPriceLabel(pack),
    creditsLabel: formatCreditPackLabel(pack),
  }));

  if (!teamMode) {
    return {
      orgId,
      orgName: "camelAI",
      byokProviderLabel,
      stripeConfigured,
      creditPacks: formattedCreditPacks,
      teamContext: {
        memberCount: 0,
        appCount: 0,
        integrations: [],
      },
    } satisfies WelcomeLoaderData;
  }

  const [orgName, memberCount, workerScripts, integrations] = await Promise.all(
    [
      Promise.resolve(orgInfo?.name ?? "your team"),
      orgStub.getMemberCount(),
      orgStub.listWorkerScripts(),
      workspaceId
        ? authEnv.WORKSPACE.get(authEnv.WORKSPACE.idFromName(workspaceId))
            .getIntegrations()
            .then((rows: Array<{ name: string }>) =>
              rows.map((row: { name: string }) => row.name),
            )
            .catch(() => [] as string[])
        : Promise.resolve([] as string[]),
    ],
  );

  return {
    orgId,
    orgName,
    byokProviderLabel,
    stripeConfigured,
    creditPacks: formattedCreditPacks,
    teamContext: {
      memberCount,
      appCount: workerScripts.length,
      integrations: integrations.slice(0, 4),
    },
  } satisfies WelcomeLoaderData;
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  const successUrl = new URL(
    "/onboarding?checkout=success",
    request.url,
  ).toString();
  const cancelUrl = new URL(
    "/onboarding?checkout=cancelled",
    request.url,
  ).toString();

  if (intent === "buyCredits") {
    await requireOrgAdmin(request, context, authContext.currentOrg.id);
    const priceId = String(formData.get("priceId") || "").trim();

    try {
      const paygOrg = await activatePayAsYouGoPlan({
        env,
        org: authContext.currentOrg,
      });
      const checkoutUrl = await createCreditsCheckoutSession({
        env,
        org: paygOrg,
        customerEmail: authContext.user.email,
        successUrl,
        cancelUrl,
        priceId,
      });
      throw redirect(checkoutUrl);
    } catch (nextError) {
      if (nextError instanceof Response) {
        throw nextError;
      }
      console.error("[onboarding] failed to create credit checkout", nextError);
      return Response.json(
        {
          error:
            nextError instanceof Error
              ? nextError.message
              : "Failed to start credit checkout",
        },
        { status: 503 },
      );
    }
  }

  if (intent !== "startSubscription") {
    return Response.json(
      { error: "Unknown onboarding action" },
      { status: 400 },
    );
  }

  const rawPlan = String(formData.get("plan") || "").trim();
  if (!isSubscriptionPlan(rawPlan)) {
    return Response.json(
      { error: "Choose Starter, Pro, or Team to start a subscription." },
      { status: 400 },
    );
  }

  try {
    const seatCount =
      rawPlan === "team"
        ? await getBillableTeamSeatCountForOrg(env, authContext.currentOrg.id)
        : 1;

    const checkoutUrl = await createSubscriptionCheckoutSession({
      env,
      org: authContext.currentOrg,
      customerEmail: authContext.user.email,
      successUrl,
      cancelUrl,
      plan: rawPlan,
      seatCount,
    });

    return Response.json({ checkoutUrl });
  } catch (nextError) {
    console.error("[onboarding] failed to create subscription checkout", nextError);
    return Response.json(
      {
        error:
          nextError instanceof Error
            ? nextError.message
            : "Failed to start subscription checkout",
      },
      { status: 503 },
    );
  }
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Welcome - camelAI" },
    { name: "description", content: "Welcome to camelAI onboarding" },
  ];
}

function formatTeamSummary(teamContext: TeamContext): string {
  const parts = [
    `${teamContext.memberCount} team ${teamContext.memberCount === 1 ? "member" : "members"}`,
  ];

  if (teamContext.appCount > 0) {
    parts.push(`${teamContext.appCount} apps deployed`);
  }

  if (teamContext.integrations.length > 0) {
    parts.push(`Connected to ${teamContext.integrations.join(", ")}`);
  }

  return parts.join("  •  ");
}

export default function OnboardingWelcomeRoute() {
  const context = useOutletContext<OnboardingRouteContext>();
  const [error, setError] = useState<string | null>(null);
  const [isCompleting, setIsCompleting] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<OnboardingByokProvider>("openrouter");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [awsRegion, setAwsRegion] = useState("us-east-1");
  const [byokDialogOpen, setByokDialogOpen] = useState(false);
  const [paygChoiceOpen, setPaygChoiceOpen] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [showProviderError, setShowProviderError] = useState(true);
  const [legacyIntroOpen, setLegacyIntroOpen] = useState(
    () => context.legacyMigration?.eligible ?? false,
  );
  const [legacyConfirmation, setLegacyConfirmation] =
    useState<LegacyMigrationConfirmation | null>(null);
  const completionStartedRef = useRef(false);
  const providerCompletionStartedRef = useRef(false);
  const verificationFetcher = useFetcher<{
    success?: boolean;
    error?: string;
  }>();
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
  const {
    orgId,
    orgName,
    teamContext,
    byokProviderLabel,
    stripeConfigured = false,
    creditPacks = [],
  } = useLoaderData<typeof loader>() as WelcomeLoaderData;

  const isTeamWelcome = context.teamMode;
  const isBillingChoiceRequired =
    !isTeamWelcome &&
    !context.billingAccessReady &&
    !(context.emailVerificationRequired && !context.emailVerified);
  const isTeamMemberAlreadyOnboarded =
    isTeamWelcome && context.onboardingComplete;
  const emailVerificationRequired =
    context.emailVerificationRequired && !context.emailVerified;
  const verificationSent =
    verificationFetcher.state === "idle" &&
    verificationFetcher.data?.success === true;
  const verificationError =
    verificationFetcher.state === "idle"
      ? verificationFetcher.data?.error
      : undefined;
  const checkoutError =
    checkoutFetcher.state === "idle" ? checkoutFetcher.data?.error : undefined;
  const pendingCheckoutPlanValue = String(
    checkoutFetcher.formData?.get("plan") || "",
  );
  const pendingCheckoutPlan = isSubscriptionPlan(pendingCheckoutPlanValue)
    ? pendingCheckoutPlanValue
    : pendingCheckoutPlanValue === "payg"
      ? "payg"
    : null;
  const providerError =
    showProviderError && providerFetcher.state === "idle"
      ? providerFetcher.data?.error
      : undefined;
  const isSavingProvider = providerFetcher.state !== "idle";
  const isStartingCheckout = checkoutFetcher.state !== "idle";
  const isMigrating = migrationFetcher.state !== "idle";
  const creditTopUpUnavailable = !stripeConfigured || creditPacks.length === 0;
  const migrationError =
    migrationFetcher.state === "idle"
      ? migrationFetcher.data?.error
      : undefined;
  const pendingMigrationPlanValue = String(
    migrationFetcher.formData?.get("plan") || "",
  );
  const pendingMigrationPlan = isSubscriptionPlan(pendingMigrationPlanValue)
    ? pendingMigrationPlanValue
    : null;

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

  const completeWithByok = useCallback(() => {
    if (providerCompletionStartedRef.current) {
      return;
    }
    providerCompletionStartedRef.current = true;
    setByokDialogOpen(false);
    setIsCompleting(true);
    setError(null);
    context.completeOnboarding({ accessChoice: "byok" }).catch((nextError) => {
      providerCompletionStartedRef.current = false;
      setIsCompleting(false);
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Failed to complete onboarding",
      );
    });
  }, [context]);

  const continueWithOwnApiKey = useCallback(() => {
    setPaygChoiceOpen(false);
    if (byokProviderLabel) {
      completeWithByok();
      return;
    }
    setShowProviderError(false);
    setByokDialogOpen(true);
  }, [byokProviderLabel, completeWithByok]);

  const startPayAsYouGoWithCredits = useCallback(() => {
    if (creditTopUpUnavailable) {
      setError("Hosted credit checkout isn't configured in this environment.");
      return;
    }
    setPaygChoiceOpen(false);
    setTopUpOpen(true);
  }, [creditTopUpUnavailable]);

  useEffect(() => {
    if (providerFetcher.state !== "idle" || !providerFetcher.data?.success) {
      return;
    }
    completeWithByok();
  }, [completeWithByok, providerFetcher.data, providerFetcher.state]);

  const saveProviderAndContinue = () => {
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
      action: `/api/orgs/${orgId}/llm-provider`,
      encType: "application/json",
    });
  };

  return (
    <OnboardingLayout
      contentClassName={isBillingChoiceRequired ? "max-w-4xl" : undefined}
    >
      <div className="space-y-4">
        {!isBillingChoiceRequired ? (
          <div className="space-y-3 text-center">
            <h1 className="text-3xl font-semibold tracking-tight">
              {isTeamWelcome ? `Welcome to ${orgName}` : "Welcome to camelAI"}
            </h1>
            {!isTeamWelcome ? (
              <>
                <p className="text-balance text-muted-foreground">
                  camelAI is your AI software engineer. Claude has a permanent
                  computer here, so it can build, deploy, and maintain
                  applications for you.
                </p>
                {emailVerificationRequired ? (
                  <p className="text-muted-foreground">
                    Verify your email to get started.
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <p className="text-muted-foreground">
                  You&apos;re joining a team that&apos;s already building.
                </p>
                <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
                  {formatTeamSummary(teamContext)}
                </div>
                <p className="text-muted-foreground">
                  Let&apos;s get you set up.
                </p>
              </>
            )}
          </div>
        ) : null}

        {emailVerificationRequired ? (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-4 text-left">
            <p className="text-sm font-medium">Verify your email</p>
            <p className="text-sm text-muted-foreground">
              We sent a verification link to {context.userEmail}. You&apos;ll
              need to confirm it before continuing.
            </p>
            {verificationSent ? (
              <p className="text-sm text-muted-foreground">
                Verification email sent.
              </p>
            ) : null}
            {verificationError ? (
              <Alert variant="destructive">
                <AlertDescription>{verificationError}</AlertDescription>
              </Alert>
            ) : null}
            <verificationFetcher.Form
              method="post"
              action="/api/auth/verify-email/send"
            >
              <Button
                type="submit"
                variant="outline"
                disabled={verificationFetcher.state !== "idle"}
              >
                {verificationFetcher.state !== "idle"
                  ? "Sending..."
                  : verificationSent
                    ? "Resend verification email"
                    : "Send verification email"}
              </Button>
            </verificationFetcher.Form>
          </div>
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

        {isBillingChoiceRequired ? (
          <div className="space-y-5 text-left">
            {context.legacyMigration?.eligible ? (
              <>
                <LegacyMigrationDialog
                  migration={context.legacyMigration}
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
                      window.location.assign(
                        legacyConfirmation.billingPortalUrl,
                      );
                    }
                  }}
                />
              </>
            ) : null}

            <PlanPicker
              defaultBillingMode="individual"
              heading={{
                title: "Choose your plan",
                subtitle: context.legacyMigration?.eligible
                  ? "Pick a paid plan to switch over from your existing subscription, or bring your own API key to keep using camelAI on the free tier."
                  : byokProviderLabel
                    ? `Your ${byokProviderLabel} API key is connected. Continue on Free, use prepaid hosted credits, or start a subscription.`
                    : "Choose a plan, use prepaid hosted credits, or bring your own API key.",
              }}
              byokProviderLabel={byokProviderLabel}
              legacyMigration={context.legacyMigration}
              disabledReason={
                context.legacyMigration?.eligible &&
                context.legacyMigration.activeLegacySubscriptionCount > 1
                  ? "This account has multiple active subscriptions. Contact support@camelai.com to switch over without double billing."
                  : null
              }
              onLegacyWhyClick={() => setLegacyIntroOpen(true)}
              pendingPlan={
                isStartingCheckout
                  ? pendingCheckoutPlan
                  : isMigrating
                    ? pendingMigrationPlan
                    : null
              }
              onSelectPlan={(cta) => {
                setError(null);
                if (cta.kind === "byok") {
                  continueWithOwnApiKey();
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
                if (cta.kind === "subscribe") {
                  if (isStartingCheckout) {
                    return;
                  }
                  checkoutFetcher.submit(
                    { intent: "startSubscription", plan: cta.plan },
                    { method: "post" },
                  );
                  return;
                }
                if (cta.kind === "payg") {
                  setPaygChoiceOpen(true);
                  return;
                }
                if (cta.kind === "contact") {
                  window.open(BOOK_DEMO_URL, "_blank", "noopener,noreferrer");
                }
              }}
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
              isSubmitting={isSavingProvider || isCompleting}
              errorMessage={error ?? providerError ?? null}
            />

            <Dialog open={paygChoiceOpen} onOpenChange={setPaygChoiceOpen}>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Continue with Pay as you go</DialogTitle>
                  <DialogDescription>
                    Choose how to connect an LLM provider. Purchase credits and
                    camelAI will provide hosted models, or bring your own API
                    key.
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
                    disabled={creditTopUpUnavailable}
                    onClick={startPayAsYouGoWithCredits}
                  >
                    Purchase credits
                  </Button>
                </DialogFooter>
                {creditTopUpUnavailable ? (
                  <p className="text-sm text-muted-foreground">
                    Hosted credit checkout isn't configured in this
                    environment.
                  </p>
                ) : null}
              </DialogContent>
            </Dialog>

            {creditPacks.length > 0 ? (
              <TopUpDialog
                open={topUpOpen}
                onOpenChange={setTopUpOpen}
                packs={creditPacks}
              />
            ) : null}
          </div>
        ) : (
          <div className="flex justify-center pt-2">
            <Button
              type="button"
              size="lg"
              disabled={emailVerificationRequired || isCompleting}
              onClick={async () => {
                if (isTeamMemberAlreadyOnboarded) {
                  context.skipToChat();
                  return;
                }
                if (completionStartedRef.current) {
                  return;
                }
                completionStartedRef.current = true;
                setIsCompleting(true);
                setError(null);
                try {
                  await context.completeOnboarding();
                } catch (nextError) {
                  completionStartedRef.current = false;
                  setIsCompleting(false);
                  setError(
                    nextError instanceof Error
                      ? nextError.message
                      : "Failed to complete onboarding",
                  );
                }
              }}
            >
              {isCompleting ? "Getting Started..." : "Get Started"}
            </Button>
          </div>
        )}
      </div>
    </OnboardingLayout>
  );
}
