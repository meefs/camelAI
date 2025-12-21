import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AuthEnv, SessionData, UserProfile, OrgIntegrationRecord, ApiTokenData } from './auth';
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
} from '../src/types';
import { getIntegrationDefinition } from '../src/lib/integration-registry';
import { encryptCredentials, decryptCredentials } from '../src/lib/integration-crypto';

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

  // API Token functions (all operations go through OrgDO for consistency)
  async createOrgApiToken(
    orgId: string,
    userId: string,
    input: CreateApiTokenInput
  ): Promise<{ tokenId: string; tokenData: ApiTokenData }> {
    const scopes = input.scopes || ['proxy'];
    const expiresAt = input.expires_in_days
      ? Date.now() + input.expires_in_days * 24 * 60 * 60 * 1000
      : null;

    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    return stub.createApiToken(orgId, userId, input.name, scopes, input.integration_id || null, expiresAt);
  }

  async validateApiToken(tokenId: string, orgId: string): Promise<ApiTokenData | null> {
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    return stub.validateApiToken(tokenId);
  }

  async deleteOrgApiToken(orgId: string, tokenId: string): Promise<void> {
    const stub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    await stub.deleteApiToken(tokenId);
  }
}
