import { Outlet, redirect, useLoaderData } from 'react-router';
import type { Route } from './+types/_app';
import { getAuthEnv, requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { parseCookies } from '@/lib/cookies.server';
import { AppSidebar } from '@/components/sidebar/app-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import type { AuthState } from '@/types';

const SIDEBAR_COOKIE_NAME = 'sidebar_state';

export async function loader({ request, context }: Route.LoaderArgs) {
  // Auth check - redirects to /login if not authenticated
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const userStub = authEnv.USER.get(
    authEnv.USER.idFromName(authContext.user.id)
  );
  const verificationStatus = await userStub.getEmailVerificationStatus();

  if (!authContext.onboarding?.completed_at) {
    throw redirect('/onboarding');
  }
  if (verificationStatus.required && !verificationStatus.verified) {
    throw redirect('/onboarding');
  }

  // Get sidebar state from cookies
  const cookies = parseCookies(request);
  const sidebarValue = cookies[SIDEBAR_COOKIE_NAME];
  let defaultSidebarOpen = true;
  if (sidebarValue === 'false') {
    defaultSidebarOpen = false;
  }

  // Convert auth context to AuthState for the provider
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

  return {
    authState,
    defaultSidebarOpen,
  };
}

export default function AppLayout() {
  const { defaultSidebarOpen } = useLoaderData<typeof loader>();

  return (
    <SidebarProvider defaultOpen={defaultSidebarOpen}>
      <AppSidebar />
      <SidebarInset className="h-svh overflow-hidden flex flex-col">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
