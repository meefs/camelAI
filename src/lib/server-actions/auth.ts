"use server";

import * as authDO from "@/lib/auth-do";
import {
  deleteSessionCookie,
  isValidEmail,
  isValidPassword,
  setSessionCookie,
} from "@/lib/auth";
import { getAuthContext, getSessionContext } from "@/lib/auth-context";
import type { Organization, OrgMembership, User, WorkspaceWithAccess } from "@/types";
import type { UserProfile } from "../../../workers/main/src/auth";

export type AuthPayload = {
  user: User;
  currentOrg: Organization;
  currentWorkspace: WorkspaceWithAccess | null;
  orgs: OrgMembership[];
  workspaces: WorkspaceWithAccess[];
};

function toSafeUser(user: User | UserProfile): User {
  if ("avatar" in user) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      created_at: user.created_at,
      is_superuser: user.is_superuser,
      avatar: {
        color: user.avatar.color,
        content: user.avatar.content,
      },
      is_orphaned: user.is_orphaned,
    };
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.created_at,
    is_superuser: user.is_superuser,
    avatar: {
      color: user.avatar_color,
      content: user.avatar_content,
    },
    is_orphaned: user.is_orphaned,
  };
}

function toSafeOrg(org: Organization): Organization {
  return {
    id: org.id,
    name: org.name,
    created_at: org.created_at,
    created_by: org.created_by,
    billing_status: org.billing_status,
    archived: org.archived,
    archived_at: org.archived_at,
  };
}

function toSafeOrgMembership(membership: OrgMembership): OrgMembership {
  return {
    org_id: membership.org_id,
    org_name: membership.org_name,
    role: membership.role,
    joined_at: membership.joined_at,
    last_workspace_id: membership.last_workspace_id ?? null,
  };
}

function toSafeWorkspace(workspace: WorkspaceWithAccess): WorkspaceWithAccess {
  return {
    ...workspace,
    avatar: {
      color: workspace.avatar.color,
      content: workspace.avatar.content,
    },
  };
}

export async function login(
  email: string,
  password: string
): Promise<AuthPayload> {
  // Input validation
  if (!email || !password) {
    throw new Error("Email and password are required");
  }
  if (!isValidEmail(email)) {
    throw new Error("Invalid email address");
  }

  // Check user exists
  const userResult = await authDO.getUserByEmail(email);
  if (!userResult) {
    throw new Error("Invalid email or password");
  }

  // Verify password
  const { userId, user } = userResult;
  const isValid = await authDO.verifyUserPassword(userId, password);
  if (!isValid) {
    throw new Error("Invalid email or password");
  }

  // Handle orphaned users (may create recovery org/workspace)
  const orphanRecovery = await authDO.handleOrphanedUserLogin(userId);

  // Get orgs (refresh after orphan handling may have created new org)
  const orgs = await authDO.getUserOrgs(userId);

  let currentOrg: Organization;
  let workspaces: WorkspaceWithAccess[];
  let currentWorkspace: WorkspaceWithAccess | null;

  if (orphanRecovery) {
    // User was orphaned and got a recovery org/workspace
    currentOrg = orphanRecovery.org;
    workspaces = [orphanRecovery.workspace];
    currentWorkspace = orphanRecovery.workspace;
  } else if (orgs.length === 0) {
    // No orgs - create one
    const org = await authDO.createOrg(
      `${user.name || email.split("@")[0]}'s Workspace`,
      userId
    );
    orgs.push({
      org_id: org.id,
      org_name: org.name,
      role: "admin",
      joined_at: org.created_at,
    });
    currentOrg = org;
    workspaces = [];
    currentWorkspace = null;
  } else {
    // Normal case - use first org
    const currentOrgId = orgs[0].org_id;
    const org = await authDO.getOrg(currentOrgId);
    if (!org) {
      throw new Error("Failed to load organization");
    }
    currentOrg = org;
    workspaces = await authDO.listUserWorkspaces(userId, currentOrgId);
    const preferredWorkspaceId = orgs[0].last_workspace_id ?? null;
    currentWorkspace = workspaces.find((ws) => ws.id === preferredWorkspaceId) || workspaces[0] || null;
  }

  // Create session with workspace
  const { sessionId } = await authDO.createSession(userId, currentOrg.id, currentWorkspace?.id ?? null);
  await setSessionCookie(sessionId);

  return {
    user: toSafeUser(user),
    currentOrg: toSafeOrg(currentOrg),
    currentWorkspace: currentWorkspace ? toSafeWorkspace(currentWorkspace) : null,
    orgs: orgs.map(toSafeOrgMembership),
    workspaces: workspaces.map(toSafeWorkspace),
  };
}

