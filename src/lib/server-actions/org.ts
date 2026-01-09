'use server';

import * as authDO from '@/lib/auth-do';
import { isValidEmail } from '@/lib/auth';
import {
  getIntegrationDefinition,
  validateConfig,
  validateCredentials,
} from '@/lib/integration-registry';
import type { CreateApiTokenInput, Integration, Organization, OrgRole } from '@/types';
import { deleteSessionCookie } from '@/lib/auth';
import { getSessionContext } from '@/lib/auth-context';
import { requireOrgAdmin, requireOrgMember, requireSession } from '@/lib/server-guards';

async function resolveWorkspaceId(
  session: { user_id: string; workspace_id?: string | null },
  orgId: string
): Promise<string> {
  const workspaces = await authDO.listUserWorkspaces(session.user_id, orgId);
  const memberships = await authDO.getUserOrgs(session.user_id);
  const preferredWorkspaceId = memberships.find((entry) => entry.org_id === orgId)?.last_workspace_id ?? null;
  const current = session.workspace_id
    ? workspaces.find((workspace) => workspace.id === session.workspace_id)
    : null;
  const preferred = workspaces.find((workspace) => workspace.id === preferredWorkspaceId);
  const workspaceId = current?.id ?? preferred?.id ?? workspaces[0]?.id;
  if (!workspaceId) {
    throw new Error('No workspace available for this organization');
  }
  return workspaceId;
}

function toSafeOrg(org: Organization): Organization {
  return {
    id: org.id,
    name: org.name,
    created_at: org.created_at,
    created_by: org.created_by,
    billing_status: org.billing_status,
    archived: org.archived,
    archived_at: org.archived_at,
  };
}

function toSafeIntegration(integration: Integration): Integration {
  return {
    ...integration,
    config: integration.config ? JSON.parse(JSON.stringify(integration.config)) : {},
  };
}

export async function createOrg(name: string) {
  const session = await requireSession();
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Organization name is required');
  }
  if (name.length > 100) {
    throw new Error('Organization name must be 100 characters or less');
  }
  const org = await authDO.createOrg(name.trim(), session.user_id);
  return toSafeOrg(org);
}

export async function updateOrgName(orgId: string, name: string) {
  const session = await requireOrgAdmin(orgId, 'Only admins can update the organization');
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Invalid organization name');
  }
  if (name.length > 100) {
    throw new Error('Organization name must be 100 characters or less');
  }
  await authDO.updateOrgName(orgId, name.trim(), session.user_id);
  const org = await authDO.getOrg(orgId);
  if (!org) {
    throw new Error('Organization not found');
  }
  return toSafeOrg(org);
}

export async function updateOrgMemberRole(
  orgId: string,
  userId: string,
  role: OrgRole
) {
  const session = await requireOrgAdmin(orgId, 'Only admins can update member roles');

  if (!userId || typeof userId !== 'string') {
    throw new Error('User ID is required');
  }
  if (!['admin', 'member', 'viewer'].includes(role)) {
    throw new Error('Role must be "admin", "member", or "viewer"');
  }

  if (userId === session.user_id) {
    throw new Error('You cannot change your own role');
  }

  const isMember = await authDO.isOrgMember(userId, orgId);
  if (!isMember) {
    throw new Error('User is not a member of this organization');
  }

  const members = await authDO.getOrgMembers(orgId);
  const targetMember = members.find((member) => member.user.id === userId);
  if (targetMember?.role === 'owner') {
    throw new Error('Cannot change the owner role. Transfer ownership first.');
  }

  if (role !== 'admin') {
    const admins = members.filter((member) => member.role === 'admin' || member.role === 'owner');
    const isTargetCurrentlyAdmin = admins.some((member) => member.user.id === userId);
    if (isTargetCurrentlyAdmin && admins.length === 1) {
      throw new Error('Cannot demote the last admin or owner. Promote another member to admin first.');
    }
  }

  await authDO.updateOrgMemberRole(orgId, userId, role, session.user_id);
  return { success: true };
}

