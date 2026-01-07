import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  errorResponse,
  forbiddenResponse,
  getSessionId,
  jsonResponse,
  unauthorizedResponse,
} from '@/lib/auth';
import { validateConfig, validateCredentials } from '@/lib/integration-registry';

interface RouteParams {
  params: Promise<{ id: string; integrationId: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id, integrationId } = await params;
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

    const integration = await authDO.getWorkspaceIntegration(id, integrationId);
    if (!integration) {
      return errorResponse('Integration not found', 404);
    }

    return jsonResponse(integration);
  } catch (error) {
    console.error('Error fetching integration:', error);
    return errorResponse('Failed to fetch integration', 500);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { id, integrationId } = await params;
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
      return forbiddenResponse('Only admins can update integrations');
    }

    const existing = await authDO.getWorkspaceIntegration(id, integrationId);
    if (!existing) {
      return errorResponse('Integration not found', 404);
    }

    const body = await request.json() as {
      name?: string;
      config?: Record<string, unknown>;
      credentials?: Record<string, unknown>;
      enabled?: boolean;
    };

    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) {
        return errorResponse('Integration name cannot be empty', 400);
      }
      if (name.length > 100) {
        return errorResponse('Integration name must be 100 characters or less', 400);
      }
    }

    if (body.config !== undefined) {
      const configErrors = validateConfig(existing.integration_type, body.config);
      if (configErrors.length > 0) {
        return errorResponse(configErrors.join(', '), 400);
      }
    }

    if (body.credentials !== undefined) {
      const credentialErrors = validateCredentials(existing.integration_type, body.credentials);
      if (credentialErrors.length > 0) {
        return errorResponse(credentialErrors.join(', '), 400);
      }
    }

    const updated = await authDO.updateWorkspaceIntegration(id, integrationId, session.user_id, {
      name: body.name?.trim(),
      config: body.config,
      credentials: body.credentials,
      enabled: body.enabled,
    });

    if (!updated) {
      return errorResponse('Failed to update integration', 500);
    }

    return jsonResponse(updated);
  } catch (error) {
    console.error('Error updating integration:', error);
    return errorResponse('Failed to update integration', 500);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id, integrationId } = await params;
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
      return forbiddenResponse('Only admins can delete integrations');
    }

    const existing = await authDO.getWorkspaceIntegration(id, integrationId);
    if (!existing) {
      return errorResponse('Integration not found', 404);
    }

    await authDO.deleteWorkspaceIntegration(id, integrationId, session.user_id);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Error deleting integration:', error);
    return errorResponse('Failed to delete integration', 500);
  }
}
