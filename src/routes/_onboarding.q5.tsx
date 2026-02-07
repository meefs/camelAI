import {
  BarChart3,
  Gamepad2,
  Globe,
  Users,
  Wrench,
} from 'lucide-react';
import { useOutletContext } from 'react-router';
import type { Route } from './+types/_onboarding.q5';
import { SingleChoiceStep } from '@/components/onboarding/single-choice-step';
import { STARTER_PROJECT_OPTIONS } from '@/lib/onboarding';
import type { OnboardingStarterProject } from '@/types';
import type { OnboardingRouteContext } from './_onboarding';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Starter Project - Chiridion' },
    { name: 'description', content: 'Pick a starter project direction' },
  ];
}

const STARTER_ICONS: Record<OnboardingStarterProject, typeof BarChart3> = {
  data_analytics: BarChart3,
  personal_site: Globe,
  business_tool: Wrench,
  team_productivity: Users,
  something_fun: Gamepad2,
};

export default function OnboardingQ5Route() {
  const context = useOutletContext<OnboardingRouteContext>();

  return (
    <SingleChoiceStep
      context={context}
      stepId="q5"
      field="starter_project"
      title="What do you want to build first?"
      description="Pick a starter project to get moving quickly."
      options={STARTER_PROJECT_OPTIONS}
      renderIcon={(value) => {
        const Icon = STARTER_ICONS[value];
        return <Icon className="h-4 w-4" />;
      }}
    />
  );
}
