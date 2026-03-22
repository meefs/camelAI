import { Outlet, redirect, data } from 'react-router';
import type { Route } from './+types/_auth';
import { getAuthContext, getSession } from '@/lib/auth.server';
import { createDeleteSessionCookieHeader } from '@/lib/cookies.server';

/**
 * Auth layout for public routes (login, signup).
 * Redirects to home if user is already authenticated.
 *
 * Uses getAuthContext (not just getSession) to break the redirect loop:
 * if the session cookie exists but auth context fails (corrupted profile/org),
 * we clear the stale cookie so the user can re-login.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const redirectTo = getSafeRedirect(url.searchParams.get('redirect'));

  const sessionContext = await getSession(request, context);
  if (sessionContext) {
    // Session cookie is valid — check if full auth context can be built
    const authContext = await getAuthContext(request, context);
    if (authContext) {
      throw redirect(redirectTo);
    }
    // Session exists but auth context failed (corrupted profile/org) —
    // clear the stale cookie to break the redirect loop with _app routes.
    return data(
      { redirectTo },
      { headers: { 'Set-Cookie': createDeleteSessionCookieHeader(request) } }
    );
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
  // Check only the path portion — query params may contain colons
  // (e.g. redirect_uri=https://...) which are safe.
  const pathPart = redirect.split('?')[0];
  if (
    pathPart.startsWith('/') &&
    !pathPart.startsWith('//') &&
    !pathPart.includes(':')
  ) {
    return redirect;
  }
  return '/';
}
