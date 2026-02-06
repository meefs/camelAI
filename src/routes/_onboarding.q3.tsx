import { useOutletContext } from 'react-router';
import type { Route } from './+types/_onboarding.q3';
import { OnboardingLayout } from '@/components/onboarding/onboarding-layout';
import { OnboardingOption } from '@/components/onboarding/onboarding-option';
import { useDelayedAdvance } from '@/components/onboarding/use-delayed-advance';
import { STAKES_OPTIONS } from '@/lib/onboarding';
import type { OnboardingRouteContext } from './_onboarding';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Project Stakes - Chiridion' },
    { name: 'description', content: 'Tell us what you plan to build first' },
  ];
}

export default function OnboardingQ3Route() {
  const context = useOutletContext<OnboardingRouteContext>();
  const { isAdvancing, scheduleAdvance } = useDelayedAdvance(() => context.goNext('q3'));

  return (
    <OnboardingLayout
      currentStep={Math.max(1, context.currentStepIndex + 1)}
      totalSteps={context.totalSteps}
      transitionDirection={context.transitionDirection}
      onBack={() => {
        if (isAdvancing) return;
        context.goBack('q3');
      }}
      onSkip={() => {
        if (isAdvancing) return;
        context.updateAnswers({ stakes: null });
        context.goNext('q3');
      }}
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            What are you hoping to build first?
          </h1>
        </div>

        <div className="space-y-3">
          {STAKES_OPTIONS.map((option) => (
            <OnboardingOption
              key={option.value}
              selected={context.answers.stakes === option.value}
              title={option.title}
              description={option.description}
              disabled={isAdvancing}
              onClick={() => {
                if (isAdvancing) return;
                context.updateAnswers({ stakes: option.value });
                scheduleAdvance();
              }}
            />
          ))}
        </div>
      </div>
    </OnboardingLayout>
  );
}
