import type { OrgDO, UserDO } from './auth.js';
import {
  type AppIndexDatabase,
  getAppIndexDatabase,
} from './app-index-db.js';

type AdminIndexBootstrapEnv = {
  APP_DB?: D1Database;
  APP_KV: KVNamespace;
  EMAIL_TO_USER: KVNamespace;
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
};

const APP_INDEX_BOOTSTRAP_LOCK_KEY = 'admin_index_d1_bootstrap_lock';
const APP_INDEX_BOOTSTRAP_IN_PROGRESS = 'syncing';
const APP_INDEX_BOOTSTRAP_LOCK_TTL_SECONDS = 300;
const APP_INDEX_BOOTSTRAP_WAIT_MS = 10_000;
const APP_INDEX_BOOTSTRAP_POLL_MS = 200;
const ORG_INDEX_PREFIX = 'org_index:';

type AdminIndexBootstrapOptions = {
  waitMs?: number;
  pollMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectAllUserIds(env: AdminIndexBootstrapEnv): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  while (true) {
    const list = await env.EMAIL_TO_USER.list({ prefix: 'email:', cursor });
    for (const key of list.keys) {
      keys.push(key.name);
    }
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
  }

  const userIds = await Promise.all(keys.map((key) => env.EMAIL_TO_USER.get(key)));
  return Array.from(
    new Set(
      userIds.filter(
        (id): id is string => id !== null && !id.startsWith('{'),
      ),
    ),
  );
}

async function collectOrgIdsFromUsers(
  env: AdminIndexBootstrapEnv,
  userIds: string[],
): Promise<Set<string>> {
  const orgIds = new Set<string>();
  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const userStub = env.USER.get(env.USER.idFromName(userId));
        const orgs = await userStub.getOrgs();
        for (const org of orgs) {
          orgIds.add(org.org_id);
        }
      } catch {
        // Stale email mappings can point at deleted users.
      }
    }),
  );
  return orgIds;
}

async function collectOrgIdsFromOrgIndex(
  env: AdminIndexBootstrapEnv,
): Promise<Set<string>> {
  const orgIds = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const list = await env.APP_KV.list({ prefix: ORG_INDEX_PREFIX, cursor });
    for (const key of list.keys) {
      const orgId = key.name.slice(ORG_INDEX_PREFIX.length);
      if (orgId) orgIds.add(orgId);
    }
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
  }

  return orgIds;
}

async function getWorkspaceIntegrationCount(
  env: AdminIndexBootstrapEnv,
  orgId: string,
  workspaceId: string,
): Promise<number> {
  try {
    const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
    return (await orgStub.getWorkspaceIntegrations(workspaceId)).length;
  } catch {
    return 0;
  }
}

async function waitForAdminIndexBootstrap(
  appIndex: AppIndexDatabase,
  options: AdminIndexBootstrapOptions = {},
): Promise<void> {
  const startedAt = Date.now();
  const waitMs = options.waitMs ?? APP_INDEX_BOOTSTRAP_WAIT_MS;
  const pollMs = options.pollMs ?? APP_INDEX_BOOTSTRAP_POLL_MS;
  while (Date.now() - startedAt < waitMs) {
    if (await appIndex.isBootstrapComplete()) {
      return;
    }
    await sleep(pollMs);
  }
}

