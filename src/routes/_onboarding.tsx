import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Outlet, redirect, useLoaderData, useNavigate } from "react-router";
import type { Route } from "./+types/_onboarding";
import { getAuthEnv, requireSession } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { hasCompletedOnboarding } from "@/lib/onboarding";
import { OnboardingLayout } from "@/components/onboarding/onboarding-layout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface OnboardingLoaderData {
  userEmail: string;
  teamMode: boolean;
  onboardingComplete: boolean;
  emailVerificationRequired: boolean;
  emailVerified: boolean;
}

const PENDING_NEW_THREAD_MESSAGE_KEY = "pendingMessage:newThread";
const AUTO_COMPLETE_MAX_ATTEMPTS = 3;
const AUTO_COMPLETE_RETRY_DELAY_MS = 600;

type CompleteOnboardingError = Error & { status?: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryAutoComplete(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: number }).status
      : undefined;
  if (status == null) {
    return true;
  }
  return status === 408 || status === 429 || status >= 500;
}

function getAutoCompleteErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return "Failed to complete onboarding. Please try again.";
}

export interface OnboardingRouteContext {
  completeOnboarding: () => Promise<void>;
  skipToChat: () => void;
  teamMode: boolean;
  onboardingComplete: boolean;
  userEmail: string;
  emailVerificationRequired: boolean;
  emailVerified: boolean;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sessionContext = await requireSession(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const userStub = authEnv.USER.get(
    authEnv.USER.idFromName(sessionContext.session.user_id),
  );
  const [authBootstrap, emailVerificationStatus] = await Promise.all([
    userStub.getAuthBootstrap(),
    userStub.getEmailVerificationStatus(),
  ]);

  if (!authBootstrap.profile) {
    const url = new URL(request.url);
    const redirectTo = encodeURIComponent(url.pathname + url.search);
    throw redirect(`/login?redirect=${redirectTo}`);
  }

  const url = new URL(request.url);
  const teamMode = url.searchParams.get("team") === "1";
  const onboarding = authBootstrap.onboarding;
  const onboardingComplete = hasCompletedOnboarding(onboarding);
  const emailVerificationRequired =
    emailVerificationStatus.required && !emailVerificationStatus.verified;

  if (onboardingComplete && !teamMode && !emailVerificationRequired) {
    throw redirect("/chat");
  }

  return {
    userEmail: authBootstrap.profile.email,
    teamMode,
    onboardingComplete,
    emailVerificationRequired,
    emailVerified: emailVerificationStatus.verified,
  } satisfies OnboardingLoaderData;
}

export default function OnboardingRoute() {
  const loaderData = useLoaderData<typeof loader>() as OnboardingLoaderData;
  const navigate = useNavigate();
  const [autoCompleteError, setAutoCompleteError] = useState<string | null>(
    null,
  );
  const [isAutoCompleting, setIsAutoCompleting] = useState(false);
  const [autoCompleteRunId, setAutoCompleteRunId] = useState(0);
  const autoCompleteRunStartedRef = useRef<number | null>(null);
  const completeOnboardingRequestRef = useRef<Promise<void> | null>(null);
  const skipToChat = useCallback(() => {
    navigate("/chat");
  }, [navigate]);

  const completeOnboarding = useCallback(async () => {
    if (completeOnboardingRequestRef.current) {
      return completeOnboardingRequestRef.current;
    }

    const completeRequest = (async () => {
      const response = await fetch("/api/onboarding/complete", {
        method: "POST",
      });

      if (!response.ok) {
        let errorMessage = "Failed to complete onboarding";
        try {
          const data = (await response.json()) as { error?: string };
          if (data.error) {
            errorMessage = data.error;
          }
        } catch {
          // Ignore parse failures and keep default error message.
        }
        const error = new Error(errorMessage) as CompleteOnboardingError;
        error.status = response.status;
        throw error;
      }

      const data = (await response.json()) as {
        redirectTo?: string;
        threadId?: string;
        onboardingSystemMessage?: string | null;
        salesPrompt?: string | null;
      };

      const threadId = data.threadId?.trim();
      const onboardingSystemMessage = data.onboardingSystemMessage?.trim();
      const salesPrompt = data.salesPrompt?.trim();

      if (threadId && onboardingSystemMessage) {
        try {
          const pendingMessage = salesPrompt
            ? `<camelai system message>${onboardingSystemMessage}</camelai system message>\n\n${salesPrompt}`
            : `<camelai system message>${onboardingSystemMessage}</camelai system message>`;
          sessionStorage.setItem(
            PENDING_NEW_THREAD_MESSAGE_KEY,
            JSON.stringify({
              message: pendingMessage,
              threadId,
            }),
          );
        } catch (error) {
          console.error("Failed to persist onboarding prefill message:", error);
        }
      }

      try {
        sessionStorage.setItem("showBootModal", "1");
      } catch {
        // Ignore storage failures.
      }

      navigate(data.redirectTo || "/chat");
    })();

    completeOnboardingRequestRef.current = completeRequest;

    try {
      await completeRequest;
    } finally {
      completeOnboardingRequestRef.current = null;
    }
  }, [navigate]);

  const needsWelcomeScreen =
    loaderData.teamMode || loaderData.emailVerificationRequired;

  const runAutoComplete = useCallback(async () => {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= AUTO_COMPLETE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await completeOnboarding();
        return;
      } catch (error) {
        lastError = error;
        if (
          attempt >= AUTO_COMPLETE_MAX_ATTEMPTS ||
          !shouldRetryAutoComplete(error)
        ) {
          break;
        }
        await sleep(AUTO_COMPLETE_RETRY_DELAY_MS * attempt);
      }
    }
    throw lastError ?? new Error("Failed to complete onboarding");
  }, [completeOnboarding]);

  useEffect(() => {
    if (needsWelcomeScreen) {
      return;
    }
    if (autoCompleteRunStartedRef.current === autoCompleteRunId) {
      return;
    }
    autoCompleteRunStartedRef.current = autoCompleteRunId;

    let cancelled = false;
    setAutoCompleteError(null);
    setIsAutoCompleting(true);

    runAutoComplete()
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setAutoCompleteError(getAutoCompleteErrorMessage(error));
      })
      .finally(() => {
        if (cancelled) {
          return;
        }
        setIsAutoCompleting(false);
      });

    return () => {
      cancelled = true;
    };
  }, [autoCompleteRunId, needsWelcomeScreen, runAutoComplete]);

  if (!needsWelcomeScreen) {
    if (autoCompleteError) {
      return (
        <OnboardingLayout>
          <div className="space-y-6 text-center">
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight">
                We couldn&apos;t finish onboarding
              </h1>
              <p className="text-muted-foreground">
                Retry and we&apos;ll set up your first chat.
              </p>
            </div>
            <Alert variant="destructive" className="text-left">
              <AlertDescription>{autoCompleteError}</AlertDescription>
            </Alert>
            <div className="pt-2">
              <Button
                type="button"
                size="lg"
                disabled={isAutoCompleting}
                onClick={() => {
                  setAutoCompleteRunId((previous) => previous + 1);
                }}
              >
                {isAutoCompleting ? "Retrying..." : "Try again"}
              </Button>
            </div>
          </div>
        </OnboardingLayout>
      );
    }
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const contextValue: OnboardingRouteContext = {
    completeOnboarding,
    skipToChat,
    teamMode: loaderData.teamMode,
    onboardingComplete: loaderData.onboardingComplete,
    userEmail: loaderData.userEmail,
    emailVerificationRequired: loaderData.emailVerificationRequired,
    emailVerified: loaderData.emailVerified,
  };

  return <Outlet context={contextValue} />;
}
