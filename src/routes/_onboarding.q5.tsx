import {
  BarChart3,
  Gamepad2,
  Globe,
  Users,
  Wrench,
} from 'lucide-react';
import { useOutletContext } from 'react-router';
import type { Route } from './+types/_onboarding.q5';
import { OnboardingLayout } from '@/components/onboarding/onboarding-layout';
import { OnboardingOption } from '@/components/onboarding/onboarding-option';
import { useDelayedAdvance } from '@/components/onboarding/use-delayed-advance';
import { STARTER_PROJECT_OPTIONS } from '@/lib/onboarding';
import type { OnboardingRouteContext } from './_onboarding';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Starter Project - Chiridion' },
    { name: 'description', content: 'Pick a starter project direction' },
  ];
}

const STARTER_ICONS = {
  data_analytics: BarChart3,
  personal_site: Globe,
  business_tool: Wrench,
  team_productivity: Users,
  something_fun: Gamepad2,
} as const;

export default function OnboardingQ5Route() {
  const context = useOutletContext<OnboardingRouteContext>();
  const { isAdvancing, scheduleAdvance } = useDelayedAdvance(() => context.goNext('q5'));

  return (
    <OnboardingLayout
      currentStep={Math.max(1, context.currentStepIndex + 1)}
      totalSteps={context.totalSteps}
      transitionDirection={context.transitionDirection}
      onBack={() => {
        if (isAdvancing) return;
        context.goBack('q5');
      }}
      onSkip={() => {
        if (isAdvancing) return;
        context.updateAnswers({ starter_project: null });
        context.goNext('q5');
      }}
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            What do you want to build first?
          </h1>
          <p className="text-muted-foreground">
            Pick a starter project to get moving quickly.
          </p>
        </div>

        <div className="space-y-3">
          {STARTER_PROJECT_OPTIONS.map((option) => {
            const Icon = STARTER_ICONS[option.value];
            return (
              <OnboardingOption
                key={option.value}
                selected={context.answers.starter_project === option.value}
                title={option.title}
                description={option.description}
                icon={<Icon className="h-4 w-4" />}
                disabled={isAdvancing}
                onClick={() => {
                  if (isAdvancing) return;
                  context.updateAnswers({ starter_project: option.value });
                  scheduleAdvance();
                }}
              />
            );
          })}
        </div>
      </div>
    </OnboardingLayout>
  );
}
