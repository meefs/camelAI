import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, redirect, useLoaderData, useLocation, useNavigate } from 'react-router';
import type { Route } from './+types/_onboarding';
import { getAuthEnv, requireAuthContext } from '@/lib/auth.server';
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
  getNextStep,
  getPreviousStep,
  getStepIndex,
  getStepSequence,
  hasCompletedOnboarding,
  normalizePreferences,
  stepIdFromPath,
} from '@/lib/onboarding';
import type { OnboardingPreferences } from '@/types';

interface OnboardingLoaderData {
  userId: string;
  onboarding: OnboardingPreferences | null;
  currentOrg: {
    id: string;
    name: string;
    slug: string;
  };
  showOrgSlugStep: boolean;
  teamVariant: boolean;
  teamWelcomeOnly: boolean;
  teamContext: {
    memberCount: number;
    appCount: number;
    integrations: string[];
  };
  vanityDomain: string;
  teamMode: boolean;
}

const PENDING_NEW_THREAD_MESSAGE_KEY = 'pendingMessage:newThread';

export interface OnboardingRouteContext extends OnboardingLoaderData {
  answers: OnboardingPreferences;
  pendingOrgSlug: string | null;
  setPendingOrgSlug: (slug: string | null) => void;
  transitionDirection: OnboardingTransitionDirection;
  updateAnswers: (updates: Partial<OnboardingPreferences>) => void;
  currentStep: OnboardingStepId;
  sequence: OnboardingStepId[];
  currentStepIndex: number;
  totalSteps: number;
  goBack: (step?: OnboardingStepId) => void;
  goNext: (step?: OnboardingStepId) => void;
  goToStep: (step: OnboardingStepId) => void;
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
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const url = new URL(request.url);
  const teamMode = url.searchParams.get('team') === '1';
  const onboarding = authContext.onboarding;
  const onboardingComplete = hasCompletedOnboarding(onboarding);

  if (onboardingComplete && !teamMode) {
    throw redirect('/chat');
  }

  const orgStub = authEnv.ORG.get(
    authEnv.ORG.idFromName(authContext.currentOrg.id)
  );
  const membership = authContext.orgs.find(
    (org) => org.org_id === authContext.currentOrg.id
  );

  const [memberCount, workerScripts, integrations] = await Promise.all([
    orgStub.getMemberCount(),
    orgStub.listWorkerScripts(),
    authContext.currentWorkspace
      ? authEnv.WORKSPACE.get(
          authEnv.WORKSPACE.idFromName(authContext.currentWorkspace.id)
        )
          .getIntegrations()
          .then((rows: Array<{ enabled: number; name: string }>) =>
            rows
              .filter((row: { enabled: number }) => row.enabled === 1)
              .map((row: { name: string }) => row.name)
          )
      : Promise.resolve([] as string[]),
  ]);

  const showOrgSlugStep =
    membership?.role === 'owner' &&
    memberCount === 1 &&
    workerScripts.length === 0;

  const teamVariant = teamMode;

  return {
    userId: authContext.user.id,
    onboarding,
    currentOrg: {
      id: authContext.currentOrg.id,
      name: authContext.currentOrg.name,
      slug: authContext.currentOrg.slug,
    },
    showOrgSlugStep,
    teamVariant,
    teamWelcomeOnly: onboardingComplete && teamMode,
    teamContext: {
      memberCount,
      appCount: workerScripts.length,
      integrations: integrations.slice(0, 4),
    },
    vanityDomain: getVanityDomain(request.headers.get('host')?.split(':')[0]),
    teamMode,
  } satisfies OnboardingLoaderData;
}

