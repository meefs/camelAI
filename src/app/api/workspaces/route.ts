import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  errorResponse,
  forbiddenResponse,
  getSessionId,
  jsonResponse,
  unauthorizedResponse,
} from '@/lib/auth';

export async function GET() {
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const workspaces = await authDO.listUserWorkspaces(session.user_id, session.org_id);
    return jsonResponse(workspaces);
  } catch (error) {
    console.error('Error listing workspaces:', error);
    return errorResponse('Failed to list workspaces', 500);
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

    const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id);
    if (!isAdmin) {
      return forbiddenResponse('Only admins can create workspaces');
    }

    const body = await request.json() as { name?: string; description?: string | null };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return errorResponse('Workspace name is required', 400);
    }
    if (name.length > 100) {
      return errorResponse('Workspace name must be 100 characters or less', 400);
    }

    const workspace = await authDO.createWorkspace(
      session.org_id,
      name,
      session.user_id,
      typeof body.description === 'string' ? body.description : null
    );

    return jsonResponse(workspace);
  } catch (error) {
    console.error('Error creating workspace:', error);
    return errorResponse('Failed to create workspace', 500);
  }
}
