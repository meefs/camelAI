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
import { Card, CardContent, CardTitle } from "@/components/ui/card";
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
import { getEffectiveLlmProviderConfig } from "@/lib/selfhost-ai-provider";
import { isSelfhostRuntime } from "@/lib/selfhost-runtime";

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

  // Get sidebar state from cookies
  const cookies = parseCookies(request);
  const sidebarValue = cookies[SIDEBAR_COOKIE_NAME];
  let defaultSidebarOpen = true;
  if (sidebarValue === "false") {
    defaultSidebarOpen = false;
  }

  const embedMode =
    /^\/chat\/[^/]+$/.test(url.pathname) &&
    url.searchParams.get("adminReadonly") === "1" &&
    url.searchParams.get("embed") === "1" &&
    authContext.user.is_superuser === true;

  if (embedMode) {
    const authState: AuthState = {
      user: authContext.user,
      currentOrg: authContext.currentOrg,
      currentWorkspace: authContext.currentWorkspace,
      orgs: authContext.orgs,
      onboarding: authContext.onboarding,
      workspaces: authContext.workspaces,
      allWorkspaces: authContext.allWorkspaces,
      orgWorkspaceCount: authContext.orgWorkspaceCount,
      loading: false,
      error: null,
    };
    const responseData = {
      authState,
      defaultSidebarOpen,
      showLegacyBanner: Promise.resolve(false),
      legacyMigration: Promise.resolve(null),
      chatGroups: Promise.resolve([] as ChatGroupView[]),
      billingAccessReady: true,
      appRouteAccessible: true,
      paywallContext: null,
      projectMigrationGate: null,
      embedMode: true,
    };

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

  const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
    env,
    authContext.currentOrgLlmProviderConfig,
  );
  const selfhostRuntime = isSelfhostRuntime(env);
  const currentOrg = authContext.currentOrg;
  const billingAccess = resolveOrgBillingAccess({
    env,
    org: currentOrg,
    llmProviderConfig: effectiveLlmProviderConfig,
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
        byokProviderLabel: getByokProviderLabel(effectiveLlmProviderConfig?.provider),
      };

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
  const legacyMigrationPromise = selfhostRuntime
    ? Promise.resolve(null)
    : Promise.resolve(
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
    embedMode: false,
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
    embedMode,
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
      <ChatGroupsProvider disableLiveStatus={embedMode}>
        <ChatThreadSnapshotsProvider>
          {embedMode ? null : <AppSidebar />}
          <SidebarInset className="h-svh overflow-hidden flex flex-col">
            {embedMode ? (
              <Outlet />
            ) : projectMigrationGate ? (
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
      {embedMode ? null : (
        <>
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
        </>
      )}
    </SidebarProvider>
  );
}

function WorkspaceMigrationInProgress() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-5 px-6 py-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-2">
            <CardTitle className="text-base">
              camelAI migration in progress
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              We are upgrading camel&apos;s abilities. This page will refresh
              automatically when migration is complete.
            </p>
            <p className="text-sm text-muted-foreground">
              This may take a few minutes. You&apos;re free to leave this page and
              come back later.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function getMigrationGateWorkspace(
  _url: URL,
  authContext: Awaited<ReturnType<typeof requireAuthContext>>,
): WorkspaceWithAccess | null {
  return authContext.currentWorkspace ?? null;
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
