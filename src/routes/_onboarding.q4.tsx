import { useNavigate, useOutletContext } from 'react-router';
import type { Route } from './+types/_onboarding.q4';
import { OnboardingLayout } from '@/components/onboarding/onboarding-layout';
import { DesignStyleCard } from '@/components/onboarding/design-style-card';
import { DESIGN_STYLE_PREVIEWS } from '@/components/onboarding/design-style-previews';
import { useDelayedAdvance } from '@/components/onboarding/use-delayed-advance';
import {
  DESIGN_STYLE_OPTIONS,
  STEP_PATHS,
  getNextStep,
  getPreviousStep,
} from '@/lib/onboarding';
import { cn } from '@/lib/utils';
import type { OnboardingDesignStyle } from '@/types';
import type { OnboardingRouteContext } from './_onboarding';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Design Style - Chiridion' },
    { name: 'description', content: 'Choose a design vibe for first projects' },
  ];
}

export const links: Route.LinksFunction = () => [
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Nunito:wght@700;800&family=JetBrains+Mono:wght@400;500&family=Lora:wght@400;600;700&family=Instrument+Serif&family=DM+Sans:wght@400;500;700&display=swap',
  },
];

export default function OnboardingQ4Route() {
  const context = useOutletContext<OnboardingRouteContext>();
  const navigate = useNavigate();
  const querySuffix = context.teamMode ? '?team=1' : '';
  const previousStep = getPreviousStep('q4', context.sequence);
  const nextStep = getNextStep('q4', context.sequence);
  const { isAdvancing, scheduleAdvance } = useDelayedAdvance(() => {
    if (!nextStep) return;
    navigate(`${STEP_PATHS[nextStep]}${querySuffix}`);
  });
  const visualStyles = DESIGN_STYLE_OPTIONS.filter(
    (style) => style.value !== 'per_project'
  );

  const selectStyle = (value: OnboardingDesignStyle) => {
    if (isAdvancing) return;
    context.updateAnswers({ design_style: value });
    scheduleAdvance();
  };

  return (
    <OnboardingLayout
      currentStep={Math.max(1, context.currentStepIndex + 1)}
      totalSteps={context.totalSteps}
      transitionDirection={context.transitionDirection}
      contentClassName="max-w-5xl"
      onBack={() => {
        if (isAdvancing) return;
        if (!previousStep) return;
        navigate(`${STEP_PATHS[previousStep]}${querySuffix}`);
      }}
      onSkip={() => {
        if (isAdvancing) return;
        context.updateAnswers({ design_style: null });
        if (!nextStep) return;
        navigate(`${STEP_PATHS[nextStep]}${querySuffix}`);
      }}
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            What vibe fits your style?
          </h1>
          <p className="text-muted-foreground">
            Pick the design direction that feels most like you. We will use this
            as a starting point, and you can always change it in chat.
          </p>
        </div>

        <div className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {visualStyles.map((style) => {
            const Preview =
              DESIGN_STYLE_PREVIEWS[
                style.value as keyof typeof DESIGN_STYLE_PREVIEWS
              ];
            if (!Preview) return null;

            return (
              <DesignStyleCard
                key={style.value}
                label={style.label}
                preview={Preview}
                selected={context.answers.design_style === style.value}
                disabled={isAdvancing}
                onClick={() => selectStyle(style.value)}
              />
            );
          })}
        </div>

        <button
          type="button"
          disabled={isAdvancing}
          onClick={() => selectStyle('per_project')}
          className={cn(
            'w-full rounded-xl border px-4 py-3 text-left text-sm transition-colors disabled:pointer-events-none',
            context.answers.design_style === 'per_project'
              ? 'border-foreground bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:border-foreground/30 hover:text-foreground'
          )}
        >
          I&apos;ll decide on a per-project basis
        </button>
      </div>
    </OnboardingLayout>
  );
}
