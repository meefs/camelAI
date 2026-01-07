import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do';
import { errorResponse, getSessionId, jsonResponse, unauthorizedResponse } from '@/lib/auth';

function parseNumber(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(parsed) || parsed < 0) return fallback;
  return parsed;
}

export async function GET(request: NextRequest) {
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const workspaceId = session.workspace_id;
    if (!workspaceId) {
      return errorResponse('No workspace selected', 400);
    }
    // FIXME: Enforce viewer role restrictions when publishing is implemented.
    // Viewers should only access published apps, not chat threads.
    const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id);
    if (access === 'none') {
      return errorResponse('Workspace not found', 404);
    }

    const offset = parseNumber(request.nextUrl.searchParams.get('offset'), 0);
    const limit = parseNumber(request.nextUrl.searchParams.get('limit'), 50);
    const page = await chatDO.getThreadsPaginated(workspaceId, { offset, limit });
    return jsonResponse(page);
  } catch (error) {
    console.error('Error listing threads:', error);
    return errorResponse('Failed to list threads', 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const workspaceId = session.workspace_id;
    if (!workspaceId) {
      return errorResponse('No workspace selected', 400);
    }
    // FIXME: Enforce viewer role restrictions when publishing is implemented.
    // Viewers should only access published apps, not chat threads.
    const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id);
    if (access !== 'full') {
      return errorResponse('Workspace access denied', 403);
    }

    const body = await request.json() as { title?: string; session_id?: string };
    const title = typeof body.title === 'string' ? body.title : undefined;
    const sessionIdOverride = typeof body.session_id === 'string' ? body.session_id : undefined;
    const thread = await chatDO.createThread(
      workspaceId,
      title,
      session.user_id,
      sessionIdOverride
    );
    return jsonResponse(thread);
  } catch (error) {
    console.error('Error creating thread:', error);
    return errorResponse('Failed to create thread', 500);
  }
}