async function bootstrapAdminIndexFromDurableObjects(
  env: AdminIndexBootstrapEnv,
  appIndex: AppIndexDatabase,
): Promise<void> {
  const userIds = await collectAllUserIds(env);

  for (const userId of userIds) {
    const userStub = env.USER.get(env.USER.idFromName(userId));
    const profile = await userStub.getProfile();
    if (!profile) {
      continue;
    }

    const orgs = await userStub.getOrgs();
    await appIndex.applyAdminEvent({
      type: 'user_upsert',
      payload: {
        ...profile,
        org_count: orgs.length,
      },
    });
  }

  const [membershipOrgIds, indexedOrgIds] = await Promise.all([
    collectOrgIdsFromUsers(env, userIds),
    collectOrgIdsFromOrgIndex(env),
  ]);
  const orgIds = new Set([...membershipOrgIds, ...indexedOrgIds]);

  for (const orgId of orgIds) {
    const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
    const [info, members, workspaces, scripts, threads, invitations] =
      await Promise.all([
        orgStub.getInfo(),
        orgStub.getMembers(),
        orgStub.getWorkspaceInfos(true),
        orgStub.listWorkerScripts(),
        orgStub.getThreads(),
        orgStub.getInvitations(),
      ]);

    if (!info) {
      continue;
    }

    await appIndex.applyAdminEvent({
      type: 'org_upsert',
      payload: {
        ...info,
        member_count: members.length,
        workspace_count: workspaces.length,
      },
    });

    for (const member of members) {
      await appIndex.applyAdminEvent({
        type: 'org_membership_upsert',
        payload: {
          org_id: orgId,
          user_id: member.user_id,
          role: member.role,
          joined_at: member.joined_at,
        },
      });
    }

    const integrationCounts = new Map(
      await Promise.all(
        workspaces.map(
          async (workspace) =>
            [
              workspace.id,
              await getWorkspaceIntegrationCount(env, orgId, workspace.id),
            ] as const,
        ),
      ),
    );

    for (const workspace of workspaces) {
      await appIndex.applyAdminEvent({
        type: 'workspace_upsert',
        payload: {
          ...workspace,
          integration_count: integrationCounts.get(workspace.id) ?? 0,
        },
      });
    }

    for (const script of scripts) {
      await appIndex.applyAdminEvent({
        type: 'app_upsert',
        payload: { ...script, org_id: orgId },
      });
    }

    for (const thread of threads) {
      await appIndex.applyAdminEvent({
        type: 'thread_upsert',
        payload: { ...thread, org_id: orgId },
      });
    }

    for (const invitation of invitations) {
      await appIndex.applyAdminEvent({
        type: 'invitation_upsert',
        payload: { ...invitation, org_id: orgId },
      });
    }
  }

  await appIndex.markBootstrapComplete();
  await appIndex.markThreadsIndexBackfillComplete();
}

async function acquireAdminIndexBootstrapLock(
  env: AdminIndexBootstrapEnv,
): Promise<boolean> {
  const bootstrapLock = await env.APP_KV.get(APP_INDEX_BOOTSTRAP_LOCK_KEY);
  if (bootstrapLock === APP_INDEX_BOOTSTRAP_IN_PROGRESS) {
    return false;
  }

  await env.APP_KV.put(
    APP_INDEX_BOOTSTRAP_LOCK_KEY,
    APP_INDEX_BOOTSTRAP_IN_PROGRESS,
    { expirationTtl: APP_INDEX_BOOTSTRAP_LOCK_TTL_SECONDS },
  );
  return true;
}

export async function ensureAdminIndexReady(
  env: AdminIndexBootstrapEnv,
  options: AdminIndexBootstrapOptions = {},
): Promise<void> {
  const appIndex = getAppIndexDatabase(env);
  if (!appIndex) {
    throw new Error('APP_DB binding is not configured');
  }

  await appIndex.ensureSchema();
  if (await appIndex.isBootstrapComplete()) {
    // Schema-version backfills must run through an explicit, checkpointed job.
    // Starting the full-platform rebuild here ties it to every admin request;
    // an OOM leaves the marker set and restarts the rebuild after the KV lock
    // expires, repeatedly killing the request isolate.
    return;
  }

  let ownsLock = await acquireAdminIndexBootstrapLock(env);
  if (!ownsLock) {
    await waitForAdminIndexBootstrap(appIndex, options);
    if (await appIndex.isBootstrapComplete()) {
      return;
    }
    ownsLock = await acquireAdminIndexBootstrapLock(env);
    if (!ownsLock) {
      throw new Error('Admin index bootstrap is still in progress; retry shortly');
    }
  }

  try {
    if (!(await appIndex.isBootstrapComplete())) {
      await bootstrapAdminIndexFromDurableObjects(env, appIndex);
    }
  } finally {
    await env.APP_KV.delete(APP_INDEX_BOOTSTRAP_LOCK_KEY);
  }
}
