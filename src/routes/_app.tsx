import { Suspense, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Await,
  Outlet,
  redirect,
  data,
  useLoaderData,
  useNavigate,
  useRevalidator,
} from "react-router";
import type { Route } from "./+types/_app";
import { requireAuthContext } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { parseCookies, createSessionCookieHeader } from "@/lib/cookies.server";
import { LegacyUserBanner } from "@/components/legacy-user-banner";
import { LegacyMigrationDialog } from "@/components/billing/legacy-migration-dialog";
import {
  PaywallTakeover,
  type PaywallTakeoverContext,
} from "@/components/billing/paywall-takeover";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { ChatGroupsProvider } from "@/hooks/use-chat-groups";
import { ChatThreadSnapshotsProvider } from "@/hooks/use-chat-thread-snapshots";
import type { AuthState } from "@/types";
import type { ChatGroupView, WorkspaceWithAccess } from "@/types";
import {
  getVerifiedLegacyStripeMigrationEligibility,
  isOrgBillingAccessReady,
  resolveOrgBillingAccess,
} from "@/lib/billing.server";
import { listGroupsForWorkspace } from "@/lib/chat-groups.server";
import { getByokProviderLabel } from "@/lib/byok-providers";
import { getWorkspaceMigrationGate } from "@/lib/workspace-migration-gate.server";

const SIDEBAR_COOKIE_NAME = "sidebar_state";
const PROJECT_MIGRATION_POLL_INTERVAL_MS = 5_000;

export function shouldRevalidate({
  formData,
  defaultShouldRevalidate,
}: {
  formData?: FormData;
  defaultShouldRevalidate: boolean;
}) {
  if (formData?.get("intent") === "createThreadAndStart") {
    return false;
  }

  return defaultShouldRevalidate;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  // Auth check - redirects to /login if not authenticated
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const url = new URL(request.url);

  if (!authContext.onboarding?.completed_at) {
    throw redirect("/onboarding");
  }
  if (
    authContext.emailVerification.required &&
    !authContext.emailVerification.verified
  ) {
    throw redirect("/onboarding");
  }

  const orgStub = env.ORG.get(env.ORG.idFromName(authContext.currentOrg.id));
  const [orgInfo, llmProviderConfig] = await Promise.all([
    orgStub.getInfo().catch(() => null),
    orgStub.getLlmProviderConfig(),
  ]);
  const currentOrg = orgInfo ?? authContext.currentOrg;
  const billingAccess = resolveOrgBillingAccess({
    org: currentOrg,
    llmProviderConfig,
    pathname: url.pathname,
  });
  const billingAccessReady = isOrgBillingAccessReady(billingAccess);
  const appRouteAccessible =
    billingAccessReady || billingAccess.setupRouteAccessible;
  const paywallContext: PaywallTakeoverContext | null = billingAccessReady
    ? null
    : {
        currentOrgName: currentOrg.name,
        multiOrg: authContext.orgs.length > 1,
        byokProviderLabel: getByokProviderLabel(llmProviderConfig?.provider),
      };

  // Get sidebar state from cookies
  const cookies = parseCookies(request);
  const sidebarValue = cookies[SIDEBAR_COOKIE_NAME];
  let defaultSidebarOpen = true;
  if (sidebarValue === "false") {
    defaultSidebarOpen = false;
  }

  // Convert auth context to AuthState for the provider
  const authState: AuthState = {
    user: authContext.user,
    currentOrg,
    currentWorkspace: authContext.currentWorkspace,
    orgs: authContext.orgs,
    onboarding: authContext.onboarding,
    workspaces: authContext.workspaces,
    allWorkspaces: authContext.allWorkspaces,
    orgWorkspaceCount: authContext.orgWorkspaceCount,
    loading: false,
    error: null,
  };

  const currentWorkspaceId = authContext.currentWorkspace?.id ?? null;
  const migrationGateWorkspace = getMigrationGateWorkspace(url, authContext);
  const projectMigrationGate = await getWorkspaceMigrationGate(
    env,
    migrationGateWorkspace,
  );
  const actingUserId =
    authContext.user?.id ?? authContext.session?.user_id ?? null;
  const currentChatGroupsPromise: Promise<ChatGroupView[]> = currentWorkspaceId && actingUserId
    ? listGroupsForWorkspace(context, {
        userId: actingUserId,
        orgId: currentOrg.id,
        workspaceId: currentWorkspaceId,
      }).catch((error) => {
        console.error("Failed to load chat groups:", error);
        return [];
      })
    : Promise.resolve([]);
  const legacyMigrationPromise = Promise.resolve(
    getVerifiedLegacyStripeMigrationEligibility({
      env,
      org: currentOrg,
      userEmail: authContext.user?.email ?? authContext.session?.user_email ?? "",
    }),
  ).catch((error) => {
    console.error("Failed to load legacy migration eligibility:", error);
    return null;
  });
  const showLegacyBannerPromise = (async () => {
    const normalizedEmail = (
      authContext.user?.email ??
      authContext.session?.user_email ??
      ""
    )
      .trim()
      .toLowerCase();
    const isDevelopment = env.NEXTJS_ENV === "development";
    const [legacyUserValue, dismissedValue] = await Promise.all([
      isDevelopment || !normalizedEmail
        ? Promise.resolve(isDevelopment ? "1" : null)
        : env.APP_KV.get(`legacy_user:${normalizedEmail}`),
      actingUserId
        ? env.APP_KV.get(`legacy_banner_dismissed:${actingUserId}`)
        : Promise.resolve(null),
    ]);
    const isLegacyUser = isDevelopment || Boolean(legacyUserValue);
    return isLegacyUser && !Boolean(dismissedValue);
  })().catch(() => {
    // KV failure should never take down the app — degrade to hiding the banner.
    return false;
  });
  const responseData = {
    authState,
    defaultSidebarOpen,
    showLegacyBanner: showLegacyBannerPromise,
    legacyMigration: legacyMigrationPromise,
    chatGroups: currentChatGroupsPromise,
    billingAccessReady,
    appRouteAccessible,
    paywallContext,
    projectMigrationGate,
  };

  // Re-sign session cookie if workspace fell back (e.g. workspace removed/access revoked)
  if (authContext.resignedSessionCookie) {
    return data(responseData, {
      headers: {
        "Set-Cookie": createSessionCookieHeader(
          authContext.resignedSessionCookie,
          request,
        ),
      },
    });
  }

  return responseData;
}