export default function OnboardingLayout() {
  const loaderData = useLoaderData<typeof loader>() as OnboardingLoaderData;
  const location = useLocation();
  const navigate = useNavigate();
  const [answers, setAnswers] = useState<OnboardingPreferences>(() =>
    normalizePreferences(loaderData.onboarding ?? DEFAULT_ONBOARDING_PREFERENCES)
  );
  const [pendingOrgSlugState, setPendingOrgSlugState] = useState<string | null>(
    () => loaderData.currentOrg.slug
  );
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
        showOrgSlugStep: loaderData.showOrgSlugStep,
        aiFamiliarity: answers.ai_familiarity,
        teamWelcomeOnly: loaderData.teamWelcomeOnly,
      }),
    [answers.ai_familiarity, loaderData.showOrgSlugStep, loaderData.teamWelcomeOnly]
  );
  const currentStepIndex = getStepIndex(currentStep, sequence);
  const totalSteps = sequence.length;

  const goToStep = useCallback(
    (step: OnboardingStepId) => {
      navigate(`${STEP_PATHS[step]}${querySuffix}`);
    },
    [navigate, querySuffix]
  );

  const goNext = useCallback(
    (step?: OnboardingStepId) => {
      const source = step ?? currentStep;
      const next = getNextStep(source, sequence);
      if (next) {
        goToStep(next);
      }
    },
    [currentStep, goToStep, sequence]
  );

  const goBack = useCallback(
    (step?: OnboardingStepId) => {
      const source = step ?? currentStep;
      const previous = getPreviousStep(source, sequence);
      if (previous) {
        goToStep(previous);
      }
    },
    [currentStep, goToStep, sequence]
  );

  const clearStoredProgress = useCallback(() => {
    localStorage.removeItem(progressStorageKey);
  }, [progressStorageKey]);

  const setPendingOrgSlug = useCallback((slug: string | null) => {
    setPendingOrgSlugState(slug ? slug.trim().toLowerCase() : null);
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

      if (
        loaderData.showOrgSlugStep &&
        desiredSlug &&
        desiredSlug !== loaderData.currentOrg.slug
      ) {
        const response = await fetch(`/api/orgs/${loaderData.currentOrg.id}/update-slug`, {
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
        const formData = new FormData();
        formData.set('intent', 'createThread');
        const createThreadResponse = await fetch('/chat', {
          method: 'POST',
          body: formData,
        });

        if (createThreadResponse.ok) {
          const data = (await createThreadResponse.json()) as {
            thread?: { id?: string };
            onboardingSystemMessage?: string | null;
          };
          const threadId = data.thread?.id;
          if (threadId) {
            const onboardingSystemMessage = data.onboardingSystemMessage?.trim();
            if (onboardingSystemMessage) {
              const hiddenOnboardingMessage = `<chiridion system message>${onboardingSystemMessage}</chiridion system message>`;
              sessionStorage.setItem(
                PENDING_NEW_THREAD_MESSAGE_KEY,
                JSON.stringify({ message: hiddenOnboardingMessage, threadId })
              );
            }
            navigate(`/chat/${threadId}?newThread=1`);
            return;
          }
        }
      } catch (error) {
        console.error('Failed to auto-start chat after onboarding:', error);
      }

      navigate('/chat');
    },
    [
      answers,
      clearStoredProgress,
      loaderData.currentOrg.id,
      loaderData.currentOrg.slug,
      loaderData.showOrgSlugStep,
      navigate,
      pendingOrgSlugState,
      saveOnboarding,
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
    setPendingOrgSlug(loaderData.currentOrg.slug);
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
    loaderData.currentOrg.slug,
    loaderData.onboarding,
    location.pathname,
    location.search,
    navigate,
    resetRequested,
    setPendingOrgSlug,
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
      setPendingOrgSlug(
        stored.pendingOrgSlug ?? loaderData.currentOrg.slug
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
    loaderData.currentOrg.slug,
    progressStorageKey,
    querySuffix,
    setPendingOrgSlug,
  ]);

  useEffect(() => {
    if (loaderData.teamWelcomeOnly) return;
    if (currentStepIndex < 0 && sequence.length > 0) {
      let fallbackStep = sequence[0];
      if (
        answers.ai_familiarity === 'extensive' &&
        (currentStep === 'q2' || currentStep === 'q3')
      ) {
        fallbackStep = 'q4';
      }
      if (answers.ai_familiarity === 'extensive' && currentStep === 'q5') {
        fallbackStep = 'q6';
      }
      navigate(`${STEP_PATHS[fallbackStep]}${querySuffix}`, { replace: true });
    }
  }, [
    answers.ai_familiarity,
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
    };
    localStorage.setItem(progressStorageKey, JSON.stringify(progress));
  }, [
    answers,
    currentStep,
    hasRestoredProgress,
    loaderData.teamWelcomeOnly,
    pendingOrgSlugState,
    progressStorageKey,
    startedAt,
  ]);

  const contextValue: OnboardingRouteContext = {
    ...loaderData,
    answers,
    pendingOrgSlug: pendingOrgSlugState,
    setPendingOrgSlug,
    transitionDirection,
    updateAnswers,
    currentStep,
    sequence,
    currentStepIndex,
    totalSteps,
    goBack,
    goNext,
    goToStep,
    skipToChat,
    saveOnboarding,
    completeOnboarding,
    clearStoredProgress,
  };

  return <Outlet context={contextValue} />;
}