export async function signup(
  email: string,
  password: string,
  name?: string
): Promise<AuthPayload> {
  // Input validation
  if (!email || !password) {
    throw new Error("Email and password are required");
  }
  if (!isValidEmail(email)) {
    throw new Error("Invalid email address");
  }
  if (!isValidPassword(password)) {
    throw new Error("Password must be at least 8 characters");
  }

  // Check for existing user
  const existing = await authDO.getUserByEmail(email);
  if (existing) {
    throw new Error("An account with this email already exists");
  }

  // Create user and org (createOrg also creates a default workspace)
  const { userId, user } = await authDO.createUser(email, password, name || null);
  const org = await authDO.createOrg(
    `${name || email.split("@")[0]}'s Workspace`,
    userId
  );

  // Get the default workspace that was created with the org
  const workspaces = await authDO.listUserWorkspaces(userId, org.id);
  const defaultWorkspace = workspaces[0] || null;

  // Create session with workspace
  const { sessionId } = await authDO.createSession(
    userId,
    org.id,
    defaultWorkspace?.id ?? null
  );
  await setSessionCookie(sessionId);

  const orgs = await authDO.getUserOrgs(userId);

  return {
    user: toSafeUser(user),
    currentOrg: toSafeOrg(org),
    currentWorkspace: defaultWorkspace ? toSafeWorkspace(defaultWorkspace) : null,
    orgs: orgs.map(toSafeOrgMembership),
    workspaces: workspaces.map(toSafeWorkspace),
  };
}

export async function logout(): Promise<void> {
  const sessionContext = await getSessionContext();
  if (sessionContext) {
    await authDO.destroySession(sessionContext.sessionId);
  }
  await deleteSessionCookie();
}

export async function switchOrg(orgId: string): Promise<Organization> {
  const sessionContext = await getSessionContext();
  if (!sessionContext) {
    throw new Error("Not logged in");
  }

  if (!orgId) {
    throw new Error("Organization ID is required");
  }

  const isMember = await authDO.isOrgMember(sessionContext.session.user_id, orgId);
  if (!isMember) {
    throw new Error("You are not a member of this organization");
  }

  // Get preferred workspace for the new org
  const orgs = await authDO.getUserOrgs(sessionContext.session.user_id);
  const membership = orgs.find((entry) => entry.org_id === orgId);
  const workspaces = await authDO.listUserWorkspaces(sessionContext.session.user_id, orgId);
  const preferredWorkspaceId = membership?.last_workspace_id ?? null;
  const nextWorkspace = workspaces.find((workspace) => workspace.id === preferredWorkspaceId) || workspaces[0] || null;

  await authDO.switchSessionOrg(sessionContext.sessionId, orgId, nextWorkspace?.id ?? null);
  const currentOrg = await authDO.getOrg(orgId);
  if (!currentOrg) {
    throw new Error("Organization not found");
  }

  return toSafeOrg(currentOrg);
}

export async function switchWorkspace(
  workspaceId: string
): Promise<WorkspaceWithAccess | null> {
  const sessionContext = await getSessionContext();
  if (!sessionContext) {
    throw new Error("Not logged in");
  }

  if (!workspaceId) {
    await authDO.switchSessionWorkspace(sessionContext.sessionId, null);
    return null;
  }

  const workspace = await authDO.getWorkspace(workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found");
  }

  const access = await authDO.getWorkspaceAccess(workspaceId, sessionContext.session.user_id);
  if (access === 'none') {
    throw new Error("Workspace not found");
  }

  if (workspace.org_id !== sessionContext.session.org_id) {
    await authDO.switchSessionOrg(sessionContext.sessionId, workspace.org_id, workspaceId);
  } else {
    await authDO.switchSessionWorkspace(sessionContext.sessionId, workspaceId);
  }

  return toSafeWorkspace({ ...workspace, access_level: access });
}

export async function getAuthState(): Promise<AuthPayload | null> {
  try {
    const authContext = await getAuthContext();
    if (!authContext) return null;
    return {
      user: toSafeUser(authContext.user),
      currentOrg: toSafeOrg(authContext.currentOrg),
      currentWorkspace: authContext.currentWorkspace
        ? toSafeWorkspace(authContext.currentWorkspace)
        : null,
      orgs: authContext.orgs.map(toSafeOrgMembership),
      workspaces: authContext.workspaces?.map(toSafeWorkspace) ?? [],
    };
  } catch (error) {
    console.error("[getAuthState] Unexpected error:", error);
    return null;
  }
}