export async function removeOrgMember(orgId: string, userId: string) {
  const session = await requireSession();

  if (!userId) {
    throw new Error('User ID is required');
  }

  const isMember = await authDO.isOrgMember(userId, orgId);
  if (!isMember) {
    throw new Error('User is not a member of this organization');
  }

  const members = await authDO.getOrgMembers(orgId);
  if (members.length === 1) {
    throw new Error('Cannot remove the last member of an organization');
  }

  const targetMember = members.find((member) => member.user.id === userId);
  if (targetMember?.role === 'owner') {
    throw new Error('Cannot remove the organization owner. Transfer ownership first.');
  }
  if (targetMember?.role === 'admin') {
    const admins = members.filter((member) => member.role === 'admin' || member.role === 'owner');
    if (admins.length === 1) {
      throw new Error('Cannot remove the last admin or owner. Promote another member to admin first.');
    }
  }

  if (userId !== session.user_id) {
    const isAdmin = await authDO.isOrgAdmin(session.user_id, orgId);
    if (!isAdmin) {
      throw new Error('Only admins can remove members');
    }
  }

  await authDO.removeOrgMember(orgId, userId, session.user_id);
  return { success: true };
}

export async function createInvitation(
  orgId: string,
  email: string,
  role: OrgRole = 'member'
) {
  const session = await requireOrgAdmin(orgId, 'Only admins can invite members');

  if (!email || !isValidEmail(email)) {
    throw new Error('Valid email is required');
  }
  if (!['admin', 'member', 'viewer'].includes(role)) {
    throw new Error('Role must be "admin", "member", or "viewer"');
  }

  const existingUser = await authDO.getUserByEmail(email);
  if (existingUser) {
    const isMember = await authDO.isOrgMember(existingUser.userId, orgId);
    if (isMember) {
      throw new Error('User is already a member of this organization');
    }
  }

  const invitation = await authDO.createInvitation(orgId, email, role, session.user_id);
  return {
    id: invitation.id,
    email,
    role,
    expires_at: invitation.expires_at,
  };
}

export async function deleteInvitation(orgId: string, invitationId: string) {
  await requireOrgAdmin(orgId, 'Only admins can delete invitations');
  if (!invitationId) {
    throw new Error('Invitation ID is required');
  }
  await authDO.deleteInvitation(orgId, invitationId);
  return { success: true };
}

export async function createIntegration(
  orgId: string,
  input: {
    integration_type: string;
    name: string;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
  }
) {
  const session = await requireOrgAdmin(orgId, 'Only admins can create integrations');
  const workspaceId = await resolveWorkspaceId(session, orgId);

  const { integration_type, name, config, credentials } = input;
  const definition = getIntegrationDefinition(integration_type);
  if (!definition) {
    throw new Error(`Unknown integration type: ${integration_type}`);
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Integration name is required');
  }
  if (name.length > 100) {
    throw new Error('Integration name must be 100 characters or less');
  }

  const configErrors = validateConfig(integration_type, config || {});
  if (configErrors.length > 0) {
    throw new Error(configErrors.join(', '));
  }

  const credentialErrors = validateCredentials(integration_type, credentials || {});
  if (credentialErrors.length > 0) {
    throw new Error(credentialErrors.join(', '));
  }

  const created = await authDO.createWorkspaceIntegration(workspaceId, session.user_id, {
    integration_type,
    name: name.trim(),
    config: config || {},
    credentials: credentials || {},
  });
  return toSafeIntegration(created);
}

export async function updateIntegration(
  orgId: string,
  integrationId: string,
  input: {
    name?: string;
    config?: Record<string, unknown>;
    credentials?: Record<string, unknown>;
    enabled?: boolean;
  }
) {
  const session = await requireOrgAdmin(orgId, 'Only admins can update integrations');
  const workspaceId = await resolveWorkspaceId(session, orgId);
  const existing = await authDO.getWorkspaceIntegration(workspaceId, integrationId);
  if (!existing) {
    throw new Error('Integration not found');
  }

  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new Error('Integration name cannot be empty');
    }
    if (input.name.length > 100) {
      throw new Error('Integration name must be 100 characters or less');
    }
  }

  if (input.config !== undefined) {
    const configErrors = validateConfig(existing.integration_type, input.config);
    if (configErrors.length > 0) {
      throw new Error(configErrors.join(', '));
    }
  }

  if (input.credentials !== undefined) {
    const credentialErrors = validateCredentials(existing.integration_type, input.credentials);
    if (credentialErrors.length > 0) {
      throw new Error(credentialErrors.join(', '));
    }
  }

  const updated = await authDO.updateWorkspaceIntegration(workspaceId, integrationId, session.user_id, {
    name: input.name?.trim(),
    config: input.config,
    credentials: input.credentials,
    enabled: input.enabled,
  });
  if (!updated) {
    throw new Error('Failed to update integration');
  }
  return toSafeIntegration(updated);
}

