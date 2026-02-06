import { useOutletContext } from 'react-router';
import type { Route } from './+types/_onboarding.q1';
import { SingleChoiceStep } from '@/components/onboarding/single-choice-step';
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

  return (
    <SingleChoiceStep
      context={context}
      stepId="q1"
      field="ai_familiarity"
      title="Have you built things with AI before?"
      options={AI_FAMILIARITY_OPTIONS}
    />
  );
}
