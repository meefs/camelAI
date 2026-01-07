import { NextRequest, NextResponse } from 'next/server';
import * as authDO from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do';
import { errorResponse, getSessionId, jsonResponse, unauthorizedResponse } from '@/lib/auth';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
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
    const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id);
    if (access === 'none') {
      return errorResponse('Workspace not found', 404);
    }

    const thread = await chatDO.getThread(id, workspaceId);
    if (!thread) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return jsonResponse(thread);
  } catch (error) {
    console.error('Error fetching thread:', error);
    return errorResponse('Failed to fetch thread', 500);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const body = await request.json() as { title?: string };
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      return errorResponse('Title is required', 400);
    }

    const workspaceId = session.workspace_id;
    if (!workspaceId) {
      return errorResponse('No workspace selected', 400);
    }
    const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id);
    if (access !== 'full') {
      return errorResponse('Workspace access denied', 403);
    }

    const thread = await chatDO.updateThread(id, title, workspaceId);
    if (!thread) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return jsonResponse(thread);
  } catch (error) {
    console.error('Error updating thread:', error);
    return errorResponse('Failed to update thread', 500);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
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
    const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id);
    if (access !== 'full') {
      return errorResponse('Workspace access denied', 403);
    }

    const thread = await chatDO.getThread(id, workspaceId);
    if (!thread) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    await chatDO.deleteThread(id, workspaceId);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Error deleting thread:', error);
    return errorResponse('Failed to delete thread', 500);
  }
}
