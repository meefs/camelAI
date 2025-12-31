import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AuthEnv, SessionData, UserProfile, OrgIntegrationRecord } from './auth';
import type { ChatEnv } from './durable-objects';
import type {
  Message,
  Organization,
  OrgMembership,
  Project,
  Thread,
  User,
  UserProject,
  Integration,
  CreateIntegrationInput,
  UpdateIntegrationInput,
  CreateApiTokenInput,
  AdminOverview,
  AdminUserSummary,
  PaginatedResult,
  PaginationParams,
} from '../../../src/types';
import { getIntegrationDefinition, isProxyable, type ProxyConfig } from '../../../src/lib/integration-registry';
import { encryptCredentials, decryptCredentials } from '../../../src/lib/integration-crypto';
import {
  createApiToken,
  validateApiToken as validateApiTokenKV,
  deleteApiToken,
  type ApiTokenData,
} from './api-tokens';

/**
 * Configuration returned to callers for making proxied requests.
 * Contains everything needed to build and authenticate the upstream request.
 */
export interface IntegrationProxyConfig {
  baseUrl: string;
  authHeader: { name: string; value: string } | null;
  defaultHeaders: Record<string, string>;
  authType: ProxyConfig['authType'];
}

interface DoRpcEnv extends AuthEnv, ChatEnv {
  INTEGRATION_SECRET_KEY: string;
}

function getIndexStub(env: DoRpcEnv, org: string) {
  return env.CHAT_INDEX.get(env.CHAT_INDEX.idFromName(org));
}

function getThreadStub(env: DoRpcEnv, threadId: string) {
  return env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
}

export class DoRpcService extends WorkerEntrypoint<DoRpcEnv> {
  // Session functions
  async getSession(sessionId: string): Promise<SessionData | null> {
    const stub = this.env.SESSION.get(this.env.SESSION.idFromName(sessionId));
    return stub.getData();
  }

  async getSessionWithUser(
    sessionId: string
  ): Promise<{ session: SessionData; user: UserProfile } | null> {
    const sessionStub = this.env.SESSION.get(this.env.SESSION.idFromName(sessionId));
    const session = await sessionStub.getData();
    if (!session) return null;

    const userStub = this.env.USER.get(this.env.USER.idFromName(session.user_id));
    const user = await userStub.getProfile();
    if (!user) return null;

    return { session, user };
  }

  async createSession(
    userId: string,
    orgId: string
  ): Promise<{ sessionId: string; sessionData: SessionData }> {
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + 30 * 24 * 60 * 60 * 1000;

    const sessionData: SessionData = {
      user_id: userId,
      org_id: orgId,
      created_at: now,
      last_accessed: now,
      expires_at: expiresAt,
    };

    const stub = this.env.SESSION.get(this.env.SESSION.idFromName(sessionId));
    await stub.setData(sessionData);

    return { sessionId, sessionData };
  }

  async destroySession(sessionId: string): Promise<void> {
    const stub = this.env.SESSION.get(this.env.SESSION.idFromName(sessionId));
    await stub.destroy();
  }

  async switchSessionOrg(sessionId: string, orgId: string): Promise<void> {
    const stub = this.env.SESSION.get(this.env.SESSION.idFromName(sessionId));
    await stub.switchOrg(orgId);
  }

  // User functions
  async getUserByEmail(email: string): Promise<{ userId: string; user: UserProfile } | null> {
    const userId = await this.env.EMAIL_TO_USER.get(`email:${email.toLowerCase()}`);
    if (!userId) return null;

    const stub = this.env.USER.get(this.env.USER.idFromName(userId));
    const user = await stub.getProfile();
    if (!user) return null;

    return { userId, user };
  }

  async getUserById(userId: string): Promise<UserProfile | null> {
    const stub = this.env.USER.get(this.env.USER.idFromName(userId));
    return stub.getProfile();
  }

