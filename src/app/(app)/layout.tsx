import type { ReactNode } from 'react';
import { cookies } from 'next/headers';

import { AppSidebar } from '@/components/sidebar/app-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

const SIDEBAR_COOKIE_NAME = 'sidebar_state';

function getDefaultSidebarOpen(): boolean {
  const cookieStore = cookies();
  const value = cookieStore.get(SIDEBAR_COOKIE_NAME)?.value;

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return true;
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const defaultOpen = getDefaultSidebarOpen();

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar />
      <SidebarInset className="h-svh overflow-hidden flex flex-col">
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
