/**
 * Cross-DO consistency tests using Cloudflare Vitest pool
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createUser,
  getUserById,
  getUserOrgs,
  createOrg,
  getOrg,
  updateOrgName,
  getOrgMembers,
  createInvitation,
  acceptInvitation,
  removeOrgMember,
  updateOrgMemberRole,
  checkUserOrphaned,
  handleOrphanedUserLogin,
  adminTransferOrgOwnership,
  transferOrgOwnership,
  archiveOrg,
  createWorkspace,
  archiveWorkspace,
  listOrgWorkspaces,
  listUserWorkspacesAcrossOrgs,
  isOrgMember,
  getOrgAuditLog,
  type TestEnv,
} from './test-helpers';

const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe('cross-DO consistency', () => {
  const testEnv = env as unknown as TestEnv;

  it('addMember updates both OrgDO and UserDO', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Member Sync Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    const members = await getOrgMembers(testEnv, org.id);
    expect(members.some((entry) => entry.user.id === memberId && entry.role === 'member')).toBe(true);

    const userOrgs = await getUserOrgs(testEnv, memberId);
    expect(userOrgs.some((entry) => entry.org_id === org.id && entry.role === 'member')).toBe(true);
  });

  it('removeMember updates both OrgDO and UserDO', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Remove Sync Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    await removeOrgMember(testEnv, org.id, memberId, ownerId);

    const members = await getOrgMembers(testEnv, org.id);
    expect(members.some((entry) => entry.user.id === memberId)).toBe(false);

    const userOrgs = await getUserOrgs(testEnv, memberId);
    expect(userOrgs.some((entry) => entry.org_id === org.id)).toBe(false);
  });

  it('role change updates both OrgDO and UserDO', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Role Sync Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    await updateOrgMemberRole(testEnv, org.id, memberId, 'admin', ownerId);

    const members = await getOrgMembers(testEnv, org.id);
    expect(members.some((entry) => entry.user.id === memberId && entry.role === 'admin')).toBe(true);

    const userOrgs = await getUserOrgs(testEnv, memberId);
    expect(userOrgs.some((entry) => entry.org_id === org.id && entry.role === 'admin')).toBe(true);
  });

  it('createWorkspace adds to OrgDO.workspaces', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { org } = await createOrg(testEnv, 'Workspace Registry Org', ownerId);

    const workspace = await createWorkspace(testEnv, org.id, 'Design', ownerId, 'Design workspace');
    const workspaces = await listOrgWorkspaces(testEnv, org.id);
    expect(workspaces.some((entry) => entry.id === workspace.id)).toBe(true);
  });

  it('archiveWorkspace updates OrgDO.workspaces', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { org } = await createOrg(testEnv, 'Archive Registry Org', ownerId);

    const workspace = await createWorkspace(testEnv, org.id, 'Archive Me', ownerId);
    await archiveWorkspace(testEnv, workspace.id, ownerId);

    const workspaces = await listOrgWorkspaces(testEnv, org.id);
    expect(workspaces.some((entry) => entry.id === workspace.id)).toBe(false);
  });

  it('removeMember sets is_orphaned when no orgs remain', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Orphan Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    await removeOrgMember(testEnv, org.id, memberId, ownerId);

    const profile = await getUserById(testEnv, memberId);
    expect(profile?.is_orphaned).toBe(true);
  });

  it('acceptInvitation clears is_orphaned', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Invite Org', ownerId);

    await checkUserOrphaned(testEnv, memberId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    const profile = await getUserById(testEnv, memberId);
    expect(profile?.is_orphaned).toBe(false);
  });

  it('handleOrphanedUserLogin creates org and workspace', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Orphan');
    await checkUserOrphaned(testEnv, userId);

    const result = await handleOrphanedUserLogin(testEnv, userId);
    expect(result).not.toBeNull();
    expect(result?.org.id).toBeDefined();
    expect(result?.workspace.id).toBeDefined();

    const orgs = await getUserOrgs(testEnv, userId);
    expect(orgs.length).toBeGreaterThan(0);

    const profile = await getUserById(testEnv, userId);
    expect(profile?.is_orphaned).toBe(false);
  });

  it('transferOwnership updates roles in both DOs', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Ownership Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    await transferOrgOwnership(testEnv, org.id, memberId, ownerId);

    const members = await getOrgMembers(testEnv, org.id);
    const newOwner = members.find((entry) => entry.user.id === memberId);
    const oldOwner = members.find((entry) => entry.user.id === ownerId);
    expect(newOwner?.role).toBe('owner');
    expect(oldOwner?.role).toBe('admin');

    const newOwnerOrgs = await getUserOrgs(testEnv, memberId);
    const oldOwnerOrgs = await getUserOrgs(testEnv, ownerId);
    expect(newOwnerOrgs.find((entry) => entry.org_id === org.id)?.role).toBe('owner');
    expect(oldOwnerOrgs.find((entry) => entry.org_id === org.id)?.role).toBe('admin');
  });

  it('adminTransferOwnership no-ops when target is already the owner', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Admin Transfer Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    await adminTransferOrgOwnership(testEnv, org.id, ownerId, 'system-admin');

    const members = await getOrgMembers(testEnv, org.id);
    const ownerMember = members.find((entry) => entry.user.id === ownerId);
    const otherMember = members.find((entry) => entry.user.id === memberId);
    expect(ownerMember?.role).toBe('owner');
    expect(otherMember?.role).toBe('member');

    const ownerOrgs = await getUserOrgs(testEnv, ownerId);
    const memberOrgs = await getUserOrgs(testEnv, memberId);
    expect(ownerOrgs.find((entry) => entry.org_id === org.id)?.role).toBe('owner');
    expect(memberOrgs.find((entry) => entry.org_id === org.id)?.role).toBe('member');
  });

  it('archiveOrg archives workspaces and removes memberships', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Archive Org', ownerId);

    await createWorkspace(testEnv, org.id, 'Extra Workspace', ownerId);
    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    await archiveOrg(testEnv, org.id, ownerId);

    const archived = await getOrg(testEnv, org.id);
    expect(archived?.archived).toBe(true);

    const workspaces = await listOrgWorkspaces(testEnv, org.id);
    expect(workspaces).toHaveLength(0);

    const ownerOrgs = await getUserOrgs(testEnv, ownerId);
    const memberOrgs = await getUserOrgs(testEnv, memberId);
    expect(ownerOrgs.some((entry) => entry.org_id === org.id)).toBe(false);
    expect(memberOrgs.some((entry) => entry.org_id === org.id)).toBe(false);

    const ownerProfile = await getUserById(testEnv, ownerId);
    const memberProfile = await getUserById(testEnv, memberId);
    expect(ownerProfile?.is_orphaned).toBe(true);
    expect(memberProfile?.is_orphaned).toBe(true);

    const orgMembers = await getOrgMembers(testEnv, org.id);
    expect(orgMembers.some((entry) => entry.user.id === ownerId && entry.role === 'owner')).toBe(true);
    expect(orgMembers.some((entry) => entry.user.id === memberId)).toBe(false);

    expect(await isOrgMember(testEnv, ownerId, org.id)).toBe(false);
    expect(await isOrgMember(testEnv, memberId, org.id)).toBe(false);
  });

  it('logs org audit events for membership changes', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Audit Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);
    await updateOrgMemberRole(testEnv, org.id, memberId, 'admin', ownerId);
    await removeOrgMember(testEnv, org.id, memberId, ownerId);

    const audit = await getOrgAuditLog(testEnv, org.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('org_created');
    expect(actions).toContain('member_added');
    expect(actions).toContain('member_role_changed');
    expect(actions).toContain('member_removed');
  });

  it('logs org update and workspace creation events', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { org } = await createOrg(testEnv, 'Audit Updates Org', ownerId);

    await updateOrgName(testEnv, org.id, 'Audit Updates Org Renamed', ownerId);
    const workspace = await createWorkspace(testEnv, org.id, 'New Workspace', ownerId);

    const audit = await getOrgAuditLog(testEnv, org.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('org_updated');
    expect(actions).toContain('workspace_created');

    const workspaceEntry = audit.find((entry) => entry.action === 'workspace_created');
    expect(workspaceEntry?.target_id).toBe(workspace.id);
    const details = workspaceEntry?.details as { name?: string } | undefined;
    expect(details?.name).toBe('New Workspace');
  });

  it('logs ownership transfer and org archival events', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Ownership Log Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    await transferOrgOwnership(testEnv, org.id, memberId, ownerId);
    await archiveOrg(testEnv, org.id, memberId);

    const audit = await getOrgAuditLog(testEnv, org.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('ownership_transferred');
    expect(actions).toContain('org_archived');

    const transferEntry = audit.find((entry) => entry.action === 'ownership_transferred');
    expect(transferEntry?.target_id).toBe(memberId);
    const details = transferEntry?.details as { from_user_id?: string } | undefined;
    expect(details?.from_user_id).toBe(ownerId);
  });

  it('listUserWorkspacesAcrossOrgs returns workspaces from all user orgs', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Multi-Org User');

    // Create two orgs with workspaces
    const { org: org1, defaultWorkspaceId: ws1Id } = await createOrg(testEnv, 'Org One', userId);
    const { org: org2, defaultWorkspaceId: ws2Id } = await createOrg(testEnv, 'Org Two', userId);

    // Create additional workspace in org1
    const extraWorkspace = await createWorkspace(testEnv, org1.id, 'Extra Workspace', userId);

    // List all workspaces across orgs
    const allWorkspaces = await listUserWorkspacesAcrossOrgs(testEnv, userId);

    // Should have 3 workspaces total (2 defaults + 1 extra)
    expect(allWorkspaces.length).toBe(3);

    // Should include workspaces from both orgs
    const org1Workspaces = allWorkspaces.filter((ws) => ws.org_id === org1.id);
    const org2Workspaces = allWorkspaces.filter((ws) => ws.org_id === org2.id);

    expect(org1Workspaces.length).toBe(2); // default + extra
    expect(org2Workspaces.length).toBe(1); // default only

    // Verify specific workspace IDs
    expect(allWorkspaces.some((ws) => ws.id === ws1Id)).toBe(true);
    expect(allWorkspaces.some((ws) => ws.id === ws2Id)).toBe(true);
    expect(allWorkspaces.some((ws) => ws.id === extraWorkspace.id)).toBe(true);
  });

  it('createOrg returns defaultWorkspaceId that is different from org.id', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Workspace ID User');

    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Test Org', userId);

    // The bug was using org.id as workspace ID - they must be different UUIDs
    expect(defaultWorkspaceId).toBeDefined();
    expect(defaultWorkspaceId).not.toBe(org.id);

    // Verify the workspace actually exists
    const workspaces = await listOrgWorkspaces(testEnv, org.id);
    expect(workspaces.some((ws) => ws.id === defaultWorkspaceId)).toBe(true);
  });
});
