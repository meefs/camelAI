import { useOutletContext } from 'react-router';
import type { Route } from './+types/_onboarding.welcome';
import { OnboardingLayout } from '@/components/onboarding/onboarding-layout';
import { Button } from '@/components/ui/button';
import type { OnboardingRouteContext } from './_onboarding';

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Welcome - Chiridion' },
    { name: 'description', content: 'Welcome to Chiridion onboarding' },
  ];
}

function formatTeamSummary(context: OnboardingRouteContext): string {
  const parts: string[] = [];

  if (context.teamContext.appCount > 0) {
    parts.push(`${context.teamContext.appCount} apps deployed`);
  }
  if (context.teamContext.integrations.length > 0) {
    parts.push(`Connected to ${context.teamContext.integrations.join(', ')}`);
  }
  if (parts.length === 0) {
    parts.push(`${context.teamContext.memberCount} team members`);
  }

  return parts.join('  •  ');
}

export default function OnboardingWelcomeRoute() {
  const context = useOutletContext<OnboardingRouteContext>();
  const isTeamWelcome = context.teamVariant;

  return (
    <OnboardingLayout
      currentStep={Math.max(1, context.currentStepIndex + 1)}
      totalSteps={context.totalSteps}
      transitionDirection={context.transitionDirection}
      showBack={false}
      showSkip={false}
    >
      <div className="space-y-6 text-center">
        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            {isTeamWelcome
              ? `Welcome to ${context.currentOrg.name}`
              : 'Welcome to Chiridion'}
          </h1>
          {!isTeamWelcome ? (
            <>
              <p className="text-balance text-muted-foreground">
                Chiridion is your AI software engineer. Claude has a permanent computer here, so it can build, deploy, and maintain applications for you.
              </p>
              <p className="text-muted-foreground">
                Let&apos;s get you set up. This takes about 30 seconds.
              </p>
            </>
          ) : (
            <>
              <p className="text-muted-foreground">
                You&apos;re joining a team that&apos;s already building.
              </p>
              <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
                {formatTeamSummary(context)}
              </div>
              <p className="text-muted-foreground">
                Let&apos;s learn a bit about you so Claude can help.
              </p>
            </>
          )}
        </div>

        <div className="pt-2">
          <Button
            type="button"
            size="lg"
            onClick={() => {
              if (context.teamWelcomeOnly) {
                context.skipToChat();
                return;
              }
              context.goNext('welcome');
            }}
          >
            Get Started
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
