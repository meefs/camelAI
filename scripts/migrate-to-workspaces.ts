/**
 * One-off migration worker for workspace schema backfill.
 *
 * Run (example):
 *   wrangler dev scripts/migrate-to-workspaces.ts -c wrangler.jsonc --env staging
 *   curl -X POST "http://127.0.0.1:8787/migrate?dryRun=1"
 *   curl -X POST "http://127.0.0.1:8787/migrate?dropLegacy=1"
 *
 * Optional auth:
 *   - Set MIGRATION_TOKEN and pass Authorization: Bearer <token>
 */

type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

type OrgInfo = {
  id: string;
  name: string;
  created_at: number;
  created_by: string;
  billing_status: 'free' | 'paying';
  archived: boolean;
  archived_at: number | null;
  archived_by: string | null;
};

type OrgMember = {
  user_id: string;
  role: OrgRole;
  joined_at: number;
};

type OrgIntegrationRecord = {
  id: string;
  integration_type: string;
  name: string;
  category: string;
  auth_method: string;
  config: string;
  credentials_encrypted: string;
  enabled: number;
  created_by: string;
  created_at: number;
  updated_at: number;
};

type WorkspaceInfo = {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: number;
  avatar_color: string;
  avatar_content: string;
  archived: boolean;
  archived_at: number | null;
  archived_by: string | null;
  compute_tier: 'standard';
};

type WorkspaceIntegrationRecord = {
  id: string;
};

type OrgWorkspaceEntry = {
  id: string;
  name: string;
  created_at: number;
  archived: number;
};

interface MigrationEnv {
  ORG: DurableObjectNamespace;
  WORKSPACE: DurableObjectNamespace;
  USER: DurableObjectNamespace;
  EMAIL_TO_USER: KVNamespace;
  MIGRATION_TOKEN?: string;
}

type MigrationResult = {
  orgId: string;
  workspaceId: string | null;
  createdWorkspace: boolean;
  ownerBackfilled: boolean;
  integrationsMigrated: number;
  legacyIntegrationsDropped: boolean;
  errors: string[];
};

async function listUserIds(env: MigrationEnv): Promise<string[]> {
  const ids = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const list = await env.EMAIL_TO_USER.list({ prefix: 'email:', cursor });
    for (const key of list.keys) {
      const userId = await env.EMAIL_TO_USER.get(key.name);
      if (userId) {
        ids.add(userId);
      }
    }
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
  }

  return Array.from(ids);
}

async function collectOrgIds(env: MigrationEnv): Promise<string[]> {
  const userIds = await listUserIds(env);
  const orgIds = new Set<string>();

  for (const userId of userIds) {
    const userStub = env.USER.get(env.USER.idFromName(userId)) as DurableObjectStub<{
      getOrgs: () => Promise<Array<{ org_id: string }>>;
    }>;
    const orgs = await userStub.getOrgs();
    for (const org of orgs) {
      orgIds.add(org.org_id);
    }
  }

  return Array.from(orgIds);
}

