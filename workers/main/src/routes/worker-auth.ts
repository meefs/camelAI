/**
 * Worker Auth Route
 *
 * Handles cross-domain authentication for private worker access.
 * This route is called by the dispatcher when a user tries to access
 * a private worker on *.camelai.app (cross-site).
 *
 * Flow:
 * 1. Dispatcher redirects here with ?state={uuid}
 * 2. We validate the user is logged in
 * 3. We validate and consume the auth state
 * 4. We check if user is a member of the required org
 * 5. We create a one-time token
 * 6. We redirect back to dispatcher callback with token and state
 */

import type { RouteContext } from '../types.js';
import { redirect, text } from '../helpers/response.js';
import { getSignedSessionFromRequest } from '../cookies.js';
import {
  validateAndConsumeAuthState,
  createWorkerAuthToken,
} from '../worker-auth.js';
import { validateAccessBackedSignedSession } from '../helpers/access-session.js';
import type { OrgDO, UserDO } from '../auth.js';

// Auth callback path on dispatcher domain
const AUTH_CALLBACK_PATH = '/__chiridion_auth/callback';

function getOrgStub(env: RouteContext['env'], orgId: string) {
  const namespace = env.ORG as DurableObjectNamespace<OrgDO>;
  return namespace.get(namespace.idFromName(orgId));
}

export async function handleWorkerAuth({ req, env, url }: RouteContext): Promise<Response> {
  const state = url.searchParams.get('state');

  if (!state) {
    return text('Missing state parameter', 400);
  }

  // Validate the auth state (consume it from KV)
  const stateData = await validateAndConsumeAuthState(env.APP_KV, state);
  if (!stateData) {
    return text('Invalid or expired state', 400);
  }

  // Check if user is authenticated via signed session cookie
  const session = await getSignedSessionFromRequest(req, env.TOKEN_SIGNING_SECRET);

  if (!session) {
    const loginUrl = new URL('/login', url.origin);
    return redirect(loginUrl.toString());
  }
  const accessValidation = await validateAccessBackedSignedSession(
    req,
    env,
    session,
  );
  if (accessValidation === 'unavailable') {
    return text('Cloudflare Access validation is temporarily unavailable', 503);
  }
  if (accessValidation !== 'valid') {
    const loginUrl = new URL('/login', url.origin);
    return redirect(loginUrl.toString());
  }

  // Check if this session was invalidated (e.g. by logout)
  const userNs = env.USER as DurableObjectNamespace<UserDO>;
  const invalidatedAt = await userNs
    .get(userNs.idFromName(session.user_id))
    .getSessionInvalidatedAt();
  if (invalidatedAt && session.created_at < invalidatedAt) {
    const loginUrl = new URL('/login', url.origin);
    return redirect(loginUrl.toString());
  }

  // Check if user is a member of the required org
  const orgStub = getOrgStub(env, stateData.required_org_id);
  const isMember = await orgStub.isMember(session.user_id);

  if (!isMember) {
    return text('Forbidden - not a member of this organization', 403);
  }

  // Create one-time token for the dispatcher
  const token = await createWorkerAuthToken(env.APP_KV, {
    user_id: session.user_id,
    org_id: stateData.required_org_id,
    state: state,
    script_name: stateData.script_name,
  });

  // Build callback URL on the dispatcher domain
  const callbackUrl = new URL(AUTH_CALLBACK_PATH, stateData.return_url);
  callbackUrl.searchParams.set('token', token);
  callbackUrl.searchParams.set('state', state);

  return redirect(callbackUrl.toString());
}
