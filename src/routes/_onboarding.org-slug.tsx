import { useState } from 'react';
import { useOutletContext } from 'react-router';
import type { Route } from './+types/_onboarding.org-slug';
import { OnboardingLayout } from '@/components/onboarding/onboarding-layout';
import {
  SlugInput,
  type SlugAvailabilityState,
} from '@/components/onboarding/slug-input';
import { Button } from '@/components/ui/button';
import type { OnboardingRouteContext } from './_onboarding';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Organization URL - Chiridion' },
    { name: 'description', content: 'Choose your organization app URL slug' },
  ];
}

export default function OnboardingOrgSlugRoute() {
  const context = useOutletContext<OnboardingRouteContext>();
  const [slug, setSlug] = useState(
    context.pendingOrgSlug ?? context.currentOrg.slug
  );
  const [status, setStatus] = useState<SlugAvailabilityState>('available');

  const canContinue = status === 'available';

  return (
    <OnboardingLayout
      currentStep={Math.max(1, context.currentStepIndex + 1)}
      totalSteps={context.totalSteps}
      transitionDirection={context.transitionDirection}
      onBack={() => context.goBack('orgSlug')}
      onSkip={() => {
        context.setPendingOrgSlug(context.currentOrg.slug);
        context.goNext('orgSlug');
      }}
    >
      <div className="space-y-6">
        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight">Choose your app URL</h1>
          <p className="text-muted-foreground">
            Every app you publish uses this format:{' '}
            <span className="font-medium text-foreground">
              https://my-app--your-slug.{context.vanityDomain}
            </span>
          </p>
        </div>

        <SlugInput
          orgId={context.currentOrg.id}
          currentSlug={context.pendingOrgSlug ?? context.currentOrg.slug}
          value={slug}
          vanityDomain={context.vanityDomain}
          onChange={(next) => {
            setSlug(next);
          }}
          onAvailabilityChange={setStatus}
        />

        <Button
          type="button"
          size="lg"
          disabled={!canContinue}
          onClick={() => {
            if (!canContinue) return;
            context.setPendingOrgSlug(slug.trim().toLowerCase());
            context.goNext('orgSlug');
          }}
        >
          Continue
        </Button>
      </div>
    </OnboardingLayout>
  );
}
