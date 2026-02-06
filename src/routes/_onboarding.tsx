import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Outlet,
  redirect,
  useLoaderData,
  useLocation,
  useNavigate,
  type ShouldRevalidateFunctionArgs,
} from 'react-router';
import type { Route } from './+types/_onboarding';
import { getAuthEnv, requireSession } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getVanityDomain } from '@/lib/app-url';
import {
  ONBOARDING_PROGRESS_STORAGE_KEY_PREFIX,
  DEFAULT_ONBOARDING_PREFERENCES,
  type OnboardingProgressState,
  type OnboardingStepId,
  type OnboardingTransitionDirection,
  STEP_PATHS,
  getOnboardingProgressStorageKey,
  getNearestValidStep,
  getStepIndex,
  getStepSequence,
  hasCompletedOnboarding,
  normalizePreferences,
  stepIdFromPath,
} from '@/lib/onboarding';
import type { OnboardingPreferences } from '@/types';

interface OnboardingLoaderData {
  userId: string;
  orgId: string;
  onboarding: OnboardingPreferences | null;
  teamWelcomeOnly: boolean;
  vanityDomain: string;
  teamMode: boolean;
}

const ONBOARDING_AUTO_START_CHAT_KEY = 'chiridion:onboarding:auto-start-chat';

export interface OnboardingRouteContext extends OnboardingLoaderData {
  answers: OnboardingPreferences;
  showOrgSlugStep: boolean;
  setShowOrgSlugStep: (show: boolean) => void;
  pendingOrgSlug: string | null;
  setPendingOrgSlug: (slug: string | null) => void;
  transitionDirection: OnboardingTransitionDirection;
  updateAnswers: (updates: Partial<OnboardingPreferences>) => void;
  currentStep: OnboardingStepId;
  sequence: OnboardingStepId[];
  currentStepIndex: number;
  totalSteps: number;
  skipToChat: () => void;
  saveOnboarding: (overrides?: Partial<OnboardingPreferences>) => Promise<OnboardingPreferences>;
  completeOnboarding: (overrides?: Partial<OnboardingPreferences>) => Promise<void>;
  clearStoredProgress: () => void;
}

function mergeAnswers(
  current: OnboardingPreferences,
  updates: Partial<OnboardingPreferences>
): OnboardingPreferences {
  return normalizePreferences({
    ...current,
    ...updates,
    data_interests: {
      files: updates.data_interests?.files ?? current.data_interests.files,
      integrations:
        updates.data_interests?.integrations ?? current.data_interests.integrations,
    },
  });
}

function readStoredProgress(storageKey: string): OnboardingProgressState | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OnboardingProgressState;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.currentStep !== 'string') return null;
    if (!parsed.answers || typeof parsed.answers !== 'object') return null;
    if (typeof parsed.startedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sessionContext = await requireSession(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const userStub = authEnv.USER.get(
    authEnv.USER.idFromName(sessionContext.session.user_id)
  );
  const authBootstrap = await userStub.getAuthBootstrap();

  if (!authBootstrap.profile) {
    const url = new URL(request.url);
    const redirectTo = encodeURIComponent(url.pathname + url.search);
    throw redirect(`/login?redirect=${redirectTo}`);
  }

  const url = new URL(request.url);
  const teamMode = url.searchParams.get('team') === '1';
  const onboarding = authBootstrap.onboarding;
  const onboardingComplete = hasCompletedOnboarding(onboarding);

  if (onboardingComplete && !teamMode) {
    throw redirect('/chat');
  }

  return {
    userId: authBootstrap.profile.id,
    orgId: sessionContext.session.org_id,
    onboarding,
    teamWelcomeOnly: onboardingComplete && teamMode,
    vanityDomain: getVanityDomain(request.headers.get('host')?.split(':')[0]),
    teamMode,
  } satisfies OnboardingLoaderData;
}

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (formMethod && formMethod.toUpperCase() !== 'GET') {
    return defaultShouldRevalidate;
  }

  const currentOnboarding = currentUrl.pathname.startsWith('/onboarding');
  const nextOnboarding = nextUrl.pathname.startsWith('/onboarding');
  if (!currentOnboarding || !nextOnboarding) {
    return defaultShouldRevalidate;
  }

  const currentTeam = currentUrl.searchParams.get('team');
  const nextTeam = nextUrl.searchParams.get('team');
  if (currentTeam !== nextTeam) {
    return defaultShouldRevalidate;
  }

  return false;
}

