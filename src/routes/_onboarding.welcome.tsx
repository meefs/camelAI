import { Suspense, use, useState } from 'react';
import { useLoaderData, useNavigate, useOutletContext } from 'react-router';
import type { Route } from './+types/_onboarding.welcome';
import { getAuthEnv, requireSession } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { OnboardingLayout } from '@/components/onboarding/onboarding-layout';
import { Button } from '@/components/ui/button';
import { STEP_PATHS } from '@/lib/onboarding';
import type { OnboardingRouteContext } from './_onboarding';

interface TeamContext {
  memberCount: number;
  appCount: number;
  integrations: string[];
}

interface WelcomeLoaderData {
  orgNamePromise: Promise<string>;
  showOrgSlugStepPromise: Promise<boolean>;
  teamContextPromise: Promise<TeamContext>;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const sessionContext = await requireSession(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const url = new URL(request.url);
  const teamMode = url.searchParams.get('team') === '1';
  const orgId = sessionContext.session.org_id;
  const workspaceId = sessionContext.session.workspace_id;
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const userStub = authEnv.USER.get(
    authEnv.USER.idFromName(sessionContext.session.user_id)
  );

  const showOrgSlugStepPromise: Promise<boolean> = Promise.all([
    userStub.getOrgRole(orgId),
    orgStub.getMemberCount(),
    orgStub.listWorkerScripts(),
  ]).then(([role, memberCount, workerScripts]) => {
    return role === 'owner' && memberCount === 1 && workerScripts.length === 0;
  });

  if (!teamMode) {
    return {
      orgNamePromise: Promise.resolve('Chiridion'),
      showOrgSlugStepPromise,
      teamContextPromise: Promise.resolve({
        memberCount: 0,
        appCount: 0,
        integrations: [],
      }),
    } satisfies WelcomeLoaderData;
  }
  const memberCountPromise = orgStub.getMemberCount().catch(() => 0);
  const workerScriptsPromise = orgStub
    .listWorkerScripts()
    .catch(() => [] as Array<unknown>);

  const orgNamePromise: Promise<string> = orgStub
    .getInfo()
    .then((info) => info?.name ?? 'your team')
    .catch(() => 'your team');

  const teamContextPromise: Promise<TeamContext> = Promise.all([
    memberCountPromise,
    workerScriptsPromise,
    workspaceId
      ? authEnv.WORKSPACE.get(authEnv.WORKSPACE.idFromName(workspaceId))
          .getIntegrations()
          .then((rows: Array<{ enabled: number; name: string }>) =>
            rows
              .filter((row: { enabled: number }) => row.enabled === 1)
              .map((row: { name: string }) => row.name)
          )
          .catch(() => [] as string[])
      : Promise.resolve([] as string[]),
  ]).then(([memberCount, workerScripts, integrations]) => ({
    memberCount,
    appCount: workerScripts.length,
    integrations: integrations.slice(0, 4),
  }));

  return {
    orgNamePromise,
    showOrgSlugStepPromise,
    teamContextPromise,
  } satisfies WelcomeLoaderData;
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: 'Welcome - Chiridion' },
    { name: 'description', content: 'Welcome to Chiridion onboarding' },
  ];
}

function formatTeamSummary(teamContext: TeamContext): string {
  const parts: string[] = [];

  if (teamContext.appCount > 0) {
    parts.push(`${teamContext.appCount} apps deployed`);
  }
  if (teamContext.integrations.length > 0) {
    parts.push(`Connected to ${teamContext.integrations.join(', ')}`);
  }
  if (parts.length === 0) {
    parts.push(`${teamContext.memberCount} team members`);
  }

  return parts.join('  •  ');
}

function TeamSummary({ teamContextPromise }: { teamContextPromise: Promise<TeamContext> }) {
  const teamContext = use(teamContextPromise);
  return (
    <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
      {formatTeamSummary(teamContext)}
    </div>
  );
}

function TeamHeading({ orgNamePromise }: { orgNamePromise: Promise<string> }) {
  const orgName = use(orgNamePromise);
  return <>{`Welcome to ${orgName}`}</>;
}

export default function OnboardingWelcomeRoute() {
  const context = useOutletContext<OnboardingRouteContext>();
  const navigate = useNavigate();
  const { orgNamePromise, showOrgSlugStepPromise, teamContextPromise } =
    useLoaderData<typeof loader>() as WelcomeLoaderData;
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const isTeamWelcome = context.teamMode;
  const querySuffix = context.teamMode ? '?team=1' : '';

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
            {isTeamWelcome ? (
              <Suspense fallback={<>Welcome to your team</>}>
                <TeamHeading orgNamePromise={orgNamePromise} />
              </Suspense>
            ) : (
              'Welcome to Chiridion'
            )}
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
              <Suspense
                fallback={
                  <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                    Loading team activity...
                  </div>
                }
              >
                <TeamSummary teamContextPromise={teamContextPromise} />
              </Suspense>
              <p className="text-muted-foreground">
                Let&apos;s learn a bit about you so Claude can help.
              </p>
            </>
          )}
        </div>

        {startError ? (
          <p className="text-sm text-destructive">{startError}</p>
        ) : null}

        <div className="pt-2">
          <Button
            type="button"
            size="lg"
            disabled={starting}
            onClick={() => {
              if (context.teamWelcomeOnly) {
                context.skipToChat();
                return;
              }

              setStarting(true);
              setStartError(null);
              void showOrgSlugStepPromise
                .then((showOrgSlugStep) => {
                  context.setShowOrgSlugStep(showOrgSlugStep);
                  const step = showOrgSlugStep ? 'orgSlug' : 'q1';
                  navigate(`${STEP_PATHS[step]}${querySuffix}`);
                })
                .catch(() => {
                  setStartError('Failed to check onboarding steps. Please try again.');
                })
                .finally(() => {
                  setStarting(false);
                });
            }}
          >
            {starting ? 'Loading...' : 'Get Started'}
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
