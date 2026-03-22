/**
 * External MCP server route handler.
 *
 * Serves:
 *   GET  /.well-known/oauth-authorization-server/api/mcp/external  → OAuth metadata
 *   GET  /.well-known/oauth-protected-resource/api/mcp/external    → Resource metadata
 *   POST /api/mcp/external/register                                → Dynamic client registration
 *   GET  /api/mcp/external/authorize                               → OAuth authorize (show consent)
 *   POST /api/mcp/external/authorize                               → OAuth authorize (submit consent)
 *   POST /api/mcp/external/token                                   → Token exchange
 *   POST /api/mcp/external/revoke                                  → Token revocation
 *   *    /api/mcp/external                                         → MCP protocol (Bearer auth)
 */

import type { Env, RouteContext } from '../types.js';
import { ExternalMcpOAuthProvider, OAuthError } from '../external-mcp-oauth.js';
import { ExternalMcpDO, type ExternalMcpEnv } from '../external-mcp-handler.js';
import { getSignedSessionFromRequest } from '../cookies.js';

// ── OAuth Metadata ───────────────────────────────────────────────────

function getBaseUrl(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

function buildOAuthMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/api/mcp/external/authorize`,
    token_endpoint: `${baseUrl}/api/mcp/external/token`,
    registration_endpoint: `${baseUrl}/api/mcp/external/register`,
    revocation_endpoint: `${baseUrl}/api/mcp/external/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['workspace'],
  };
}

function buildResourceMetadata(baseUrl: string) {
  return {
    resource: `${baseUrl}/api/mcp/external`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: ['workspace'],
    resource_name: 'camelAI Workspace',
  };
}

// ── Well-Known Endpoints ────────────────────────────────────────────

export async function handleOAuthMetadata({ req }: RouteContext): Promise<Response | null> {
  if (req.method !== 'GET') return null;
  const baseUrl = getBaseUrl(req);
  return Response.json(buildOAuthMetadata(baseUrl), {
    headers: { 'cache-control': 'public, max-age=3600' },
  });
}

export async function handleResourceMetadata({ req }: RouteContext): Promise<Response | null> {
  if (req.method !== 'GET') return null;
  const baseUrl = getBaseUrl(req);
  return Response.json(buildResourceMetadata(baseUrl), {
    headers: { 'cache-control': 'public, max-age=3600' },
  });
}

// ── Main Route Handler ──────────────────────────────────────────────

export async function handleExternalMcp({ req, env, ctx, url }: RouteContext): Promise<Response | null> {
  const oauth = new ExternalMcpOAuthProvider(env.APP_KV);
  const pathname = url.pathname;

  // ─── Client Registration ──────────────────────────────────────
  if (pathname === '/api/mcp/external/register') {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    try {
      const body = await req.json() as Record<string, unknown>;
      const client = await oauth.registerClient({
        redirect_uris: body.redirect_uris as string[],
        client_name: body.client_name as string | undefined,
        client_uri: body.client_uri as string | undefined,
        scope: body.scope as string | undefined,
        grant_types: body.grant_types as string[] | undefined,
        response_types: body.response_types as string[] | undefined,
        token_endpoint_auth_method: body.token_endpoint_auth_method as string | undefined,
      });
      return Response.json(client, { status: 201 });
    } catch (err) {
      if (err instanceof OAuthError) return err.toResponse();
      return Response.json({ error: 'server_error', error_description: 'Registration failed' }, { status: 500 });
    }
  }

  // ─── Authorization ────────────────────────────────────────────
  if (pathname === '/api/mcp/external/authorize') {
    return handleAuthorize(req, env, oauth);
  }

  // ─── Token Exchange ───────────────────────────────────────────
  if (pathname === '/api/mcp/external/token') {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    return handleTokenExchange(req, oauth);
  }

  // ─── Token Revocation ─────────────────────────────────────────
  if (pathname === '/api/mcp/external/revoke') {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    return handleTokenRevocation(req, oauth);
  }

  // ─── MCP Protocol ─────────────────────────────────────────────
  // Everything else under /api/mcp/external is MCP protocol traffic

  // Health check
  if (pathname === '/api/mcp/external/health') {
    return Response.json({ ok: true });
  }

  // Verify Bearer token
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer',
      },
    });
  }

  const token = authHeader.slice(7);
  const grant = await oauth.verifyAccessToken(token);
  if (!grant) {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer error="invalid_token"',
      },
    });
  }

  // Forward to ExternalMcpDO with auth context headers
  const headers = new Headers(req.headers);
  headers.set('x-ext-mcp-org-id', grant.org_id);
  headers.set('x-ext-mcp-user-id', grant.user_id);
  headers.set('x-ext-mcp-workspace-id', grant.workspace_id);

  const authenticatedRequest = new Request(req.url, {
    method: req.method,
    headers,
    body: req.body,
    // @ts-expect-error - duplex is required for streaming bodies
    duplex: 'half',
  });

  const response = await ExternalMcpDO.serve('/api/mcp/external').fetch(
    authenticatedRequest,
    env as unknown as ExternalMcpEnv,
    ctx,
  );

  return response;
}

