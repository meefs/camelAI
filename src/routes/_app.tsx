import { Outlet, redirect, useLoaderData } from 'react-router';
import type { Route } from './+types/_app';
import { requireAuthContext } from '@/lib/auth.server';
import { parseCookies } from '@/lib/cookies.server';
import { AppSidebar } from '@/components/sidebar/app-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import type { AuthState } from '@/types';

const SIDEBAR_COOKIE_NAME = 'sidebar_state';

export async function loader({ request, context }: Route.LoaderArgs) {
  // Auth check - redirects to /login if not authenticated
  const authContext = await requireAuthContext(request, context);

  if (!authContext.onboarding?.completed_at) {
    throw redirect('/onboarding');
  }
  if (authContext.emailVerification.required && !authContext.emailVerification.verified) {
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
