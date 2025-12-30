import { notFound, redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import * as authDO from '@/lib/auth-do';
import { getSessionId } from '@/lib/auth';
import { AdminSidebar } from '@/components/admin/admin-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

const SIDEBAR_COOKIE_NAME = 'sidebar_state';

async function getDefaultSidebarOpen(): Promise<boolean> {
  const cookieStore = await cookies();
  const value = cookieStore.get(SIDEBAR_COOKIE_NAME)?.value;

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return true;
}

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const sessionId = await getSessionId();
  if (!sessionId) {
    redirect('/login');
  }

  // Run auth check and sidebar cookie read in parallel
  const [sessionWithUser, defaultOpen] = await Promise.all([
    authDO.getSessionWithUser(sessionId),
    getDefaultSidebarOpen(),
  ]);

  if (!sessionWithUser) {
    redirect('/login');
  }

  const { user } = sessionWithUser;

  if (!user.is_superuser) {
    notFound();
  }

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AdminSidebar />
      <SidebarInset className="h-svh overflow-hidden flex flex-col">
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
