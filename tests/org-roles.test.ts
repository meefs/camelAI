import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateOrgMemberRole, removeOrgMember } from '@/lib/server-actions/org';
import { POST as transferOwnership } from '@/app/api/orgs/[id]/transfer-ownership/route';
import { POST as createWorkspace } from '@/app/api/workspaces/route';

const mockRequireOrgAdmin = vi.fn();
const mockRequireSession = vi.fn();

vi.mock('@/lib/server-guards', () => ({
  requireOrgAdmin: (...args: [string, string?]) => mockRequireOrgAdmin(...args),
  requireSession: (...args: []) => mockRequireSession(...args),
}));

const mockIsOrgMember = vi.fn();
const mockGetOrgMembers = vi.fn();
const mockUpdateOrgMemberRole = vi.fn();
const mockRemoveOrgMember = vi.fn();
const mockIsOrgAdmin = vi.fn();
const mockGetSession = vi.fn();
const mockTransferOrgOwnership = vi.fn();
const mockGetWorkspace = vi.fn();
const mockCreateWorkspace = vi.fn();

vi.mock('@/lib/auth-do', () => ({
  isOrgMember: (...args: [string, string]) => mockIsOrgMember(...args),
  getOrgMembers: (...args: [string]) => mockGetOrgMembers(...args),
  updateOrgMemberRole: (...args: [string, string, string, string]) => mockUpdateOrgMemberRole(...args),
  removeOrgMember: (...args: [string, string, string]) => mockRemoveOrgMember(...args),
  isOrgAdmin: (...args: [string, string]) => mockIsOrgAdmin(...args),
  getSession: (...args: [string]) => mockGetSession(...args),
  transferOrgOwnership: (...args: [string, string, string]) => mockTransferOrgOwnership(...args),
  getWorkspace: (...args: [string]) => mockGetWorkspace(...args),
  createWorkspace: (...args: [string, string, string, string | null]) => mockCreateWorkspace(...args),
}));

const mockGetSessionId = vi.fn();

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    getSessionId: (...args: []) => mockGetSessionId(...args),
  };
});

