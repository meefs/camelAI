import { Outlet, useLoaderData } from 'react-router';
import { waitUntil } from 'cloudflare:workers';
import type { Route } from './+types/_app';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { parseCookies } from '@/lib/cookies.server';
import { AppSidebar } from '@/components/sidebar/app-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { getWorkspaceContainer, type WorkspaceContainerEnv } from '../../workers/main/src/workspace-container';
import type { AuthState } from '@/types';

const SIDEBAR_COOKIE_NAME = 'sidebar_state';

export async function loader({ request, context }: Route.LoaderArgs) {
  // Auth check - redirects to /login if not authenticated
  const authContext = await requireAuthContext(request, context);

  // Get sidebar state from cookies
  const cookies = parseCookies(request);
  const sidebarValue = cookies[SIDEBAR_COOKIE_NAME];
  let defaultSidebarOpen = true;
  if (sidebarValue === 'false') {
    defaultSidebarOpen = false;
  }

  // Trigger container warmup in background (fire-and-forget)
  if (authContext.currentWorkspace) {
    const env = getEnv(context);
    const container = getWorkspaceContainer(env as unknown as WorkspaceContainerEnv, authContext.currentWorkspace.id);
    waitUntil(
      container
        .startForWorkspace(authContext.currentWorkspace.id, authContext.currentOrg.id)
        .catch((err) => console.error('[warmup] Container start failed:', err))
    );
  }

  // Convert auth context to AuthState for the provider
  const authState: AuthState = {
    user: authContext.user,
    currentOrg: authContext.currentOrg,
    currentWorkspace: authContext.currentWorkspace,
    orgs: authContext.orgs,
    workspaces: authContext.workspaces,
    allWorkspaces: authContext.allWorkspaces,
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
