// Stub file - server actions not yet converted to API routes
// TODO: Convert to API routes

import type { AuthState } from '@/types';

export async function login(_email: string, _password: string): Promise<AuthState> {
  throw new Error('login not yet implemented - requires API route');
}

export async function signup(
  _email: string,
  _password: string,
  _name?: string
): Promise<AuthState> {
  throw new Error('signup not yet implemented - requires API route');
}

export async function logout(): Promise<void> {
  throw new Error('logout not yet implemented - requires API route');
}

export async function getAuthState(): Promise<AuthState | null> {
  throw new Error('getAuthState not yet implemented - requires API route');
}

export async function switchOrg(_orgId: string): Promise<void> {
  throw new Error('switchOrg not yet implemented - requires API route');
}

export async function switchWorkspace(_workspaceId: string): Promise<void> {
  throw new Error('switchWorkspace not yet implemented - requires API route');
}
