/**
 * Integration OAuth routes (Slack)
 */

import type { RouteContext } from '../types.js';
import { createIntegrationOAuthState, validateAndConsumeIntegrationOAuthState } from '../integration-oauth-state.js';
import { INTEGRATION_REGISTRY } from '../../../../src/lib/integration-registry.js';
import { encryptCredentials } from '../../../../src/lib/integration-crypto.js';
import { getWorkspaceContainer } from '../workspace-container.js';
import { requireSession } from '../helpers/auth.js';
import { getWorkspaceStub, getOrgStub } from '../helpers/stubs.js';
import { redirect, text } from '../helpers/response.js';

/**
 * Sanitize redirect URL to prevent open redirect attacks.
 * Only allows relative paths starting with `/` (but not `//` which is protocol-relative).
 */
function sanitizeRedirectPath(input: string): string {
  // Default to /connections if empty
  if (!input) return '/connections';

  // Must start with exactly one `/` (not `//` which is protocol-relative)
  if (!input.startsWith('/') || input.startsWith('//')) {
    return '/connections';
  }

  // Strip any query params or fragments that might contain absolute URLs
  // and reconstruct with just the pathname
  try {
    const parsed = new URL(input, 'http://dummy');
    // Ensure the path doesn't encode an absolute URL
    if (parsed.pathname.includes('://') || parsed.pathname.startsWith('//')) {
      return '/connections';
    }
    return parsed.pathname + parsed.search;
  } catch {
    return '/connections';
  }
}

export async function handleSlackOAuthStart({ req, env, url }: RouteContext): Promise<Response> {
  const slackDef = INTEGRATION_REGISTRY.slack;
  if (!slackDef?.oauthConfig || !env.SLACK_CLIENT_ID) {
    return text('Slack OAuth is not configured', 500);
  }

  const auth = await requireSession(req, env);
  if ('error' in auth) return redirect(`${url.origin}/login?error=unauthorized`);

  const { session } = auth;
  if (!session.workspace_id) return redirect(`${url.origin}/connections?error=no_workspace`);

  const redirectTo = sanitizeRedirectPath(url.searchParams.get('redirect') || '/connections');
  const callbackUrl = `${url.origin}/api/integrations/slack/callback`;

  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    'slack',
    session.workspace_id,
    session.user_id,
    redirectTo
  );

  const authUrl = new URL(slackDef.oauthConfig.authorizationUrl);
  authUrl.searchParams.set('client_id', env.SLACK_CLIENT_ID);
  authUrl.searchParams.set('scope', slackDef.oauthConfig.scopes.join(','));
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('state', state);

  return redirect(authUrl.toString());
}

export async function handleSlackOAuthCallback({ env, url, ctx }: RouteContext): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return redirect(`${url.origin}/connections?error=oauth_denied`);
  if (!code || !state) return redirect(`${url.origin}/connections?error=oauth_invalid`);

  const stateData = await validateAndConsumeIntegrationOAuthState(env.SESSIONS, state);
  if (!stateData || stateData.integration_type !== 'slack') {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }

  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    return redirect(`${url.origin}/connections?error=oauth_config`);
  }

  try {
    const callbackUrl = `${url.origin}/api/integrations/slack/callback`;
    const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.SLACK_CLIENT_ID,
        client_secret: env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: callbackUrl,
      }),
    });

    const tokenData = (await tokenRes.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
      token_type?: string;
      scope?: string;
      bot_user_id?: string;
      app_id?: string;
      team?: { id: string; name: string };
      authed_user?: { id: string; access_token?: string };
    };

    if (!tokenData.ok || !tokenData.access_token) {
      return redirect(`${url.origin}/connections?error=oauth_token_failed`);
    }

    // Re-validate workspace access before creating integration
    // User may have been removed or workspace archived since OAuth started
    const wsStub = getWorkspaceStub(env, stateData.workspace_id);
    const wsInfo = await wsStub.getInfo();
    if (!wsInfo || wsInfo.archived) {
      return redirect(`${url.origin}/connections?error=workspace_not_found`);
    }

    const orgStub = getOrgStub(env, wsInfo.org_id);
    if (!(await orgStub.isMember(stateData.user_id))) {
      return redirect(`${url.origin}/connections?error=access_denied`);
    }

    const memberAccess = await wsStub.getMemberAccess(stateData.user_id);
    if ((memberAccess?.access_level ?? 'full') !== 'full') {
      return redirect(`${url.origin}/connections?error=access_denied`);
    }

    const credentials = {
      access_token: tokenData.access_token,
      token_type: tokenData.token_type,
      scope: tokenData.scope,
      bot_user_id: tokenData.bot_user_id,
      app_id: tokenData.app_id,
      team_id: tokenData.team?.id,
      team_name: tokenData.team?.name,
      user_access_token: tokenData.authed_user?.access_token,
      authed_user_id: tokenData.authed_user?.id,
    };

    const encrypted = await encryptCredentials(credentials, env.INTEGRATION_SECRET_KEY);
    const name = tokenData.team?.name ? `Slack - ${tokenData.team.name}` : 'Slack';

    await wsStub.createIntegration(
      crypto.randomUUID(),
      'slack',
      name,
      'communication',
      'oauth2',
      JSON.stringify({}),
      encrypted,
      stateData.user_id
    );

    ctx.waitUntil(
      getWorkspaceContainer(env, stateData.workspace_id)
        .refreshIntegrationEnvVars(stateData.workspace_id)
        .catch(() => {})
    );

    // Sanitize redirect URL again as defense-in-depth
    const safePath = sanitizeRedirectPath(stateData.redirect_url);
    const redirectUrl = new URL(safePath, url.origin);
    redirectUrl.searchParams.set('success', 'slack_connected');
    return redirect(redirectUrl.toString());
  } catch {
    return redirect(`${url.origin}/connections?error=oauth_failed`);
  }
}
