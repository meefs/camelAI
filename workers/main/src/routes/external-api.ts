/**
 * External API route handler using Cap'n Web RPC.
 *
 * OAuth endpoints:
 *   GET  /.well-known/oauth-authorization-server  → OAuth metadata
 *   GET  /.well-known/oauth-protected-resource     → Resource metadata
 *   POST /api/ext/oauth/register                   → Dynamic client registration
 *   GET  /api/ext/oauth/authorize                  → OAuth authorize (show consent)
 *   POST /api/ext/oauth/authorize                  → OAuth authorize (submit consent)
 *   POST /api/ext/oauth/token                      → Token exchange
 *   POST /api/ext/oauth/revoke                     → Token revocation
 *
 * RPC endpoint:
 *   POST /api/ext/rpc                              → Cap'n Web RPC (Bearer auth)
 */

import type { Env, RouteContext } from '../types.js';
import { ExternalMcpOAuthProvider, OAuthError } from '../external-api-oauth.js';
import { getSignedSessionFromRequest } from '../cookies.js';
import { RpcTarget, newWorkersRpcResponse } from 'capnweb';
import { WorkspaceContainer } from '../workspace-container.js';
import type { OrgDO, WorkerScript } from '../auth.js';
import { getEnvPrefix } from '../cf-api-proxy.js';

// ── Helpers ──────────────────────────────────────────────────────────

function getBaseUrl(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

// ── Cap'n Web RPC Targets ───────────────────────────────────────────

/**
 * Public API entry point. Validates an OAuth Bearer token and returns
 * an authenticated WorkspaceSession.
 */
class ExternalApi extends RpcTarget {
  constructor(private env: Env, private oauth: ExternalMcpOAuthProvider) {
    super();
  }

  async authenticate(token: string): Promise<WorkspaceSession> {
    const grant = await this.oauth.verifyAccessToken(token);
    if (!grant) {
      throw new Error('Invalid or expired token');
    }
    return new WorkspaceSession(this.env, grant.org_id, grant.workspace_id);
  }
}

/**
 * Authenticated workspace session. All methods operate on the workspace
 * the user authorized during OAuth.
 */
class WorkspaceSession extends RpcTarget {
  private container: WorkspaceContainer;

  constructor(private env: Env, private orgId: string, private workspaceId: string) {
    super();
    this.container = new WorkspaceContainer(env, workspaceId, orgId);
  }

  async bash(command: string, cwd?: string) {
    return this.container.exec(command, { cwd });
  }

  async listApps() {
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(this.orgId)) as DurableObjectStub<OrgDO>;
    const scripts: WorkerScript[] = await orgStub.listWorkerScriptsByWorkspace(this.workspaceId);
    const vanityDomain = getVanityDomain(this.env);

    return Promise.all(scripts.map(async (s: WorkerScript) => {
      let url: string;
      try {
        const customDomain = await orgStub.getCustomDomain();
        if (customDomain?.domain) {
          url = `https://${s.script_name}.${customDomain.domain}`;
        } else {
          const orgSlug = await orgStub.getSlug();
          const sep = orgSlug && /^[a-z0-9]{6,}$/.test(orgSlug) ? '-' : '--';
          url = orgSlug
            ? `https://${s.script_name}${sep}${orgSlug}.${vanityDomain}`
            : `https://${s.script_name}.${vanityDomain}`;
        }
      } catch {
        url = `https://${s.script_name}.${vanityDomain}`;
      }
      return {
        name: s.script_name,
        url,
        is_public: s.is_public,
        created_at: new Date(s.created_at).toISOString(),
        updated_at: new Date(s.updated_at).toISOString(),
      };
    }));
  }

  async listFiles(path = '/home/claude', recursive = false) {
    return this.container.listFiles(path, { recursive });
  }

  async readFile(path: string) {
    return this.container.readFile(path);
  }

  async writeFile(path: string, content: string) {
    return this.container.writeFile(path, content);
  }

  async uploadFile(path: string, contentBase64: string) {
    return this.container.writeBinaryFile(path, contentBase64);
  }

  async downloadFile(path: string) {
    return this.container.readFile(path);
  }
}

