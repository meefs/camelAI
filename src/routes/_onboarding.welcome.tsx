import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useOutletContext } from "react-router";
import type { Route } from "./+types/_onboarding.welcome";
import {
  getAuthEnv,
  requireAuthContext,
  requireSession,
} from "@/lib/auth.server";
import { createSubscriptionCheckoutSession } from "@/lib/billing.server";
import { getEnv } from "@/lib/cloudflare.server";
import { OnboardingLayout } from "@/components/onboarding/onboarding-layout";
import { PlanPicker } from "@/components/billing/plan-picker";
import { ByokKeyDialog } from "@/components/onboarding/byok-key-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { OnboardingByokProvider } from "@/lib/byok-providers";
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
}

const BOOK_DEMO_URL = "https://book-demo--camelai-team-d9e.camelai.app/";

export async function loader({ request, context }: Route.LoaderArgs) {
  const sessionContext = await requireSession(request, context);
  const url = new URL(request.url);
  const teamMode = url.searchParams.get("team") === "1";

  if (!teamMode) {
    return {
      orgId: sessionContext.session.org_id,
      orgName: "camelAI",
      teamContext: {
        memberCount: 0,
        appCount: 0,
        integrations: [],
      },
    } satisfies WelcomeLoaderData;
  }

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgId = sessionContext.session.org_id;
  const workspaceId = sessionContext.session.workspace_id;
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));

  const [orgName, memberCount, workerScripts, integrations] = await Promise.all(
    [
      orgStub
        .getInfo()
        .then((info) => info?.name ?? "your team")
        .catch(() => "your team"),
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

  if (intent !== "startTrial") {
    return Response.json(
      { error: "Unknown onboarding action" },
      { status: 400 },
    );
  }

  const successUrl = new URL(
    "/onboarding?checkout=success",
    request.url,
  ).toString();
  const cancelUrl = new URL(
    "/onboarding?checkout=cancelled",
    request.url,
  ).toString();
  const checkoutUrl = await createSubscriptionCheckoutSession({
    env,
    org: authContext.currentOrg,
    customerEmail: authContext.user.email,
    successUrl,
    cancelUrl,
    plan: "starter",
    seatCount: 1,
  });

  return Response.json({ checkoutUrl });
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
  const [showProviderError, setShowProviderError] = useState(true);
  const completionStartedRef = useRef(false);
  const providerCompletionStartedRef = useRef(false);
  const verificationFetcher = useFetcher<{
    success?: boolean;
    error?: string;
  }>();
  const checkoutFetcher = useFetcher<{
    checkoutUrl?: string;
    error?: string;
  }>();
  const providerFetcher = useFetcher<{
    success?: boolean;
    error?: string;
  }>();
  const { orgId, orgName, teamContext } = useLoaderData<
    typeof loader
  >() as WelcomeLoaderData;

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
  const providerError =
    showProviderError && providerFetcher.state === "idle"
      ? providerFetcher.data?.error
      : undefined;
  const isSavingProvider = providerFetcher.state !== "idle";
  const isStartingCheckout = checkoutFetcher.state !== "idle";

  useEffect(() => {
    if (
      checkoutFetcher.state !== "idle" ||
      !checkoutFetcher.data?.checkoutUrl
    ) {
      return;
    }
    window.location.assign(checkoutFetcher.data.checkoutUrl);
  }, [checkoutFetcher.data, checkoutFetcher.state]);

  useEffect(() => {
    if (
      providerFetcher.state !== "idle" ||
      !providerFetcher.data?.success ||
      providerCompletionStartedRef.current
    ) {
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
  }, [context, providerFetcher.data, providerFetcher.state]);

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

        {isBillingChoiceRequired ? (
          <div className="space-y-5 text-left">
            <PlanPicker
              defaultBillingMode="individual"
              heading={{
                title: "Choose your plan",
                subtitle:
                  "Start a free trial with model credits, or use your own API key.",
              }}
              pendingPlan={isStartingCheckout ? "starter" : null}
              onSelectPlan={(cta) => {
                // FIXME(billing): trial CTAs silently no-op when Stripe isn't configured.
                // The billing engineer wiring Pro/Team should also handle the unconfigured case
                // server-side (toast on action error path), not by gating these CTAs in the UI.
                setError(null);
                if (cta.kind === "byok") {
                  setShowProviderError(false);
                  setByokDialogOpen(true);
                  return;
                }
                if (cta.kind === "trial" && cta.plan === "starter") {
                  checkoutFetcher.submit(
                    { intent: "startTrial" },
                    { method: "post" },
                  );
                  return;
                }
                if (
                  cta.kind === "trial" &&
                  (cta.plan === "pro" || cta.plan === "team")
                ) {
                  // FIXME(billing): wire Pro and Team trial Stripe checkout — different engineer is owning the Stripe piping.
                  // Team checkout will land on a Stripe page that asks for seat count, so onboarding does not need to collect it.
                  return;
                }
                if (cta.kind === "contact") {
                  window.open(BOOK_DEMO_URL, "_blank");
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