export async function deleteIntegration(orgId: string, integrationId: string) {
  const session = await requireOrgAdmin(orgId, 'Only admins can delete integrations');
  const workspaceId = await resolveWorkspaceId(session, orgId);
  const existing = await authDO.getWorkspaceIntegration(workspaceId, integrationId);
  if (!existing) {
    throw new Error('Integration not found');
  }
  await authDO.deleteWorkspaceIntegration(workspaceId, integrationId, session.user_id);
  return { success: true };
}

export async function createApiToken(orgId: string, input: CreateApiTokenInput) {
  const session = await requireOrgAdmin(orgId, 'Only admins can create API tokens');
  const workspaceId = await resolveWorkspaceId(session, orgId);

  if (!input.name || input.name.trim().length === 0) {
    throw new Error('Token name is required');
  }

  if (input.integration_id) {
    const integration = await authDO.getWorkspaceIntegration(workspaceId, input.integration_id);
    if (!integration) {
      throw new Error('Integration not found');
    }
  }

  const result = await authDO.createOrgApiToken(orgId, session.user_id, {
    name: input.name.trim(),
    integration_id: input.integration_id,
    scopes: input.scopes,
    expires_in_days: input.expires_in_days,
  });

  return {
    token: result.tokenId,
    name: result.tokenData.name,
    integration_id: result.tokenData.integration_id,
    scopes: result.tokenData.scopes,
    expires_at: result.tokenData.expires_at,
    warning: 'Save this token now. It will not be shown again.',
  };
}

export async function deleteApiToken(orgId: string, tokenId: string) {
  await requireOrgAdmin(orgId, 'Only admins can revoke API tokens');
  await authDO.deleteApiToken(tokenId);
  return { success: true };
}

export async function getOrgIntegrations(orgId: string) {
  const session = await requireOrgMember(orgId);
  const workspaceId = await resolveWorkspaceId(session, orgId);
  const integrations = await authDO.getWorkspaceIntegrations(workspaceId);
  return integrations.map(toSafeIntegration);
}

export async function transferOrgOwnership(orgId: string, newOwnerId: string) {
  const session = await requireSession();
  if (!newOwnerId) {
    throw new Error('New owner ID is required');
  }

  if (session.org_id !== orgId) {
    throw new Error('Organization mismatch');
  }

  const members = await authDO.getOrgMembers(orgId);
  const self = members.find((member) => member.user.id === session.user_id);
  if (self?.role !== 'owner') {
    throw new Error('Only the organization owner can transfer ownership');
  }

  const targetMember = members.find((member) => member.user.id === newOwnerId);
  if (!targetMember) {
    throw new Error('User is not a member of this organization');
  }

  await authDO.transferOrgOwnership(orgId, newOwnerId, session.user_id);
  return { success: true };
}

export async function archiveOrg(orgId: string) {
  const sessionContext = await getSessionContext();
  if (!sessionContext) {
    throw new Error('Not logged in');
  }
  const { session, sessionId } = sessionContext;
  if (session.org_id !== orgId) {
    throw new Error('Organization mismatch');
  }

  const members = await authDO.getOrgMembers(orgId);
  const self = members.find((member) => member.user.id === session.user_id);
  if (self?.role !== 'owner') {
    throw new Error('Only the organization owner can delete the organization');
  }

  await authDO.archiveOrg(orgId, session.user_id);
  await authDO.destroySession(sessionId);
  await deleteSessionCookie();
  return { success: true };
}