// ── OAuth Metadata ───────────────────────────────────────────────────

function buildOAuthMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/api/ext/oauth/authorize`,
    token_endpoint: `${baseUrl}/api/ext/oauth/token`,
    registration_endpoint: `${baseUrl}/api/ext/oauth/register`,
    revocation_endpoint: `${baseUrl}/api/ext/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['workspace'],
  };
}

function buildResourceMetadata(baseUrl: string) {
  return {
    resource: `${baseUrl}/api/ext`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: ['workspace'],
    resource_name: 'camelAI Workspace',
  };
}

export async function handleOAuthMetadata({ req }: RouteContext): Promise<Response | null> {
  if (req.method !== 'GET') return null;
  return Response.json(buildOAuthMetadata(getBaseUrl(req)), {
    headers: { 'cache-control': 'public, max-age=3600' },
  });
}

export async function handleResourceMetadata({ req }: RouteContext): Promise<Response | null> {
  if (req.method !== 'GET') return null;
  return Response.json(buildResourceMetadata(getBaseUrl(req)), {
    headers: { 'cache-control': 'public, max-age=3600' },
  });
}

// ── Main Route Handler ──────────────────────────────────────────────

export async function handleExternalApi({ req, env, ctx, url }: RouteContext): Promise<Response | null> {
  const oauth = new ExternalMcpOAuthProvider(env.APP_KV);
  const pathname = url.pathname;

  // OAuth endpoints
  if (pathname === '/api/ext/oauth/register') {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
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
      return Response.json({ error: 'Registration failed' }, { status: 500 });
    }
  }

  if (pathname === '/api/ext/oauth/authorize') {
    return handleAuthorize(req, env, oauth);
  }

  if (pathname === '/api/ext/oauth/token') {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    return handleTokenExchange(req, oauth);
  }

  if (pathname === '/api/ext/oauth/revoke') {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    return handleTokenRevocation(req, oauth);
  }

  // Health check
  if (pathname === '/api/ext/health') {
    return Response.json({ ok: true });
  }

  // Cap'n Web RPC endpoint
  if (pathname === '/api/ext/rpc') {
    const api = new ExternalApi(env, oauth);
    return newWorkersRpcResponse(req, api);
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
}

// ── Vanity Domain Helper ────────────────────────────────────────────

function getVanityDomain(env: Env): string {
  const baseUrl = env.WORKER_BASE_URL;
  if (baseUrl) {
    try {
      const hostname = new URL(baseUrl).hostname;
      const envPrefix = getEnvPrefix(hostname);
      if (envPrefix) return `${envPrefix}.camelai.app`;
      if (hostname !== 'camelai.dev' && !hostname.endsWith('.camelai.dev')) return 'local.camelai.app';
      return 'camelai.app';
    } catch { return 'camelai.app'; }
  }
  return 'camelai.app';
}

// ── Authorization Handler ───────────────────────────────────────────

