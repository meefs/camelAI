// Stub file - server actions not yet converted to API routes
// TODO: Convert to API routes

export async function updateAdminThread(_threadId: string, _updates: unknown): Promise<void> {
  throw new Error('updateAdminThread not yet implemented - requires API route');
}

export async function transferAdminOrgOwnership(_orgId: string, _newOwnerId: string): Promise<void> {
  throw new Error('transferAdminOrgOwnership not yet implemented - requires API route');
}

export async function updateAdminApp(_orgId: string, _scriptName: string, _updates: unknown): Promise<void> {
  throw new Error('updateAdminApp not yet implemented - requires API route');
}

export async function forceAdminOrphanUser(_userId: string): Promise<void> {
  throw new Error('forceAdminOrphanUser not yet implemented - requires API route');
}

export async function updateAdminOrg(_orgId: string, _updates: unknown): Promise<void> {
  throw new Error('updateAdminOrg not yet implemented - requires API route');
}

export async function addAdminOrgMember(_orgId: string, _userId: string, _role: string): Promise<void> {
  throw new Error('addAdminOrgMember not yet implemented - requires API route');
}

export async function archiveAdminWorkspace(_workspaceId: string): Promise<void> {
  throw new Error('archiveAdminWorkspace not yet implemented - requires API route');
}

export async function deleteAdminApp(_orgId: string, _scriptName: string): Promise<void> {
  throw new Error('deleteAdminApp not yet implemented - requires API route');
}

export async function updateAdminUser(_userId: string, _updates: unknown): Promise<void> {
  throw new Error('updateAdminUser not yet implemented - requires API route');
}

export async function archiveAdminOrg(_orgId: string): Promise<void> {
  throw new Error('archiveAdminOrg not yet implemented - requires API route');
}

export async function updateAdminWorkspace(_workspaceId: string, _updates: unknown): Promise<void> {
  throw new Error('updateAdminWorkspace not yet implemented - requires API route');
}

export async function updateAdminOrgMemberRole(_orgId: string, _userId: string, _role: string): Promise<void> {
  throw new Error('updateAdminOrgMemberRole not yet implemented - requires API route');
}

export async function deleteAdminInvitation(_orgId: string, _invitationId: string): Promise<void> {
  throw new Error('deleteAdminInvitation not yet implemented - requires API route');
}
