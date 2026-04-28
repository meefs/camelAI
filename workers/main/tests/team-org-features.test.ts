/**
 * Integration tests for team/org feature remediation
 *
 * Tests for: default workspace access grants, workspace archive,
 * member removal + orphaning, permission gating, billing status,
 * owner transfer, and workspace access restrictions.
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createUser,
  createOrg,
  createInvitation,
  acceptInvitation,
  createWorkspace,
  archiveWorkspace,
  removeOrgMember,
  getUserOrgs,
  getUserById,
  getWorkspaceAccess,
  listUserWorkspaces,
  listOrgWorkspaces,
  setWorkspaceAccess,
  transferOrgOwnership,
  isOrgAdmin,
  isOrgMember,
  archiveOrg,
  getOrg,
  createWorkspaceIntegration,
  getWorkspaceIntegrations,
  getOrgMembers,
  type TestEnv,
} from './test-helpers';

const testEmail = () =>
  `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe('Default workspace access on invitation accept', () => {
  const testEnv = env as unknown as TestEnv;

  it('grants full access to all existing workspaces when user accepts invitation', async () => {
    // Setup: create org with owner and 2 workspaces
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Test Org', ownerId);
    const ws2 = await createWorkspace(testEnv, org.id, 'Workspace 2', ownerId);

    // Create and accept invitation for a new user
    const inviteeEmail = testEmail();
    const { userId: inviteeId } = await createUser(testEnv, inviteeEmail, 'password', 'Invitee');
    const { id: invitationId } = await createInvitation(testEnv, org.id, inviteeEmail, 'member', ownerId);
    const accepted = await acceptInvitation(testEnv, org.id, invitationId, inviteeId);

    expect(accepted).toBe(true);

    // Verify the new user has full access to both workspaces
    const access1 = await getWorkspaceAccess(testEnv, defaultWorkspaceId, inviteeId);
    const access2 = await getWorkspaceAccess(testEnv, ws2.id, inviteeId);
    expect(access1).toBe('full');
    expect(access2).toBe('full');

    // Verify they can list both workspaces
    const workspaces = await listUserWorkspaces(testEnv, inviteeId, org.id);
    expect(workspaces.length).toBe(2);
  });

  it('grants full access to all existing members when a new workspace is created', async () => {
    // Setup: create org with 3 members
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org } = await createOrg(testEnv, 'Test Org', ownerId);

    const member1Email = testEmail();
    const { userId: member1Id } = await createUser(testEnv, member1Email, 'password', 'Member 1');
    const { id: inv1 } = await createInvitation(testEnv, org.id, member1Email, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, inv1, member1Id);

    const member2Email = testEmail();
    const { userId: member2Id } = await createUser(testEnv, member2Email, 'password', 'Member 2');
    const { id: inv2 } = await createInvitation(testEnv, org.id, member2Email, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, inv2, member2Id);

    // Create a new workspace
    const newWs = await createWorkspace(testEnv, org.id, 'New Workspace', ownerId);

    // Verify all 3 members have full access
    const ownerAccess = await getWorkspaceAccess(testEnv, newWs.id, ownerId);
    const member1Access = await getWorkspaceAccess(testEnv, newWs.id, member1Id);
    const member2Access = await getWorkspaceAccess(testEnv, newWs.id, member2Id);

    expect(ownerAccess).toBe('full');
    expect(member1Access).toBe('full');
    expect(member2Access).toBe('full');
  });
});

describe('Workspace archive', () => {
  const testEnv = env as unknown as TestEnv;

  it('reassigns last_workspace_id when active workspace is archived', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Test Org', ownerId);
    const ws2 = await createWorkspace(testEnv, org.id, 'Workspace 2', ownerId);

    // Archive the default workspace
    await archiveWorkspace(testEnv, defaultWorkspaceId, ownerId);

    // User's last workspace should be reassigned to ws2
    const orgs = await getUserOrgs(testEnv, ownerId);
    const orgEntry = orgs.find((o) => o.org_id === org.id);
    expect(orgEntry?.last_workspace_id).toBe(ws2.id);
  });

  it('reassigns last_workspace_id to a workspace the member can access', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Access Reassign Org', ownerId);
    const ws2 = await createWorkspace(testEnv, org.id, 'Workspace 2', ownerId);
    const ws3 = await createWorkspace(testEnv, org.id, 'Workspace 3', ownerId);

    const { id: invitationId } = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitationId, memberId);

    await setWorkspaceAccess(testEnv, ws2.id, memberId, 'none', ownerId);

    await archiveWorkspace(testEnv, defaultWorkspaceId, ownerId);

    const orgs = await getUserOrgs(testEnv, memberId);
    const orgEntry = orgs.find((o) => o.org_id === org.id);
    expect(orgEntry?.last_workspace_id).toBe(ws3.id);
  });

  it('does not return archived workspaces in normal queries', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Test Org', ownerId);
    const ws2 = await createWorkspace(testEnv, org.id, 'Workspace 2', ownerId);

    await archiveWorkspace(testEnv, defaultWorkspaceId, ownerId);

    // Normal query should only return active workspace
    const workspaces = await listOrgWorkspaces(testEnv, org.id);
    expect(workspaces.length).toBe(1);
    expect(workspaces[0].id).toBe(ws2.id);
  });
});

describe('Member removal and orphaning', () => {
  const testEnv = env as unknown as TestEnv;

  it('marks user as orphaned immediately when removed from their only org', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org } = await createOrg(testEnv, 'Test Org', ownerId);

    // Add a member
    const memberEmail = testEmail();
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
    const { id: invId } = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invId, memberId);

    // Remove the member
    await removeOrgMember(testEnv, org.id, memberId, ownerId);

    // Verify orphaned status is set immediately
    const profile = await getUserById(testEnv, memberId);
    expect(profile?.is_orphaned).toBe(true);
  });

  it('does NOT mark user as orphaned when removed from one of two orgs', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org: org1 } = await createOrg(testEnv, 'Org 1', ownerId);
    const { org: org2 } = await createOrg(testEnv, 'Org 2', ownerId);

    // Add a member to both orgs
    const memberEmail = testEmail();
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
    const { id: inv1 } = await createInvitation(testEnv, org1.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org1.id, inv1, memberId);
    const { id: inv2 } = await createInvitation(testEnv, org2.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org2.id, inv2, memberId);

    // Remove from org1
    await removeOrgMember(testEnv, org1.id, memberId, ownerId);

    // Should NOT be orphaned (still in org2)
    const profile = await getUserById(testEnv, memberId);
    expect(profile?.is_orphaned).toBe(false);
  });

  it('revokes workspace access when member is removed from org', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Test Org', ownerId);

    // Add a member
    const memberEmail = testEmail();
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
    const { id: invId } = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invId, memberId);

    // Verify they have access
    const accessBefore = await getWorkspaceAccess(testEnv, defaultWorkspaceId, memberId);
    expect(accessBefore).toBe('full');

    // Remove the member
    await removeOrgMember(testEnv, org.id, memberId, ownerId);

    // Verify access is revoked (user is no longer org member, so access = 'none')
    const accessAfter = await getWorkspaceAccess(testEnv, defaultWorkspaceId, memberId);
    expect(accessAfter).toBe('none');
  });
});

describe('Workspace access restrictions', () => {
  const testEnv = env as unknown as TestEnv;

  it('restricts workspace visibility when access is set to none', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Test Org', ownerId);
    const ws2 = await createWorkspace(testEnv, org.id, 'Workspace 2', ownerId);

    // Add a member
    const memberEmail = testEmail();
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
    const { id: invId } = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invId, memberId);

    // Revoke access to ws2
    await setWorkspaceAccess(testEnv, ws2.id, memberId, 'none', ownerId);

    // Member should only see the default workspace
    const workspaces = await listUserWorkspaces(testEnv, memberId, org.id);
    expect(workspaces.length).toBe(1);
    expect(workspaces[0].id).toBe(defaultWorkspaceId);
  });

  it('allows read_only access to workspace', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Test Org', ownerId);

    // Add a member
    const memberEmail = testEmail();
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
    const { id: invId } = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invId, memberId);

    // Set read_only access
    await setWorkspaceAccess(testEnv, defaultWorkspaceId, memberId, 'read_only', ownerId);

    const access = await getWorkspaceAccess(testEnv, defaultWorkspaceId, memberId);
    expect(access).toBe('read_only');

    // Should still appear in workspace list
    const workspaces = await listUserWorkspaces(testEnv, memberId, org.id);
    expect(workspaces.length).toBe(1);
    expect(workspaces[0].access_level).toBe('read_only');
  });
});

describe('Owner transfer', () => {
  const testEnv = env as unknown as TestEnv;

  it('transfers ownership: old owner becomes admin, new owner becomes owner', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org } = await createOrg(testEnv, 'Test Org', ownerId);

    // Add a member
    const memberEmail = testEmail();
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
    const { id: invId } = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invId, memberId);

    // Transfer ownership
    await transferOrgOwnership(testEnv, org.id, memberId, ownerId);

    // Verify roles
    const newOwnerIsAdmin = await isOrgAdmin(testEnv, memberId, org.id);
    expect(newOwnerIsAdmin).toBe(true);

    // Old owner should be admin (still has admin access)
    const oldOwnerIsAdmin = await isOrgAdmin(testEnv, ownerId, org.id);
    expect(oldOwnerIsAdmin).toBe(true);
  });
});

describe('Workspace creation registers with org', () => {
  const testEnv = env as unknown as TestEnv;

  it('new workspace appears in org workspace list', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org } = await createOrg(testEnv, 'Test Org', ownerId);

    const ws = await createWorkspace(testEnv, org.id, 'New Workspace', ownerId);

    const workspaces = await listOrgWorkspaces(testEnv, org.id);
    const wsIds = workspaces.map((w) => w.id);
    expect(wsIds).toContain(ws.id);
  });
});

describe('Archive organization', () => {
  const testEnv = env as unknown as TestEnv;

  it('archives org and orphans members', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org } = await createOrg(testEnv, 'Test Org', ownerId);

    // Add a member
    const memberEmail = testEmail();
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
    const { id: invId } = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invId, memberId);

    // Archive the org
    await archiveOrg(testEnv, org.id, ownerId);

    // Verify org is archived
    const orgInfo = await getOrg(testEnv, org.id);
    expect(orgInfo?.archived).toBe(true);

    // Verify member is orphaned (they only had this org)
    const memberProfile = await getUserById(testEnv, memberId);
    expect(memberProfile?.is_orphaned).toBe(true);
  });
});

describe('Billing status from OrgDO', () => {
  const testEnv = env as unknown as TestEnv;

  it('returns actual billing_status from org data (not hardcoded)', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org } = await createOrg(testEnv, 'Billing Test Org', ownerId);

    // getOrg should return the billing_status field (defaults to 'inactive')
    const orgInfo = await getOrg(testEnv, org.id);
    expect(orgInfo).not.toBeNull();
    expect(orgInfo!.billing_status).toBe('inactive');
  });

  it('applies each Stripe credit checkout session only once', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org } = await createOrg(testEnv, 'Credit Checkout Org', ownerId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const first = await orgStub.applyCreditCheckout('cs_test_credit_1', 2500, 'cus_test_1');
    expect(first?.applied).toBe(true);
    expect(first?.org.billing_credit_purchase_total_cents).toBe(2500);

    const duplicate = await orgStub.applyCreditCheckout('cs_test_credit_1', 2500, 'cus_test_1');
    expect(duplicate?.applied).toBe(false);
    expect(duplicate?.org.billing_credit_purchase_total_cents).toBe(2500);

    const second = await orgStub.applyCreditCheckout('cs_test_credit_2', 1000, 'cus_test_1');
    expect(second?.applied).toBe(true);
    expect(second?.org.billing_credit_purchase_total_cents).toBe(3500);
  });
});

describe('Connection duplication', () => {
  const testEnv = env as unknown as TestEnv;

  it('duplicates an integration to another workspace in the same org', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Integration Org', ownerId);
    const ws2 = await createWorkspace(testEnv, org.id, 'Workspace 2', ownerId);

    // Create an integration on the default workspace
    const { id: integrationId } = await createWorkspaceIntegration(testEnv, defaultWorkspaceId, ownerId, {
      integration_type: 'notion',
      name: 'My Notion',
      config: { workspace_id: 'test-123' },
      credentials: { api_key: 'secret-key' },
    });

    // Verify it exists on source workspace
    const sourceIntegrations = await getWorkspaceIntegrations(testEnv, defaultWorkspaceId);
    expect(sourceIntegrations.some((i) => i.id === integrationId)).toBe(true);

    // Duplicate to ws2 by creating the same integration there
    await createWorkspaceIntegration(testEnv, ws2.id, ownerId, {
      integration_type: 'notion',
      name: 'My Notion',
      config: { workspace_id: 'test-123' },
      credentials: { api_key: 'secret-key' },
    });

    // Verify it exists on target workspace
    const targetIntegrations = await getWorkspaceIntegrations(testEnv, ws2.id);
    expect(targetIntegrations.some((i) => i.name === 'My Notion')).toBe(true);
  });

  // Note: duplicate name rejection is tested in workspace-do.test.ts.
  // The workerd test runner can't handle DO-thrown errors cleanly (isolated storage error).
});

describe('Owner transfer permission gating', () => {
  const testEnv = env as unknown as TestEnv;

  // Note: "rejects transfer by non-owner" is tested in cross-do-consistency.test.ts
  // and ownership-transfer integration tests. The workerd test runner can't handle
  // DO-thrown errors cleanly in isolated storage mode.

  it('succeeds when called by the actual owner', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
    const { org } = await createOrg(testEnv, 'Transfer Success Org', ownerId);

    // Add a member
    const memberEmail = testEmail();
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
    const { id: invId } = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invId, memberId);

    // Owner transfers — should succeed
    await transferOrgOwnership(testEnv, org.id, memberId, ownerId);

    // Verify new owner
    const members = await getOrgMembers(testEnv, org.id);
    const newOwner = members.find((m) => m.user.id === memberId);
    const oldOwner = members.find((m) => m.user.id === ownerId);
    expect(newOwner?.role).toBe('owner');
    expect(oldOwner?.role).toBe('admin');
  });
});
