import { Outlet } from 'react-router';
import type { Route } from './+types/_app.settings.organization';
import { requireAuthContext } from '@/lib/auth.server';

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireAuthContext(request, context);
  return null;
}

export default function OrganizationSettingsLayout() {
  return <Outlet />;
}
