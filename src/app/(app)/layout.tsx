import type { ReactNode } from 'react';
import { cookies } from 'next/headers';

import { AppSidebar } from '@/components/sidebar/app-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { requireSession } from '@/lib/server-guards';

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

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Auth check - redirects to /login if not authenticated
  // This protects all pages under (app)/*
  await requireSession();

  const defaultOpen = await getDefaultSidebarOpen();

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar />
      <SidebarInset className="h-svh overflow-hidden flex flex-col">
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