export default function AppLayout() {
  const {
    authState,
    defaultSidebarOpen,
    showLegacyBanner,
    legacyMigration,
    billingAccessReady,
    appRouteAccessible,
    paywallContext,
    projectMigrationGate,
  } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (!projectMigrationGate) return;
    const interval = window.setInterval(() => {
      if (revalidator.state === "idle") {
        revalidator.revalidate();
      }
    }, PROJECT_MIGRATION_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [projectMigrationGate, revalidator]);

  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <ChatGroupsProvider>
        <ChatThreadSnapshotsProvider>
          <AppSidebar />
          <SidebarInset className="h-svh overflow-hidden flex flex-col">
            {projectMigrationGate ? (
              <WorkspaceMigrationInProgress />
            ) : appRouteAccessible ? (
              <Outlet />
            ) : paywallContext ? (
              <Suspense
                fallback={
                  <PaywallTakeover
                    paywallContext={paywallContext}
                    legacyMigration={null}
                  />
                }
              >
                <Await resolve={legacyMigration}>
                  {(resolvedLegacyMigration) => (
                    <PaywallTakeover
                      paywallContext={paywallContext}
                      legacyMigration={resolvedLegacyMigration}
                    />
                  )}
                </Await>
              </Suspense>
            ) : null}
          </SidebarInset>
        </ChatThreadSnapshotsProvider>
      </ChatGroupsProvider>
      <Suspense fallback={null}>
        <Await resolve={showLegacyBanner}>
          {(resolvedShowLegacyBanner) => (
            <LegacyUserBanner
              show={resolvedShowLegacyBanner}
              userId={authState.user?.id ?? "legacy-user"}
            />
          )}
        </Await>
      </Suspense>
      {billingAccessReady ? (
        <Suspense fallback={null}>
          <Await resolve={legacyMigration}>
            {(resolvedLegacyMigration) => (
              <LegacyMigrationDisclosure
                authState={authState}
                legacyMigration={resolvedLegacyMigration}
                navigate={navigate}
              />
            )}
          </Await>
        </Suspense>
      ) : null}
    </SidebarProvider>
  );
}

function WorkspaceMigrationInProgress() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md text-center">
        <CardHeader className="items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          </div>
          <CardTitle className="text-base">camelAI migration in progress</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          We are upgrading camel&apos;s abilities. This page will refresh
          automatically when migration is complete.
        </CardContent>
      </Card>
    </div>
  );
}

function getMigrationGateWorkspace(
  url: URL,
  authContext: Awaited<ReturnType<typeof requireAuthContext>>,
): WorkspaceWithAccess | null {
  const currentWorkspace = authContext.currentWorkspace ?? null;
  const currentWorkspaceId = currentWorkspace?.id ?? null;
  const computerWorkspaceId = getComputerRouteWorkspaceId(url.pathname);
  if (!computerWorkspaceId || computerWorkspaceId === currentWorkspaceId) {
    return currentWorkspace;
  }

  const workspace = [
    ...(authContext.workspaces ?? []),
    ...(authContext.allWorkspaces ?? []),
  ].find((candidate) => candidate.id === computerWorkspaceId);

  return workspace ?? currentWorkspace;
}

function getComputerRouteWorkspaceId(pathname: string): string | null {
  const match = /^\/computer\/([^/?#]+)/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

type LegacyMigrationData = Awaited<
  ReturnType<typeof getVerifiedLegacyStripeMigrationEligibility>
>;

function LegacyMigrationDisclosure({
  authState,
  legacyMigration,
  navigate,
}: {
  authState: AuthState;
  legacyMigration: LegacyMigrationData;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const legacyMigrationKey = legacyMigration?.eligible
    ? [
        authState.currentOrg?.id ?? "unknown-org",
        legacyMigration.customerId,
        legacyMigration.activeLegacySubscriptionCount,
        legacyMigration.defaultPlan,
      ].join(":")
    : null;
  const [legacyDialogOpen, setLegacyDialogOpen] = useState(
    () => legacyMigrationKey !== null,
  );
  const legacyDialogKeyRef = useRef<string | null>(legacyMigrationKey);

  useEffect(() => {
    if (!legacyMigrationKey) {
      legacyDialogKeyRef.current = null;
      setLegacyDialogOpen(false);
      return;
    }

    if (legacyDialogKeyRef.current !== legacyMigrationKey) {
      legacyDialogKeyRef.current = legacyMigrationKey;
      setLegacyDialogOpen(true);
    }
  }, [legacyMigrationKey]);

  return (
    <LegacyMigrationDialog
      migration={legacyMigration}
      open={legacyDialogOpen}
      onOpenChange={setLegacyDialogOpen}
      primaryAction={{
        label: "See plans",
        onClick: () => {
          setLegacyDialogOpen(false);
          navigate("/settings/organization/billing?view=plans");
        },
      }}
    />
  );
}
