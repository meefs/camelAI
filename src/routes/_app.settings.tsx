import { Outlet } from 'react-router';
import type { Route } from './+types/_app.settings';
import { requireAuthContext } from '@/lib/auth.server';
import { SettingsNav } from '@/components/settings/settings-nav';
import {
  SettingsContentSkeleton,
  SettingsNavSkeleton,
} from '@/components/settings/settings-loading';
import { SettingsRefreshWrapper } from '@/components/settings/settings-refresh-wrapper';

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireAuthContext(request, context);
  return null;
}

export default function SettingsLayout() {
  return (
    <div className="flex h-full flex-col md:flex-row overflow-hidden">
      <SettingsNav />
      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        <SettingsRefreshWrapper>
          <Outlet />
        </SettingsRefreshWrapper>
      </main>
    </div>
  );
}

export function HydrateFallback() {
  return (
    <div className="flex h-full flex-col md:flex-row overflow-hidden">
      <SettingsNavSkeleton />
      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        <SettingsContentSkeleton />
      </main>
    </div>
  );
}
