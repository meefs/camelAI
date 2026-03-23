/**
 * Shared helpers for the external API routes.
 */

import { getEnv, type CloudflareEnv } from './cloudflare.server';
import { ExtApiOAuthProvider, type TokenGrantRecord } from '../../workers/main/src/external-api-oauth';
import { WorkspaceContainer } from '../../workers/main/src/workspace-container';
import { getEnvPrefix } from '../../workers/main/src/cf-api-proxy';
import type { AppLoadContext } from 'react-router';

export { OAuthError } from '../../workers/main/src/external-api-oauth';
export { CLI_REDIRECT_URI } from '../../workers/main/src/external-api-oauth';
export type { TokenGrantRecord };

export function getOAuth(env: CloudflareEnv): ExtApiOAuthProvider | null {
  const clientId = (env as any).EXT_API_CLIENT_ID;
  if (!clientId) return null;
  return new ExtApiOAuthProvider(env.APP_KV, clientId);
}

export function err(error: string, status = 400, details?: string): Response {
  return Response.json({ error, ...(details && { details }) }, { status });
}

export async function requireBearerAuth(request: Request, env: CloudflareEnv): Promise<TokenGrantRecord | Response> {
  const oauth = getOAuth(env);
  if (!oauth) return err('External API not configured', 503);
  const h = request.headers.get('authorization');
  if (!h?.startsWith('Bearer ')) return err('Unauthorized', 401);
  const grant = await oauth.verifyAccessToken(h.slice(7));
  if (!grant) return err('Invalid or expired token', 401);
  return grant;
}

export function getContainer(env: CloudflareEnv, grant: TokenGrantRecord): WorkspaceContainer {
  return new WorkspaceContainer(env as any, grant.workspace_id, grant.org_id);
}

export function getVanityDomain(env: CloudflareEnv): string {
  const u = (env as any).WORKER_BASE_URL;
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

export interface WorkspaceInfo { id: string; name: string; }

export async function verifyWorkspaceAccess(env: CloudflareEnv, userId: string, orgId: string, workspaceId: string): Promise<boolean> {
  try {
    const org = (env as any).ORG.get((env as any).ORG.idFromName(orgId));
    if (!await org.getMember(userId)) return false;
    const ws = (env as any).WORKSPACE.get((env as any).WORKSPACE.idFromName(workspaceId));
    const meta = await ws.getMetadata();
    if (!meta || meta.org_id !== orgId) return false;
    const access = await ws.getMemberAccess(userId);
    return access && access !== 'none';
  } catch { return false; }
}

export async function listUserWorkspaces(env: CloudflareEnv, userId: string, orgId: string): Promise<WorkspaceInfo[]> {
  try {
    const orgStub = (env as any).ORG.get((env as any).ORG.idFromName(orgId));
    const workspaceRows: { id: string }[] = await orgStub.getWorkspaces();
    const out: WorkspaceInfo[] = [];
    for (const row of workspaceRows) {
      try {
        const wsStub = (env as any).WORKSPACE.get((env as any).WORKSPACE.idFromName(row.id));
        const info = await wsStub.getInfo();
        const memberAccess = await wsStub.getMemberAccess(userId);
        if (info && (!memberAccess || (memberAccess.access_level ?? 'full') !== 'none')) {
          out.push({ id: row.id, name: info.name ?? row.id });
        }
      } catch {}
    }
    return out;
  } catch { return []; }
}
