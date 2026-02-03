/**
 * Integration OAuth routes
 * Supports: Slack, Notion, GitHub, Linear, Airtable, HubSpot, Typeform, Mailchimp,
 * Jira, Asana, Figma, Intercom, Zendesk, Discord, Shopify, Square
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

// =============================================================================
// Generic OAuth Helper
// =============================================================================

interface OAuthProviderConfig {
  type: string;
  category: 'saas' | 'communication' | 'databases' | 'cloud_providers' | 'ai_services';
  clientIdKey: keyof RouteContext['env'];
  clientSecretKey: keyof RouteContext['env'];
  // Token exchange method
  tokenExchangeMethod: 'form' | 'json' | 'basic_auth_json';
  // How to extract the display name from token response
  getDisplayName: (tokenData: Record<string, unknown>) => string;
  // How to build credentials object from token response
  buildCredentials: (tokenData: Record<string, unknown>) => Record<string, unknown>;
  // Optional: custom auth URL builder (for providers that need dynamic URLs)
  buildAuthUrl?: (baseUrl: string, config: Record<string, unknown>) => string;
  // Optional: custom token URL builder
  buildTokenUrl?: (baseUrl: string, config: Record<string, unknown>) => string;
}

async function genericOAuthStart(
  routeCtx: RouteContext,
  config: OAuthProviderConfig
): Promise<Response> {
  const { req, env, url } = routeCtx;
  const def = INTEGRATION_REGISTRY[config.type];
  const clientId = env[config.clientIdKey] as string | undefined;

  if (!def?.oauthConfig || !clientId) {
    return text(`${config.type} OAuth is not configured`, 500);
  }

  const auth = await requireSession(req, env);
  if ('error' in auth) return redirect(`${url.origin}/login?error=unauthorized`);

  const { session } = auth;
  if (!session.workspace_id) return redirect(`${url.origin}/connections?error=no_workspace`);

  const redirectTo = sanitizeRedirectPath(url.searchParams.get('redirect') || '/connections');
  const callbackUrl = `${url.origin}/api/integrations/${config.type}/callback`;

  const mcpRequestId = url.searchParams.get('mcp_request_id');
  const mcpDoId = url.searchParams.get('mcp_do_id');
  const mcpContext = mcpRequestId && mcpDoId ? { requestId: mcpRequestId, doId: mcpDoId } : undefined;

  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    config.type,
    session.workspace_id,
    session.user_id,
    redirectTo,
    mcpContext
  );

  let authUrlStr = def.oauthConfig.authorizationUrl;
  if (config.buildAuthUrl) {
    // For providers with dynamic URLs (e.g., Zendesk, Shopify)
    const configData = Object.fromEntries(url.searchParams.entries());
    authUrlStr = config.buildAuthUrl(authUrlStr, configData);
  }

  const authUrl = new URL(authUrlStr);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('response_type', 'code');

  if (def.oauthConfig.scopes.length > 0) {
    authUrl.searchParams.set('scope', def.oauthConfig.scopes.join(' '));
  }

  return redirect(authUrl.toString());
}

async function genericOAuthCallback(
  routeCtx: RouteContext,
  config: OAuthProviderConfig
): Promise<Response> {
  const { env, url, ctx } = routeCtx;

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return redirect(`${url.origin}/connections?error=oauth_denied`);
  if (!code || !state) return redirect(`${url.origin}/connections?error=oauth_invalid`);

  const stateData = await validateAndConsumeIntegrationOAuthState(env.SESSIONS, state);
  if (!stateData || stateData.integration_type !== config.type) {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }

  const clientId = env[config.clientIdKey] as string | undefined;
  const clientSecret = env[config.clientSecretKey] as string | undefined;

  if (!clientId || !clientSecret) {
    return redirect(`${url.origin}/connections?error=oauth_config`);
  }

  try {
    const def = INTEGRATION_REGISTRY[config.type];
    if (!def?.oauthConfig) {
      return redirect(`${url.origin}/connections?error=oauth_config`);
    }

    const callbackUrl = `${url.origin}/api/integrations/${config.type}/callback`;
    let tokenUrl = def.oauthConfig.tokenUrl;

    if (config.buildTokenUrl) {
      const configData = stateData.extra_config || {};
      tokenUrl = config.buildTokenUrl(tokenUrl, configData);
    }

    let tokenRes: Response;

    if (config.tokenExchangeMethod === 'form') {
      tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: callbackUrl,
          grant_type: 'authorization_code',
        }),
      });
    } else if (config.tokenExchangeMethod === 'basic_auth_json') {
      const basicAuth = btoa(`${clientId}:${clientSecret}`);
      tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${basicAuth}`,
          Accept: 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: callbackUrl,
        }),
      });
    } else {
      // json
      tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: callbackUrl,
          grant_type: 'authorization_code',
        }),
      });
    }

    const tokenData = (await tokenRes.json()) as Record<string, unknown>;

    if (!tokenData.access_token) {
      console.error(`[${config.type}-oauth] Token exchange failed:`, tokenData.error || tokenData);
      return redirect(`${url.origin}/connections?error=oauth_token_failed`);
    }

    // Re-validate workspace access
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

    const credentials = config.buildCredentials(tokenData);
    const encrypted = await encryptCredentials(credentials, env.INTEGRATION_SECRET_KEY);
    const name = config.getDisplayName(tokenData);
    const integrationId = crypto.randomUUID();

    await wsStub.createIntegration(
      integrationId,
      config.type,
      name,
      config.category,
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

    ctx.waitUntil(
      syncAllWorkspaceWorkerSecrets(env as unknown as CfApiProxyEnv, stateData.workspace_id, wsInfo.org_id)
        .catch((err) => console.error(`[${config.type}-oauth] Failed to sync secrets:`, err))
    );

    if (stateData.mcp_request_id && stateData.mcp_do_id) {
      await completeMcpConnectionSetup(env, stateData, integrationId, config.type, name);
    }

    const safePath = sanitizeRedirectPath(stateData.redirect_url);
    const redirectUrl = new URL(safePath, url.origin);
    redirectUrl.searchParams.set('success', `${config.type}_connected`);
    return redirect(redirectUrl.toString());
  } catch (err) {
    console.error(`[${config.type}-oauth] OAuth flow failed:`, err);
    return redirect(`${url.origin}/connections?error=oauth_failed`);
  }
}

// =============================================================================
// GitHub OAuth
// =============================================================================

const githubConfig: OAuthProviderConfig = {
  type: 'github',
  category: 'saas',
  clientIdKey: 'GITHUB_CLIENT_ID',
  clientSecretKey: 'GITHUB_CLIENT_SECRET',
  tokenExchangeMethod: 'form',
  getDisplayName: (data) => (data.login as string) || 'GitHub',
  buildCredentials: (data) => ({
    access_token: data.access_token,
    token_type: data.token_type,
    scope: data.scope,
  }),
};

export async function handleGitHubOAuthStart(ctx: RouteContext): Promise<Response> {
  return genericOAuthStart(ctx, githubConfig);
}

export async function handleGitHubOAuthCallback(ctx: RouteContext): Promise<Response> {
  return genericOAuthCallback(ctx, githubConfig);
}

// =============================================================================
// Linear OAuth
// =============================================================================

const linearConfig: OAuthProviderConfig = {
  type: 'linear',
  category: 'saas',
  clientIdKey: 'LINEAR_CLIENT_ID',
  clientSecretKey: 'LINEAR_CLIENT_SECRET',
  tokenExchangeMethod: 'form',
  getDisplayName: () => 'Linear',
  buildCredentials: (data) => ({
    access_token: data.access_token,
    token_type: data.token_type,
    scope: data.scope,
    expires_in: data.expires_in,
  }),
};

export async function handleLinearOAuthStart(ctx: RouteContext): Promise<Response> {
  return genericOAuthStart(ctx, linearConfig);
}

export async function handleLinearOAuthCallback(ctx: RouteContext): Promise<Response> {
  return genericOAuthCallback(ctx, linearConfig);
}

// =============================================================================
// Airtable OAuth
// =============================================================================

const airtableConfig: OAuthProviderConfig = {
  type: 'airtable',
  category: 'saas',
  clientIdKey: 'AIRTABLE_CLIENT_ID',
  clientSecretKey: 'AIRTABLE_CLIENT_SECRET',
  tokenExchangeMethod: 'form',
  getDisplayName: () => 'Airtable',
  buildCredentials: (data) => ({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    scope: data.scope,
    expires_in: data.expires_in,
  }),
};

export async function handleAirtableOAuthStart(ctx: RouteContext): Promise<Response> {
  return genericOAuthStart(ctx, airtableConfig);
}

export async function handleAirtableOAuthCallback(ctx: RouteContext): Promise<Response> {
  return genericOAuthCallback(ctx, airtableConfig);
}

// =============================================================================
// HubSpot OAuth
// =============================================================================

const hubspotConfig: OAuthProviderConfig = {
  type: 'hubspot',
  category: 'saas',
  clientIdKey: 'HUBSPOT_CLIENT_ID',
  clientSecretKey: 'HUBSPOT_CLIENT_SECRET',
  tokenExchangeMethod: 'form',
  getDisplayName: () => 'HubSpot',
  buildCredentials: (data) => ({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expires_in: data.expires_in,
  }),
};

export async function handleHubSpotOAuthStart(ctx: RouteContext): Promise<Response> {
  return genericOAuthStart(ctx, hubspotConfig);
}

export async function handleHubSpotOAuthCallback(ctx: RouteContext): Promise<Response> {
  return genericOAuthCallback(ctx, hubspotConfig);
}

// =============================================================================
// Typeform OAuth
// =============================================================================

const typeformConfig: OAuthProviderConfig = {
  type: 'typeform',
  category: 'saas',
  clientIdKey: 'TYPEFORM_CLIENT_ID',
  clientSecretKey: 'TYPEFORM_CLIENT_SECRET',
  tokenExchangeMethod: 'form',
  getDisplayName: () => 'Typeform',
  buildCredentials: (data) => ({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    scope: data.scope,
  }),
};

export async function handleTypeformOAuthStart(ctx: RouteContext): Promise<Response> {
  return genericOAuthStart(ctx, typeformConfig);
}

export async function handleTypeformOAuthCallback(ctx: RouteContext): Promise<Response> {
  return genericOAuthCallback(ctx, typeformConfig);
}

// =============================================================================
// Mailchimp OAuth
// =============================================================================

const mailchimpConfig: OAuthProviderConfig = {
  type: 'mailchimp',
  category: 'saas',
  clientIdKey: 'MAILCHIMP_CLIENT_ID',
  clientSecretKey: 'MAILCHIMP_CLIENT_SECRET',
  tokenExchangeMethod: 'form',
  getDisplayName: () => 'Mailchimp',
  buildCredentials: (data) => ({
    access_token: data.access_token,
    token_type: data.token_type,
    scope: data.scope,
    // Mailchimp returns metadata endpoint to get data center
    metadata_url: (data as { dc?: string }).dc,
  }),
};

export async function handleMailchimpOAuthStart(ctx: RouteContext): Promise<Response> {
  return genericOAuthStart(ctx, mailchimpConfig);
}

export async function handleMailchimpOAuthCallback(ctx: RouteContext): Promise<Response> {
  return genericOAuthCallback(ctx, mailchimpConfig);
}

// =============================================================================
// Jira (Atlassian) OAuth
// =============================================================================

const jiraConfig: OAuthProviderConfig = {
  type: 'jira',
  category: 'saas',
  clientIdKey: 'JIRA_CLIENT_ID',
  clientSecretKey: 'JIRA_CLIENT_SECRET',
  tokenExchangeMethod: 'json',
  getDisplayName: () => 'Jira',
  buildCredentials: (data) => ({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    scope: data.scope,
    expires_in: data.expires_in,
  }),
};

export async function handleJiraOAuthStart(ctx: RouteContext): Promise<Response> {
  const { req, env, url } = ctx;
  const def = INTEGRATION_REGISTRY.jira;
  const clientId = env.JIRA_CLIENT_ID;

  if (!def?.oauthConfig || !clientId) {
    return text('Jira OAuth is not configured', 500);
  }

  const auth = await requireSession(req, env);
  if ('error' in auth) return redirect(`${url.origin}/login?error=unauthorized`);

  const { session } = auth;
  if (!session.workspace_id) return redirect(`${url.origin}/connections?error=no_workspace`);

  const redirectTo = sanitizeRedirectPath(url.searchParams.get('redirect') || '/connections');
  const callbackUrl = `${url.origin}/api/integrations/jira/callback`;

  const mcpRequestId = url.searchParams.get('mcp_request_id');
  const mcpDoId = url.searchParams.get('mcp_do_id');
  const mcpContext = mcpRequestId && mcpDoId ? { requestId: mcpRequestId, doId: mcpDoId } : undefined;

  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    'jira',
    session.workspace_id,
    session.user_id,
    redirectTo,
    mcpContext
  );

  // Atlassian requires audience parameter
  const authUrl = new URL(def.oauthConfig.authorizationUrl);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', def.oauthConfig.scopes.join(' '));
  authUrl.searchParams.set('audience', 'api.atlassian.com');
  authUrl.searchParams.set('prompt', 'consent');

  return redirect(authUrl.toString());
}

export async function handleJiraOAuthCallback(ctx: RouteContext): Promise<Response> {
  return genericOAuthCallback(ctx, jiraConfig);
}

// =============================================================================
// Asana OAuth
// =============================================================================

const asanaConfig: OAuthProviderConfig = {
  type: 'asana',
  category: 'saas',
  clientIdKey: 'ASANA_CLIENT_ID',
  clientSecretKey: 'ASANA_CLIENT_SECRET',
  tokenExchangeMethod: 'form',
  getDisplayName: (data) => {
    const user = data.data as { name?: string } | undefined;
    return user?.name || 'Asana';
  },
  buildCredentials: (data) => ({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expires_in: data.expires_in,
    user_data: data.data,
  }),
};

export async function handleAsanaOAuthStart(ctx: RouteContext): Promise<Response> {
  return genericOAuthStart(ctx, asanaConfig);
}

export async function handleAsanaOAuthCallback(ctx: RouteContext): Promise<Response> {
  return genericOAuthCallback(ctx, asanaConfig);
}

// =============================================================================
// Figma OAuth
// =============================================================================

const figmaConfig: OAuthProviderConfig = {
  type: 'figma',
  category: 'saas',
  clientIdKey: 'FIGMA_CLIENT_ID',
  clientSecretKey: 'FIGMA_CLIENT_SECRET',
  tokenExchangeMethod: 'form',
  getDisplayName: () => 'Figma',
  buildCredentials: (data) => ({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    user_id: data.user_id,
  }),
};

export async function handleFigmaOAuthStart(ctx: RouteContext): Promise<Response> {
  return genericOAuthStart(ctx, figmaConfig);
}

export async function handleFigmaOAuthCallback(ctx: RouteContext): Promise<Response> {
  return genericOAuthCallback(ctx, figmaConfig);
}

// =============================================================================
// Intercom OAuth
// =============================================================================

const intercomConfig: OAuthProviderConfig = {
  type: 'intercom',
  category: 'saas',
  clientIdKey: 'INTERCOM_CLIENT_ID',
  clientSecretKey: 'INTERCOM_CLIENT_SECRET',
  tokenExchangeMethod: 'form',
  getDisplayName: () => 'Intercom',
  buildCredentials: (data) => ({
    access_token: data.access_token,
    token_type: data.token_type,
  }),
};

export async function handleIntercomOAuthStart(ctx: RouteContext): Promise<Response> {
  return genericOAuthStart(ctx, intercomConfig);
}

export async function handleIntercomOAuthCallback(ctx: RouteContext): Promise<Response> {
  return genericOAuthCallback(ctx, intercomConfig);
}

// =============================================================================
// Zendesk OAuth (requires subdomain)
// =============================================================================

const zendeskConfig: OAuthProviderConfig = {
  type: 'zendesk',
  category: 'saas',
  clientIdKey: 'ZENDESK_CLIENT_ID',
  clientSecretKey: 'ZENDESK_CLIENT_SECRET',
  tokenExchangeMethod: 'form',
  getDisplayName: () => 'Zendesk',
  buildCredentials: (data) => ({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    scope: data.scope,
  }),
};

export async function handleZendeskOAuthStart(ctx: RouteContext): Promise<Response> {
  const { req, env, url } = ctx;
  const def = INTEGRATION_REGISTRY.zendesk;
  const clientId = env.ZENDESK_CLIENT_ID;

  if (!def?.oauthConfig || !clientId) {
    return text('Zendesk OAuth is not configured', 500);
  }

  const subdomain = url.searchParams.get('subdomain');
  if (!subdomain) {
    return redirect(`${url.origin}/connections?error=zendesk_subdomain_required`);
  }

  const auth = await requireSession(req, env);
  if ('error' in auth) return redirect(`${url.origin}/login?error=unauthorized`);

  const { session } = auth;
  if (!session.workspace_id) return redirect(`${url.origin}/connections?error=no_workspace`);

  const redirectTo = sanitizeRedirectPath(url.searchParams.get('redirect') || '/connections');
  const callbackUrl = `${url.origin}/api/integrations/zendesk/callback`;

  const mcpRequestId = url.searchParams.get('mcp_request_id');
  const mcpDoId = url.searchParams.get('mcp_do_id');
  const mcpContext = mcpRequestId && mcpDoId ? { requestId: mcpRequestId, doId: mcpDoId } : undefined;

  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    'zendesk',
    session.workspace_id,
    session.user_id,
    redirectTo,
    mcpContext,
    { subdomain } // Store subdomain in state for callback
  );

  const authUrl = new URL(`https://${subdomain}.zendesk.com/oauth/authorizations/new`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', def.oauthConfig.scopes.join(' '));

  return redirect(authUrl.toString());
}

export async function handleZendeskOAuthCallback(ctx: RouteContext): Promise<Response> {
  const { env, url } = ctx;

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return redirect(`${url.origin}/connections?error=oauth_denied`);
  if (!code || !state) return redirect(`${url.origin}/connections?error=oauth_invalid`);

  const stateData = await validateAndConsumeIntegrationOAuthState(env.SESSIONS, state);
  if (!stateData || stateData.integration_type !== 'zendesk') {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }

  const subdomain = stateData.extra_config?.subdomain as string;
  if (!subdomain) {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }

  const clientId = env.ZENDESK_CLIENT_ID;
  const clientSecret = env.ZENDESK_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return redirect(`${url.origin}/connections?error=oauth_config`);
  }

  try {
    const callbackUrl = `${url.origin}/api/integrations/zendesk/callback`;
    const tokenUrl = `https://${subdomain}.zendesk.com/oauth/tokens`;

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUrl,
        scope: 'read write',
      }),
    });

    const tokenData = (await tokenRes.json()) as Record<string, unknown>;

    if (!tokenData.access_token) {
      console.error('[zendesk-oauth] Token exchange failed:', tokenData);
      return redirect(`${url.origin}/connections?error=oauth_token_failed`);
    }

    const wsStub = getWorkspaceStub(env, stateData.workspace_id);
    const wsInfo = await wsStub.getInfo();
    if (!wsInfo || wsInfo.archived) {
      return redirect(`${url.origin}/connections?error=workspace_not_found`);
    }

    const orgStub = getOrgStub(env, wsInfo.org_id);
    if (!(await orgStub.isMember(stateData.user_id))) {
      return redirect(`${url.origin}/connections?error=access_denied`);
    }

    const credentials = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_type: tokenData.token_type,
      subdomain,
    };

    const encrypted = await encryptCredentials(credentials, env.INTEGRATION_SECRET_KEY);
    const integrationId = crypto.randomUUID();

    await wsStub.createIntegration(
      integrationId,
      'zendesk',
      `Zendesk (${subdomain})`,
      'saas',
      'oauth2',
      JSON.stringify({ subdomain }),
      encrypted,
      stateData.user_id
    );

    ctx.waitUntil(
      getWorkspaceContainer(env, stateData.workspace_id)
        .refreshIntegrationEnvVars(stateData.workspace_id)
        .catch(() => {})
    );

    ctx.waitUntil(
      syncAllWorkspaceWorkerSecrets(env as unknown as CfApiProxyEnv, stateData.workspace_id, wsInfo.org_id)
        .catch((err) => console.error('[zendesk-oauth] Failed to sync secrets:', err))
    );

    if (stateData.mcp_request_id && stateData.mcp_do_id) {
      await completeMcpConnectionSetup(env, stateData, integrationId, 'zendesk', `Zendesk (${subdomain})`);
    }

    const safePath = sanitizeRedirectPath(stateData.redirect_url);
    const redirectUrl = new URL(safePath, url.origin);
    redirectUrl.searchParams.set('success', 'zendesk_connected');
    return redirect(redirectUrl.toString());
  } catch (err) {
    console.error('[zendesk-oauth] OAuth flow failed:', err);
    return redirect(`${url.origin}/connections?error=oauth_failed`);
  }
}

// =============================================================================
// Discord OAuth
// =============================================================================

const discordConfig: OAuthProviderConfig = {
  type: 'discord',
  category: 'communication',
  clientIdKey: 'DISCORD_CLIENT_ID',
  clientSecretKey: 'DISCORD_CLIENT_SECRET',
  tokenExchangeMethod: 'form',
  getDisplayName: (data) => (data.guild as { name?: string })?.name || 'Discord',
  buildCredentials: (data) => ({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    scope: data.scope,
    expires_in: data.expires_in,
    guild: data.guild,
  }),
};

export async function handleDiscordOAuthStart(ctx: RouteContext): Promise<Response> {
  return genericOAuthStart(ctx, discordConfig);
}

export async function handleDiscordOAuthCallback(ctx: RouteContext): Promise<Response> {
  return genericOAuthCallback(ctx, discordConfig);
}

// =============================================================================
// Shopify OAuth (requires shop domain)
// =============================================================================

export async function handleShopifyOAuthStart(ctx: RouteContext): Promise<Response> {
  const { req, env, url } = ctx;
  const def = INTEGRATION_REGISTRY.shopify;
  const clientId = env.SHOPIFY_CLIENT_ID;

  if (!def?.oauthConfig || !clientId) {
    return text('Shopify OAuth is not configured', 500);
  }

  const shopDomain = url.searchParams.get('shop_domain');
  if (!shopDomain) {
    return redirect(`${url.origin}/connections?error=shopify_shop_required`);
  }

  const auth = await requireSession(req, env);
  if ('error' in auth) return redirect(`${url.origin}/login?error=unauthorized`);

  const { session } = auth;
  if (!session.workspace_id) return redirect(`${url.origin}/connections?error=no_workspace`);

  const redirectTo = sanitizeRedirectPath(url.searchParams.get('redirect') || '/connections');
  const callbackUrl = `${url.origin}/api/integrations/shopify/callback`;

  const mcpRequestId = url.searchParams.get('mcp_request_id');
  const mcpDoId = url.searchParams.get('mcp_do_id');
  const mcpContext = mcpRequestId && mcpDoId ? { requestId: mcpRequestId, doId: mcpDoId } : undefined;

  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    'shopify',
    session.workspace_id,
    session.user_id,
    redirectTo,
    mcpContext,
    { shop_domain: shopDomain }
  );

  const authUrl = new URL(`https://${shopDomain}/admin/oauth/authorize`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('scope', def.oauthConfig.scopes.join(','));

  return redirect(authUrl.toString());
}

export async function handleShopifyOAuthCallback(ctx: RouteContext): Promise<Response> {
  const { env, url } = ctx;

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const shop = url.searchParams.get('shop');

  if (!code || !state || !shop) return redirect(`${url.origin}/connections?error=oauth_invalid`);

  const stateData = await validateAndConsumeIntegrationOAuthState(env.SESSIONS, state);
  if (!stateData || stateData.integration_type !== 'shopify') {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }

  const clientId = env.SHOPIFY_CLIENT_ID;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return redirect(`${url.origin}/connections?error=oauth_config`);
  }

  try {
    const tokenUrl = `https://${shop}/admin/oauth/access_token`;

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = (await tokenRes.json()) as Record<string, unknown>;

    if (!tokenData.access_token) {
      console.error('[shopify-oauth] Token exchange failed:', tokenData);
      return redirect(`${url.origin}/connections?error=oauth_token_failed`);
    }

    const wsStub = getWorkspaceStub(env, stateData.workspace_id);
    const wsInfo = await wsStub.getInfo();
    if (!wsInfo || wsInfo.archived) {
      return redirect(`${url.origin}/connections?error=workspace_not_found`);
    }

    const orgStub = getOrgStub(env, wsInfo.org_id);
    if (!(await orgStub.isMember(stateData.user_id))) {
      return redirect(`${url.origin}/connections?error=access_denied`);
    }

    const credentials = {
      access_token: tokenData.access_token,
      scope: tokenData.scope,
      shop_domain: shop,
    };

    const encrypted = await encryptCredentials(credentials, env.INTEGRATION_SECRET_KEY);
    const integrationId = crypto.randomUUID();
    const shopName = shop.replace('.myshopify.com', '');

    await wsStub.createIntegration(
      integrationId,
      'shopify',
      `Shopify (${shopName})`,
      'saas',
      'oauth2',
      JSON.stringify({ shop_domain: shop }),
      encrypted,
      stateData.user_id
    );

    ctx.waitUntil(
      getWorkspaceContainer(env, stateData.workspace_id)
        .refreshIntegrationEnvVars(stateData.workspace_id)
        .catch(() => {})
    );

    ctx.waitUntil(
      syncAllWorkspaceWorkerSecrets(env as unknown as CfApiProxyEnv, stateData.workspace_id, wsInfo.org_id)
        .catch((err) => console.error('[shopify-oauth] Failed to sync secrets:', err))
    );

    if (stateData.mcp_request_id && stateData.mcp_do_id) {
      await completeMcpConnectionSetup(env, stateData, integrationId, 'shopify', `Shopify (${shopName})`);
    }

    const safePath = sanitizeRedirectPath(stateData.redirect_url);
    const redirectUrl = new URL(safePath, url.origin);
    redirectUrl.searchParams.set('success', 'shopify_connected');
    return redirect(redirectUrl.toString());
  } catch (err) {
    console.error('[shopify-oauth] OAuth flow failed:', err);
    return redirect(`${url.origin}/connections?error=oauth_failed`);
  }
}

// =============================================================================
// Square OAuth
// =============================================================================

const squareConfig: OAuthProviderConfig = {
  type: 'square',
  category: 'saas',
  clientIdKey: 'SQUARE_CLIENT_ID',
  clientSecretKey: 'SQUARE_CLIENT_SECRET',
  tokenExchangeMethod: 'json',
  getDisplayName: (data) => (data.merchant_id as string) || 'Square',
  buildCredentials: (data) => ({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expires_at: data.expires_at,
    merchant_id: data.merchant_id,
  }),
};

export async function handleSquareOAuthStart(ctx: RouteContext): Promise<Response> {
  return genericOAuthStart(ctx, squareConfig);
}

export async function handleSquareOAuthCallback(ctx: RouteContext): Promise<Response> {
  return genericOAuthCallback(ctx, squareConfig);
}
