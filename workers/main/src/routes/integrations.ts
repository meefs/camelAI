/**
 * Integration OAuth routes
 * Supports: Slack, Notion
 */

import type { RouteContext } from '../types.js';
import { createIntegrationOAuthState, validateAndConsumeIntegrationOAuthState, type IntegrationOAuthState } from '../integration-oauth-state.js';
import { INTEGRATION_REGISTRY } from '../../../../src/lib/integration-registry.js';
import { encryptCredentials } from '../../../../src/lib/integration-crypto.js';
import { getWorkspaceContainer } from '../workspace-container.js';
import { requireSession } from '../helpers/auth.js';
import { getWorkspaceStub, getOrgStub } from '../helpers/stubs.js';
import { redirect, text } from '../helpers/response.js';
import type { ConnectionSetupResponse } from '../durable-objects.js';
import type { ChiridionMcp } from '../mcp-handler.js';
import { syncAllWorkspaceWorkerSecrets, type CfApiProxyEnv } from '../cf-api-proxy.js';

// RPC interface for MCP DO callback
interface ChiridionMcpRpc {
  receiveConnectionSetupResponse(response: ConnectionSetupResponse): void;
}

/**
 * Complete MCP connection setup request after OAuth flow succeeds.
 * Called when OAuth state contains MCP callback context.
 */
async function completeMcpConnectionSetup(
  env: RouteContext['env'],
  stateData: IntegrationOAuthState,
  integrationId: string,
  integrationType: string,
  integrationName: string
): Promise<void> {
  if (!stateData.mcp_request_id || !stateData.mcp_do_id) {
    return; // No MCP context
  }

  try {
    const mcpDoId = env.MCP_OBJECT.idFromString(stateData.mcp_do_id);
    const mcpStub = env.MCP_OBJECT.get(mcpDoId) as unknown as ChiridionMcpRpc;

    // Send success response to MCP - credentials are already stored via OAuth
    // We send empty credentials since they're already encrypted in the integration
    await mcpStub.receiveConnectionSetupResponse({
      requestId: stateData.mcp_request_id,
      cancelled: false,
      integration: {
        type: integrationType,
        name: integrationName,
        config: {},
        credentials: { _oauth_completed: true, integration_id: integrationId },
      },
    });
  } catch (err) {
    console.error('[Integration OAuth] Failed to complete MCP request:', err);
  }
}

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

  // Check for MCP callback context (from chat connection setup prompt)
  const mcpRequestId = url.searchParams.get('mcp_request_id');
  const mcpDoId = url.searchParams.get('mcp_do_id');
  const mcpContext = mcpRequestId && mcpDoId ? { requestId: mcpRequestId, doId: mcpDoId } : undefined;

  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    'slack',
    session.workspace_id,
    session.user_id,
    redirectTo,
    mcpContext
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
    const name = tokenData.team?.name || 'Slack';
    const integrationId = crypto.randomUUID();

    await wsStub.createIntegration(
      integrationId,
      'slack',
      name,
      'communication',
      'oauth2',
      JSON.stringify({}),
      encrypted,
      stateData.user_id
    );

    // Push secrets to running container
    ctx.waitUntil(
      getWorkspaceContainer(env, stateData.workspace_id)
        .refreshIntegrationEnvVars(stateData.workspace_id)
        .catch(() => {})
    );

    // Sync secrets to all deployed workers in this workspace
    ctx.waitUntil(
      syncAllWorkspaceWorkerSecrets(env as unknown as CfApiProxyEnv, stateData.workspace_id, wsInfo.org_id)
        .catch((err) => console.error('[slack-oauth] Failed to sync secrets to workers:', err))
    );

    // Complete MCP request if this OAuth flow was initiated from chat
    if (stateData.mcp_request_id && stateData.mcp_do_id) {
      await completeMcpConnectionSetup(env, stateData, integrationId, 'slack', name);
    }

    // Sanitize redirect URL again as defense-in-depth
    const safePath = sanitizeRedirectPath(stateData.redirect_url);
    const redirectUrl = new URL(safePath, url.origin);
    redirectUrl.searchParams.set('success', 'slack_connected');
    return redirect(redirectUrl.toString());
  } catch {
    return redirect(`${url.origin}/connections?error=oauth_failed`);
  }
}

// =============================================================================
// Notion OAuth
// =============================================================================

