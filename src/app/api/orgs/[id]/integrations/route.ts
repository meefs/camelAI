import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  getSessionId,
  jsonResponse,
  errorResponse,
  unauthorizedResponse,
  forbiddenResponse,
} from '@/lib/auth';
import {
  getIntegrationDefinition,
  validateConfig,
  validateCredentials,
} from '@/lib/integration-registry';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/orgs/[id]/integrations - List all integrations
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id: orgId } = await params;
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    // Check if user is a member of the org
    const isMember = await authDO.isOrgMember(session.user_id, orgId);
    if (!isMember) {
      return forbiddenResponse('You are not a member of this organization');
    }

    const integrations = await authDO.getOrgIntegrations(orgId);
    return jsonResponse(integrations);
  } catch (error) {
    console.error('Error listing integrations:', error);
    return errorResponse('Failed to list integrations', 500);
  }
}

// POST /api/orgs/[id]/integrations - Create new integration
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: orgId } = await params;
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    // Check if user is an admin of the org
    const isAdmin = await authDO.isOrgAdmin(session.user_id, orgId);
    if (!isAdmin) {
      return forbiddenResponse('Only admins can create integrations');
    }

    const body = (await request.json()) as {
      integration_type: string;
      name: string;
      config: Record<string, unknown>;
      credentials: Record<string, unknown>;
    };

    const { integration_type, name, config, credentials } = body;

    // Validate integration type exists
    const definition = getIntegrationDefinition(integration_type);
    if (!definition) {
      return errorResponse(`Unknown integration type: ${integration_type}`);
    }

    // Validate name
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return errorResponse('Integration name is required');
    }

    if (name.length > 100) {
      return errorResponse('Integration name must be 100 characters or less');
    }

    // Validate config
    const configErrors = validateConfig(integration_type, config || {});
    if (configErrors.length > 0) {
      return errorResponse(configErrors.join(', '));
    }

    // Validate credentials
    const credentialErrors = validateCredentials(integration_type, credentials || {});
    if (credentialErrors.length > 0) {
      return errorResponse(credentialErrors.join(', '));
    }

    const integration = await authDO.createOrgIntegration(orgId, session.user_id, {
      integration_type,
      name: name.trim(),
      config: config || {},
      credentials: credentials || {},
    });

    // TODO: Re-enable container restart when integrations change
    // authDO.restartOrgContainers(orgId).catch((e) => {
    //   console.error('Failed to restart containers after integration create:', e);
    // });

    return jsonResponse(integration, 201);
  } catch (error) {
    console.error('Error creating integration:', error);
    return errorResponse('Failed to create integration', 500);
  }
}