async function migrateOrg(
  env: MigrationEnv,
  orgId: string,
  dryRun: boolean,
  dropLegacy: boolean
): Promise<MigrationResult> {
  const errors: string[] = [];
  let workspaceId: string | null = null;
  let createdWorkspace = false;
  let ownerBackfilled = false;
  let integrationsMigrated = 0;
  let legacyIntegrationsDropped = false;
  let integrationErrors = 0;

  const orgStub = env.ORG.get(env.ORG.idFromName(orgId)) as DurableObjectStub<{
    getInfo: () => Promise<OrgInfo | null>;
    getWorkspaces: () => Promise<OrgWorkspaceEntry[]>;
    addWorkspace: (id: string, name: string, createdAt: number, actorId: string) => Promise<void>;
    getMembers: () => Promise<OrgMember[]>;
    updateMemberRole: (userId: string, role: OrgRole, actorId: string) => Promise<void>;
    getIntegrations: () => Promise<OrgIntegrationRecord[]>;
    dropLegacyIntegrations: () => Promise<void>;
  }>;

  const orgInfo = await orgStub.getInfo();
  if (!orgInfo || orgInfo.archived) {
    return {
      orgId,
      workspaceId: null,
      createdWorkspace: false,
      ownerBackfilled: false,
      integrationsMigrated: 0,
      legacyIntegrationsDropped: false,
      errors,
    };
  }

  const workspaces = await orgStub.getWorkspaces();
  const activeWorkspace = workspaces.find((entry) => entry.archived !== 1);
  workspaceId = activeWorkspace?.id ?? orgId;

  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)) as DurableObjectStub<{
    getInfo: () => Promise<WorkspaceInfo | null>;
    createWorkspace: (
      id: string,
      orgId: string,
      name: string,
      createdBy: string,
      description?: string | null
    ) => Promise<WorkspaceInfo>;
    getIntegration: (id: string) => Promise<WorkspaceIntegrationRecord | null>;
    createIntegration: (
      id: string,
      integrationType: string,
      name: string,
      category: string,
      authMethod: string,
      config: string,
      credentialsEncrypted: string,
      createdBy: string
    ) => Promise<void>;
  }>;

  let workspaceInfo = await workspaceStub.getInfo();
  if (!workspaceInfo) {
    createdWorkspace = true;
    if (!dryRun) {
      workspaceInfo = await workspaceStub.createWorkspace(
        workspaceId,
        orgId,
        'Default Workspace',
        orgInfo.created_by
      );
    }
  }

  if (workspaceInfo && !workspaces.some((entry) => entry.id === workspaceId)) {
    if (!dryRun) {
      await orgStub.addWorkspace(workspaceId, workspaceInfo.name, workspaceInfo.created_at, orgInfo.created_by);
    }
  }

  const members = await orgStub.getMembers();
  const hasOwner = members.some((member) => member.role === 'owner');
  if (!hasOwner) {
    const ownerCandidate = members.find((member) => member.user_id === orgInfo.created_by) ?? members[0];
    if (ownerCandidate) {
      ownerBackfilled = true;
      if (!dryRun) {
        await orgStub.updateMemberRole(ownerCandidate.user_id, 'owner', orgInfo.created_by);
        const userStub = env.USER.get(env.USER.idFromName(ownerCandidate.user_id)) as DurableObjectStub<{
          updateOrgRole: (orgId: string, role: OrgRole) => Promise<void>;
          setOrgLastWorkspace: (orgId: string, workspaceId: string | null) => Promise<void>;
        }>;
        await userStub.updateOrgRole(orgId, 'owner');
        await userStub.setOrgLastWorkspace(orgId, workspaceId);
      }
    }
  }

  if (workspaceId) {
    const members = await orgStub.getMembers();
    for (const member of members) {
      try {
        const userStub = env.USER.get(env.USER.idFromName(member.user_id)) as DurableObjectStub<{
          setOrgLastWorkspace: (orgId: string, workspaceId: string | null) => Promise<void>;
        }>;
        if (!dryRun) {
          await userStub.setOrgLastWorkspace(orgId, workspaceId);
        }
      } catch (err) {
        errors.push(`member:${member.user_id}:${String(err)}`);
      }
    }
  }

  const integrations = await orgStub.getIntegrations();
  for (const integration of integrations) {
    try {
      const existing = await workspaceStub.getIntegration(integration.id);
      if (existing) continue;
      integrationsMigrated += 1;
      if (!dryRun) {
        await workspaceStub.createIntegration(
          integration.id,
          integration.integration_type,
          integration.name,
          integration.category,
          integration.auth_method,
          integration.config,
          integration.credentials_encrypted,
          integration.created_by
        );
      }
    } catch (err) {
      integrationErrors += 1;
      errors.push(`integration:${integration.id}:${String(err)}`);
    }
  }

  if (!dryRun && dropLegacy) {
    if (integrationErrors === 0) {
      await orgStub.dropLegacyIntegrations();
      legacyIntegrationsDropped = true;
    } else {
      errors.push('dropLegacy:skipped_due_to_integration_errors');
    }
  }

  return {
    orgId,
    workspaceId,
    createdWorkspace,
    ownerBackfilled,
    integrationsMigrated,
    legacyIntegrationsDropped,
    errors,
  };
}

export default {
  async fetch(request: Request, env: MigrationEnv): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Use POST /migrate', { status: 405 });
    }

    if (env.MIGRATION_TOKEN) {
      const header = request.headers.get('Authorization') || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (token !== env.MIGRATION_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    const url = new URL(request.url);
    if (url.pathname !== '/migrate') {
      return new Response('Not found', { status: 404 });
    }

    const dryRun = url.searchParams.get('dryRun') === '1';
    const dropLegacy = url.searchParams.get('dropLegacy') === '1';
    const targetOrgId = url.searchParams.get('orgId');

    const orgIds = targetOrgId ? [targetOrgId] : await collectOrgIds(env);
    const results: MigrationResult[] = [];

    for (const orgId of orgIds) {
      try {
        const result = await migrateOrg(env, orgId, dryRun, dropLegacy);
        results.push(result);
      } catch (err) {
        results.push({
          orgId,
          workspaceId: null,
          createdWorkspace: false,
          ownerBackfilled: false,
          integrationsMigrated: 0,
          legacyIntegrationsDropped: false,
          errors: [String(err)],
        });
      }
    }

    return new Response(JSON.stringify({
      dryRun,
      dropLegacy,
      count: results.length,
      results,
    }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
