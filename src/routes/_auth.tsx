import { safeRedirectPath } from "@/lib/safe-redirect";
import { Outlet, redirect, data } from 'react-router';
import type { Route } from './+types/_auth';
import { getAuthContext, getSession } from '@/lib/auth.server';
import {
  createDeleteSessionCookieHeader,
  createSessionCookieHeader,
} from '@/lib/cookies.server';

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
  const redirectTo = safeRedirectPath(url.searchParams.get('redirect'));

  const sessionContext = await getSession(request, context);
  if (sessionContext) {
    if (sessionContext.createdSessionCookie) {
      throw redirect(redirectTo, {
        headers: {
          'Set-Cookie': createSessionCookieHeader(
            sessionContext.createdSessionCookie,
            request,
          ),
        },
      });
    }
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
