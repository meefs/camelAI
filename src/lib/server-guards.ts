/**
 * @deprecated This file is deprecated during the Next.js → React Router migration.
 * Use auth.server.ts instead, which provides the same functionality with proper
 * request/context parameters for React Router loaders and actions.
 *
 * Migration guide:
 * - Import { requireSession, requireAuthContext, requireSuperuser, ... } from '@/lib/auth.server'
 * - These functions require (request, context) parameters
 * - Call them from route loaders/actions, not from server actions
 */

import type { SessionData } from '../../workers/main/src/session-kv';
import type { AuthContext } from '@/lib/auth-context';

type Session = SessionData;

// Re-export types for compatibility
export type { Session };
export type { AuthContextLite } from '@/lib/auth-context';

// These functions are stubs that throw errors directing developers to use auth.server.ts
// They exist only to prevent import errors during migration

export async function requireSession(): Promise<Session> {
  throw new Error(
    'requireSession() is deprecated. Use requireSession(request, context) from auth.server.ts.'
  );
}

export async function requireUser() {
  throw new Error(
    'requireUser() is deprecated. Use requireUserContext(request, context) from auth.server.ts.'
  );
}

export async function requireSuperuser(message = 'Forbidden') {
  throw new Error(
    'requireSuperuser() is deprecated. Use requireSuperuser(request, context) from auth.server.ts.'
  );
}

export async function requireOrgMember(
  orgId: string,
  message = 'You are not a member of this organization'
): Promise<Session> {
  throw new Error(
    'requireOrgMember() is deprecated. Use requireAuthContext(request, context) and check membership manually.'
  );
}

export async function requireOrgAdmin(
  orgId: string,
  message = 'Only admins can perform this action'
): Promise<Session> {
  throw new Error(
    'requireOrgAdmin() is deprecated. Use requireOrgAdmin(request, context, orgId) from auth.server.ts.'
  );
}

export async function requireAuthContextLite(): Promise<AuthContext> {
  throw new Error(
    'requireAuthContextLite() is deprecated. Use requireAuthContext(request, context) from auth.server.ts.'
  );
}

export async function requireWorkspaceAccess(
  workspaceId: string,
  options: { requireWrite?: boolean } = {}
): Promise<{ session: Session; access: 'full' | 'read_only' }> {
  throw new Error(
    'requireWorkspaceAccess() is deprecated. Use requireWorkspaceAccess(request, context, workspaceId) from auth.server.ts.'
  );
}
