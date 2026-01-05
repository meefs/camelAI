"use server";

import * as authDO from "@/lib/auth-do";
import {
  deleteSessionCookie,
  isValidEmail,
  isValidPassword,
  setSessionCookie,
} from "@/lib/auth";
import { getAuthContext, getSessionContext } from "@/lib/auth-context";
import type { Organization, OrgMembership, User } from "@/types";

type AuthPayload = {
  user: User;
  currentOrg: Organization;
  orgs: OrgMembership[];
};

function toSafeUser(user: User): User {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.created_at,
    is_superuser: user.is_superuser,
  };
}

function toSafeOrg(org: Organization): Organization {
  return {
    id: org.id,
    name: org.name,
    created_at: org.created_at,
    created_by: org.created_by,
  };
}

function toSafeOrgMembership(membership: OrgMembership): OrgMembership {
  return {
    org_id: membership.org_id,
    org_name: membership.org_name,
    role: membership.role,
    joined_at: membership.joined_at,
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

  const orgs = await authDO.getUserOrgs(userId);
  if (orgs.length === 0) {
    const org = await authDO.createOrg(`${user.name || email.split("@")[0]}'s Workspace`, userId);
    orgs.push({
      org_id: org.id,
      org_name: org.name,
      role: "admin",
      joined_at: org.created_at,
    });
  }

  const currentOrgId = orgs[0].org_id;
  const currentOrg = await authDO.getOrg(currentOrgId);
  if (!currentOrg) {
    throw new Error("Failed to load organization");
  }

  const { sessionId } = await authDO.createSession(userId, currentOrgId);
  await setSessionCookie(sessionId);

  return {
    user: toSafeUser(user),
    currentOrg: toSafeOrg(currentOrg),
    orgs: orgs.map(toSafeOrgMembership),
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
  const org = await authDO.createOrg(`${name || email.split("@")[0]}'s Workspace`, userId);
  const { sessionId } = await authDO.createSession(userId, org.id);
  await setSessionCookie(sessionId);

  const orgs = await authDO.getUserOrgs(userId);

  return {
    user: toSafeUser(user),
    currentOrg: toSafeOrg(org),
    orgs: orgs.map(toSafeOrgMembership),
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

  await authDO.switchSessionOrg(sessionContext.sessionId, orgId);
  const currentOrg = await authDO.getOrg(orgId);
  if (!currentOrg) {
    throw new Error("Organization not found");
  }
  return toSafeOrg(currentOrg);
}

export async function getAuthState(): Promise<AuthPayload | null> {
  const authContext = await getAuthContext();
  if (!authContext) return null;
  return {
    user: toSafeUser(authContext.user),
    currentOrg: toSafeOrg(authContext.currentOrg),
    orgs: authContext.orgs.map(toSafeOrgMembership),
  };
}
