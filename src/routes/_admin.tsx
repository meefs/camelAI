import { Outlet } from 'react-router';
import type { Route } from './+types/_admin';
import { requireSuperuser } from '@/lib/auth.server';
import { AdminSidebar } from '@/components/admin/admin-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { getCookie } from '@/lib/cookies.server';

const SIDEBAR_COOKIE_NAME = 'sidebar_state';

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const sidebarValue = getCookie(request, SIDEBAR_COOKIE_NAME);
  const defaultOpen = sidebarValue !== 'false';

  return { defaultOpen };
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  const { defaultOpen } = loaderData;

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AdminSidebar />
      <SidebarInset className="h-svh overflow-hidden flex flex-col">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
