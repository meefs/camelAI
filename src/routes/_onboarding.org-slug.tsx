import { useState } from 'react';
import { useLoaderData, useNavigate, useOutletContext } from 'react-router';
import type { Route } from './+types/_onboarding.org-slug';
import { getAuthEnv, requireSession } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { OnboardingLayout } from '@/components/onboarding/onboarding-layout';
import {
  SlugInput,
  type SlugAvailabilityState,
} from '@/components/onboarding/slug-input';
import { Button } from '@/components/ui/button';
import { STEP_PATHS, getNextStep, getPreviousStep } from '@/lib/onboarding';
import type { OnboardingRouteContext } from './_onboarding';

interface OrgSlugLoaderData {
  currentSlug: string;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sessionContext = await requireSession(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const orgStub = authEnv.ORG.get(
    authEnv.ORG.idFromName(sessionContext.session.org_id)
  );
  const orgInfo = await orgStub.getInfo();

  return {
    currentSlug: orgInfo?.slug ?? '',
  } satisfies OrgSlugLoaderData;
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Organization URL - Chiridion' },
    { name: 'description', content: 'Choose your organization app URL slug' },
  ];
}

export default function OnboardingOrgSlugRoute() {
  const context = useOutletContext<OnboardingRouteContext>();
  const navigate = useNavigate();
  const { currentSlug } = useLoaderData<typeof loader>() as OrgSlugLoaderData;
  const [slug, setSlug] = useState(context.pendingOrgSlug ?? currentSlug);
  const [status, setStatus] = useState<SlugAvailabilityState>('available');
  const querySuffix = context.teamMode ? '?team=1' : '';
  const previousStep = getPreviousStep('orgSlug', context.sequence);
  const nextStep = getNextStep('orgSlug', context.sequence);

  const canContinue = status === 'available';

  return (
    <OnboardingLayout
      currentStep={Math.max(1, context.currentStepIndex + 1)}
      totalSteps={context.totalSteps}
      transitionDirection={context.transitionDirection}
      onBack={() => {
        if (!previousStep) return;
        navigate(`${STEP_PATHS[previousStep]}${querySuffix}`);
      }}
      onSkip={() => {
        context.setPendingOrgSlug(currentSlug);
        if (!nextStep) return;
        navigate(`${STEP_PATHS[nextStep]}${querySuffix}`);
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
          orgId={context.orgId}
          currentSlug={context.pendingOrgSlug ?? currentSlug}
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
            if (!nextStep) return;
            navigate(`${STEP_PATHS[nextStep]}${querySuffix}`);
          }}
        >
          Continue
        </Button>
      </div>
    </OnboardingLayout>
  );
}
