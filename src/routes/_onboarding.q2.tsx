import { useOutletContext } from 'react-router';
import type { Route } from './+types/_onboarding.q2';
import { OnboardingLayout } from '@/components/onboarding/onboarding-layout';
import { OnboardingOption } from '@/components/onboarding/onboarding-option';
import { useDelayedAdvance } from '@/components/onboarding/use-delayed-advance';
import { ITERATION_STYLE_OPTIONS } from '@/lib/onboarding';
import type { OnboardingRouteContext } from './_onboarding';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Iteration Style - Chiridion' },
    { name: 'description', content: 'Choose your preferred build collaboration style' },
  ];
}

export default function OnboardingQ2Route() {
  const context = useOutletContext<OnboardingRouteContext>();
  const { isAdvancing, scheduleAdvance } = useDelayedAdvance(() => context.goNext('q2'));

  return (
    <OnboardingLayout
      currentStep={Math.max(1, context.currentStepIndex + 1)}
      totalSteps={context.totalSteps}
      transitionDirection={context.transitionDirection}
      onBack={() => {
        if (isAdvancing) return;
        context.goBack('q2');
      }}
      onSkip={() => {
        if (isAdvancing) return;
        context.updateAnswers({ iteration_style: null });
        context.goNext('q2');
      }}
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            When we&apos;re building together, what feels better?
          </h1>
        </div>

        <div className="space-y-3">
          {ITERATION_STYLE_OPTIONS.map((option) => (
            <OnboardingOption
              key={option.value}
              selected={context.answers.iteration_style === option.value}
              title={option.title}
              description={option.description}
              disabled={isAdvancing}
              onClick={() => {
                if (isAdvancing) return;
                context.updateAnswers({ iteration_style: option.value });
                scheduleAdvance();
              }}
            />
          ))}
        </div>
      </div>
    </OnboardingLayout>
  );
}
