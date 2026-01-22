/**
 * @deprecated This file is deprecated during the Next.js → React Router migration.
 * Use auth.server.ts instead, which provides the same functionality with proper
 * request/context parameters for React Router loaders and actions.
 *
 * Migration guide:
 * - Import { getAuthContext, requireAuthContext, ... } from '@/lib/auth.server'
 * - These functions require (request, context) parameters
 * - Call them from route loaders/actions, not from server actions
 */

import type { Organization, OrgMembership, User, WorkspaceWithAccess } from '@/types';
import type { SessionData } from '../../workers/main/src/session-kv';

export type Session = SessionData;

export type SessionContext = {
  sessionId: string;
  session: Session;
};

export type UserContext = SessionContext & {
  user: User;
};

export type AuthContextLite = UserContext & {
  currentOrg: Organization;
  currentWorkspace: WorkspaceWithAccess | null;
  workspaces?: WorkspaceWithAccess[];
};

export type AuthContext = AuthContextLite & {
  orgs: OrgMembership[];
  workspaces: WorkspaceWithAccess[];
};

// These functions are stubs that throw errors directing developers to use auth.server.ts
// They exist only to prevent import errors during migration

export async function getSessionContext(): Promise<SessionContext | null> {
  throw new Error(
    'getSessionContext() is deprecated. Use getSession() from auth.server.ts with (request, context) parameters.'
  );
}

export async function getUserByIdCached(userId: string) {
  throw new Error(
    'getUserByIdCached() is deprecated. Use auth.server.ts functions with (request, context) parameters.'
  );
}

export async function getUserContext(): Promise<UserContext | null> {
  throw new Error(
    'getUserContext() is deprecated. Use getUserContext() from auth.server.ts with (request, context) parameters.'
  );
}

export async function getAuthContextLite(): Promise<AuthContextLite | null> {
  throw new Error(
    'getAuthContextLite() is deprecated. Use getAuthContext() from auth.server.ts with (request, context) parameters.'
  );
}

export async function getAuthContext(): Promise<AuthContext | null> {
  throw new Error(
    'getAuthContext() is deprecated. Use getAuthContext() from auth.server.ts with (request, context) parameters.'
  );
}
