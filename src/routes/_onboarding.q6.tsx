import { useMemo, useState } from 'react';
import { useOutletContext } from 'react-router';
import type { Route } from './+types/_onboarding.q6';
import { DataInterestGrid } from '@/components/onboarding/data-interest-grid';
import { OnboardingLayout } from '@/components/onboarding/onboarding-layout';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  DEFAULT_INTEGRATION_INTERESTS,
} from '@/lib/onboarding';
import type { OnboardingFileType } from '@/types';
import type { OnboardingRouteContext } from './_onboarding';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Data Interests - Chiridion' },
    { name: 'description', content: 'Select data sources and integrations' },
  ];
}

function toggleInList<T extends string>(list: T[], item: T): T[] {
  if (list.includes(item)) {
    return list.filter((value) => value !== item);
  }
  return [...list, item];
}

export default function OnboardingQ6Route() {
  const context = useOutletContext<OnboardingRouteContext>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedFiles = context.answers.data_interests.files;
  const selectedIntegrations = context.answers.data_interests.integrations;
  const integrationOptions = useMemo(
    () => DEFAULT_INTEGRATION_INTERESTS,
    []
  );

  async function finish(overrides?: {
    data_interests: { files: OnboardingFileType[]; integrations: string[] };
  }) {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await context.completeOnboarding(overrides);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Failed to complete onboarding. Please try again.'
      );
      setSubmitting(false);
    }
  }

  return (
    <OnboardingLayout
      currentStep={Math.max(1, context.currentStepIndex + 1)}
      totalSteps={context.totalSteps}
      transitionDirection={context.transitionDirection}
      onBack={() => context.goBack('q6')}
      onSkip={() => {
        void finish({
          data_interests: {
            files: [],
            integrations: [],
          },
        });
      }}
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            What data or tools do you want to use?
          </h1>
          <p className="text-muted-foreground">
            Select all that apply. We&apos;ll set them up later.
          </p>
        </div>

        <DataInterestGrid
          selectedFiles={selectedFiles}
          selectedIntegrations={selectedIntegrations}
          onToggleFile={(file: OnboardingFileType) => {
            context.updateAnswers({
              data_interests: {
                files: toggleInList(selectedFiles, file),
                integrations: selectedIntegrations,
              },
            });
          }}
          onToggleIntegration={(id: string) => {
            context.updateAnswers({
              data_interests: {
                files: selectedFiles,
                integrations: toggleInList(selectedIntegrations, id),
              },
            });
          }}
          integrationOptions={integrationOptions}
        />

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Button
          type="button"
          size="lg"
          className="w-full"
          disabled={submitting}
          onClick={() => {
            void finish();
          }}
        >
          {submitting ? 'Finishing...' : "Let's get started"}
        </Button>
      </div>
    </OnboardingLayout>
  );
}
