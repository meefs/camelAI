import { Outlet, redirect } from 'react-router';
import type { Route } from './+types/_auth';
import { getSession } from '@/lib/auth.server';

/**
 * Auth layout for public routes (login, signup).
 * Redirects to home if user is already authenticated.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const session = await getSession(request, context);
  const url = new URL(request.url);
  const redirectTo = getSafeRedirect(url.searchParams.get('redirect'));

  if (session) {
    throw redirect(redirectTo);
  }

  return { redirectTo };
}

export default function AuthLayout() {
  return <Outlet />;
}

/**
 * Validate redirect URL to prevent open redirects
 */
function getSafeRedirect(redirect: string | null): string {
  if (!redirect) return '/';
  // Must start with single slash and not be a protocol-relative URL
  if (
    redirect.startsWith('/') &&
    !redirect.startsWith('//') &&
    !redirect.includes(':')
  ) {
    return redirect;
  }
  return '/';
}
