import { redirect } from 'next/navigation';
import { getSessionId } from '@/lib/auth';
import * as authDO from '@/lib/auth-do';

/**
 * Worker Auth Endpoint
 *
 * Handles the cross-domain authentication flow for private workers.
 * This is step 2 of the auth flow:
 *
 * 1. User visits private worker → dispatcher creates state → redirects here
 * 2. This endpoint validates session → creates token → redirects to callback
 * 3. Dispatcher callback validates token → creates session cookie
 *
 * Query params:
 * - state: The auth state UUID created by the dispatcher
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');

  // State is required
  if (!state) {
    return new Response('Missing state parameter', { status: 400 });
  }

  // Check if user is logged in
  const sessionId = await getSessionId();
  if (!sessionId) {
    // Redirect to login with return URL back to this auth flow
    const loginUrl = new URL('/login', url.origin);
    loginUrl.searchParams.set('redirect', url.pathname + url.search);
    redirect(loginUrl.toString());
  }

  // Get user session data
  const sessionWithUser = await authDO.getSessionWithUser(sessionId);
  if (!sessionWithUser) {
    // Session invalid, redirect to login
    const loginUrl = new URL('/login', url.origin);
    loginUrl.searchParams.set('redirect', url.pathname + url.search);
    redirect(loginUrl.toString());
  }

  const { user } = sessionWithUser;

  // Validate and consume the auth state
  const authState = await authDO.validateAndConsumeWorkerAuthState(state);
  if (!authState) {
    // State invalid or expired (30s TTL)
    return new Response(
      'Invalid or expired authentication state. Please try accessing the worker again.',
      { status: 400 }
    );
  }

  // Verify the user is a member of the required org
  const isMember = await authDO.isOrgMember(user.id, authState.required_org_id);
  if (!isMember) {
    return new Response(
      'You do not have access to this worker. You must be a member of the organization that owns it.',
      { status: 403 }
    );
  }

  // Create one-time token for the callback
  const token = await authDO.createWorkerAuthToken(
    user.id,
    authState.required_org_id,
    state,
    authState.script_name
  );

  // Build callback URL
  const callbackUrl = new URL('/__chiridion_auth/callback', authState.return_url);
  callbackUrl.searchParams.set('token', token);
  callbackUrl.searchParams.set('state', state);

  // Redirect to the dispatcher callback
  redirect(callbackUrl.toString());
}