async function handleAuthorize(req: Request, env: Env, oauth: ExternalMcpOAuthProvider): Promise<Response> {
  const url = new URL(req.url);

  let params: URLSearchParams;
  if (req.method === 'POST') {
    const formData = await req.text();
    params = new URLSearchParams(formData);
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

  if (!clientId || !redirectUri || responseType !== 'code') {
    return new OAuthError('invalid_request', 'Missing required parameters').toResponse();
  }
  if (!codeChallenge) {
    return new OAuthError('invalid_request', 'code_challenge is required (PKCE is mandatory)').toResponse();
  }
  if (codeChallengeMethod !== 'S256') {
    return new OAuthError('invalid_request', 'Only S256 code challenge method is supported').toResponse();
  }

  const client = await oauth.getClient(clientId);
  if (!client) return new OAuthError('invalid_client', 'Unknown client_id').toResponse();
  if (!client.redirect_uris.includes(redirectUri)) {
    return new OAuthError('invalid_request', 'redirect_uri not registered').toResponse();
  }

  const session = await getSignedSessionFromRequest(req, env.TOKEN_SIGNING_SECRET);
  if (!session) {
    const returnUrl = encodeURIComponent(url.pathname + url.search);
    return Response.redirect(`${url.origin}/login?redirect=${returnUrl}`, 302);
  }

  if (req.method === 'POST') {
    const workspaceId = params.get('workspace_id');
    if (!workspaceId) return new OAuthError('invalid_request', 'No workspace selected').toResponse();

    const hasAccess = await verifyWorkspaceAccess(env, session.user_id, session.org_id, workspaceId);
    if (!hasAccess) return new OAuthError('access_denied', 'No access to this workspace').toResponse();

    const code = await oauth.createAuthorizationCode({
      client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge,
      scopes: scope ? scope.split(' ') : ['workspace'],
      user_id: session.user_id, org_id: session.org_id, workspace_id: workspaceId, state,
    });

    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set('code', code);
    if (state) callbackUrl.searchParams.set('state', state);
    return Response.redirect(callbackUrl.toString(), 302);
  }

  const workspaces = await listUserWorkspaces(env, session.user_id, session.org_id);
  return new Response(renderConsentPage({
    clientName: client.client_name ?? clientId,
    userName: session.user_name ?? session.user_email ?? session.user_id,
    workspaces, authorizeUrl: url.pathname + url.search, clientId, redirectUri,
    responseType: responseType!, codeChallenge, codeChallengeMethod: codeChallengeMethod ?? '',
    state: state ?? '', scope: scope ?? 'workspace',
  }), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

// ── Token Exchange ──────────────────────────────────────────────────

async function handleTokenExchange(req: Request, oauth: ExternalMcpOAuthProvider): Promise<Response> {
  const params = new URLSearchParams(await req.text());
  const clientId = params.get('client_id');
  if (!clientId) return new OAuthError('invalid_request', 'client_id is required').toResponse();

  const client = await oauth.getClient(clientId);
  if (!client) return new OAuthError('invalid_client', 'Unknown client_id').toResponse(401);
  if (client.client_secret) {
    const cs = params.get('client_secret');
    if (!cs) return new OAuthError('invalid_client', 'client_secret required').toResponse(401);
    if (cs !== client.client_secret) return new OAuthError('invalid_client', 'Invalid client_secret').toResponse(401);
  }

  try {
    const gt = params.get('grant_type');
    if (gt === 'authorization_code') {
      const code = params.get('code');
      if (!code) return new OAuthError('invalid_request', 'code is required').toResponse();
      return Response.json(await oauth.exchangeAuthorizationCode(clientId, code, params.get('code_verifier') ?? undefined, params.get('redirect_uri') ?? undefined), { headers: { 'cache-control': 'no-store' } });
    }
    if (gt === 'refresh_token') {
      const rt = params.get('refresh_token');
      if (!rt) return new OAuthError('invalid_request', 'refresh_token is required').toResponse();
      return Response.json(await oauth.exchangeRefreshToken(clientId, rt), { headers: { 'cache-control': 'no-store' } });
    }
    return new OAuthError('unsupported_grant_type', `Unsupported: ${gt}`).toResponse();
  } catch (err) {
    if (err instanceof OAuthError) return err.toResponse();
    return Response.json({ error: 'Token exchange failed' }, { status: 500 });
  }
}

// ── Token Revocation ────────────────────────────────────────────────

async function handleTokenRevocation(req: Request, oauth: ExternalMcpOAuthProvider): Promise<Response> {
  const params = new URLSearchParams(await req.text());
  const token = params.get('token');
  if (!token) return new OAuthError('invalid_request', 'token is required').toResponse();
  await oauth.revokeToken(token, params.get('token_type_hint') ?? undefined);
  return new Response(null, { status: 200 });
}

// ── Workspace Helpers ───────────────────────────────────────────────

interface WorkspaceInfo { id: string; name: string; }

async function verifyWorkspaceAccess(env: Env, userId: string, orgId: string, workspaceId: string): Promise<boolean> {
  try {
    const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
    const member = await (orgStub as any).getMember(userId);
    if (!member) return false;
    const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
    const wsMeta = await (wsStub as any).getMetadata();
    if (!wsMeta || wsMeta.org_id !== orgId) return false;
    const access = await (wsStub as any).getMemberAccess(userId);
    return access && access !== 'none';
  } catch { return false; }
}

async function listUserWorkspaces(env: Env, userId: string, orgId: string): Promise<WorkspaceInfo[]> {
  try {
    const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
    const workspaceIds: string[] = await (orgStub as any).listWorkspaceIds();
    const results: WorkspaceInfo[] = [];
    for (const wsId of workspaceIds) {
      try {
        const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(wsId));
        const meta = await (wsStub as any).getMetadata();
        const access = await (wsStub as any).getMemberAccess(userId);
        if (meta && access && access !== 'none') results.push({ id: wsId, name: meta.name ?? wsId });
      } catch {}
    }
    return results;
  } catch { return []; }
}

// ── Consent Page ────────────────────────────────────────────────────

function renderConsentPage(p: {
  clientName: string; userName: string; workspaces: WorkspaceInfo[];
  authorizeUrl: string; clientId: string; redirectUri: string;
  responseType: string; codeChallenge: string; codeChallengeMethod: string;
  state: string; scope: string;
}): string {
  const opts = p.workspaces.map(ws => `<option value="${esc(ws.id)}">${esc(ws.name)}</option>`).join('\n');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize – camelAI</title>
<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:1rem}.card{background:#171717;border:1px solid #262626;border-radius:12px;padding:2rem;max-width:420px;width:100%}.card h1{font-size:1.25rem;font-weight:600;margin-bottom:.5rem}.card p{color:#a3a3a3;font-size:.875rem;line-height:1.5;margin-bottom:1.25rem}.cn{color:#f5f5f5;font-weight:500}label{display:block;font-size:.8125rem;font-weight:500;color:#a3a3a3;margin-bottom:.375rem}select{width:100%;padding:.625rem .75rem;background:#262626;border:1px solid #404040;border-radius:8px;color:#e5e5e5;font-size:.875rem;margin-bottom:1.25rem;appearance:none;cursor:pointer}select:focus{outline:2px solid #3b82f6;outline-offset:-1px}.pm{background:#1c1c1c;border:1px solid #262626;border-radius:8px;padding:.75rem 1rem;margin-bottom:1.25rem;font-size:.8125rem}.pm h3{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:#737373;margin-bottom:.5rem}.pm ul{list-style:none;padding:0}.pm li{padding:.25rem 0;color:#a3a3a3}.pm li::before{content:"•";color:#525252;margin-right:.5rem}.actions{display:flex;gap:.75rem}.btn{flex:1;padding:.625rem 1rem;border-radius:8px;font-size:.875rem;font-weight:500;cursor:pointer;border:none;transition:background .15s}.bc{background:#262626;color:#a3a3a3}.bc:hover{background:#333}.ba{background:#3b82f6;color:#fff}.ba:hover{background:#2563eb}.ui{font-size:.75rem;color:#525252;text-align:center;margin-top:1rem}</style></head>
<body><div class="card"><h1>Authorize Access</h1><p><span class="cn">${esc(p.clientName)}</span> wants to access your camelAI workspace.</p>
<form method="POST" action="${esc(p.authorizeUrl)}">
<input type="hidden" name="client_id" value="${esc(p.clientId)}"><input type="hidden" name="redirect_uri" value="${esc(p.redirectUri)}"><input type="hidden" name="response_type" value="${esc(p.responseType)}"><input type="hidden" name="code_challenge" value="${esc(p.codeChallenge)}"><input type="hidden" name="code_challenge_method" value="${esc(p.codeChallengeMethod)}"><input type="hidden" name="state" value="${esc(p.state)}"><input type="hidden" name="scope" value="${esc(p.scope)}">
<label for="workspace_id">Workspace</label><select name="workspace_id" id="workspace_id" required><option value="" disabled selected>Select a workspace…</option>${opts}</select>
<div class="pm"><h3>This will allow</h3><ul><li>Execute commands in your workspace</li><li>Read and write files</li><li>List and manage deployed apps</li></ul></div>
<div class="actions"><button type="button" class="btn bc" onclick="window.close()">Cancel</button><button type="submit" class="btn ba">Authorize</button></div>
</form><p class="ui">Signed in as ${esc(p.userName)}</p></div></body></html>`;
}

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