  async createUser(
    email: string,
    password: string,
    name: string | null
  ): Promise<{ userId: string; user: UserProfile }> {
    const userId = crypto.randomUUID();

    const stub = this.env.USER.get(this.env.USER.idFromName(userId));
    const user = await stub.createUser(userId, email.toLowerCase(), password, name);

    await this.env.EMAIL_TO_USER.put(`email:${email.toLowerCase()}`, userId);

    return { userId, user };
  }

  async verifyUserPassword(userId: string, password: string): Promise<boolean> {
    const stub = this.env.USER.get(this.env.USER.idFromName(userId));
    return stub.verifyPassword(password);
  }

  async getUserOrgs(userId: string): Promise<OrgMembership[]> {
    const userStub = this.env.USER.get(this.env.USER.idFromName(userId));
    const userOrgs = await userStub.getOrgs();

    const memberships: OrgMembership[] = [];
    for (const uo of userOrgs) {
      const orgStub = this.env.ORG.get(this.env.ORG.idFromName(uo.org_id));
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

  async addUserToOrg(userId: string, orgId: string, role: 'admin' | 'member'): Promise<void> {
    const userStub = this.env.USER.get(this.env.USER.idFromName(userId));
    await userStub.addOrg(orgId, role);
  }

  async removeUserFromOrg(userId: string, orgId: string): Promise<void> {
    const userStub = this.env.USER.get(this.env.USER.idFromName(userId));
    await userStub.removeOrg(orgId);
  }

  async getUserProjects(userId: string): Promise<UserProject[]> {
    const userStub = this.env.USER.get(this.env.USER.idFromName(userId));
    return userStub.getProjects();
  }

  async addUserProject(userId: string, orgId: string, projectId: string): Promise<void> {
    const userStub = this.env.USER.get(this.env.USER.idFromName(userId));
    await userStub.addProject(orgId, projectId);
  }

  async removeUserProject(userId: string, orgId: string, projectId: string): Promise<void> {
    const userStub = this.env.USER.get(this.env.USER.idFromName(userId));
    await userStub.removeProject(orgId, projectId);
  }

  // Admin functions
  async getAdminOverview(): Promise<AdminOverview> {
    const orgIds = new Set<string>();
    const seenUserIds = new Set<string>();
    const allKeys: string[] = [];
    let cursor: string | undefined;

    // Step 1: Collect all email keys
    while (true) {
      const list = await this.env.EMAIL_TO_USER.list({ prefix: 'email:', cursor });
      for (const key of list.keys) {
        allKeys.push(key.name);
      }
      if (list.list_complete || !list.cursor) break;
      cursor = list.cursor;
    }

    // Step 2: Batch fetch all user IDs in parallel
    const userIdResults = await Promise.all(
      allKeys.map((key) => this.env.EMAIL_TO_USER.get(key))
    );
    const userIds = userIdResults.filter((id): id is string => {
      if (!id || seenUserIds.has(id)) return false;
      seenUserIds.add(id);
      return true;
    });

    // Step 3: Batch fetch all profiles and orgs in parallel
    const userDataResults = await Promise.all(
      userIds.map(async (userId) => {
        const userStub = this.env.USER.get(this.env.USER.idFromName(userId));
        const [profile, orgs] = await Promise.all([
          userStub.getProfile(),
          userStub.getOrgs(),
        ]);
        return { profile, orgs };
      })
    );

    // Step 4: Process results
    const users: AdminUserSummary[] = [];
    let totalMemberships = 0;

    for (const { profile, orgs } of userDataResults) {
      if (!profile) continue;

      for (const org of orgs) {
        orgIds.add(org.org_id);
      }
      totalMemberships += orgs.length;

      users.push({
        id: profile.id,
        email: profile.email,
        name: profile.name,
        created_at: profile.created_at,
        is_superuser: profile.is_superuser,
        org_count: orgs.length,
      });
    }

    users.sort((a, b) => b.created_at - a.created_at);

    return {
      users,
      total_users: users.length,
      total_orgs: orgIds.size,
      total_memberships: totalMemberships,
    };
  }

  // Admin: Update user profile (name, is_superuser)
  async adminUpdateUser(
    userId: string,
    updates: { name?: string; is_superuser?: boolean }
  ): Promise<UserProfile | null> {
    const stub = this.env.USER.get(this.env.USER.idFromName(userId));
    const profile = await stub.getProfile();
    if (!profile) return null;

    if (updates.name !== undefined) {
      profile.name = updates.name;
    }
    if (updates.is_superuser !== undefined) {
      profile.is_superuser = updates.is_superuser;
    }
    await stub.setProfile(profile);
    return profile;
  }

  // Admin: Get all organizations with details
  async adminGetAllOrgs(): Promise<Array<Organization & { member_count: number }>> {
    const orgIds = await this.collectAllOrgIds();

    // Fetch org details in parallel
    const orgResults = await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        const orgStub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
        const [info, memberCount] = await Promise.all([
          orgStub.getInfo(),
          orgStub.getMemberCount(),
        ]);
        if (!info) return null;
        return {
          id: info.id,
          name: info.name,
          created_at: info.created_at,
          created_by: info.created_by,
          member_count: memberCount,
        };
      })
    );