export async function handleNotionOAuthStart({ req, env, url }: RouteContext): Promise<Response> {
  const notionDef = INTEGRATION_REGISTRY.notion;
  if (!notionDef?.oauthConfig || !env.NOTION_CLIENT_ID) {
    return text('Notion OAuth is not configured', 500);
  }

  const auth = await requireSession(req, env);
  if ('error' in auth) return redirect(`${url.origin}/login?error=unauthorized`);

  const { session } = auth;
  if (!session.workspace_id) return redirect(`${url.origin}/connections?error=no_workspace`);

  const redirectTo = sanitizeRedirectPath(url.searchParams.get('redirect') || '/connections');
  const callbackUrl = `${url.origin}/api/integrations/notion/callback`;

  // Check for MCP callback context (from chat connection setup prompt)
  const mcpRequestId = url.searchParams.get('mcp_request_id');
  const mcpDoId = url.searchParams.get('mcp_do_id');
  const mcpContext = mcpRequestId && mcpDoId ? { requestId: mcpRequestId, doId: mcpDoId } : undefined;

  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    'notion',
    session.workspace_id,
    session.user_id,
    redirectTo,
    mcpContext
  );

  const authUrl = new URL(notionDef.oauthConfig.authorizationUrl);
  authUrl.searchParams.set('client_id', env.NOTION_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('owner', 'user');
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('state', state);

  return redirect(authUrl.toString());
}

export async function handleNotionOAuthCallback({ env, url, ctx }: RouteContext): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return redirect(`${url.origin}/connections?error=oauth_denied`);
  if (!code || !state) return redirect(`${url.origin}/connections?error=oauth_invalid`);

  const stateData = await validateAndConsumeIntegrationOAuthState(env.SESSIONS, state);
  if (!stateData || stateData.integration_type !== 'notion') {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }

  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
    return redirect(`${url.origin}/connections?error=oauth_config`);
  }

  try {
    const callbackUrl = `${url.origin}/api/integrations/notion/callback`;

    // Notion uses Basic Auth for token exchange
    const basicAuth = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);
    const tokenRes = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
      }),
    });

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number; // Token lifetime in seconds
      refresh_token?: string; // For refreshing the access token
      bot_id?: string;
      workspace_id?: string;
      workspace_name?: string;
      workspace_icon?: string;
      owner?: {
        type: string;
        user?: {
          id: string;
          name?: string;
          avatar_url?: string;
          person?: { email?: string };
        };
      };
      duplicated_template_id?: string;
      request_id?: string;
      error?: string;
    };

    if (!tokenData.access_token) {
      console.error('[notion-oauth] Token exchange failed:', tokenData.error);
      return redirect(`${url.origin}/connections?error=oauth_token_failed`);
    }

    // Re-validate workspace access before creating integration
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

    // Calculate token expiry time (Notion tokens expire after ~1 hour)
    // Default to 1 hour if expires_in not provided
    const expiresInSeconds = tokenData.expires_in ?? 3600;
    const tokenExpiresAt = Date.now() + expiresInSeconds * 1000;

    const credentials = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token, // Stored but never pushed to containers
      expires_at: tokenExpiresAt,
      token_type: tokenData.token_type,
      bot_id: tokenData.bot_id,
      notion_workspace_id: tokenData.workspace_id,
      notion_workspace_name: tokenData.workspace_name,
      owner_user_id: tokenData.owner?.user?.id,
      owner_user_name: tokenData.owner?.user?.name,
      owner_user_email: tokenData.owner?.user?.person?.email,
    };

    const encrypted = await encryptCredentials(credentials, env.INTEGRATION_SECRET_KEY);
    const name = tokenData.workspace_name || 'Notion';
    const integrationId = crypto.randomUUID();

    await wsStub.createIntegration(
      integrationId,
      'notion',
      name,
      'saas',
      'oauth2',
      JSON.stringify({}),
      encrypted,
      stateData.user_id,
      tokenExpiresAt // Pass expiry for alarm scheduling
    );

    // Push secrets to running container
    ctx.waitUntil(
      getWorkspaceContainer(env, stateData.workspace_id)
        .refreshIntegrationEnvVars(stateData.workspace_id)
        .catch(() => {})
    );

    // Sync secrets to all deployed workers in this workspace
    ctx.waitUntil(
      syncAllWorkspaceWorkerSecrets(env as unknown as CfApiProxyEnv, stateData.workspace_id, wsInfo.org_id)
        .catch((err) => console.error('[notion-oauth] Failed to sync secrets to workers:', err))
    );

    // Complete MCP request if this OAuth flow was initiated from chat
    if (stateData.mcp_request_id && stateData.mcp_do_id) {
      await completeMcpConnectionSetup(env, stateData, integrationId, 'notion', name);
    }

    const safePath = sanitizeRedirectPath(stateData.redirect_url);
    const redirectUrl = new URL(safePath, url.origin);
    redirectUrl.searchParams.set('success', 'notion_connected');
    return redirect(redirectUrl.toString());
  } catch (err) {
    console.error('[notion-oauth] OAuth flow failed:', err);
    return redirect(`${url.origin}/connections?error=oauth_failed`);
  }
}
