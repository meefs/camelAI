import { useOutletContext } from 'react-router';
import type { Route } from './+types/_onboarding.q2';
import { SingleChoiceStep } from '@/components/onboarding/single-choice-step';
import { ITERATION_STYLE_OPTIONS } from '@/lib/onboarding';
import type { OnboardingRouteContext } from './_onboarding';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Iteration Style - camelAI' },
    { name: 'description', content: 'Choose your preferred build collaboration style' },
  ];
}

export default function OnboardingQ2Route() {
  const context = useOutletContext<OnboardingRouteContext>();

  return (
    <SingleChoiceStep
      context={context}
      stepId="q2"
      field="iteration_style"
      title="When we're building together, what feels better?"
      options={ITERATION_STYLE_OPTIONS}
    />
  );
}
