import { useCallback, useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { Outlet, redirect, useLoaderData, useNavigate } from 'react-router';
import type { Route } from './+types/_onboarding';
import { getAuthEnv, requireSession } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { hasCompletedOnboarding } from '@/lib/onboarding';

interface OnboardingLoaderData {
  userEmail: string;
  teamMode: boolean;
  onboardingComplete: boolean;
  emailVerificationRequired: boolean;
  emailVerified: boolean;
}

const PENDING_NEW_THREAD_MESSAGE_KEY = 'pendingMessage:newThread';

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
    authEnv.USER.idFromName(sessionContext.session.user_id)
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
  const teamMode = url.searchParams.get('team') === '1';
  const onboarding = authBootstrap.onboarding;
  const onboardingComplete = hasCompletedOnboarding(onboarding);
  const emailVerificationRequired =
    emailVerificationStatus.required && !emailVerificationStatus.verified;

  if (onboardingComplete && !teamMode && !emailVerificationRequired) {
    throw redirect('/chat');
  }

  return {
    userEmail: authBootstrap.profile.email,
    teamMode,
    onboardingComplete,
    emailVerificationRequired,
    emailVerified: emailVerificationStatus.verified,
  } satisfies OnboardingLoaderData;
}

export default function OnboardingLayout() {
  const loaderData = useLoaderData<typeof loader>() as OnboardingLoaderData;
  const navigate = useNavigate();
  const completedRef = useRef(false);
  const completeOnboardingRequestRef = useRef<Promise<void> | null>(null);
  const skipToChat = useCallback(() => {
    navigate('/chat');
  }, [navigate]);

  const completeOnboarding = useCallback(async () => {
    if (completeOnboardingRequestRef.current) {
      return completeOnboardingRequestRef.current;
    }

    const completeRequest = (async () => {
      const response = await fetch('/api/onboarding/complete', {
        method: 'POST',
      });

      if (!response.ok) {
        let errorMessage = 'Failed to complete onboarding';
        try {
          const data = (await response.json()) as { error?: string };
          if (data.error) {
            errorMessage = data.error;
          }
        } catch {
          // Ignore parse failures and keep default error message.
        }
        throw new Error(errorMessage);
      }

      const data = (await response.json()) as {
        redirectTo?: string;
        threadId?: string;
        onboardingSystemMessage?: string | null;
      };

      const threadId = data.threadId?.trim();
      const onboardingSystemMessage = data.onboardingSystemMessage?.trim();

      if (threadId && onboardingSystemMessage) {
        try {
          sessionStorage.setItem(
            PENDING_NEW_THREAD_MESSAGE_KEY,
            JSON.stringify({
              message: `<camelai system message>${onboardingSystemMessage}</camelai system message>`,
              threadId,
            })
          );
        } catch (error) {
          console.error('Failed to persist onboarding prefill message:', error);
        }
      }

      try {
        sessionStorage.setItem('showBootModal', '1');
      } catch {
        // Ignore storage failures.
      }

      navigate(data.redirectTo || '/chat');
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

  useEffect(() => {
    if (needsWelcomeScreen || completedRef.current) {
      return;
    }

    completedRef.current = true;
    completeOnboarding().catch(() => {
      navigate('/chat');
    });
  }, [completeOnboarding, navigate, needsWelcomeScreen]);

  if (!needsWelcomeScreen) {
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
