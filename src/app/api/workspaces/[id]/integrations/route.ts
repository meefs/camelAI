import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  errorResponse,
  forbiddenResponse,
  getSessionId,
  jsonResponse,
  unauthorizedResponse,
} from '@/lib/auth';
import {
  getIntegrationDefinition,
  validateConfig,
  validateCredentials,
} from '@/lib/integration-registry';

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

    const integrations = await authDO.getWorkspaceIntegrations(id);
    return jsonResponse(integrations);
  } catch (error) {
    console.error('Error listing integrations:', error);
    return errorResponse('Failed to list integrations', 500);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
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
      return forbiddenResponse('Only admins can create integrations');
    }

    const body = await request.json() as {
      integration_type?: string;
      name?: string;
      config?: Record<string, unknown>;
      credentials?: Record<string, unknown>;
    };

    const integrationType = body.integration_type;
    if (!integrationType) {
      return errorResponse('Integration type is required', 400);
    }
    const definition = getIntegrationDefinition(integrationType);
    if (!definition) {
      return errorResponse(`Unknown integration type: ${integrationType}`, 400);
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return errorResponse('Integration name is required', 400);
    }
    if (name.length > 100) {
      return errorResponse('Integration name must be 100 characters or less', 400);
    }

    const config = body.config ?? {};
    const credentials = body.credentials ?? {};
    const configErrors = validateConfig(integrationType, config);
    if (configErrors.length > 0) {
      return errorResponse(configErrors.join(', '), 400);
    }
    const credentialErrors = validateCredentials(integrationType, credentials);
    if (credentialErrors.length > 0) {
      return errorResponse(credentialErrors.join(', '), 400);
    }

    const integration = await authDO.createWorkspaceIntegration(id, session.user_id, {
      integration_type: integrationType,
      name,
      config,
      credentials,
    });

    return jsonResponse(integration);
  } catch (error) {
    console.error('Error creating integration:', error);
    return errorResponse('Failed to create integration', 500);
  }
}
