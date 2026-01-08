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

type AuthPayload = {
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

export async function login(email: string, password: string): Promise<AuthPayload> {
  if (!email || !password) {
    throw new Error("Email and password are required");
  }
  if (!isValidEmail(email)) {
    throw new Error("Invalid email address");
  }

  const userResult = await authDO.getUserByEmail(email);
  if (!userResult) {
    throw new Error("Invalid email or password");
  }

  const { userId, user } = userResult;
  const isValid = await authDO.verifyUserPassword(userId, password);
  if (!isValid) {
    throw new Error("Invalid email or password");
  }

  let orgs = await authDO.getUserOrgs(userId);
  const orphanResult = await authDO.handleOrphanedUserLogin(userId);

  let currentOrg: Organization;
  let orgWorkspaces: WorkspaceWithAccess[];
  let currentWorkspace: WorkspaceWithAccess | null;

  if (orphanResult) {
    orgs = await authDO.getUserOrgs(userId);
    currentOrg = orphanResult.org;
    orgWorkspaces = await authDO.listUserWorkspaces(userId, currentOrg.id);
    currentWorkspace =
      orgWorkspaces.find((workspace) => workspace.id === orphanResult.workspace.id) ||
      orphanResult.workspace;
  } else {
    if (orgs.length === 0) {
      const orgName = `${user.name || 'My'}'s Organization`;
      await authDO.createOrg(orgName, userId);
      orgs = await authDO.getUserOrgs(userId);
    }

    const currentOrgId = orgs[0].org_id;
    const currentMembership = orgs.find((entry) => entry.org_id === currentOrgId);
    const org = await authDO.getOrg(currentOrgId);
    if (!org) {
      throw new Error("Failed to load organization");
    }
    currentOrg = org;
    orgWorkspaces = await authDO.listUserWorkspaces(userId, currentOrgId);
    const preferredWorkspaceId = currentMembership?.last_workspace_id ?? null;
    currentWorkspace =
      orgWorkspaces.find((workspace) => workspace.id === preferredWorkspaceId) ||
      orgWorkspaces[0] ||
      null;
  }

  const { sessionId } = await authDO.createSession(
    userId,
    currentOrg.id,
    currentWorkspace?.id ?? null
  );
  await setSessionCookie(sessionId);

  const allWorkspaces = await authDO.listUserWorkspacesAcrossOrgs(userId, orgs);
  const responseUser = orphanResult ? { ...user, is_orphaned: false } : user;

  return {
    user: toSafeUser(responseUser),
    currentOrg: toSafeOrg(currentOrg),
    currentWorkspace: currentWorkspace ? toSafeWorkspace(currentWorkspace) : null,
    orgs: orgs.map(toSafeOrgMembership),
    workspaces: allWorkspaces.map(toSafeWorkspace),
  };
}

export async function signup(
  email: string,
  password: string,
  name?: string
): Promise<AuthPayload> {
  if (!email || !password) {
    throw new Error("Email and password are required");
  }
  if (!isValidEmail(email)) {
    throw new Error("Invalid email address");
  }
  if (!isValidPassword(password)) {
    throw new Error("Password must be at least 8 characters");
  }

  const existing = await authDO.getUserByEmail(email);
  if (existing) {
    throw new Error("An account with this email already exists");
  }

  const { userId, user } = await authDO.createUser(email, password, name || null);
  const orgName = `${name || email.split("@")[0]}'s Organization`;
  const org = await authDO.createOrg(orgName, userId);
  const orgWorkspaces = await authDO.listUserWorkspaces(userId, org.id);
  const currentWorkspace = orgWorkspaces[0] || null;

  const { sessionId } = await authDO.createSession(
    userId,
    org.id,
    currentWorkspace?.id ?? null
  );
  await setSessionCookie(sessionId);

  const orgs = await authDO.getUserOrgs(userId);
  const allWorkspaces = await authDO.listUserWorkspacesAcrossOrgs(userId, orgs);

  return {
    user: toSafeUser(user),
    currentOrg: toSafeOrg(org),
    currentWorkspace: currentWorkspace ? toSafeWorkspace(currentWorkspace) : null,
    orgs: orgs.map(toSafeOrgMembership),
    workspaces: allWorkspaces.map(toSafeWorkspace),
  };
}

export async function logout() {
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
}
