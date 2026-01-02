import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  getSessionId,
  jsonResponse,
  errorResponse,
  unauthorizedResponse,
  forbiddenResponse,
} from '@/lib/auth';
import { validateConfig, validateCredentials } from '@/lib/integration-registry';

interface RouteParams {
  params: Promise<{ id: string; integrationId: string }>;
}

// GET /api/orgs/[id]/integrations/[integrationId] - Get single integration
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id: orgId, integrationId } = await params;
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

    const integration = await authDO.getOrgIntegration(orgId, integrationId);
    if (!integration) {
      return errorResponse('Integration not found', 404);
    }

    return jsonResponse(integration);
  } catch (error) {
    console.error('Error getting integration:', error);
    return errorResponse('Failed to get integration', 500);
  }
}

// PUT /api/orgs/[id]/integrations/[integrationId] - Update integration
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: orgId, integrationId } = await params;
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
      return forbiddenResponse('Only admins can update integrations');
    }

    // Check if integration exists
    const existing = await authDO.getOrgIntegration(orgId, integrationId);
    if (!existing) {
      return errorResponse('Integration not found', 404);
    }

    const body = (await request.json()) as {
      name?: string;
      config?: Record<string, unknown>;
      credentials?: Record<string, unknown>;
      enabled?: boolean;
    };

    const { name, config, credentials, enabled } = body;

    // Validate name if provided
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return errorResponse('Integration name cannot be empty');
      }
      if (name.length > 100) {
        return errorResponse('Integration name must be 100 characters or less');
      }
    }

    // Validate config if provided
    if (config !== undefined) {
      const configErrors = validateConfig(existing.integration_type, config);
      if (configErrors.length > 0) {
        return errorResponse(configErrors.join(', '));
      }
    }

    // Validate credentials if provided
    if (credentials !== undefined) {
      const credentialErrors = validateCredentials(existing.integration_type, credentials);
      if (credentialErrors.length > 0) {
        return errorResponse(credentialErrors.join(', '));
      }
    }

    const updated = await authDO.updateOrgIntegration(orgId, integrationId, {
      name: name?.trim(),
      config,
      credentials,
      enabled,
    });

    if (!updated) {
      return errorResponse('Failed to update integration', 500);
    }

    // TODO: Re-enable container restart when integrations change
    // authDO.restartOrgContainers(orgId).catch((e) => {
    //   console.error('Failed to restart containers after integration update:', e);
    // });

    return jsonResponse(updated);
  } catch (error) {
    console.error('Error updating integration:', error);
    return errorResponse('Failed to update integration', 500);
  }
}

// DELETE /api/orgs/[id]/integrations/[integrationId] - Delete integration
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id: orgId, integrationId } = await params;
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
      return forbiddenResponse('Only admins can delete integrations');
    }

    // Check if integration exists
    const existing = await authDO.getOrgIntegration(orgId, integrationId);
    if (!existing) {
      return errorResponse('Integration not found', 404);
    }

    await authDO.deleteOrgIntegration(orgId, integrationId);

    // TODO: Re-enable container restart when integrations change
    // authDO.restartOrgContainers(orgId).catch((e) => {
    //   console.error('Failed to restart containers after integration delete:', e);
    // });

    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Error deleting integration:', error);
    return errorResponse('Failed to delete integration', 500);
  }
}
