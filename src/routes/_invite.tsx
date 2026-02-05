import { Outlet } from 'react-router';
import type { Route } from './+types/_invite';
import { getAuthContext } from '@/lib/auth.server';

/**
 * Layout for invitation pages. Fetches optional auth state
 * so child pages can check if user is logged in.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await getAuthContext(request, context);
  return {
    user: authContext?.user ?? null,
  };
}

export default function InviteLayout() {
  return <Outlet />;
}
