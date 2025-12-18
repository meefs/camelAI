import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { User, Organization, OrgMembership, UserProject } from '@/types';
import type { SessionDO, UserDO, OrgDO, SessionData, UserProfile } from '../../worker/auth';

interface AuthEnv {
  SESSION: DurableObjectNamespace<SessionDO>;
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  EMAIL_TO_USER: KVNamespace;
}

async function getEnv(): Promise<AuthEnv> {
  const { env } = getCloudflareContext() as unknown as { env: AuthEnv };
  return env;
}

// Session functions
export async function getSession(sessionId: string): Promise<SessionData | null> {
  const env = await getEnv();
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  return stub.getData();
}

export async function createSession(
  userId: string,
  orgId: string
): Promise<{ sessionId: string; sessionData: SessionData }> {
  const env = await getEnv();
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000; // 30 days

  const sessionData: SessionData = {
    user_id: userId,
    org_id: orgId,
    created_at: now,
    last_accessed: now,
    expires_at: expiresAt,
  };

  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  await stub.setData(sessionData);

  return { sessionId, sessionData };
}

export async function destroySession(sessionId: string): Promise<void> {
  const env = await getEnv();
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  await stub.destroy();
}

export async function switchSessionOrg(sessionId: string, orgId: string): Promise<void> {
  const env = await getEnv();
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  await stub.switchOrg(orgId);
}

// User functions
export async function getUserByEmail(email: string): Promise<{ userId: string; user: UserProfile } | null> {
  const env = await getEnv();
  const userId = await env.EMAIL_TO_USER.get(`email:${email.toLowerCase()}`);
  if (!userId) return null;

  const stub = env.USER.get(env.USER.idFromName(userId));
  const user = await stub.getProfile();
  if (!user) return null;

  return { userId, user };
}

export async function getUserById(userId: string): Promise<UserProfile | null> {
  const env = await getEnv();
  const stub = env.USER.get(env.USER.idFromName(userId));
  return stub.getProfile();
}

export async function createUser(
  email: string,
  password: string,
  name: string | null
): Promise<{ userId: string; user: UserProfile }> {
  const env = await getEnv();
  const userId = crypto.randomUUID();

  // Create user in UserDO
  const stub = env.USER.get(env.USER.idFromName(userId));
  const user = await stub.createUser(userId, email.toLowerCase(), password, name);

  // Store email -> userId mapping in KV
  await env.EMAIL_TO_USER.put(`email:${email.toLowerCase()}`, userId);

  return { userId, user };
}

export async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
  const env = await getEnv();
  const stub = env.USER.get(env.USER.idFromName(userId));
  return stub.verifyPassword(password);
}

export async function getUserOrgs(userId: string): Promise<OrgMembership[]> {
  const env = await getEnv();
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const userOrgs = await userStub.getOrgs();

  // Fetch org names for each membership
  const memberships: OrgMembership[] = [];
  for (const uo of userOrgs) {
    const orgStub = env.ORG.get(env.ORG.idFromName(uo.org_id));
    const orgInfo = await orgStub.getInfo();
    if (orgInfo) {
      memberships.push({
        org_id: uo.org_id,
        org_name: orgInfo.name,
        role: uo.role,
        joined_at: uo.joined_at,
      });
    }
  }

  return memberships;
}

export async function addUserToOrg(userId: string, orgId: string, role: 'admin' | 'member'): Promise<void> {
  const env = await getEnv();
  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.addOrg(orgId, role);
}

export async function removeUserFromOrg(userId: string, orgId: string): Promise<void> {
  const env = await getEnv();
  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.removeOrg(orgId);
}

export async function getUserProjects(userId: string): Promise<UserProject[]> {
  const env = await getEnv();
  const userStub = env.USER.get(env.USER.idFromName(userId));
  return userStub.getProjects();
}

export async function addUserProject(userId: string, orgId: string, projectId: string): Promise<void> {
  const env = await getEnv();
  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.addProject(orgId, projectId);
}

export async function removeUserProject(userId: string, orgId: string, projectId: string): Promise<void> {
  const env = await getEnv();
  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.removeProject(orgId, projectId);
}

