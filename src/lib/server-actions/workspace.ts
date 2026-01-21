// Stub file - server actions not yet converted to API routes
// TODO: Convert to API routes

import type { Workspace, WorkspaceWithAccess, WorkspaceAccessLevel, AuditLogEntry } from '@/types';

export async function getWorkspaceAuditLog(
  _workspaceId: string,
  _limit?: number,
  _offset?: number
): Promise<AuditLogEntry[]> {
  throw new Error('getWorkspaceAuditLog not yet implemented - requires API route');
}

export async function createWorkspace(
  _name: string,
  _description?: string | null
): Promise<Workspace> {
  throw new Error('createWorkspace not yet implemented - requires API route');
}

export async function archiveWorkspace(_workspaceId: string): Promise<Workspace> {
  throw new Error('archiveWorkspace not yet implemented - requires API route');
}

export async function getWorkspace(_workspaceId: string): Promise<WorkspaceWithAccess | null> {
  throw new Error('getWorkspace not yet implemented - requires API route');
}

export async function setWorkspaceAccess(
  _workspaceId: string,
  _userId: string,
  _accessLevel: WorkspaceAccessLevel
): Promise<void> {
  throw new Error('setWorkspaceAccess not yet implemented - requires API route');
}

export async function updateWorkspaceInfo(
  _workspaceId: string,
  _updates: { name?: string; description?: string | null; avatar?: { color: string; content: string } }
): Promise<Workspace> {
  throw new Error('updateWorkspaceInfo not yet implemented - requires API route');
}
