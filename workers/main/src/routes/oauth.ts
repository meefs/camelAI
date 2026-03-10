/**
 * User OAuth routes (Google, GitHub)
 *
 * Uses HMAC-signed cookies for both OAuth state (CSRF) and session tokens.
 * No server-side storage needed — eliminates KV eventual-consistency issues.
 */

import type { RouteContext, Env } from '../types.js';
import {
  isValidOAuthProvider,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
  OAUTH_PROVIDERS,
  type OAuthProvider,
} from '../../../../src/lib/oauth-config.js';
import { getOrCreateUserFromOAuth, ensureDefaultOrgWorkspace } from '../services/oauth.js';
import { text } from '../helpers/response.js';
import {
  SESSION_MAX_AGE,
  getCookieDomain,
  getSessionCookieName,
  createOAuthStateCookie,
  getOAuthStateFromRequest,
  createDeleteOAuthStateCookie,
} from '../cookies.js';
import { createSignedSession, type SignedSessionData } from '../signed-session.js';
import { consumeSalesPrompt, getPromptKeyFromUrl } from '../../../../src/lib/sales-prompt.server.js';

const OAUTH_PROVIDER_TIMEOUT_MS = 15_000;

export function sanitizeRedirectPath(input: string | null): string {
  if (!input) return '/';
  if (
    input.startsWith('/') &&
    !input.startsWith('//') &&
    !input.includes(':')
  ) {
    return input;
  }
  return '/';
}

function buildSessionCookie(name: string, value: string, maxAge: number, secure: boolean, domain?: string): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

export async function handleOAuthStart({ env, url, match, req }: RouteContext): Promise<Response> {
  const provider = match[1] as OAuthProvider;
  if (!isValidOAuthProvider(provider)) return text('Invalid provider', 400);

  const config = OAUTH_PROVIDERS[provider];
  const clientId = env[config.clientIdEnvVar as keyof Env] as string | undefined;
  if (!clientId) return text(`${config.displayName} OAuth is not configured`, 500);

  const redirectTo = sanitizeRedirectPath(url.searchParams.get('redirect'));
  const callbackUrl = `${url.origin}/api/auth/${provider}/callback`;
  const nonce = crypto.randomUUID();

  const stateCookie = await createOAuthStateCookie(
    { provider, redirect_url: redirectTo, nonce, created_at: Date.now() },
    env.TOKEN_SIGNING_SECRET,
    req
  );

  const headers = new Headers({
    Location: buildAuthorizationUrl(provider, clientId, callbackUrl, nonce),
  });
  headers.append('Set-Cookie', stateCookie);
  return new Response(null, { status: 302, headers });
}

export async function handleOAuthCallback({ env, url, match, req }: RouteContext): Promise<Response> {
  const startedAt = Date.now();
  const provider = match[1] as OAuthProvider;
  if (!isValidOAuthProvider(provider)) return text('Invalid provider', 400);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const secure = url.protocol === 'https:';
  const hostname = url.hostname;

  if (error) return redirectTo(`${url.origin}/login?error=oauth_denied`);
  if (!code || !state) return redirectTo(`${url.origin}/login?error=oauth_invalid`);

  // Verify OAuth state from signed cookie
  const stateData = await getOAuthStateFromRequest(req, env.TOKEN_SIGNING_SECRET);
  if (!stateData || stateData.provider !== provider || stateData.nonce !== state) {
    console.warn('[oauth] invalid state on callback', {
      provider,
      hasStateCookie: !!stateData,
      nonceMatch: stateData?.nonce === state,
      elapsed_ms: Date.now() - startedAt,
    });
    return redirectTo(`${url.origin}/login?error=oauth_state_invalid`);
  }

  const config = OAUTH_PROVIDERS[provider];
  const clientId = env[config.clientIdEnvVar as keyof Env] as string | undefined;
  const clientSecret = env[config.clientSecretEnvVar as keyof Env] as string | undefined;
  if (!clientId || !clientSecret) return redirectTo(`${url.origin}/login?error=oauth_config`);

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

    stage = 'session_create';
    const sessionData: SignedSessionData = {
      user_id: userId,
      org_id: orgId,
      workspace_id: workspaceId,
      created_at: Date.now(),
      user_name: userInfo.name || null,
      user_email: userInfo.email || null,
    };
    const signedToken = await createSignedSession(env.TOKEN_SIGNING_SECRET, sessionData);

    // For new users (onboarding incomplete), consume the sales prompt from KV
    // and store on UserDO so it survives through onboarding. For returning users
    // (onboarding complete), leave the KV entry intact — the /chat loader will
    // consume it directly and prefill the composer.
    const promptKey = getPromptKeyFromRedirectUrl(stateData.redirect_url);
    if (promptKey) {
      try {
        const userStub = env.USER.get(env.USER.idFromName(userId));
        const onboarding = await userStub.getOnboarding();
        if (!onboarding?.completed_at) {
          const prompt = await consumeSalesPrompt(env.APP_KV, promptKey);
          if (prompt) {
            await userStub.setPendingSalesPrompt(prompt);
          }
        }
      } catch (err) {
        console.error('[oauth] failed to consume sales prompt:', err);
      }
    }

    console.log('[oauth] callback succeeded', {
      provider,
      elapsed_ms: Date.now() - startedAt,
    });

    // Set session cookie and clear OAuth state cookie
    const domain = getCookieDomain(hostname);
    const cookieName = getSessionCookieName(hostname);
    const headers = new Headers({
      Location: stateData.redirect_url || '/',
    });
    headers.append('Set-Cookie', buildSessionCookie(cookieName, signedToken, SESSION_MAX_AGE, secure, domain));
    headers.append('Set-Cookie', createDeleteOAuthStateCookie(req));
    return new Response(null, { status: 302, headers });
  } catch (err) {
    if (err instanceof Error && err.message === 'oauth_race_condition') {
      return redirectTo(`${url.origin}/login?error=oauth_race_condition`);
    }
    console.error('[oauth] OAuth flow failed:', {
      provider,
      stage,
      elapsed_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    return redirectTo(`${url.origin}/login?error=oauth_failed`);
  }
}

function redirectTo(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } });
}

function getPromptKeyFromRedirectUrl(redirectUrl: string | undefined): string | null {
  if (!redirectUrl) return null;
  try {
    return getPromptKeyFromUrl(new URL(redirectUrl, 'https://camelai.dev'));
  } catch {
    return null;
  }
}
