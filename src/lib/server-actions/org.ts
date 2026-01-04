'use server';

import * as authDO from '@/lib/auth-do';
import { isValidEmail } from '@/lib/auth';
import {
  getIntegrationDefinition,
  validateConfig,
  validateCredentials,
} from '@/lib/integration-registry';
import type { CreateApiTokenInput } from '@/types';
import { requireOrgAdmin, requireOrgMember, requireSession } from '@/lib/server-guards';

export async function createOrg(name: string) {
  const session = await requireSession();
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Organization name is required');
  }
  if (name.length > 100) {
    throw new Error('Organization name must be 100 characters or less');
  }
  return authDO.createOrg(name.trim(), session.user_id);
}

export async function updateOrgName(orgId: string, name: string) {
  await requireOrgAdmin(orgId, 'Only admins can update the organization');
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Invalid organization name');
  }
  if (name.length > 100) {
    throw new Error('Organization name must be 100 characters or less');
  }
  await authDO.updateOrgName(orgId, name.trim());
  const org = await authDO.getOrg(orgId);
  if (!org) {
    throw new Error('Organization not found');
  }
  return org;
}

export async function updateOrgMemberRole(
  orgId: string,
  userId: string,
  role: 'admin' | 'member'
) {
  const session = await requireOrgAdmin(orgId, 'Only admins can update member roles');

  if (!userId || typeof userId !== 'string') {
    throw new Error('User ID is required');
  }
  if (role !== 'admin' && role !== 'member') {
    throw new Error('Role must be "admin" or "member"');
  }

  if (userId === session.user_id) {
    throw new Error('You cannot change your own role');
  }

  const isMember = await authDO.isOrgMember(userId, orgId);
  if (!isMember) {
    throw new Error('User is not a member of this organization');
  }

  if (role === 'member') {
    const members = await authDO.getOrgMembers(orgId);
    const admins = members.filter((member) => member.role === 'admin');
    const isTargetCurrentlyAdmin = admins.some((member) => member.user.id === userId);
    if (isTargetCurrentlyAdmin && admins.length === 1) {
      throw new Error('Cannot demote the last admin. Promote another member to admin first.');
    }
  }

  await authDO.updateOrgMemberRole(orgId, userId, role);
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
  if (targetMember?.role === 'admin') {
    const admins = members.filter((member) => member.role === 'admin');
    if (admins.length === 1) {
      throw new Error('Cannot remove the last admin. Promote another member to admin first.');
    }
  }

  if (userId !== session.user_id) {
    const isAdmin = await authDO.isOrgAdmin(session.user_id, orgId);
    if (!isAdmin) {
      throw new Error('Only admins can remove members');
    }
  }

  await authDO.removeOrgMember(orgId, userId);
  return { success: true };
}

export async function createInvitation(
  orgId: string,
  email: string,
  role: 'admin' | 'member' = 'member'
) {
  const session = await requireOrgAdmin(orgId, 'Only admins can invite members');

  if (!email || !isValidEmail(email)) {
    throw new Error('Valid email is required');
  }
  if (role !== 'admin' && role !== 'member') {
    throw new Error('Role must be "admin" or "member"');
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

  return authDO.createOrgIntegration(orgId, session.user_id, {
    integration_type,
    name: name.trim(),
    config: config || {},
    credentials: credentials || {},
  });
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
  await requireOrgAdmin(orgId, 'Only admins can update integrations');
  const existing = await authDO.getOrgIntegration(orgId, integrationId);
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

  const updated = await authDO.updateOrgIntegration(orgId, integrationId, {
    name: input.name?.trim(),
    config: input.config,
    credentials: input.credentials,
    enabled: input.enabled,
  });
  if (!updated) {
    throw new Error('Failed to update integration');
  }
  return updated;
}

export async function deleteIntegration(orgId: string, integrationId: string) {
  await requireOrgAdmin(orgId, 'Only admins can delete integrations');
  const existing = await authDO.getOrgIntegration(orgId, integrationId);
  if (!existing) {
    throw new Error('Integration not found');
  }
  await authDO.deleteOrgIntegration(orgId, integrationId);
  return { success: true };
}

export async function createApiToken(orgId: string, input: CreateApiTokenInput) {
  const session = await requireOrgAdmin(orgId, 'Only admins can create API tokens');

  if (!input.name || input.name.trim().length === 0) {
    throw new Error('Token name is required');
  }

  if (input.integration_id) {
    const integration = await authDO.getOrgIntegration(orgId, input.integration_id);
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
  await requireOrgMember(orgId);
  return authDO.getOrgIntegrations(orgId);
}
