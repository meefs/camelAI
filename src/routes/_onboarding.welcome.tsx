import {
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
  useOutletContext,
} from 'react-router';
import type { Route } from './+types/_onboarding.welcome';
import { getAuthEnv, requireSession } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { OnboardingLayout } from '@/components/onboarding/onboarding-layout';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { STEP_PATHS } from '@/lib/onboarding';
import type { OnboardingRouteContext } from './_onboarding';

interface TeamContext {
  memberCount: number;
  appCount: number;
  integrations: string[];
}

interface WelcomeLoaderData {
  orgName: string;
  showOrgSlugStep: boolean;
  teamContext: TeamContext;
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

  const [role, memberCount, workerScripts] = await Promise.all([
    userStub.getOrgRole(orgId),
    orgStub.getMemberCount(),
    orgStub.listWorkerScripts(),
  ]);
  const showOrgSlugStep =
    role === 'owner' && memberCount === 1 && workerScripts.length === 0;

  if (!teamMode) {
    return {
      orgName: 'Chiridion',
      showOrgSlugStep,
      teamContext: {
        memberCount: 0,
        appCount: 0,
        integrations: [],
      },
    } satisfies WelcomeLoaderData;
  }
  const [orgName, integrations] = await Promise.all([
    orgStub
      .getInfo()
      .then((info) => info?.name ?? 'your team')
      .catch(() => 'your team'),
    workspaceId
      ? authEnv.WORKSPACE.get(authEnv.WORKSPACE.idFromName(workspaceId))
          .getIntegrations()
          .then((rows: Array<{ name: string }>) => rows.map((row: { name: string }) => row.name))
          .catch(() => [] as string[])
      : Promise.resolve([] as string[]),
  ]);

  return {
    orgName,
    showOrgSlugStep,
    teamContext: {
      memberCount,
      appCount: workerScripts.length,
      integrations: integrations.slice(0, 4),
    },
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

export default function OnboardingWelcomeRoute() {
  const context = useOutletContext<OnboardingRouteContext>();
  const navigate = useNavigate();
  const location = useLocation();
  const verificationFetcher = useFetcher<{ success?: boolean; error?: string }>();
  const { orgName, showOrgSlugStep, teamContext } =
    useLoaderData<typeof loader>() as WelcomeLoaderData;
  const isTeamWelcome = context.teamMode;
  const querySuffix = context.teamMode ? '?team=1' : '';
  const emailVerificationRequired =
    context.emailVerificationRequired && !context.emailVerified;
  const emailVerifiedFromLink =
    new URLSearchParams(location.search).get('emailVerified') === '1';
  const verificationSent =
    verificationFetcher.state === 'idle' &&
    verificationFetcher.data?.success === true;
  const verificationError =
    verificationFetcher.state === 'idle'
      ? verificationFetcher.data?.error
      : undefined;

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
            {isTeamWelcome ? `Welcome to ${orgName}` : 'Welcome to Chiridion'}
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
                {formatTeamSummary(teamContext)}
              </div>
              <p className="text-muted-foreground">
                Let&apos;s learn a bit about you so Claude can help.
              </p>
            </>
          )}
        </div>

        {emailVerifiedFromLink ? (
          <Alert>
            <AlertDescription>
              Email verified. You can finish onboarding now.
            </AlertDescription>
          </Alert>
        ) : null}

        {emailVerificationRequired ? (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-4 text-left">
            <p className="text-sm font-medium">Verify your email to finish onboarding.</p>
            <p className="text-sm text-muted-foreground">
              We sent a verification link to {context.userEmail}. You&apos;ll need to confirm it before the final onboarding step.
            </p>
            {verificationSent ? (
              <p className="text-sm text-muted-foreground">
                Verification email sent.
              </p>
            ) : null}
            {verificationError ? (
              <Alert variant="destructive">
                <AlertDescription>{verificationError}</AlertDescription>
              </Alert>
            ) : null}
            <verificationFetcher.Form method="post" action="/api/auth/verify-email/send">
              <Button
                type="submit"
                variant="outline"
                disabled={verificationFetcher.state !== 'idle'}
              >
                {verificationFetcher.state !== 'idle'
                  ? 'Sending...'
                  : verificationSent
                    ? 'Resend verification email'
                    : 'Send verification email'}
              </Button>
            </verificationFetcher.Form>
          </div>
        ) : null}

        <div className="pt-2">
          <Button
            type="button"
            size="lg"
            onClick={() => {
              if (context.teamWelcomeOnly) {
                context.skipToChat();
                return;
              }

              context.setShowOrgSlugStep(showOrgSlugStep);
              const step = showOrgSlugStep ? 'orgSlug' : 'q1';
              navigate(`${STEP_PATHS[step]}${querySuffix}`);
            }}
          >
            Get Started
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
