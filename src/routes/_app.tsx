import { Outlet, useLoaderData, useNavigation } from 'react-router';
import type { Route } from './+types/_app';
import { requireAuthContext } from '@/lib/auth.server';
import { parseCookies } from '@/lib/cookies.server';
import { AppSidebar } from '@/components/sidebar/app-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AuthProvider } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
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

  // Convert auth context to AuthState for the provider
  const authState: AuthState = {
    user: authContext.user,
    currentOrg: authContext.currentOrg,
    currentWorkspace: authContext.currentWorkspace,
    orgs: authContext.orgs,
    workspaces: authContext.workspaces,
    loading: false,
    error: null,
  };

  return {
    authState,
    defaultSidebarOpen,
  };
}

function GlobalLoadingBar() {
  const navigation = useNavigation();
  const isNavigating = navigation.state === 'loading';

  return (
    <div
      className={cn(
        'fixed top-0 left-0 right-0 z-50 h-0.5 bg-primary transition-opacity duration-200',
        isNavigating ? 'opacity-100' : 'opacity-0'
      )}
    >
      <div className="h-full w-full bg-primary animate-pulse" />
    </div>
  );
}

export default function AppLayout() {
  const { authState, defaultSidebarOpen } = useLoaderData<typeof loader>();

  return (
    <AuthProvider initialState={authState}>
      <GlobalLoadingBar />
      <SidebarProvider defaultOpen={defaultSidebarOpen}>
        <AppSidebar />
        <SidebarInset className="h-svh overflow-hidden flex flex-col">
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </AuthProvider>
  );
}
