/**
 * User OAuth routes (Google, GitHub)
 */

import type { RouteContext, Env } from '../types.js';
import { createSession } from '../session-kv.js';
import { createOAuthState, consumeOAuthStateWithData } from '../oauth-state.js';
import {
  isValidOAuthProvider,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
  OAUTH_PROVIDERS,
  type OAuthProvider,
} from '../../../../src/lib/oauth-config.js';
import { getOrCreateUserFromOAuth, ensureDefaultOrgWorkspace } from '../services/oauth.js';
import { redirect, text } from '../helpers/response.js';

const OAUTH_PROVIDER_TIMEOUT_MS = 15_000;

export async function handleOAuthStart({ env, url, match }: RouteContext): Promise<Response> {
  const provider = match[1] as OAuthProvider;
  if (!isValidOAuthProvider(provider)) return text('Invalid provider', 400);

  const config = OAUTH_PROVIDERS[provider];
  const clientId = env[config.clientIdEnvVar as keyof Env] as string | undefined;
  if (!clientId) return text(`${config.displayName} OAuth is not configured`, 500);

  const redirectTo = url.searchParams.get('redirect') || '/';
  const callbackUrl = `${url.origin}/api/auth/${provider}/callback`;
  const state = await createOAuthState(env.OAUTH_STATE, provider, redirectTo);

  return redirect(buildAuthorizationUrl(provider, clientId, callbackUrl, state));
}

export async function handleOAuthCallback({ env, url, match }: RouteContext): Promise<Response> {
  const startedAt = Date.now();
  const provider = match[1] as OAuthProvider;
  if (!isValidOAuthProvider(provider)) return text('Invalid provider', 400);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const secure = url.protocol === 'https:';

  if (error) return redirect(`${url.origin}/login?error=oauth_denied`);
  if (!code || !state) return redirect(`${url.origin}/login?error=oauth_invalid`);

  const stateData = await consumeOAuthStateWithData(env.OAUTH_STATE, state);
  if (!stateData || stateData.provider !== provider) {
    console.warn('[oauth] invalid state on callback', {
      provider,
      elapsed_ms: Date.now() - startedAt,
    });
    return redirect(`${url.origin}/login?error=oauth_state_invalid`);
  }

  const config = OAUTH_PROVIDERS[provider];
  const clientId = env[config.clientIdEnvVar as keyof Env] as string | undefined;
  const clientSecret = env[config.clientSecretEnvVar as keyof Env] as string | undefined;
  if (!clientId || !clientSecret) return redirect(`${url.origin}/login?error=oauth_config`);

  let stage:
    | 'state_validate_consume'
    | 'token_exchange'
    | 'fetch_userinfo'
    | 'user_lookup'
    | 'org_workspace'
    | 'session_create' = 'state_validate_consume';

  try {
    stage = 'state_validate_consume';
    const callbackUrl = `${url.origin}/api/auth/${provider}/callback`;
    stage = 'token_exchange';
    const tokens = await exchangeCodeForTokens(
      provider,
      code,
      clientId,
      clientSecret,
      callbackUrl,
      OAUTH_PROVIDER_TIMEOUT_MS
    );

    stage = 'fetch_userinfo';
    const userInfo = await fetchUserInfo(provider, tokens.access_token, OAUTH_PROVIDER_TIMEOUT_MS);

    stage = 'user_lookup';
    const userId = await getOrCreateUserFromOAuth(env, provider, userInfo);
    const displayName = userInfo.name || userInfo.email.split('@')[0];

    stage = 'org_workspace';
    const { orgId, workspaceId } = await ensureDefaultOrgWorkspace(env, userId, displayName);

    const sessionId = crypto.randomUUID();
    stage = 'session_create';
    await createSession(env.SESSIONS, sessionId, {
      user_id: userId,
      org_id: orgId,
      workspace_id: workspaceId,
      created_at: Date.now(),
      last_accessed: Date.now(),
      user_name: userInfo.name || null,
      user_email: userInfo.email || null,
    });

    console.log('[oauth] callback succeeded', {
      provider,
      elapsed_ms: Date.now() - startedAt,
    });

    return redirect(stateData.redirect_url || '/', sessionId, secure, url.hostname);
  } catch (err) {
    if (err instanceof Error && err.message === 'oauth_race_condition') {
      return redirect(`${url.origin}/login?error=oauth_race_condition`);
    }
    console.error('[oauth] OAuth flow failed:', {
      provider,
      stage,
      elapsed_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    return redirect(`${url.origin}/login?error=oauth_failed`);
  }
}
