import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  errorResponse,
  forbiddenResponse,
  getSessionId,
  jsonResponse,
  unauthorizedResponse,
} from '@/lib/auth';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
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

    const workspace = await authDO.getWorkspace(id);
    if (!workspace || workspace.org_id !== session.org_id) {
      return errorResponse('Workspace not found', 404);
    }

    const access = await authDO.getWorkspaceAccess(id, session.user_id);
    if (access === 'none') {
      return errorResponse('Workspace not found', 404);
    }

    return jsonResponse({ ...workspace, access_level: access });
  } catch (error) {
    console.error('Error fetching workspace:', error);
    return errorResponse('Failed to fetch workspace', 500);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
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

    const workspace = await authDO.getWorkspace(id);
    if (!workspace || workspace.org_id !== session.org_id) {
      return errorResponse('Workspace not found', 404);
    }

    const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id);
    if (!isAdmin) {
      return forbiddenResponse('Only admins can update workspaces');
    }

    const body = await request.json() as {
      name?: string;
      description?: string | null;
      avatar?: { color: string; content: string };
    };
    if (body.name && body.name.length > 100) {
      return errorResponse('Workspace name must be 100 characters or less', 400);
    }

    const updated = await authDO.updateWorkspace(id, {
      name: typeof body.name === 'string' ? body.name.trim() : undefined,
      description: body.description ?? undefined,
      avatar: body.avatar,
    }, session.user_id);
    if (!updated) {
      return errorResponse('Workspace not found', 404);
    }
    return jsonResponse(updated);
  } catch (error) {
    console.error('Error updating workspace:', error);
    return errorResponse('Failed to update workspace', 500);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
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

    const workspace = await authDO.getWorkspace(id);
    if (!workspace || workspace.org_id !== session.org_id) {
      return errorResponse('Workspace not found', 404);
    }

    const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id);
    if (!isAdmin) {
      return forbiddenResponse('Only admins can archive workspaces');
    }

    const archived = await authDO.archiveWorkspace(id, session.user_id);
    if (!archived) {
      return errorResponse('Workspace not found', 404);
    }
    return jsonResponse(archived);
  } catch (error) {
    console.error('Error archiving workspace:', error);
    return errorResponse('Failed to archive workspace', 500);
  }
}