export default function OnboardingLayout() {
  const loaderData = useLoaderData<typeof loader>() as OnboardingLoaderData;
  const location = useLocation();
  const navigate = useNavigate();
  const [answers, setAnswers] = useState<OnboardingPreferences>(() =>
    normalizePreferences(loaderData.onboarding ?? DEFAULT_ONBOARDING_PREFERENCES)
  );
  const [showOrgSlugStep, setShowOrgSlugStepState] = useState<boolean>(() =>
    location.pathname === STEP_PATHS.orgSlug
  );
  const [pendingOrgSlugState, setPendingOrgSlugState] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number>(() => Date.now());
  const [hasRestoredProgress, setHasRestoredProgress] = useState(false);
  const [transitionDirection, setTransitionDirection] =
    useState<OnboardingTransitionDirection>('none');
  const previousStepIndexRef = useRef<number | null>(null);
  const resetHandledRef = useRef(false);
  const resetRequested = useMemo(
    () => new URLSearchParams(location.search).get('reset') === '1',
    [location.search]
  );
  const querySuffix = loaderData.teamMode ? '?team=1' : '';
  const progressStorageKey = useMemo(
    () => getOnboardingProgressStorageKey(loaderData.userId),
    [loaderData.userId]
  );

  const currentStep = useMemo(
    () => stepIdFromPath(location.pathname),
    [location.pathname]
  );
  const sequence = useMemo(
    () =>
      getStepSequence({
        showOrgSlugStep,
        aiFamiliarity: answers.ai_familiarity,
        teamWelcomeOnly: loaderData.teamWelcomeOnly,
      }),
    [answers.ai_familiarity, showOrgSlugStep, loaderData.teamWelcomeOnly]
  );
  const currentStepIndex = getStepIndex(currentStep, sequence);
  const totalSteps = sequence.length;

  const clearStoredProgress = useCallback(() => {
    localStorage.removeItem(progressStorageKey);
  }, [progressStorageKey]);

  const setPendingOrgSlug = useCallback((slug: string | null) => {
    setPendingOrgSlugState(slug ? slug.trim().toLowerCase() : null);
  }, []);

  const setShowOrgSlugStep = useCallback((show: boolean) => {
    setShowOrgSlugStepState(show);
  }, []);

  const saveOnboarding = useCallback(
    async (overrides?: Partial<OnboardingPreferences>) => {
      const payload = mergeAnswers(answers, overrides ?? {});
      const response = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error('Failed to save onboarding');
      }
      const data = (await response.json()) as { onboarding?: OnboardingPreferences };
      const saved = normalizePreferences(data.onboarding ?? payload);
      setAnswers(saved);
      return saved;
    },
    [answers]
  );

  const completeOnboarding = useCallback(
    async (overrides?: Partial<OnboardingPreferences>) => {
      const withOverrides = mergeAnswers(answers, overrides ?? {});
      const desiredSlug = pendingOrgSlugState?.trim().toLowerCase() ?? null;

      if (showOrgSlugStep && desiredSlug) {
        const response = await fetch(`/api/orgs/${loaderData.orgId}/update-slug`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: desiredSlug }),
        });
        if (!response.ok) {
          let errorMessage = 'Failed to update org slug';
          try {
            const data = (await response.json()) as { error?: string };
            if (data.error) errorMessage = data.error;
          } catch {
            // Ignore parse failures and keep default message.
          }
          throw new Error(errorMessage);
        }
      }

      const completed = mergeAnswers(withOverrides, { completed_at: Date.now() });
      await saveOnboarding(completed);
      clearStoredProgress();
      try {
        sessionStorage.setItem(ONBOARDING_AUTO_START_CHAT_KEY, '1');
      } catch (error) {
        console.error('Failed to persist onboarding auto-start flag:', error);
      }
      navigate('/chat');
    },
    [
      answers,
      clearStoredProgress,
      loaderData.orgId,
      navigate,
      pendingOrgSlugState,
      saveOnboarding,
      showOrgSlugStep,
    ]
  );

  const skipToChat = useCallback(() => {
    clearStoredProgress();
    navigate('/chat');
  }, [clearStoredProgress, navigate]);

  const updateAnswers = useCallback((updates: Partial<OnboardingPreferences>) => {
    setAnswers((previous) => mergeAnswers(previous, updates));
  }, []);

  useEffect(() => {
    if (!resetRequested || resetHandledRef.current) return;
    resetHandledRef.current = true;

    const keysToClear: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(ONBOARDING_PROGRESS_STORAGE_KEY_PREFIX)) {
        keysToClear.push(key);
      }
    }
    for (const key of keysToClear) {
      localStorage.removeItem(key);
    }

    setAnswers(normalizePreferences(loaderData.onboarding ?? DEFAULT_ONBOARDING_PREFERENCES));
    setPendingOrgSlug(null);
    setShowOrgSlugStep(false);
    setStartedAt(Date.now());
    setHasRestoredProgress(false);

    const params = new URLSearchParams(location.search);
    params.delete('reset');
    const nextSearch = params.toString();
    navigate(
      `${location.pathname}${nextSearch ? `?${nextSearch}` : ''}`,
      { replace: true }
    );
  }, [
    loaderData.onboarding,
    location.pathname,
    location.search,
    navigate,
    resetRequested,
    setPendingOrgSlug,
    setShowOrgSlugStep,
  ]);

  useEffect(() => {
    if (loaderData.teamWelcomeOnly) {
      setHasRestoredProgress(true);
      return;
    }
    if (hasRestoredProgress) return;

    const stored = readStoredProgress(progressStorageKey);
    if (stored) {
      setAnswers((previous) =>
        mergeAnswers(previous, stored.answers as Partial<OnboardingPreferences>)
      );
      setStartedAt(stored.startedAt);
      setPendingOrgSlug(stored.pendingOrgSlug ?? null);
      setShowOrgSlugStep(
        Boolean(stored.showOrgSlugStep || stored.currentStep === 'orgSlug')
      );

      const storedPath = STEP_PATHS[stored.currentStep];
      if (storedPath && storedPath !== location.pathname) {
        navigate(`${storedPath}${querySuffix}`, { replace: true });
      }
    }
    setHasRestoredProgress(true);
  }, [
    hasRestoredProgress,
    loaderData.teamWelcomeOnly,
    location.pathname,
    navigate,
    progressStorageKey,
    querySuffix,
    setPendingOrgSlug,
    setShowOrgSlugStep,
  ]);

  useEffect(() => {
    if (loaderData.teamWelcomeOnly) return;
    if (currentStepIndex < 0 && sequence.length > 0) {
      const fallbackStep = getNearestValidStep(currentStep, sequence) ?? sequence[0];
      navigate(`${STEP_PATHS[fallbackStep]}${querySuffix}`, { replace: true });
    }
  }, [
    currentStep,
    currentStepIndex,
    loaderData.teamWelcomeOnly,
    navigate,
    querySuffix,
    sequence,
  ]);

  useEffect(() => {
    if (currentStepIndex < 0) return;
    const previousIndex = previousStepIndexRef.current;
    if (previousIndex === null) {
      setTransitionDirection('none');
    } else if (currentStepIndex > previousIndex) {
      setTransitionDirection('forward');
    } else if (currentStepIndex < previousIndex) {
      setTransitionDirection('backward');
    } else {
      setTransitionDirection('none');
    }
    previousStepIndexRef.current = currentStepIndex;
  }, [currentStepIndex]);

  useEffect(() => {
    if (loaderData.teamWelcomeOnly) return;
    if (!hasRestoredProgress) return;
    const progress: OnboardingProgressState = {
      currentStep,
      answers,
      startedAt,
      pendingOrgSlug: pendingOrgSlugState,
      showOrgSlugStep,
    };
    localStorage.setItem(progressStorageKey, JSON.stringify(progress));
  }, [
    answers,
    currentStep,
    hasRestoredProgress,
    loaderData.teamWelcomeOnly,
    pendingOrgSlugState,
    progressStorageKey,
    showOrgSlugStep,
    startedAt,
  ]);

  const contextValue: OnboardingRouteContext = {
    ...loaderData,
    answers,
    showOrgSlugStep,
    setShowOrgSlugStep,
    pendingOrgSlug: pendingOrgSlugState,
    setPendingOrgSlug,
    transitionDirection,
    updateAnswers,
    currentStep,
    sequence,
    currentStepIndex,
    totalSteps,
    skipToChat,
    saveOnboarding,
    completeOnboarding,
    clearStoredProgress,
  };

  return <Outlet context={contextValue} />;
}
