import { Outlet, redirect, useLoaderData } from 'react-router';
import { waitUntil } from 'cloudflare:workers';
import type { Route } from './+types/_app';
import { requireAuthContext } from '@/lib/auth.server';
import { parseCookies } from '@/lib/cookies.server';
import { getEnv } from '@/lib/cloudflare.server';
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

  // Prewarm workspace env vars in background (non-blocking)
  const env = getEnv(context);
  const currentWorkspace = authContext.currentWorkspace;
  const orgId = authContext.currentOrg.id;
  if (env.WORKSPACE && currentWorkspace) {
    const workspaceId = currentWorkspace.id;
    const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
    waitUntil(
      (workspaceStub as unknown as { prewarmEnvVars(wsId: string, orgId: string): Promise<boolean> })
        .prewarmEnvVars(workspaceId, orgId)
        .catch((err: unknown) => {
          console.error(`[_app] prewarm failed workspace=${workspaceId}`, err);
        })
    );
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
