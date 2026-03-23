/**
 * External REST API route handler.
 *
 * OAuth:
 *   GET  /.well-known/oauth-authorization-server  → OAuth metadata
 *   GET  /.well-known/oauth-protected-resource     → Resource metadata
 *   GET  /api/ext/oauth/authorize                  → OAuth authorize (consent page)
 *   POST /api/ext/oauth/authorize                  → OAuth authorize (submit)
 *   POST /api/ext/oauth/token                      → Token exchange
 *   POST /api/ext/oauth/revoke                     → Token revocation
 *
 * API (Bearer auth):
 *   GET  /api/ext/health                           → Health check
 *   POST /api/ext/bash                             → Execute bash command
 *   GET  /api/ext/apps                             → List deployed apps
 *   GET  /api/ext/files                            → List files
 *   GET  /api/ext/files/read                       → Read file
 *   PUT  /api/ext/files/write                      → Write file
 *   POST /api/ext/files/upload                     → Upload binary file (base64)
 *   GET  /api/ext/files/download                   → Download file (raw stream)
 *
 * Client ID is a hardcoded env var (EXT_API_CLIENT_ID). No dynamic
 * registration — the CLI ships with the client ID baked in.
 */

import type { Env, RouteContext } from '../types.js';
import { ExtApiOAuthProvider, OAuthError, CLI_REDIRECT_URI, type TokenGrantRecord } from '../external-api-oauth.js';
import { WorkspaceContainer } from '../workspace-container.js';
import { getSignedSessionFromRequest } from '../cookies.js';
import type { OrgDO, WorkerScript } from '../auth.js';
import { getEnvPrefix } from '../cf-api-proxy.js';

// ── Helpers ──────────────────────────────────────────────────────────

