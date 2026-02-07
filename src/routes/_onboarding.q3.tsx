import { useOutletContext } from 'react-router';
import type { Route } from './+types/_onboarding.q3';
import { SingleChoiceStep } from '@/components/onboarding/single-choice-step';
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

  return (
    <SingleChoiceStep
      context={context}
      stepId="q3"
      field="stakes"
      title="What are you hoping to build first?"
      options={STAKES_OPTIONS}
    />
  );
}
