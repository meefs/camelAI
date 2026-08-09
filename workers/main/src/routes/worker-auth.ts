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
  getAuthState,
  validateAndConsumeAuthState,
  createWorkerAuthToken,
} from '../worker-auth.js';
import { validateSessionIdentityMapsToOrg } from '../helpers/proxy-auth-providers.js';
import type { OrgDO, UserDO } from '../auth.js';

// Auth callback path on dispatcher domain
const AUTH_CALLBACK_PATH = '/__chiridion_auth/callback';

function getOrgStub(env: RouteContext['env'], orgId: string) {
  const namespace = env.ORG as DurableObjectNamespace<OrgDO>;
  return namespace.get(namespace.idFromName(orgId));
}

function loginRedirect(url: URL): Response {
  const loginUrl = new URL('/login', url.origin);
  loginUrl.searchParams.set('redirect', `${url.pathname}${url.search}`);
  return redirect(loginUrl.toString());
}

export async function handleWorkerAuth({ req, env, url }: RouteContext): Promise<Response> {
  const state = url.searchParams.get('state');

  if (!state) {
    return text('Missing state parameter', 400);
  }

  // Check if user is authenticated via signed session cookie
  const session = await getSignedSessionFromRequest(req, env.TOKEN_SIGNING_SECRET);

  if (!session) {
    return loginRedirect(url);
  }

  // Peek without consuming so proxy silent login can return to this exact
  // continuation. Consume only after identity and membership checks pass.
  const stateData = await getAuthState(env.APP_KV, state);
  if (!stateData) {
    return text('Invalid or expired state', 400);
  }
  // Re-validate the live proxy identity against the org we're about to mint a
  // token for (the private worker's org), NOT the cookie's current org_id. The
  // isMember() check below only proves persisted membership, which can outlive a
  // revoked proxy group; without targeting required_org_id a user whose cookie
  // still maps to some other org could ride stale membership into this one.
  const proxyValidation = await validateSessionIdentityMapsToOrg(
    req,
    env,
    session,
    stateData.required_org_id,
  );
  if (proxyValidation === 'unavailable') {
    return text('Identity proxy validation is temporarily unavailable', 503);
  }
  if (proxyValidation !== 'valid') {
    return loginRedirect(url);
  }

  // Check if this session was invalidated (e.g. by logout)
  const userNs = env.USER as DurableObjectNamespace<UserDO>;
  const invalidatedAt = await userNs
    .get(userNs.idFromName(session.user_id))
    .getSessionInvalidatedAt();
  if (invalidatedAt && session.created_at < invalidatedAt) {
    return loginRedirect(url);
  }

  // Check if user is a member of the required org
  const orgStub = getOrgStub(env, stateData.required_org_id);
  const isMember = await orgStub.isMember(session.user_id);

  if (!isMember) {
    return text('Forbidden - not a member of this organization', 403);
  }

  const consumedStateData = await validateAndConsumeAuthState(env.APP_KV, state);
  if (
    !consumedStateData ||
    consumedStateData.required_org_id !== stateData.required_org_id ||
    consumedStateData.script_name !== stateData.script_name ||
    consumedStateData.return_url !== stateData.return_url
  ) {
    return text('Invalid or expired state', 400);
  }

  // Create one-time token for the dispatcher
  const token = await createWorkerAuthToken(env.APP_KV, {
    user_id: session.user_id,
    org_id: consumedStateData.required_org_id,
    state: state,
    script_name: consumedStateData.script_name,
    callback_origin: new URL(consumedStateData.return_url).origin,
    auth_source: session.auth_source ?? null,
    user_email: session.user_email ?? null,
    expires_at: session.expires_at ?? null,
    sso_connection_id: session.sso_connection_id ?? null,
    sso_config_version: session.sso_config_version ?? null,
  });

  // Build callback URL on the dispatcher domain
  const callbackUrl = new URL(AUTH_CALLBACK_PATH, consumedStateData.return_url);
  callbackUrl.searchParams.set('token', token);
  callbackUrl.searchParams.set('state', state);

  return redirect(callbackUrl.toString());
}
