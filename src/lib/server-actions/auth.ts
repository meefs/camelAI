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

// Result type for server actions - allows returning errors without throwing
// Best practice: return errors for expected cases, only throw for truly unexpected errors
export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

// Generic error message for unexpected errors (don't leak internal details)
const UNEXPECTED_ERROR = "An unexpected error occurred. Please try again.";

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

export async function login(
  email: string,
  password: string
): Promise<ActionResult<AuthPayload>> {
  try {
    // Input validation
    if (!email || !password) {
      return { success: false, error: "Email and password are required" };
    }
    if (!isValidEmail(email)) {
      return { success: false, error: "Invalid email address" };
    }

    // Check user exists
    const userResult = await authDO.getUserByEmail(email);
    if (!userResult) {
      return { success: false, error: "Invalid email or password" };
    }

    // Verify password
    const { userId, user } = userResult;
    const isValid = await authDO.verifyUserPassword(userId, password);
    if (!isValid) {
      return { success: false, error: "Invalid email or password" };
    }

    // Get or create org
    const orgs = await authDO.getUserOrgs(userId);
    if (orgs.length === 0) {
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
    }

    const currentOrgId = orgs[0].org_id;
    const currentOrg = await authDO.getOrg(currentOrgId);
    if (!currentOrg) {
      return { success: false, error: "Failed to load organization" };
    }

    // Create session
    const { sessionId } = await authDO.createSession(userId, currentOrgId);
    await setSessionCookie(sessionId);

    return {
      success: true,
      data: {
        user: toSafeUser(user),
        currentOrg: toSafeOrg(currentOrg),
        orgs: orgs.map(toSafeOrgMembership),
      },
    };
  } catch (error) {
    // Log unexpected errors for debugging (will appear in instrumentation)
    console.error("[login] Unexpected error:", error);
    return { success: false, error: UNEXPECTED_ERROR };
  }
}

export async function signup(
  email: string,
  password: string,
  name?: string
): Promise<ActionResult<AuthPayload>> {
  try {
    // Input validation
    if (!email || !password) {
      return { success: false, error: "Email and password are required" };
    }
    if (!isValidEmail(email)) {
      return { success: false, error: "Invalid email address" };
    }
    if (!isValidPassword(password)) {
      return { success: false, error: "Password must be at least 8 characters" };
    }

    // Check for existing user
    const existing = await authDO.getUserByEmail(email);
    if (existing) {
      return { success: false, error: "An account with this email already exists" };
    }

    // Create user and org
    const { userId, user } = await authDO.createUser(email, password, name || null);
    const org = await authDO.createOrg(
      `${name || email.split("@")[0]}'s Workspace`,
      userId
    );

    // Create session
    const { sessionId } = await authDO.createSession(userId, org.id);
    await setSessionCookie(sessionId);

    const orgs = await authDO.getUserOrgs(userId);

    return {
      success: true,
      data: {
        user: toSafeUser(user),
        currentOrg: toSafeOrg(org),
        orgs: orgs.map(toSafeOrgMembership),
      },
    };
  } catch (error) {
    console.error("[signup] Unexpected error:", error);
    return { success: false, error: UNEXPECTED_ERROR };
  }
}

export async function logout(): Promise<ActionResult<null>> {
  try {
    const sessionContext = await getSessionContext();
    if (sessionContext) {
      await authDO.destroySession(sessionContext.sessionId);
    }
    await deleteSessionCookie();
    return { success: true, data: null };
  } catch (error) {
    console.error("[logout] Unexpected error:", error);
    return { success: false, error: UNEXPECTED_ERROR };
  }
}

export async function switchOrg(orgId: string): Promise<ActionResult<Organization>> {
  try {
    const sessionContext = await getSessionContext();
    if (!sessionContext) {
      return { success: false, error: "Not logged in" };
    }

    if (!orgId) {
      return { success: false, error: "Organization ID is required" };
    }

    const isMember = await authDO.isOrgMember(sessionContext.session.user_id, orgId);
    if (!isMember) {
      return { success: false, error: "You are not a member of this organization" };
    }

    await authDO.switchSessionOrg(sessionContext.sessionId, orgId);
    const currentOrg = await authDO.getOrg(orgId);
    if (!currentOrg) {
      return { success: false, error: "Organization not found" };
    }

    return { success: true, data: toSafeOrg(currentOrg) };
  } catch (error) {
    console.error("[switchOrg] Unexpected error:", error);
    return { success: false, error: UNEXPECTED_ERROR };
  }
}

export async function getAuthState(): Promise<AuthPayload | null> {
  try {
    const authContext = await getAuthContext();
    if (!authContext) return null;
    return {
      user: toSafeUser(authContext.user),
      currentOrg: toSafeOrg(authContext.currentOrg),
      orgs: authContext.orgs.map(toSafeOrgMembership),
    };
  } catch (error) {
    console.error("[getAuthState] Unexpected error:", error);
    return null;
  }
}