// Organization functions
export async function getOrg(orgId: string): Promise<Organization | null> {
  const env = await getEnv();
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const info = await stub.getInfo();
  if (!info) return null;

  return {
    id: info.id,
    name: info.name,
    created_at: info.created_at,
    created_by: info.created_by,
  };
}

export async function createOrg(name: string, createdBy: string): Promise<Organization> {
  const env = await getEnv();
  const orgId = crypto.randomUUID();

  // Create org in OrgDO
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const orgInfo = await orgStub.createOrg(orgId, name, createdBy);

  // Add org to user's list
  const userStub = env.USER.get(env.USER.idFromName(createdBy));
  await userStub.addOrg(orgId, 'admin');

  return {
    id: orgInfo.id,
    name: orgInfo.name,
    created_at: orgInfo.created_at,
    created_by: orgInfo.created_by,
  };
}

export async function updateOrgName(orgId: string, name: string): Promise<void> {
  const env = await getEnv();
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  await stub.updateName(name);
}

export async function getOrgMembers(orgId: string): Promise<Array<{ user: User; role: 'admin' | 'member'; joined_at: number }>> {
  const env = await getEnv();
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const members = await orgStub.getMembers();

  const result: Array<{ user: User; role: 'admin' | 'member'; joined_at: number }> = [];
  for (const m of members) {
    const user = await getUserById(m.user_id);
    if (user) {
      result.push({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          created_at: user.created_at,
        },
        role: m.role,
        joined_at: m.joined_at,
      });
    }
  }

  return result;
}

export async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
  const env = await getEnv();
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  return stub.isMember(userId);
}

export async function isOrgAdmin(userId: string, orgId: string): Promise<boolean> {
  const env = await getEnv();
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  return stub.isAdmin(userId);
}

export async function removeOrgMember(orgId: string, userId: string): Promise<void> {
  const env = await getEnv();

  // Remove from org
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  await orgStub.removeMember(userId);

  // Remove from user's list
  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.removeOrg(orgId);
}

export async function updateOrgMemberRole(orgId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
  const env = await getEnv();

  // Update in org
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  await orgStub.updateMemberRole(userId, role);

  // Update in user's list
  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.updateOrgRole(orgId, role);
}

// Invitation functions
export async function createInvitation(
  orgId: string,
  email: string,
  role: 'admin' | 'member',
  invitedBy: string
): Promise<{ id: string; expires_at: number }> {
  const env = await getEnv();
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitation = await stub.createInvitation(email, role, invitedBy);
  return { id: invitation.id, expires_at: invitation.expires_at };
}

export async function getInvitation(orgId: string, invitationId: string): Promise<{
  id: string;
  email: string;
  role: 'admin' | 'member';
  org: Organization;
} | null> {
  const env = await getEnv();
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitation = await orgStub.getInvitation(invitationId);
  if (!invitation) return null;

  const orgInfo = await orgStub.getInfo();
  if (!orgInfo) return null;

  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    org: {
      id: orgInfo.id,
      name: orgInfo.name,
      created_at: orgInfo.created_at,
      created_by: orgInfo.created_by,
    },
  };
}

export async function acceptInvitation(orgId: string, invitationId: string, userId: string): Promise<boolean> {
  const env = await getEnv();

  // Accept in org (adds member and deletes invitation)
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitation = await orgStub.getInvitation(invitationId);
  if (!invitation) return false;

  const accepted = await orgStub.acceptInvitation(invitationId, userId);
  if (!accepted) return false;

  // Add org to user's list
  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.addOrg(orgId, invitation.role);

  return true;
}

export async function getOrgInvitations(orgId: string): Promise<Array<{
  id: string;
  email: string;
  role: 'admin' | 'member';
  created_at: number;
  expires_at: number;
}>> {
  const env = await getEnv();
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitations = await stub.getInvitations();
  return invitations.map((inv) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    created_at: inv.created_at,
    expires_at: inv.expires_at,
  }));
}

export async function deleteInvitation(orgId: string, invitationId: string): Promise<void> {
  const env = await getEnv();
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  await stub.deleteInvitation(invitationId);
}
