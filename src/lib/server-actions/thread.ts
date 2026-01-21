// Stub file - server actions not yet converted to API routes
// TODO: Convert to API routes

import type { Thread, Message, PaginatedResult } from '@/types';

export async function deleteThread(_threadId: string, _workspaceId?: string): Promise<void> {
  throw new Error('deleteThread not yet implemented - requires API route');
}

export async function getThreadsPage(
  _params?: { offset?: number; limit?: number }
): Promise<PaginatedResult<Thread & { creator?: unknown }>> {
  throw new Error('getThreadsPage not yet implemented - requires API route');
}

export async function getThreadsPageAllWorkspaces(
  _params?: { offset?: number; limit?: number }
): Promise<PaginatedResult<Thread & { creator?: unknown }>> {
  throw new Error('getThreadsPageAllWorkspaces not yet implemented - requires API route');
}

export async function updateThreadTitle(_threadId: string, _title: string, _workspaceId?: string): Promise<Thread | null> {
  throw new Error('updateThreadTitle not yet implemented - requires API route');
}

export async function createThread(_options: string | { firstMessage?: string }): Promise<Thread> {
  throw new Error('createThread not yet implemented - requires API route');
}

export async function getThreadMessages(_threadId: string): Promise<Message[]> {
  throw new Error('getThreadMessages not yet implemented - requires API route');
}

export async function touchThread(_threadId: string, _workspaceId?: string): Promise<void> {
  throw new Error('touchThread not yet implemented - requires API route');
}
