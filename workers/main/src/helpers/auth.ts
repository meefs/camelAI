/**
 * Authentication and authorization helpers
 */

import type { Env } from '../types.js';
import type { SessionData } from '../session-kv.js';
import type { WorkspaceDO } from '../workspace.js';
import type { OrgDO } from '../auth.js';
import { getSession } from '../session-kv.js';
import { getSessionIdFromRequest } from '../cookies.js';
import { text } from './response.js';
import { getWorkspaceStub, getOrgStub } from './stubs.js';

export type AuthResult = { session: SessionData } | { error: Response };

export async function requireSession(req: Request, env: Env): Promise<AuthResult> {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId) return { error: text('Unauthorized', 401) };

  const session = await getSession(env.SESSIONS, sessionId);
  if (!session) return { error: text('Unauthorized', 401) };

  return { session };
}

export interface WorkspaceAccess {
  session: SessionData;
  orgId: string;
  workspaceId: string;
  userId: string;
  wsStub: WorkspaceDO;
  orgStub: OrgDO;
  /** Workspace info - already fetched during auth, avoid re-fetching */
  wsInfo: Awaited<ReturnType<WorkspaceDO['getInfo']>> & {};
  /** Organization info - already fetched during auth, avoid re-fetching */
  orgInfo: Awaited<ReturnType<OrgDO['getInfo']>> & {};
}

export type WorkspaceAccessResult = WorkspaceAccess | { error: Response };

export async function requireWorkspaceAccess(req: Request, env: Env): Promise<WorkspaceAccessResult> {
  const auth = await requireSession(req, env);
  if ('error' in auth) return auth;

  const { session } = auth;
  const { org_id: orgId, workspace_id: workspaceId, user_id: userId } = session;

  if (!orgId) return { error: text('No organization selected', 400) };
  if (!workspaceId) return { error: text('No workspace selected', 400) };

  try {
    const wsStub = getWorkspaceStub(env, workspaceId);
    const wsInfo = await wsStub.getInfo();
    if (!wsInfo || wsInfo.archived) return { error: text('Workspace not found', 404) };

    const orgStub = getOrgStub(env, wsInfo.org_id);
    const orgInfo = await orgStub.getInfo();
    if (!orgInfo || orgInfo.archived) return { error: text('Organization not found', 404) };

    if (!(await orgStub.isMember(userId))) return { error: text('Forbidden', 403) };

    const memberAccess = await wsStub.getMemberAccess(userId);
    if ((memberAccess?.access_level ?? 'full') !== 'full') {
      return { error: text('Forbidden', 403) };
    }

    return { session, orgId, workspaceId, userId, wsStub, orgStub, wsInfo, orgInfo };
  } catch {
    return { error: text('Forbidden', 403) };
  }
}
