import { Suspense } from "react";
import {
  Await,
  Outlet,
  redirect,
  data,
  useLoaderData,
} from "react-router";
import type { Route } from "./+types/_app";
import { requireAuthContext } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { parseCookies, createSessionCookieHeader } from "@/lib/cookies.server";
import { LegacyUserBanner } from "@/components/legacy-user-banner";
import {
  PaywallTakeover,
  type PaywallTakeoverContext,
} from "@/components/billing/paywall-takeover";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { ChatGroupsProvider } from "@/hooks/use-chat-groups";
import { ChatThreadSnapshotsProvider } from "@/hooks/use-chat-thread-snapshots";
import type { AuthState } from "@/types";
import type { ChatGroupView } from "@/types";
import {
  isOrgBillingAccessReady,
  resolveOrgBillingAccess,
} from "@/lib/billing.server";
import { listGroupsForWorkspace } from "@/lib/chat-groups.server";
import { getByokProviderLabel } from "@/lib/byok-providers";
import { getEffectiveLlmProviderConfig } from "@/lib/selfhost-ai-provider";
import { isConnectionsUiOnlySearchChange } from "@/lib/connections-route-revalidation";

const SIDEBAR_COOKIE_NAME = "sidebar_state";

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  formData,
  defaultShouldRevalidate,
}: {
  currentUrl?: URL;
  nextUrl?: URL;
  formData?: FormData;
  defaultShouldRevalidate: boolean;
}) {
  if (formData?.get("intent") === "createThreadAndStart") {
    return false;
  }

  if (
    !formData &&
    currentUrl &&
    nextUrl &&
    isConnectionsUiOnlySearchChange(currentUrl, nextUrl)
  ) {
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
      chatGroups: Promise.resolve([] as ChatGroupView[]),
      billingAccessReady: true,
      appRouteAccessible: true,
      paywallContext: null,
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
  const actingUserId =
    authContext.user?.id ?? authContext.session?.user_id ?? null;
  const currentChatGroupsPromise: Promise<ChatGroupView[]> = currentWorkspaceId && actingUserId
    ? listGroupsForWorkspace(context, {
        userId: actingUserId,
        orgId: currentOrg.id,
        workspaceId: currentWorkspaceId,
      }).catch((error) => {
        console.error("Failed to load chat groups:", error);
        throw error;
      })
    : Promise.resolve([]);
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
    return isLegacyUser && !dismissedValue;
  })().catch(() => {
    // KV failure should never take down the app — degrade to hiding the banner.
    return false;
  });
  const responseData = {
    authState,
    defaultSidebarOpen,
    showLegacyBanner: showLegacyBannerPromise,
    chatGroups: currentChatGroupsPromise,
    billingAccessReady,
    appRouteAccessible,
    paywallContext,
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
    appRouteAccessible,
    paywallContext,
    embedMode,
  } =
    useLoaderData<typeof loader>();
  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <ChatGroupsProvider disableLiveStatus={embedMode}>
        <ChatThreadSnapshotsProvider>
          {embedMode ? null : <AppSidebar />}
          <SidebarInset className="h-svh overflow-hidden flex flex-col">
            {embedMode || appRouteAccessible ? (
              <Outlet />
            ) : paywallContext ? (
              <PaywallTakeover paywallContext={paywallContext} />
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
        </>
      )}
    </SidebarProvider>
  );
}
