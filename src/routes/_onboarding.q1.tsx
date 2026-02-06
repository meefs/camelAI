import { useOutletContext } from 'react-router';
import type { Route } from './+types/_onboarding.q1';
import { OnboardingLayout } from '@/components/onboarding/onboarding-layout';
import { OnboardingOption } from '@/components/onboarding/onboarding-option';
import { useDelayedAdvance } from '@/components/onboarding/use-delayed-advance';
import { AI_FAMILIARITY_OPTIONS } from '@/lib/onboarding';
import type { OnboardingRouteContext } from './_onboarding';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'AI Familiarity - Chiridion' },
    { name: 'description', content: 'Tell us your AI coding familiarity' },
  ];
}

export default function OnboardingQ1Route() {
  const context = useOutletContext<OnboardingRouteContext>();
  const { isAdvancing, scheduleAdvance } = useDelayedAdvance(() => context.goNext('q1'));

  return (
    <OnboardingLayout
      currentStep={Math.max(1, context.currentStepIndex + 1)}
      totalSteps={context.totalSteps}
      transitionDirection={context.transitionDirection}
      onBack={() => {
        if (isAdvancing) return;
        context.goBack('q1');
      }}
      onSkip={() => {
        if (isAdvancing) return;
        context.updateAnswers({ ai_familiarity: null });
        context.goNext('q1');
      }}
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Have you built things with AI before?
          </h1>
        </div>

        <div className="space-y-3">
          {AI_FAMILIARITY_OPTIONS.map((option) => (
            <OnboardingOption
              key={option.value}
              selected={context.answers.ai_familiarity === option.value}
              title={option.title}
              description={option.description}
              disabled={isAdvancing}
              onClick={() => {
                if (isAdvancing) return;
                context.updateAnswers({ ai_familiarity: option.value });
                scheduleAdvance();
              }}
            />
          ))}
        </div>
      </div>
    </OnboardingLayout>
  );
}
