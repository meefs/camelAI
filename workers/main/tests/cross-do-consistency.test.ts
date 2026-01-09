/**
 * Cross-DO consistency tests using Cloudflare Vitest pool
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { DoRpcService } from '../src/rpc-service';

const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe('cross-DO consistency', () => {
  const rpc = env.DO_RPC as unknown as DoRpcService;

  it('addMember updates both OrgDO and UserDO', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await rpc.createUser(memberEmail, 'password123', 'Member');
    const org = await rpc.createOrg('Member Sync Org', ownerId);

    const invitation = await rpc.createInvitation(org.id, memberEmail, 'member', ownerId);
    await rpc.acceptInvitation(org.id, invitation.id, memberId);

    const members = await rpc.getOrgMembers(org.id);
    expect(members.some((entry) => entry.user.id === memberId && entry.role === 'member')).toBe(true);

    const userOrgs = await rpc.getUserOrgs(memberId);
    expect(userOrgs.some((entry) => entry.org_id === org.id && entry.role === 'member')).toBe(true);
  });

  it('removeMember updates both OrgDO and UserDO', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await rpc.createUser(memberEmail, 'password123', 'Member');
    const org = await rpc.createOrg('Remove Sync Org', ownerId);

    const invitation = await rpc.createInvitation(org.id, memberEmail, 'member', ownerId);
    await rpc.acceptInvitation(org.id, invitation.id, memberId);

    await rpc.removeOrgMember(org.id, memberId, ownerId);

    const members = await rpc.getOrgMembers(org.id);
    expect(members.some((entry) => entry.user.id === memberId)).toBe(false);

    const userOrgs = await rpc.getUserOrgs(memberId);
    expect(userOrgs.some((entry) => entry.org_id === org.id)).toBe(false);
  });

  it('role change updates both OrgDO and UserDO', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await rpc.createUser(memberEmail, 'password123', 'Member');
    const org = await rpc.createOrg('Role Sync Org', ownerId);

    const invitation = await rpc.createInvitation(org.id, memberEmail, 'member', ownerId);
    await rpc.acceptInvitation(org.id, invitation.id, memberId);

    await rpc.updateOrgMemberRole(org.id, memberId, 'admin', ownerId);

    const members = await rpc.getOrgMembers(org.id);
    expect(members.some((entry) => entry.user.id === memberId && entry.role === 'admin')).toBe(true);

    const userOrgs = await rpc.getUserOrgs(memberId);
    expect(userOrgs.some((entry) => entry.org_id === org.id && entry.role === 'admin')).toBe(true);
  });

  it('createWorkspace adds to OrgDO.workspaces', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const org = await rpc.createOrg('Workspace Registry Org', ownerId);

    const workspace = await rpc.createWorkspace(org.id, 'Design', ownerId, 'Design workspace');
    const workspaces = await rpc.listOrgWorkspaces(org.id);
    expect(workspaces.some((entry) => entry.id === workspace.id)).toBe(true);
  });

  it('archiveWorkspace updates OrgDO.workspaces', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const org = await rpc.createOrg('Archive Registry Org', ownerId);

    const workspace = await rpc.createWorkspace(org.id, 'Archive Me', ownerId);
    await rpc.archiveWorkspace(workspace.id, ownerId);

    const workspaces = await rpc.listOrgWorkspaces(org.id);
    expect(workspaces.some((entry) => entry.id === workspace.id)).toBe(false);
  });

  it('removeMember sets is_orphaned when no orgs remain', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await rpc.createUser(memberEmail, 'password123', 'Member');
    const org = await rpc.createOrg('Orphan Org', ownerId);

    const invitation = await rpc.createInvitation(org.id, memberEmail, 'member', ownerId);
    await rpc.acceptInvitation(org.id, invitation.id, memberId);

    await rpc.removeOrgMember(org.id, memberId, ownerId);

    const profile = await rpc.getUserById(memberId);
    expect(profile?.is_orphaned).toBe(true);
  });

  it('acceptInvitation clears is_orphaned', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await rpc.createUser(memberEmail, 'password123', 'Member');
    const org = await rpc.createOrg('Invite Org', ownerId);

    await rpc.checkUserOrphaned(memberId);

    const invitation = await rpc.createInvitation(org.id, memberEmail, 'member', ownerId);
    await rpc.acceptInvitation(org.id, invitation.id, memberId);

    const profile = await rpc.getUserById(memberId);
    expect(profile?.is_orphaned).toBe(false);
  });

  it('handleOrphanedUserLogin creates org and workspace', async () => {
    const email = testEmail();
    const { userId } = await rpc.createUser(email, 'password123', 'Orphan');
    await rpc.checkUserOrphaned(userId);

    const result = await rpc.handleOrphanedUserLogin(userId);
    expect(result).not.toBeNull();
    expect(result?.org.id).toBeDefined();
    expect(result?.workspace.id).toBeDefined();

    const orgs = await rpc.getUserOrgs(userId);
    expect(orgs.length).toBeGreaterThan(0);

    const profile = await rpc.getUserById(userId);
    expect(profile?.is_orphaned).toBe(false);
  });

  it('transferOwnership updates roles in both DOs', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await rpc.createUser(memberEmail, 'password123', 'Member');
    const org = await rpc.createOrg('Ownership Org', ownerId);

    const invitation = await rpc.createInvitation(org.id, memberEmail, 'member', ownerId);
    await rpc.acceptInvitation(org.id, invitation.id, memberId);

    await rpc.transferOrgOwnership(org.id, memberId, ownerId);

    const members = await rpc.getOrgMembers(org.id);
    const newOwner = members.find((entry) => entry.user.id === memberId);
    const oldOwner = members.find((entry) => entry.user.id === ownerId);
    expect(newOwner?.role).toBe('owner');
    expect(oldOwner?.role).toBe('admin');

    const newOwnerOrgs = await rpc.getUserOrgs(memberId);
    const oldOwnerOrgs = await rpc.getUserOrgs(ownerId);
    expect(newOwnerOrgs.find((entry) => entry.org_id === org.id)?.role).toBe('owner');
    expect(oldOwnerOrgs.find((entry) => entry.org_id === org.id)?.role).toBe('admin');
  });

  it('archiveOrg archives workspaces and removes memberships', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await rpc.createUser(memberEmail, 'password123', 'Member');
    const org = await rpc.createOrg('Archive Org', ownerId);

    await rpc.createWorkspace(org.id, 'Extra Workspace', ownerId);
    const invitation = await rpc.createInvitation(org.id, memberEmail, 'member', ownerId);
    await rpc.acceptInvitation(org.id, invitation.id, memberId);

    await rpc.archiveOrg(org.id, ownerId);

    const archived = await rpc.getOrg(org.id);
    expect(archived?.archived).toBe(true);

    const workspaces = await rpc.listOrgWorkspaces(org.id);
    expect(workspaces).toHaveLength(0);

    const ownerOrgs = await rpc.getUserOrgs(ownerId);
    const memberOrgs = await rpc.getUserOrgs(memberId);
    expect(ownerOrgs.some((entry) => entry.org_id === org.id)).toBe(false);
    expect(memberOrgs.some((entry) => entry.org_id === org.id)).toBe(false);

    const ownerProfile = await rpc.getUserById(ownerId);
    const memberProfile = await rpc.getUserById(memberId);
    expect(ownerProfile?.is_orphaned).toBe(true);
    expect(memberProfile?.is_orphaned).toBe(true);

    const orgMembers = await rpc.getOrgMembers(org.id);
    expect(orgMembers.some((entry) => entry.user.id === ownerId && entry.role === 'owner')).toBe(true);
    expect(orgMembers.some((entry) => entry.user.id === memberId)).toBe(false);

    expect(await rpc.isOrgMember(ownerId, org.id)).toBe(false);
    expect(await rpc.isOrgMember(memberId, org.id)).toBe(false);
  });

  it('logs org audit events for membership changes', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await rpc.createUser(memberEmail, 'password123', 'Member');
    const org = await rpc.createOrg('Audit Org', ownerId);

    const invitation = await rpc.createInvitation(org.id, memberEmail, 'member', ownerId);
    await rpc.acceptInvitation(org.id, invitation.id, memberId);
    await rpc.updateOrgMemberRole(org.id, memberId, 'admin', ownerId);
    await rpc.removeOrgMember(org.id, memberId, ownerId);

    const audit = await rpc.getOrgAuditLog(org.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('org_created');
    expect(actions).toContain('member_added');
    expect(actions).toContain('member_role_changed');
    expect(actions).toContain('member_removed');
  });

  it('logs org update and workspace creation events', async () => {
    const ownerEmail = testEmail();
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const org = await rpc.createOrg('Audit Updates Org', ownerId);

    await rpc.updateOrgName(org.id, 'Audit Updates Org Renamed', ownerId);
    const workspace = await rpc.createWorkspace(org.id, 'New Workspace', ownerId);

    const audit = await rpc.getOrgAuditLog(org.id);
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
    const { userId: ownerId } = await rpc.createUser(ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await rpc.createUser(memberEmail, 'password123', 'Member');
    const org = await rpc.createOrg('Ownership Log Org', ownerId);

    const invitation = await rpc.createInvitation(org.id, memberEmail, 'member', ownerId);
    await rpc.acceptInvitation(org.id, invitation.id, memberId);

    await rpc.transferOrgOwnership(org.id, memberId, ownerId);
    await rpc.archiveOrg(org.id, memberId);

    const audit = await rpc.getOrgAuditLog(org.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('ownership_transferred');
    expect(actions).toContain('org_archived');

    const transferEntry = audit.find((entry) => entry.action === 'ownership_transferred');
    expect(transferEntry?.target_id).toBe(memberId);
    const details = transferEntry?.details as { from_user_id?: string } | undefined;
    expect(details?.from_user_id).toBe(ownerId);
  });
});
