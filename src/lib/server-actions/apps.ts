// Stub file - server actions not yet converted to API routes
// TODO: Convert to API routes

import type { WorkerScriptWithCreator } from '@/types';

export async function getOrgApps(_orgId?: string): Promise<WorkerScriptWithCreator[]> {
  throw new Error('getOrgApps not yet implemented - requires API route');
}

export async function getOrgAppsAllWorkspaces(_orgId?: string): Promise<WorkerScriptWithCreator[]> {
  throw new Error('getOrgAppsAllWorkspaces not yet implemented - requires API route');
}

export async function deleteApp(_orgId: string, _scriptName: string): Promise<void> {
  throw new Error('deleteApp not yet implemented - requires API route');
}

export async function setAppPublic(_orgId: string, _scriptName: string, _isPublic: boolean): Promise<void> {
  throw new Error('setAppPublic not yet implemented - requires API route');
}
