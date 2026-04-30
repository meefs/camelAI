import { useEffect, useRef, useState } from "react";
import { Outlet, redirect, data, useLoaderData, useNavigate } from "react-router";
import type { Route } from "./+types/_app";
import { requireAuthContext } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { parseCookies, createSessionCookieHeader } from "@/lib/cookies.server";
import { LegacyUserBanner } from "@/components/legacy-user-banner";
import { LegacyMigrationDialog } from "@/components/billing/legacy-migration-dialog";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import type { AuthState } from "@/types";
import {
  getLegacyStripeMigrationEligibility,
  isConfiguredEnterpriseOrg,
} from "@/lib/billing.server";

const SIDEBAR_COOKIE_NAME = "sidebar_state";

/**
 * Skip revalidation after createThread — the layout auth state hasn't changed
 * and requireAuthContext() is expensive (~200-300ms of DO RPCs).
 * Use defaultShouldRevalidate as fallback so navigations within the layout
 * (where no params changed) also skip the expensive loader.
 */
export function shouldRevalidate({
  formData,
  defaultShouldRevalidate,
}: {
  formData?: FormData;
  defaultShouldRevalidate: boolean;
}) {
  if (formData?.get("intent") === "createThread") return false;
  return defaultShouldRevalidate;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  // Auth check - redirects to /login if not authenticated
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);

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
  const llmProviderConfig = await orgStub.getLlmProviderConfig();
  const currentOrg = isConfiguredEnterpriseOrg(env, authContext.currentOrg)
    ? {
        ...authContext.currentOrg,
        billing_status: "enterprise" as const,
        billing_plan: "enterprise" as const,
      }
    : authContext.currentOrg;
  const billingAccessReady = Boolean(
    llmProviderConfig ||
    currentOrg.billing_status === "trialing" ||
    currentOrg.billing_status === "active" ||
    currentOrg.billing_status === "enterprise",
  );
  if (!billingAccessReady) {
    throw redirect("/onboarding");
  }

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

  let showLegacyBanner = false;
  const legacyMigration = getLegacyStripeMigrationEligibility({
    env,
    org: currentOrg,
    userEmail: authContext.user.email,
  });
  try {
    const normalizedEmail = authContext.user.email.trim().toLowerCase();
    const isDevelopment = env.NEXTJS_ENV === "development";
    const [legacyUserValue, dismissedValue] = await Promise.all([
      isDevelopment || !normalizedEmail
        ? Promise.resolve(isDevelopment ? "1" : null)
        : env.APP_KV.get(`legacy_user:${normalizedEmail}`),
      env.APP_KV.get(`legacy_banner_dismissed:${authContext.user.id}`),
    ]);
    const isLegacyUser = isDevelopment || Boolean(legacyUserValue);
    showLegacyBanner = isLegacyUser && !Boolean(dismissedValue);
  } catch {
    // KV failure should never take down the app — degrade to hiding the banner
  }
  const responseData = {
    authState,
    defaultSidebarOpen,
    showLegacyBanner,
    legacyMigration,
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
  const { authState, defaultSidebarOpen, showLegacyBanner, legacyMigration } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();
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
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <AppSidebar />
      <SidebarInset className="h-svh overflow-hidden flex flex-col">
        <Outlet />
      </SidebarInset>
      <LegacyUserBanner
        show={showLegacyBanner}
        userId={authState.user?.id ?? "legacy-user"}
      />
      <LegacyMigrationDialog
        migration={legacyMigration}
        open={legacyDialogOpen}
        onOpenChange={setLegacyDialogOpen}
        primaryAction={{
          label: "See plans",
          onClick: () => {
            setLegacyDialogOpen(false);
            navigate("/settings/organization/billing");
          },
        }}
      />
    </SidebarProvider>
  );
}