    const orgs = orgResults.filter(
      (org): org is Organization & { member_count: number } => org !== null
    );
    orgs.sort((a, b) => b.created_at - a.created_at);
    return orgs;
  }

  // Admin: Get all threads across all orgs
  async adminGetAllThreads(): Promise<Array<Thread & { org_id: string }>> {
    const orgIds = await this.collectAllOrgIds();

    // Fetch threads from all orgs in parallel
    const threadResults = await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        const indexStub = getIndexStub(this.env, orgId);
        const threads = await indexStub.getThreads();
        return threads.map((thread) => ({ ...thread, org_id: orgId }));
      })
    );

    const allThreads = threadResults.flat();
    allThreads.sort((a, b) => b.updated_at - a.updated_at);
    return allThreads;
  }

  // Admin: Get all projects across all orgs
  async adminGetAllProjects(): Promise<Array<Project & { org_id: string }>> {
    const orgIds = await this.collectAllOrgIds();

    // Fetch projects from all orgs in parallel
    const projectResults = await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        const indexStub = getIndexStub(this.env, orgId);
        const projects = await indexStub.getProjects();
        return projects.map((project) => ({ ...project, org_id: orgId }));
      })
    );

    const allProjects = projectResults.flat();
    allProjects.sort((a, b) => b.updated_at - a.updated_at);
    return allProjects;
  }

  // Admin: Get thread with messages
  async adminGetThreadWithMessages(
    threadId: string
  ): Promise<{ thread: Thread; messages: Message[]; org_id: string } | null> {
    const orgIds = await this.collectAllOrgIds();

    // Search for thread in all orgs in parallel
    const results = await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        const indexStub = getIndexStub(this.env, orgId);
        const thread = await indexStub.getThread(threadId);
        if (thread) {
          const threadStub = getThreadStub(this.env, threadId);
          const messages = await threadStub.getMessages();
          return { thread, messages, org_id: orgId };
        }
        return null;
      })
    );

    return results.find((r) => r !== null) || null;
  }

  // Admin: Update thread
  async adminUpdateThread(
    threadId: string,
    updates: { title?: string }
  ): Promise<Thread | null> {
    const orgIds = await this.collectAllOrgIds();

    // Search for thread in all orgs in parallel
    const results = await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        const indexStub = getIndexStub(this.env, orgId);
        const thread = await indexStub.getThread(threadId);
        if (thread && updates.title !== undefined) {
          return indexStub.updateThread(threadId, updates.title);
        }
        return null;
      })
    );

    return results.find((r) => r !== null) || null;
  }

  // Admin: Update project
  async adminUpdateProject(
    projectId: string,
    updates: { name?: string }
  ): Promise<Project | null> {
    const orgIds = await this.collectAllOrgIds();

    // Search for project in all orgs in parallel
    const results = await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        const indexStub = getIndexStub(this.env, orgId);
        const project = await indexStub.getProject(projectId);
        if (project && updates.name !== undefined) {
          return indexStub.updateProject(projectId, updates.name);
        }
        return null;
      })
    );

    return results.find((r) => r !== null) || null;
  }

  // Helper: Collect all org IDs from user memberships (parallelized)
  private async collectAllOrgIds(): Promise<Set<string>> {
    const allKeys: string[] = [];
    let cursor: string | undefined;

    // Step 1: Collect all email keys
    while (true) {
      const list = await this.env.EMAIL_TO_USER.list({ prefix: 'email:', cursor });
      for (const key of list.keys) {
        allKeys.push(key.name);
      }
      if (list.list_complete || !list.cursor) break;
      cursor = list.cursor;
    }

    // Step 2: Batch fetch all user IDs in parallel
    const userIds = (
      await Promise.all(allKeys.map((key) => this.env.EMAIL_TO_USER.get(key)))
    ).filter((id): id is string => id !== null);

    // Step 3: Batch fetch all orgs in parallel
    const orgsResults = await Promise.all(
      userIds.map((userId) => {
        const userStub = this.env.USER.get(this.env.USER.idFromName(userId));
        return userStub.getOrgs();
      })
    );

    // Step 4: Collect unique org IDs
    const orgIds = new Set<string>();
    for (const orgs of orgsResults) {
      for (const org of orgs) {
        orgIds.add(org.org_id);
      }
    }

    return orgIds;
  }

  // Admin: Get paginated users
  async adminGetUsersPaginated(
    params: PaginationParams = {}
  ): Promise<PaginatedResult<AdminUserSummary>> {
    const { offset = 0, limit = 50 } = params;

    // Get all users first (we need the full list to know total)
    const overview = await this.getAdminOverview();
    const total = overview.users.length;

    // Apply pagination
    const items = overview.users.slice(offset, offset + limit);

    return { items, total, offset, limit };
  }

  // Admin: Get paginated organizations
  async adminGetOrgsPaginated(
    params: PaginationParams = {}
  ): Promise<PaginatedResult<Organization & { member_count: number }>> {
    const { offset = 0, limit = 50 } = params;

    // Get all orgs first
    const allOrgs = await this.adminGetAllOrgs();
    const total = allOrgs.length;

    // Apply pagination
    const items = allOrgs.slice(offset, offset + limit);

    return { items, total, offset, limit };
  }

  // Admin: Get paginated threads
  async adminGetThreadsPaginated(
    params: PaginationParams = {}
  ): Promise<PaginatedResult<Thread & { org_id: string }>> {
    const { offset = 0, limit = 50 } = params;

    // Get all threads first
    const allThreads = await this.adminGetAllThreads();
    const total = allThreads.length;

    // Apply pagination
    const items = allThreads.slice(offset, offset + limit);

    return { items, total, offset, limit };
  }

  // Admin: Get paginated projects
  async adminGetProjectsPaginated(
    params: PaginationParams = {}
  ): Promise<PaginatedResult<Project & { org_id: string }>> {
    const { offset = 0, limit = 50 } = params;

    // Get all projects first
    const allProjects = await this.adminGetAllProjects();
    const total = allProjects.length;

    // Apply pagination
    const items = allProjects.slice(offset, offset + limit);

    return { items, total, offset, limit };
  }

  // Organization functions
  async getOrg(orgId: string): Promise<Organization | null> {
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const info = await stub.getInfo();
    if (!info) return null;

    return {
      id: info.id,
      name: info.name,
      created_at: info.created_at,
      created_by: info.created_by,
    };
  }

  async createOrg(name: string, createdBy: string): Promise<Organization> {
    const orgId = crypto.randomUUID();

    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const orgInfo = await orgStub.createOrg(orgId, name, createdBy);

    const userStub = this.env.USER.get(this.env.USER.idFromName(createdBy));
    await userStub.addOrg(orgId, 'admin');

    return {
      id: orgInfo.id,
      name: orgInfo.name,
      created_at: orgInfo.created_at,
      created_by: orgInfo.created_by,
    };
  }

  async updateOrgName(orgId: string, name: string): Promise<void> {
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    await stub.updateName(name);
  }

  async getOrgMembers(
    orgId: string
  ): Promise<Array<{ user: User; role: 'admin' | 'member'; joined_at: number }>> {
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const members = await orgStub.getMembers();

    const result: Array<{ user: User; role: 'admin' | 'member'; joined_at: number }> = [];
    for (const m of members) {
      const user = await this.getUserById(m.user_id);
      if (user) {
        result.push({
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            created_at: user.created_at,
            is_superuser: user.is_superuser,
          },
          role: m.role,
          joined_at: m.joined_at,
        });
      }
    }

    return result;
  }

  async isOrgMember(userId: string, orgId: string): Promise<boolean> {
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    return stub.isMember(userId);
  }

  async isOrgAdmin(userId: string, orgId: string): Promise<boolean> {
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    return stub.isAdmin(userId);
  }

  async removeOrgMember(orgId: string, userId: string): Promise<void> {
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    await orgStub.removeMember(userId);

    const userStub = this.env.USER.get(this.env.USER.idFromName(userId));
    await userStub.removeOrg(orgId);
  }

  async updateOrgMemberRole(orgId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    await orgStub.updateMemberRole(userId, role);

    const userStub = this.env.USER.get(this.env.USER.idFromName(userId));
    await userStub.updateOrgRole(orgId, role);
  }

  // Invitation functions
  async createInvitation(
    orgId: string,
    email: string,
    role: 'admin' | 'member',
    invitedBy: string
  ): Promise<{ id: string; expires_at: number }> {
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const invitation = await stub.createInvitation(email, role, invitedBy);
    return { id: invitation.id, expires_at: invitation.expires_at };
  }

  async getInvitation(
    orgId: string,
    invitationId: string
  ): Promise<{ id: string; email: string; role: 'admin' | 'member'; org: Organization } | null> {
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
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

  async acceptInvitation(orgId: string, invitationId: string, userId: string): Promise<boolean> {
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const invitation = await orgStub.getInvitation(invitationId);
    if (!invitation) return false;

    const accepted = await orgStub.acceptInvitation(invitationId, userId);
    if (!accepted) return false;

    const userStub = this.env.USER.get(this.env.USER.idFromName(userId));
    await userStub.addOrg(orgId, invitation.role);

    return true;
  }

  async getOrgInvitations(orgId: string): Promise<Array<{
    id: string;
    email: string;
    role: 'admin' | 'member';
    created_at: number;
    expires_at: number;
  }>> {
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const invitations = await stub.getInvitations();
    return invitations.map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      created_at: inv.created_at,
      expires_at: inv.expires_at,
    }));
  }

  async deleteInvitation(orgId: string, invitationId: string): Promise<void> {
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    await stub.deleteInvitation(invitationId);
  }

  // Chat functions
  async getThreads(org = 'default'): Promise<Thread[]> {
    return getIndexStub(this.env, org).getThreads();
  }

  async createThread(
    org = 'default',
    title: string | undefined,
    projectId: string,
    createdBy?: string
  ): Promise<Thread> {
    return getIndexStub(this.env, org).createThread(title, projectId, createdBy);
  }

  async getThread(id: string, org = 'default'): Promise<Thread | null> {
    return getIndexStub(this.env, org).getThread(id);
  }

  async updateThread(id: string, title: string, org = 'default'): Promise<Thread | null> {
    return getIndexStub(this.env, org).updateThread(id, title);
  }

  async deleteThread(id: string, org = 'default'): Promise<void> {
    await getThreadStub(this.env, id).deleteAllMessages();
    await getIndexStub(this.env, org).deleteThread(id);
  }

  async getMessages(threadId: string): Promise<Message[]> {
    return getThreadStub(this.env, threadId).getMessages();
  }

  async addMessage(threadId: string, role: string, content: string, org = 'default'): Promise<Message> {
    const msg = await getThreadStub(this.env, threadId).addMessage(role, content);
    await getIndexStub(this.env, org).touchThread(threadId);
    return msg;
  }

  async getProjects(org = 'default'): Promise<Project[]> {
    return getIndexStub(this.env, org).getProjects();
  }

  async getProjectsByUser(org = 'default', userId: string): Promise<Project[]> {
    return getIndexStub(this.env, org).getProjectsByUser(userId);
  }

  async createProject(org = 'default', name?: string, createdBy?: string): Promise<Project> {
    return getIndexStub(this.env, org).createProject(name, createdBy);
  }

  async getProject(id: string, org = 'default'): Promise<Project | null> {
    return getIndexStub(this.env, org).getProject(id);
  }

  async updateProject(id: string, name: string, org = 'default'): Promise<Project | null> {
    return getIndexStub(this.env, org).updateProject(id, name);
  }

  async deleteProject(id: string, org = 'default'): Promise<void> {
    await getIndexStub(this.env, org).deleteProject(id);
  }

  // Integration functions
  private recordToIntegration(record: OrgIntegrationRecord): Integration {
    return {
      id: record.id,
      integration_type: record.integration_type,
      name: record.name,
      category: record.category as Integration['category'],
      auth_method: record.auth_method as Integration['auth_method'],
      config: JSON.parse(record.config),
      enabled: record.enabled === 1,
      created_by: record.created_by,
      created_at: record.created_at,
      updated_at: record.updated_at,
      has_credentials: record.credentials_encrypted.length > 0,
    };
  }

  async getOrgIntegrations(orgId: string): Promise<Integration[]> {
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const records = await stub.getIntegrations();
    return records.map((r) => this.recordToIntegration(r));
  }

  async getOrgIntegration(orgId: string, integrationId: string): Promise<Integration | null> {
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const record = await stub.getIntegration(integrationId);
    if (!record) return null;
    return this.recordToIntegration(record);
  }

  async createOrgIntegration(
    orgId: string,
    userId: string,
    input: CreateIntegrationInput
  ): Promise<Integration> {
    const definition = getIntegrationDefinition(input.integration_type);
    if (!definition) {
      throw new Error(`Unknown integration type: ${input.integration_type}`);
    }

    const id = crypto.randomUUID();
    const encryptedCreds = await encryptCredentials(input.credentials, this.env.INTEGRATION_SECRET_KEY);

    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    await stub.createIntegration(
      id,
      input.integration_type,
      input.name,
      definition.category,
      definition.authMethod,
      JSON.stringify(input.config),
      encryptedCreds,
      userId
    );

    const record = await stub.getIntegration(id);
    if (!record) {
      throw new Error('Failed to create integration');
    }
    return this.recordToIntegration(record);
  }

  async updateOrgIntegration(
    orgId: string,
    integrationId: string,
    input: UpdateIntegrationInput
  ): Promise<Integration | null> {
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const existing = await stub.getIntegration(integrationId);
    if (!existing) return null;

    const updates: {
      name?: string;
      config?: string;
      credentialsEncrypted?: string;
      enabled?: boolean;
    } = {};

    if (input.name !== undefined) {
      updates.name = input.name;
    }
    if (input.config !== undefined) {
      updates.config = JSON.stringify(input.config);
    }
    if (input.credentials !== undefined) {
      updates.credentialsEncrypted = await encryptCredentials(
        input.credentials,
        this.env.INTEGRATION_SECRET_KEY
      );
    }
    if (input.enabled !== undefined) {
      updates.enabled = input.enabled;
    }

    await stub.updateIntegration(integrationId, updates);

    const record = await stub.getIntegration(integrationId);
    if (!record) return null;
    return this.recordToIntegration(record);
  }

  async deleteOrgIntegration(orgId: string, integrationId: string): Promise<void> {
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    await stub.deleteIntegration(integrationId);
  }

  async getOrgIntegrationCredentials(
    orgId: string,
    integrationId: string
  ): Promise<Record<string, unknown> | null> {
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const record = await stub.getIntegration(integrationId);
    if (!record || !record.credentials_encrypted) return null;

    return decryptCredentials(record.credentials_encrypted, this.env.INTEGRATION_SECRET_KEY);
  }

  // API Token functions (direct KV access)
  async createOrgApiToken(
    orgId: string,
    userId: string,
    input: CreateApiTokenInput
  ): Promise<{ tokenId: string; tokenData: ApiTokenData }> {
    const scopes = input.scopes || ['proxy'];
    const expiresAt = input.expires_in_days
      ? Date.now() + input.expires_in_days * 24 * 60 * 60 * 1000
      : null;

    return createApiToken(this.env.API_TOKENS, {
      orgId,
      userId,
      name: input.name,
      scopes,
      integrationId: input.integration_id || null,
      expiresAt,
    });
  }

  async validateApiToken(tokenId: string): Promise<ApiTokenData | null> {
    return validateApiTokenKV(this.env.API_TOKENS, tokenId);
  }

  async deleteApiToken(tokenId: string): Promise<void> {
    await deleteApiToken(this.env.API_TOKENS, tokenId);
  }

  /**
   * Get proxy configuration for an integration.
   * Returns everything needed to make an authenticated request to the upstream API.
   * Called by outbound workers via service binding (no additional auth needed).
   */
  async getIntegrationProxyConfig(
    orgId: string,
    integrationId: string
  ): Promise<{ config: IntegrationProxyConfig } | { error: string; status: number }> {
    // Get integration
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const record = await stub.getIntegration(integrationId);

    if (!record) {
      return { error: 'Integration not found', status: 404 };
    }

    if (record.enabled !== 1) {
      return { error: 'Integration is disabled', status: 400 };
    }

    // Check if proxyable
    if (!isProxyable(record.integration_type)) {
      return {
        error: `Integration type '${record.integration_type}' does not support HTTP proxy`,
        status: 400,
      };
    }

    const definition = getIntegrationDefinition(record.integration_type);
    if (!definition?.proxyConfig) {
      return { error: 'Proxy configuration not found', status: 500 };
    }

    // Get credentials
    if (!record.credentials_encrypted) {
      return { error: 'No credentials configured for integration', status: 500 };
    }

    const credentials = await decryptCredentials(
      record.credentials_encrypted,
      this.env.INTEGRATION_SECRET_KEY
    );

    const integrationConfig = JSON.parse(record.config) as Record<string, unknown>;

    // Build base URL
    let baseUrl = definition.proxyConfig.baseUrl;
    if (!baseUrl && integrationConfig.instance_url) {
      baseUrl = String(integrationConfig.instance_url);
    }

    // Build auth header
    const authHeader = this.buildAuthHeader(definition.proxyConfig, credentials);

    // Build default headers
    const defaultHeaders: Record<string, string> = {
      ...(definition.proxyConfig.defaultHeaders || {}),
    };

    // Add config-based headers
    if (definition.proxyConfig.configHeaders) {
      for (const [headerName, configField] of Object.entries(definition.proxyConfig.configHeaders)) {
        const value = integrationConfig[configField];
        if (value !== undefined && value !== null && value !== '') {
          defaultHeaders[headerName] = String(value);
        }
      }
    }

    return {
      config: {
        baseUrl,
        authHeader,
        defaultHeaders,
        authType: definition.proxyConfig.authType,
      },
    };
  }

  /**
   * Build authorization header based on auth type
   */
  private buildAuthHeader(
    proxyConfig: ProxyConfig,
    credentials: Record<string, unknown>
  ): { name: string; value: string } | null {
    const apiKey = (credentials.api_key || credentials.access_token) as string | undefined;

    const headerName =
      proxyConfig.authType === 'header' && proxyConfig.authHeader
        ? proxyConfig.authHeader
        : 'Authorization';

    switch (proxyConfig.authType) {
      case 'bearer':
        return apiKey ? { name: headerName, value: `Bearer ${apiKey}` } : null;

      case 'basic': {
        const key = credentials.api_key as string | undefined;
        const secret = credentials.api_secret as string | undefined;
        if (key && secret) {
          const encoded = btoa(`${key}:${secret}`);
          return { name: headerName, value: `Basic ${encoded}` };
        }
        return null;
      }

      case 'header':
        return apiKey ? { name: headerName, value: apiKey } : null;

      case 'query':
        // Query params are handled differently - return the key for the caller to use
        return apiKey ? { name: '_query_api_key', value: apiKey } : null;

      default:
        return apiKey ? { name: headerName, value: `Bearer ${apiKey}` } : null;
    }
  }
}