describe('org roles', () => {
  const orgId = 'org-1';
  const ownerId = 'owner-1';
  const adminId = 'admin-1';
  const memberId = 'member-1';

  beforeEach(() => {
    mockRequireOrgAdmin.mockReset();
    mockRequireSession.mockReset();
    mockIsOrgMember.mockReset();
    mockGetOrgMembers.mockReset();
    mockUpdateOrgMemberRole.mockReset();
    mockRemoveOrgMember.mockReset();
    mockIsOrgAdmin.mockReset();
    mockGetSession.mockReset();
    mockTransferOrgOwnership.mockReset();
    mockGetWorkspace.mockReset();
    mockCreateWorkspace.mockReset();
    mockGetSessionId.mockReset();
  });

  it('owner can manage members', async () => {
    mockRequireOrgAdmin.mockResolvedValue({ user_id: ownerId, org_id: orgId });
    mockIsOrgMember.mockResolvedValue(true);
    mockGetOrgMembers.mockResolvedValue([
      { user: { id: ownerId }, role: 'owner', joined_at: Date.now() },
      { user: { id: adminId }, role: 'admin', joined_at: Date.now() },
      { user: { id: memberId }, role: 'member', joined_at: Date.now() },
    ]);

    await updateOrgMemberRole(orgId, memberId, 'viewer');

    expect(mockUpdateOrgMemberRole).toHaveBeenCalledWith(orgId, memberId, 'viewer', ownerId);
  });

  it('admin can manage members', async () => {
    mockRequireOrgAdmin.mockResolvedValue({ user_id: adminId, org_id: orgId });
    mockIsOrgMember.mockResolvedValue(true);
    mockGetOrgMembers.mockResolvedValue([
      { user: { id: ownerId }, role: 'owner', joined_at: Date.now() },
      { user: { id: adminId }, role: 'admin', joined_at: Date.now() },
    ]);

    await updateOrgMemberRole(orgId, memberId, 'member');

    expect(mockUpdateOrgMemberRole).toHaveBeenCalledWith(orgId, memberId, 'member', adminId);
  });

  it('member cannot manage members', async () => {
    mockRequireOrgAdmin.mockRejectedValue(new Error('Only admins can update member roles'));

    await expect(updateOrgMemberRole(orgId, memberId, 'member')).rejects.toThrow('Only admins can update member roles');
  });

  it('viewer has no management permissions', async () => {
    mockRequireOrgAdmin.mockRejectedValue(new Error('Only admins can update member roles'));

    await expect(updateOrgMemberRole(orgId, memberId, 'member')).rejects.toThrow('Only admins can update member roles');
  });

  it('owner can manage workspaces', async () => {
    mockGetSessionId.mockResolvedValue('session-1');
    mockGetSession.mockResolvedValue({
      user_id: ownerId,
      org_id: orgId,
      workspace_id: 'ws-1',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 1000,
    });
    mockIsOrgAdmin.mockResolvedValue(true);
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-2', org_id: orgId, name: 'New Workspace' });

    const response = await createWorkspace(new Request('http://localhost/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Workspace' }),
    }) as Request as any);

    expect(response.status).toBe(200);
    const payload = await response.json() as { id: string };
    expect(payload.id).toBe('ws-2');
  });

  it('admin can manage workspaces', async () => {
    mockGetSessionId.mockResolvedValue('session-1');
    mockGetSession.mockResolvedValue({
      user_id: adminId,
      org_id: orgId,
      workspace_id: 'ws-1',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 1000,
    });
    mockIsOrgAdmin.mockResolvedValue(true);
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-3', org_id: orgId, name: 'Admin Workspace' });

    const response = await createWorkspace(new Request('http://localhost/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Admin Workspace' }),
    }) as Request as any);

    expect(response.status).toBe(200);
    const payload = await response.json() as { id: string };
    expect(payload.id).toBe('ws-3');
  });

  it('member cannot manage workspaces', async () => {
    mockGetSessionId.mockResolvedValue('session-2');
    mockGetSession.mockResolvedValue({
      user_id: memberId,
      org_id: orgId,
      workspace_id: 'ws-1',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 1000,
    });
    mockIsOrgAdmin.mockResolvedValue(false);

    const response = await createWorkspace(new Request('http://localhost/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Workspace' }),
    }) as Request as any);

    expect(response.status).toBe(403);
  });

  it('owner can transfer ownership', async () => {
    mockGetSessionId.mockResolvedValue('session-owner');
    mockGetSession.mockResolvedValue({
      user_id: ownerId,
      org_id: orgId,
      workspace_id: 'ws-1',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 1000,
    });
    mockGetOrgMembers.mockResolvedValue([
      { user: { id: ownerId }, role: 'owner', joined_at: Date.now() },
      { user: { id: adminId }, role: 'admin', joined_at: Date.now() },
    ]);
    mockTransferOrgOwnership.mockResolvedValue(undefined);

    const response = await transferOwnership(new Request('http://localhost/api/orgs/org-1/transfer-ownership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_owner_id: adminId }),
    }) as Request as any, { params: Promise.resolve({ id: orgId }) });

    expect(response.status).toBe(200);
    expect(mockTransferOrgOwnership).toHaveBeenCalledWith(orgId, adminId, ownerId);
  });

  it('admin cannot transfer ownership', async () => {
    mockGetSessionId.mockResolvedValue('session-admin');
    mockGetSession.mockResolvedValue({
      user_id: adminId,
      org_id: orgId,
      workspace_id: 'ws-1',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 1000,
    });
    mockGetOrgMembers.mockResolvedValue([
      { user: { id: ownerId }, role: 'owner', joined_at: Date.now() },
      { user: { id: adminId }, role: 'admin', joined_at: Date.now() },
    ]);

    const response = await transferOwnership(new Request('http://localhost/api/orgs/org-1/transfer-ownership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_owner_id: memberId }),
    }) as Request as any, { params: Promise.resolve({ id: orgId }) });

    expect(response.status).toBe(403);
  });

  it('rejects transfer by non-owner', async () => {
    mockGetSessionId.mockResolvedValue('session-member');
    mockGetSession.mockResolvedValue({
      user_id: memberId,
      org_id: orgId,
      workspace_id: 'ws-1',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 1000,
    });
    mockGetOrgMembers.mockResolvedValue([
      { user: { id: ownerId }, role: 'owner', joined_at: Date.now() },
      { user: { id: memberId }, role: 'member', joined_at: Date.now() },
    ]);

    const response = await transferOwnership(new Request('http://localhost/api/orgs/org-1/transfer-ownership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_owner_id: ownerId }),
    }) as Request as any, { params: Promise.resolve({ id: orgId }) });

    expect(response.status).toBe(403);
  });

  it('rejects transfer to non-member', async () => {
    mockGetSessionId.mockResolvedValue('session-owner');
    mockGetSession.mockResolvedValue({
      user_id: ownerId,
      org_id: orgId,
      workspace_id: 'ws-1',
      created_at: Date.now(),
      last_accessed: Date.now(),
      expires_at: Date.now() + 1000,
    });
    mockGetOrgMembers.mockResolvedValue([
      { user: { id: ownerId }, role: 'owner', joined_at: Date.now() },
    ]);

    const response = await transferOwnership(new Request('http://localhost/api/orgs/org-1/transfer-ownership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_owner_id: memberId }),
    }) as Request as any, { params: Promise.resolve({ id: orgId }) });

    expect(response.status).toBe(400);
  });

  it('prevents owner from leaving org', async () => {
    mockRequireSession.mockResolvedValue({ user_id: ownerId, org_id: orgId });
    mockIsOrgMember.mockResolvedValue(true);
    mockGetOrgMembers.mockResolvedValue([
      { user: { id: ownerId }, role: 'owner', joined_at: Date.now() },
      { user: { id: adminId }, role: 'admin', joined_at: Date.now() },
    ]);

    await expect(removeOrgMember(orgId, ownerId)).rejects.toThrow('Cannot remove the organization owner');
  });

  it('prevents removing owner from org', async () => {
    mockRequireSession.mockResolvedValue({ user_id: adminId, org_id: orgId });
    mockIsOrgMember.mockResolvedValue(true);
    mockGetOrgMembers.mockResolvedValue([
      { user: { id: ownerId }, role: 'owner', joined_at: Date.now() },
      { user: { id: adminId }, role: 'admin', joined_at: Date.now() },
    ]);

    await expect(removeOrgMember(orgId, ownerId)).rejects.toThrow('Cannot remove the organization owner');
  });

  it('prevents demoting owner without transfer', async () => {
    mockRequireOrgAdmin.mockResolvedValue({ user_id: adminId, org_id: orgId });
    mockIsOrgMember.mockResolvedValue(true);
    mockGetOrgMembers.mockResolvedValue([
      { user: { id: ownerId }, role: 'owner', joined_at: Date.now() },
      { user: { id: adminId }, role: 'admin', joined_at: Date.now() },
    ]);

    await expect(updateOrgMemberRole(orgId, ownerId, 'member')).rejects.toThrow('Cannot change the owner role');
  });
});
