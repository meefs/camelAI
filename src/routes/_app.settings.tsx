import { Suspense } from 'react';
import { Outlet, useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { isSelfhostRuntime } from '@/lib/selfhost-runtime';
import { SettingsNav } from '@/components/settings/settings-nav';
import {
  SettingsContentSkeleton,
  SettingsNavSkeleton,
} from '@/components/settings/settings-loading';
import { SettingsRefreshWrapper } from '@/components/settings/settings-refresh-wrapper';
import { PageHeader } from '@/components/page-header';

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const currentUserOrg = authContext.orgs.find((o) => o.org_id === authContext.currentOrg.id);
  const isOrgAdmin = currentUserOrg?.role === 'owner' || currentUserOrg?.role === 'admin';
  return { isOrgAdmin, selfhostRuntime: isSelfhostRuntime(env) };
}

export default function SettingsLayout() {
  const { isOrgAdmin, selfhostRuntime } = useLoaderData<typeof loader>();
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader breadcrumbs={[{ label: 'Settings' }]} />
      <div className="flex flex-1 overflow-hidden">
        <div className="mx-auto flex w-full max-w-[90rem] flex-col overflow-hidden md:flex-row">
          <Suspense fallback={<SettingsNavSkeleton />}>
            <SettingsNav
              isOrgAdmin={isOrgAdmin}
              selfhostRuntime={selfhostRuntime}
            />
          </Suspense>
          <main className="flex-1 overflow-y-auto p-4 md:p-8">
            <SettingsRefreshWrapper>
              <Suspense fallback={<SettingsContentSkeleton />}>
                <Outlet />
              </Suspense>
            </SettingsRefreshWrapper>
          </main>
        </div>
      </div>
    </div>
  );
}

export function HydrateFallback() {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader breadcrumbs={[{ label: 'Settings' }]} />
      <div className="flex flex-1 overflow-hidden">
        <div className="mx-auto flex w-full max-w-[90rem] flex-col overflow-hidden md:flex-row">
          <SettingsNavSkeleton />
          <main className="flex-1 overflow-y-auto p-4 md:p-8">
            <SettingsContentSkeleton />
          </main>
        </div>
      </div>
    </div>
  );
}