// ── Authorization Handler ───────────────────────────────────────────

async function handleAuthorize(
  req: Request,
  env: Env,
  oauth: ExternalMcpOAuthProvider,
): Promise<Response> {
  const url = new URL(req.url);

  // Parse params from query (GET) or form body (POST)
  let params: URLSearchParams;
  if (req.method === 'POST') {
    const formData = await req.text();
    params = new URLSearchParams(formData);
    // Merge query params (client_id etc. may be in the URL)
    for (const [key, value] of url.searchParams) {
      if (!params.has(key)) params.set(key, value);
    }
  } else if (req.method === 'GET') {
    params = url.searchParams;
  } else {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const responseType = params.get('response_type');
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method');
  const state = params.get('state') ?? undefined;
  const scope = params.get('scope');

  // Validate required params (PKCE is mandatory per OAuth 2.1)
  if (!clientId || !redirectUri || responseType !== 'code') {
    return new OAuthError('invalid_request', 'Missing required parameters: client_id, redirect_uri, response_type=code').toResponse();
  }

  if (!codeChallenge) {
    return new OAuthError('invalid_request', 'code_challenge is required (PKCE is mandatory)').toResponse();
  }

  if (codeChallengeMethod !== 'S256') {
    return new OAuthError('invalid_request', 'Only S256 code challenge method is supported').toResponse();
  }

  // Validate client
  const client = await oauth.getClient(clientId);
  if (!client) {
    return new OAuthError('invalid_client', 'Unknown client_id').toResponse();
  }

  if (!client.redirect_uris.includes(redirectUri)) {
    return new OAuthError('invalid_request', 'redirect_uri not registered for this client').toResponse();
  }

  // Check user session
  const session = await getSignedSessionFromRequest(req, env.TOKEN_SIGNING_SECRET);
  if (!session) {
    // User not logged in → redirect to login with return URL
    const returnUrl = encodeURIComponent(url.pathname + url.search);
    return Response.redirect(`${url.origin}/login?redirect=${returnUrl}`, 302);
  }

  // POST = user submitted the consent form
  if (req.method === 'POST') {
    const workspaceId = params.get('workspace_id');
    if (!workspaceId) {
      return new OAuthError('invalid_request', 'No workspace selected').toResponse();
    }

    // Verify workspace access
    const hasAccess = await verifyWorkspaceAccess(env, session.user_id, session.org_id, workspaceId);
    if (!hasAccess) {
      return new OAuthError('access_denied', 'You do not have access to this workspace').toResponse();
    }

    // Create authorization code
    const code = await oauth.createAuthorizationCode({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge ?? '',
      scopes: scope ? scope.split(' ') : ['workspace'],
      user_id: session.user_id,
      org_id: session.org_id,
      workspace_id: workspaceId,
      state,
    });

    // Redirect back to client
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set('code', code);
    if (state) callbackUrl.searchParams.set('state', state);
    return Response.redirect(callbackUrl.toString(), 302);
  }

  // GET = show consent page
  const workspaces = await listUserWorkspaces(env, session.user_id, session.org_id);
  return new Response(renderConsentPage({
    clientName: client.client_name ?? clientId,
    userName: session.user_name ?? session.user_email ?? session.user_id,
    workspaces,
    authorizeUrl: url.pathname + url.search,
    clientId,
    redirectUri,
    responseType: responseType!,
    codeChallenge: codeChallenge ?? '',
    codeChallengeMethod: codeChallengeMethod ?? '',
    state: state ?? '',
    scope: scope ?? 'workspace',
  }), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ── Token Exchange Handler ──────────────────────────────────────────

async function handleTokenExchange(req: Request, oauth: ExternalMcpOAuthProvider): Promise<Response> {
  const body = await req.text();
  const params = new URLSearchParams(body);
  const grantType = params.get('grant_type');
  const clientId = params.get('client_id');
  const clientSecret = params.get('client_secret');

  if (!clientId) {
    return new OAuthError('invalid_request', 'client_id is required').toResponse();
  }

  // Authenticate confidential clients (those registered with a client_secret)
  const client = await oauth.getClient(clientId);
  if (!client) {
    return new OAuthError('invalid_client', 'Unknown client_id').toResponse(401);
  }
  if (client.client_secret) {
    if (!clientSecret) {
      return new OAuthError('invalid_client', 'client_secret is required for confidential clients').toResponse(401);
    }
    if (clientSecret !== client.client_secret) {
      return new OAuthError('invalid_client', 'Invalid client_secret').toResponse(401);
    }
  }

  try {
    if (grantType === 'authorization_code') {
      const code = params.get('code');
      if (!code) {
        return new OAuthError('invalid_request', 'code is required').toResponse();
      }
      const tokens = await oauth.exchangeAuthorizationCode(
        clientId,
        code,
        params.get('code_verifier') ?? undefined,
        params.get('redirect_uri') ?? undefined,
      );
      return Response.json(tokens, {
        headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
      });
    }

    if (grantType === 'refresh_token') {
      const refreshToken = params.get('refresh_token');
      if (!refreshToken) {
        return new OAuthError('invalid_request', 'refresh_token is required').toResponse();
      }
      const tokens = await oauth.exchangeRefreshToken(clientId, refreshToken);
      return Response.json(tokens, {
        headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
      });
    }

    return new OAuthError('unsupported_grant_type', `Unsupported grant_type: ${grantType}`).toResponse();
  } catch (err) {
    if (err instanceof OAuthError) return err.toResponse();
    console.error('[external-mcp] Token exchange error:', err);
    return Response.json({ error: 'server_error' }, { status: 500 });
  }
}

// ── Token Revocation Handler ────────────────────────────────────────

async function handleTokenRevocation(req: Request, oauth: ExternalMcpOAuthProvider): Promise<Response> {
  const body = await req.text();
  const params = new URLSearchParams(body);
  const token = params.get('token');

  if (!token) {
    return new OAuthError('invalid_request', 'token is required').toResponse();
  }

  await oauth.revokeToken(token, params.get('token_type_hint') ?? undefined);
  // RFC 7009: always return 200 even if token was unknown
  return new Response(null, { status: 200 });
}

// ── Workspace Access Helpers ────────────────────────────────────────

interface WorkspaceInfo {
  id: string;
  name: string;
}

async function verifyWorkspaceAccess(
  env: Env,
  userId: string,
  orgId: string,
  workspaceId: string,
): Promise<boolean> {
  try {
    const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
    const member = await (orgStub as any).getMember(userId);
    if (!member) return false;

    const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
    const wsMeta = await (wsStub as any).getMetadata();
    if (!wsMeta || wsMeta.org_id !== orgId) return false;

    // Check workspace-level access
    const access = await (wsStub as any).getMemberAccess(userId);
    return access && access !== 'none';
  } catch {
    return false;
  }
}

async function listUserWorkspaces(
  env: Env,
  userId: string,
  orgId: string,
): Promise<WorkspaceInfo[]> {
  try {
    const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
    const workspaceIds: string[] = await (orgStub as any).listWorkspaceIds();
    const results: WorkspaceInfo[] = [];

    for (const wsId of workspaceIds) {
      const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(wsId));
      try {
        const meta = await (wsStub as any).getMetadata();
        const access = await (wsStub as any).getMemberAccess(userId);
        if (meta && access && access !== 'none') {
          results.push({ id: wsId, name: meta.name ?? wsId });
        }
      } catch {
        // skip inaccessible workspaces
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ── Consent Page HTML ───────────────────────────────────────────────

function renderConsentPage(params: {
  clientName: string;
  userName: string;
  workspaces: WorkspaceInfo[];
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
}): string {
  const workspaceOptions = params.workspaces
    .map((ws) => `<option value="${escapeHtml(ws.id)}">${escapeHtml(ws.name)}</option>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize – camelAI</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      background: #171717;
      border: 1px solid #262626;
      border-radius: 12px;
      padding: 2rem;
      max-width: 420px;
      width: 100%;
    }
    .card h1 {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    .card p {
      color: #a3a3a3;
      font-size: 0.875rem;
      line-height: 1.5;
      margin-bottom: 1.25rem;
    }
    .client-name {
      color: #f5f5f5;
      font-weight: 500;
    }
    label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 500;
      color: #a3a3a3;
      margin-bottom: 0.375rem;
    }
    select {
      width: 100%;
      padding: 0.625rem 0.75rem;
      background: #262626;
      border: 1px solid #404040;
      border-radius: 8px;
      color: #e5e5e5;
      font-size: 0.875rem;
      margin-bottom: 1.25rem;
      appearance: none;
      cursor: pointer;
    }
    select:focus { outline: 2px solid #3b82f6; outline-offset: -1px; }
    .permissions {
      background: #1c1c1c;
      border: 1px solid #262626;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      margin-bottom: 1.25rem;
      font-size: 0.8125rem;
    }
    .permissions h3 {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #737373;
      margin-bottom: 0.5rem;
    }
    .permissions ul {
      list-style: none;
      padding: 0;
    }
    .permissions li {
      padding: 0.25rem 0;
      color: #a3a3a3;
    }
    .permissions li::before {
      content: "•";
      color: #525252;
      margin-right: 0.5rem;
    }
    .actions {
      display: flex;
      gap: 0.75rem;
    }
    .btn {
      flex: 1;
      padding: 0.625rem 1rem;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      border: none;
      transition: background 0.15s;
    }
    .btn-cancel {
      background: #262626;
      color: #a3a3a3;
    }
    .btn-cancel:hover { background: #333; }
    .btn-approve {
      background: #3b82f6;
      color: #fff;
    }
    .btn-approve:hover { background: #2563eb; }
    .user-info {
      font-size: 0.75rem;
      color: #525252;
      text-align: center;
      margin-top: 1rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize Access</h1>
    <p>
      <span class="client-name">${escapeHtml(params.clientName)}</span>
      wants to access your camelAI workspace.
    </p>

    <form method="POST" action="${escapeHtml(params.authorizeUrl)}">
      <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
      <input type="hidden" name="response_type" value="${escapeHtml(params.responseType)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.codeChallengeMethod)}">
      <input type="hidden" name="state" value="${escapeHtml(params.state)}">
      <input type="hidden" name="scope" value="${escapeHtml(params.scope)}">

      <label for="workspace_id">Workspace</label>
      <select name="workspace_id" id="workspace_id" required>
        <option value="" disabled selected>Select a workspace…</option>
        ${workspaceOptions}
      </select>

      <div class="permissions">
        <h3>This will allow</h3>
        <ul>
          <li>Execute commands in your workspace</li>
          <li>Read and write files</li>
          <li>List and manage deployed apps</li>
        </ul>
      </div>

      <div class="actions">
        <button type="button" class="btn btn-cancel" onclick="window.close()">Cancel</button>
        <button type="submit" class="btn btn-approve">Authorize</button>
      </div>
    </form>

    <p class="user-info">Signed in as ${escapeHtml(params.userName)}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
