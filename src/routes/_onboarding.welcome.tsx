import { useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useOutletContext,
} from "react-router";
import type { Route } from "./+types/_onboarding.welcome";
import { getAuthEnv, requireAuthContext, requireSession } from "@/lib/auth.server";
import { createSubscriptionCheckoutSession } from "@/lib/billing.server";
import { getEnv } from "@/lib/cloudflare.server";
import { OnboardingLayout } from "@/components/onboarding/onboarding-layout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { LlmProvider } from "@/types";
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

type OnboardingByokProvider = Extract<LlmProvider, "anthropic" | "openai" | "openrouter">;

const BYOK_PROVIDER_OPTIONS: Array<{
  value: OnboardingByokProvider;
  label: string;
  placeholder: string;
  helper: string;
}> = [
  {
    value: "openrouter",
    label: "OpenRouter",
    placeholder: "sk-or-...",
    helper: "Codex and Claude models billed through OpenRouter.",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    placeholder: "sk-ant-...",
    helper: "Claude models billed through your Anthropic account.",
  },
  {
    value: "openai",
    label: "OpenAI",
    placeholder: "sk-...",
    helper: "Codex models billed through your OpenAI account.",
  },
];

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
    return Response.json({ error: "Unknown onboarding action" }, { status: 400 });
  }

  const successUrl = new URL("/onboarding?checkout=success", request.url).toString();
  const cancelUrl = new URL("/onboarding?checkout=cancelled", request.url).toString();
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
    providerFetcher.state === "idle" ? providerFetcher.data?.error : undefined;
  const selectedProviderOption =
    BYOK_PROVIDER_OPTIONS.find((option) => option.value === selectedProvider) ??
    BYOK_PROVIDER_OPTIONS[0];
  const isSavingProvider = providerFetcher.state !== "idle";
  const isStartingCheckout = checkoutFetcher.state !== "idle";

  useEffect(() => {
    if (checkoutFetcher.state !== "idle" || !checkoutFetcher.data?.checkoutUrl) {
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
    setIsCompleting(true);
    setError(null);
    context
      .completeOnboarding({ accessChoice: "byok" })
      .catch((nextError) => {
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
    providerFetcher.submit(
      {
        intent: "setProvider",
        provider: selectedProvider,
        api_key: providerApiKey.trim(),
      },
      {
        method: "POST",
        action: `/api/orgs/${orgId}/llm-provider`,
        encType: "application/json",
      },
    );
  };

  return (
    <OnboardingLayout>
      <div className="space-y-6 text-center">
        <div className="space-y-3">
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
              {isBillingChoiceRequired ? (
                <p className="text-muted-foreground">
                  Choose how you want to cover model usage.
                </p>
              ) : emailVerificationRequired ? (
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

        {error ? (
          <Alert variant="destructive" className="text-left">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {checkoutError ? (
          <Alert variant="destructive" className="text-left">
            <AlertDescription>{checkoutError}</AlertDescription>
          </Alert>
        ) : null}

        {providerError ? (
          <Alert variant="destructive" className="text-left">
            <AlertDescription>{providerError}</AlertDescription>
          </Alert>
        ) : null}

        {isBillingChoiceRequired ? (
          <div className="space-y-4 text-left">
            <div className="rounded-lg border p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <p className="font-medium">Start the 7-day trial</p>
                  <p className="text-sm text-muted-foreground">
                    Starter includes hosted model credits and then bills monthly through Stripe.
                  </p>
                </div>
                <checkoutFetcher.Form method="post">
                  <input type="hidden" name="intent" value="startTrial" />
                  <Button type="submit" disabled={isStartingCheckout}>
                    {isStartingCheckout ? "Opening Stripe..." : "Start trial"}
                  </Button>
                </checkoutFetcher.Form>
              </div>
            </div>

            <div className="space-y-4 rounded-lg border p-4">
              <div className="space-y-1">
                <p className="font-medium">Use your own provider</p>
                <p className="text-sm text-muted-foreground">
                  Continue without camelAI-hosted credits. Your provider bills you directly.
                </p>
              </div>
              <RadioGroup
                value={selectedProvider}
                onValueChange={(value) => {
                  setSelectedProvider(value as OnboardingByokProvider);
                  setError(null);
                }}
                className="grid gap-2 sm:grid-cols-3"
              >
                {BYOK_PROVIDER_OPTIONS.map((option) => (
                  <Label
                    key={option.value}
                    htmlFor={`provider-${option.value}`}
                    className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm"
                  >
                    <RadioGroupItem
                      id={`provider-${option.value}`}
                      value={option.value}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="block font-medium">{option.label}</span>
                      <span className="block text-muted-foreground">
                        {option.helper}
                      </span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
              <div className="space-y-2">
                <Label htmlFor="provider-api-key">
                  {selectedProviderOption.label} API key
                </Label>
                <Input
                  id="provider-api-key"
                  type="password"
                  value={providerApiKey}
                  placeholder={selectedProviderOption.placeholder}
                  autoComplete="off"
                  onChange={(event) => {
                    setProviderApiKey(event.target.value);
                    setError(null);
                  }}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={isSavingProvider || isCompleting}
                onClick={saveProviderAndContinue}
              >
                {isSavingProvider || isCompleting
                  ? "Saving..."
                  : "Continue with own key"}
              </Button>
            </div>

          </div>
        ) : (
        <div className="pt-2">
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