function getBaseUrl(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function err(error: string, status = 400, details?: string): Response {
  return Response.json({ error, ...(details && { details }) }, { status });
}

function getOAuth(env: Env): ExtApiOAuthProvider {
  const clientId = (env as any).EXT_API_CLIENT_ID;
  if (!clientId) throw new Error('EXT_API_CLIENT_ID is not configured');
  return new ExtApiOAuthProvider(env.APP_KV, clientId);
}

// ── Bearer Auth ─────────────────────────────────────────────────────

async function requireAuth(req: Request, oauth: ExtApiOAuthProvider): Promise<TokenGrantRecord | Response> {
  const h = req.headers.get('authorization');
  if (!h?.startsWith('Bearer ')) return err('Unauthorized', 401);
  const grant = await oauth.verifyAccessToken(h.slice(7));
  if (!grant) return err('Invalid or expired token', 401);
  return grant;
}

// ── OAuth Metadata ──────────────────────────────────────────────────

function buildOAuthMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/api/ext/oauth/authorize`,
    token_endpoint: `${baseUrl}/api/ext/oauth/token`,
    revocation_endpoint: `${baseUrl}/api/ext/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
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
  const p = url.pathname;

  // ── OAuth ─────────────────────────────────────────────────────

  if (p === '/api/ext/oauth/authorize') return handleAuthorize(req, env);

  if (p === '/api/ext/oauth/token') {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    return handleTokenExchange(req, env);
  }

  if (p === '/api/ext/oauth/revoke') {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    return handleTokenRevocation(req, env);
  }

  // ── Health ────────────────────────────────────────────────────

  if (p === '/api/ext/health') return json({ ok: true });

  // ── API (auth required) ───────────────────────────────────────

  const oauth = getOAuth(env);
  const authResult = await requireAuth(req, oauth);
  if (authResult instanceof Response) return authResult;
  const grant = authResult;
  const container = new WorkspaceContainer(env, grant.workspace_id, grant.org_id);

  if (p === '/api/ext/bash' && req.method === 'POST') {
    const body = await req.json() as { command: string; cwd?: string };
    if (!body.command) return err('command is required');
    return json(await container.exec(body.command, { cwd: body.cwd }));
  }

  if (p === '/api/ext/apps' && req.method === 'GET') {
    const orgStub = env.ORG.get(env.ORG.idFromName(grant.org_id)) as DurableObjectStub<OrgDO>;
    const scripts: WorkerScript[] = await orgStub.listWorkerScriptsByWorkspace(grant.workspace_id);
    const vd = getVanityDomain(env);
    const apps = await Promise.all(scripts.map(async (s: WorkerScript) => {
      let appUrl: string;
      try {
        const cd = await orgStub.getCustomDomain();
        if (cd?.domain) { appUrl = `https://${s.script_name}.${cd.domain}`; }
        else {
          const slug = await orgStub.getSlug();
          const sep = slug && /^[a-z0-9]{6,}$/.test(slug) ? '-' : '--';
          appUrl = slug ? `https://${s.script_name}${sep}${slug}.${vd}` : `https://${s.script_name}.${vd}`;
        }
      } catch { appUrl = `https://${s.script_name}.${vd}`; }
      return { name: s.script_name, url: appUrl, is_public: s.is_public, created_at: new Date(s.created_at).toISOString(), updated_at: new Date(s.updated_at).toISOString() };
    }));
    return json({ count: apps.length, apps });
  }

  if (p === '/api/ext/files' && req.method === 'GET') {
    const path = url.searchParams.get('path') ?? '/home/claude';
    const recursive = url.searchParams.get('recursive') === '1';
    return json(await container.listFiles(path, { recursive }));
  }

  if (p === '/api/ext/files/read' && req.method === 'GET') {
    const path = url.searchParams.get('path');
    if (!path) return err('path query parameter is required');
    return json(await container.readFile(path));
  }

  if (p === '/api/ext/files/write' && req.method === 'PUT') {
    const body = await req.json() as { path: string; content: string };
    if (!body.path || body.content === undefined) return err('path and content are required');
    return json(await container.writeFile(body.path, body.content));
  }

  if (p === '/api/ext/files/upload' && req.method === 'POST') {
    const body = await req.json() as { path: string; content_base64: string };
    if (!body.path || !body.content_base64) return err('path and content_base64 are required');
    return json(await container.writeBinaryFile(body.path, body.content_base64));
  }

  if (p === '/api/ext/files/download' && req.method === 'GET') {
    const path = url.searchParams.get('path');
    if (!path) return err('path query parameter is required');
    const resp = await container.readFileStream(path);
    if (!resp) return err('File not found', 404);
    const filename = path.split('/').pop() ?? 'file';
    return new Response(resp.body, {
      headers: {
        'content-type': resp.headers.get('content-type') ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  }

  return err('Not found', 404);
}

// ── Vanity Domain ───────────────────────────────────────────────────

function getVanityDomain(env: Env): string {
  const u = env.WORKER_BASE_URL;
  if (u) {
    try {
      const h = new URL(u).hostname;
      const p = getEnvPrefix(h);
      if (p) return `${p}.camelai.app`;
      if (h !== 'camelai.dev' && !h.endsWith('.camelai.dev')) return 'local.camelai.app';
    } catch {}
  }
  return 'camelai.app';
}

// ── Authorization ───────────────────────────────────────────────────

async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  const oauth = getOAuth(env);
  const url = new URL(req.url);

  let params: URLSearchParams;
  if (req.method === 'POST') {
    params = new URLSearchParams(await req.text());
    for (const [k, v] of url.searchParams) { if (!params.has(k)) params.set(k, v); }
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

  if (!clientId || !redirectUri || responseType !== 'code')
    return new OAuthError('invalid_request', 'Missing required parameters').toResponse();
  if (!codeChallenge)
    return new OAuthError('invalid_request', 'code_challenge is required (PKCE mandatory)').toResponse();
  if (codeChallengeMethod !== 'S256')
    return new OAuthError('invalid_request', 'Only S256 supported').toResponse();
  if (!oauth.validateClient(clientId))
    return new OAuthError('invalid_client', 'Unknown client_id').toResponse();
  if (redirectUri !== CLI_REDIRECT_URI)
    return new OAuthError('invalid_request', 'Invalid redirect_uri').toResponse();

  const session = await getSignedSessionFromRequest(req, env.TOKEN_SIGNING_SECRET);
  if (!session) {
    return Response.redirect(`${url.origin}/login?redirect=${encodeURIComponent(url.pathname + url.search)}`, 302);
  }

  if (req.method === 'POST') {
    const workspaceId = params.get('workspace_id');
    if (!workspaceId) return new OAuthError('invalid_request', 'No workspace selected').toResponse();
    const ok = await verifyWorkspaceAccess(env, session.user_id, session.org_id, workspaceId);
    if (!ok) return new OAuthError('access_denied', 'No access to this workspace').toResponse();

    const code = await oauth.createAuthorizationCode({
      client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge,
      scopes: scope ? scope.split(' ') : ['workspace'],
      user_id: session.user_id, org_id: session.org_id, workspace_id: workspaceId, state,
    });
    const cb = new URL(redirectUri);
    cb.searchParams.set('code', code);
    if (state) cb.searchParams.set('state', state);
    return Response.redirect(cb.toString(), 302);
  }

  const workspaces = await listUserWorkspaces(env, session.user_id, session.org_id);
  return new Response(renderConsentPage({
    clientName: 'camelAI CLI',
    userName: session.user_name ?? session.user_email ?? session.user_id,
    workspaces, authorizeUrl: url.pathname + url.search, clientId, redirectUri,
    responseType: responseType!, codeChallenge, codeChallengeMethod: codeChallengeMethod ?? '',
    state: state ?? '', scope: scope ?? 'workspace',
  }), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

// ── Token Exchange ──────────────────────────────────────────────────

async function handleTokenExchange(req: Request, env: Env): Promise<Response> {
  const oauth = getOAuth(env);
  const params = new URLSearchParams(await req.text());
  const clientId = params.get('client_id');
  if (!clientId) return new OAuthError('invalid_request', 'client_id is required').toResponse();
  if (!oauth.validateClient(clientId)) return new OAuthError('invalid_client', 'Unknown client_id').toResponse(401);

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
  } catch (e) {
    if (e instanceof OAuthError) return e.toResponse();
    return Response.json({ error: 'Token exchange failed' }, { status: 500 });
  }
}

// ── Token Revocation ────────────────────────────────────────────────

async function handleTokenRevocation(req: Request, env: Env): Promise<Response> {
  const oauth = getOAuth(env);
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
    const org = env.ORG.get(env.ORG.idFromName(orgId));
    if (!await (org as any).getMember(userId)) return false;
    const ws = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
    const meta = await (ws as any).getMetadata();
    if (!meta || meta.org_id !== orgId) return false;
    const access = await (ws as any).getMemberAccess(userId);
    return access && access !== 'none';
  } catch { return false; }
}

async function listUserWorkspaces(env: Env, userId: string, orgId: string): Promise<WorkspaceInfo[]> {
  try {
    const org = env.ORG.get(env.ORG.idFromName(orgId));
    const ids: string[] = await (org as any).listWorkspaceIds();
    const out: WorkspaceInfo[] = [];
    for (const id of ids) {
      try {
        const ws = env.WORKSPACE.get(env.WORKSPACE.idFromName(id));
        const meta = await (ws as any).getMetadata();
        const access = await (ws as any).getMemberAccess(userId);
        if (meta && access && access !== 'none') out.push({ id, name: meta.name ?? id });
      } catch {}
    }
    return out;
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
