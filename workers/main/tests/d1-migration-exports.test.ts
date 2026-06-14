import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { AppIndexDatabase } from '../src/app-index-db';
import type { OrgDO } from '../src/auth';
import type { EmailHandleDO } from '../src/email-handle-registry';
import type { OrgSlugDO } from '../src/org-slug-registry';
import type {
  SlackTeamRegistryDO,
  TelegramRegistryDO,
} from '../src/channel-registries';
import type { UserDO } from '../src/identity/user-do';
import type { WorkspaceDO } from '../src/workspace';
import type { WorkspaceCronDO } from '../src/workspace-cron';
import type { WorkspaceFilesystemDO } from '../src/workspace-filesystem-do';
import type { WorkerLogsDO } from '../src/worker-logs-do';
import { defaultWorkspaceModelPickerConfig } from '../../../src/lib/model-picker-config';
import {
  createOrg,
  createUser,
  createWorkspaceIntegration,
  setWorkspaceAccess,
  updateUserProfile,
  type TestEnv,
} from './test-helpers';

interface MigrationExportTestEnv extends TestEnv {
  ORG_SLUG: DurableObjectNamespace<OrgSlugDO>;
  EMAIL_HANDLE: DurableObjectNamespace<EmailHandleDO>;
  TELEGRAM_REGISTRY: DurableObjectNamespace<TelegramRegistryDO>;
  SLACK_TEAM_REGISTRY: DurableObjectNamespace<SlackTeamRegistryDO>;
  WORKSPACE_CRON: DurableObjectNamespace<WorkspaceCronDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  WORKER_LOGS: DurableObjectNamespace<WorkerLogsDO>;
}

type PagedMigrationExportStub = DurableObjectStub & {
  exportD1MigrationTable(input: {
    table: string;
    cursor?: string | number | null;
    limit?: number;
  }): Promise<{
    exportVersion: 1;
    table: string;
    keyColumns: string[];
    cursor: string | null;
    nextCursor: string | null;
    hasMore: boolean;
    rows: Array<Record<string, unknown>>;
  }>;
  listD1MigrationTables(): Promise<string[]>;
};

type UserMigrationExportStub = PagedMigrationExportStub & {
  invalidateSessions(): Promise<void>;
  removeOrg(orgId: string): Promise<void>;
  exportD1MigrationMetadata(): Promise<{
    exportVersion: 1;
    kv: {
      sessionInvalidatedAt: number | null;
      pendingSalesPrompt: string | null;
    };
  }>;
};

type WorkspaceMigrationExportStub = PagedMigrationExportStub & {
  setModelPickerConfig(config: unknown): Promise<unknown>;
  exportD1MigrationMetadata(): Promise<{
    exportVersion: 1;
    kv: {
      modelPickerConfig: unknown | null;
    };
  }>;
};

const testEnv = env as unknown as MigrationExportTestEnv;

describe('D1 migration export RPCs', () => {
  it('exports user, org, and workspace data in bounded pages', async () => {
    const { userId } = await createUser(
      testEnv,
      `d1-export-${crypto.randomUUID()}@example.com`,
      'password123',
      'D1 Export User',
    );
    const { org, defaultWorkspaceId } = await createOrg(
      testEnv,
      'D1 Export Org',
      userId,
    );
    const workspaceId = defaultWorkspaceId;
    await setWorkspaceAccess(testEnv, workspaceId, userId, 'full', userId);
    await createWorkspaceIntegration(testEnv, workspaceId, userId, {
      integration_type: 'notion',
      name: `Notion ${crypto.randomUUID()}`,
      category: 'productivity',
      auth_method: 'oauth',
      config: { workspace: 'test' },
      credentials: { access_token: 'secret' },
    });

    const userStub = testEnv.USER.get(
      testEnv.USER.idFromName(userId),
    ) as PagedMigrationExportStub;
    const userProfile = await userStub.exportD1MigrationTable({
      table: 'profile',
      limit: 10,
    });
    expect(userProfile).toMatchObject({
      exportVersion: 1,
      table: 'profile',
      keyColumns: ['key'],
    });
    expect(userProfile.rows.some((row) => row.key === 'data')).toBe(true);

    const userOrgs = await userStub.exportD1MigrationTable({
      table: 'orgs',
      limit: 1,
    });
    expect(userOrgs.rows).toHaveLength(1);
    expect(userOrgs.rows[0]).toMatchObject({ org_id: org.id });

    const orgStub = testEnv.ORG.get(
      testEnv.ORG.idFromName(org.id),
    ) as DurableObjectStub<OrgDO> & PagedMigrationExportStub;
    const orgMembers = await orgStub.exportD1MigrationTable({
      table: 'members',
      limit: 1,
    });
    expect(orgMembers.rows.some((row) => row.user_id === userId)).toBe(true);

    const orgWorkspaces = await orgStub.exportD1MigrationTable({
      table: 'workspaces',
      limit: 1,
    });
    expect(orgWorkspaces.rows.some((row) => row.id === workspaceId)).toBe(true);
    expect(await orgStub.listD1MigrationTables()).not.toEqual(
      expect.arrayContaining(['proxy_usage', 'usage_log', 'usage_spend']),
    );

    const workspaceStub = testEnv.WORKSPACE.get(
      testEnv.WORKSPACE.idFromName(workspaceId),
    ) as DurableObjectStub<WorkspaceDO> & PagedMigrationExportStub;
    const workspaceInfo = await workspaceStub.exportD1MigrationTable({
      table: 'workspace_info',
      limit: 1,
    });
    expect(workspaceInfo.rows).toHaveLength(1);
    const integrations = await workspaceStub.exportD1MigrationTable({
      table: 'integrations',
      limit: 1,
    });
    expect(integrations.rows).toHaveLength(1);
  });

  it('exports cron automation and worker logs in bounded cursor pages', async () => {
    const { userId } = await createUser(
      testEnv,
      `d1-export-cron-${crypto.randomUUID()}@example.com`,
      'password123',
      'D1 Export Cron User',
    );
    const { defaultWorkspaceId } = await createOrg(
      testEnv,
      'D1 Export Cron Org',
      userId,
    );

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(defaultWorkspaceId),
    ) as DurableObjectStub<WorkspaceCronDO> & PagedMigrationExportStub;
    const firstPrompt = await cronStub.createScheduledPrompt({
      workspaceId: defaultWorkspaceId,
      name: 'Export prompt one',
      prompt: 'Summarize export state',
      cronExpression: '0 9 * * *',
      createdBy: userId,
    });
    const secondPrompt = await cronStub.createScheduledPrompt({
      workspaceId: defaultWorkspaceId,
      name: 'Export prompt two',
      prompt: 'Summarize export state again',
      cronExpression: '0 10 * * *',
      createdBy: userId,
    });

    const firstPromptPage = await cronStub.exportD1MigrationTable({
      table: 'scheduled_prompts',
      limit: 1,
    });
    expect(firstPromptPage.rows).toHaveLength(1);
    expect(firstPromptPage.hasMore).toBe(true);
    expect(firstPromptPage.nextCursor).toBe(firstPromptPage.rows[0].id);

    const secondPromptPage = await cronStub.exportD1MigrationTable({
      table: 'scheduled_prompts',
      cursor: firstPromptPage.nextCursor,
      limit: 10,
    });
    expect(secondPromptPage.hasMore).toBe(false);
    expect(
      [...firstPromptPage.rows, ...secondPromptPage.rows].map((row) => row.id),
    ).toEqual([firstPrompt.id, secondPrompt.id].sort());

    const logsStub = testEnv.WORKER_LOGS.get(
      testEnv.WORKER_LOGS.idFromName(`script-${crypto.randomUUID()}`),
    ) as DurableObjectStub<WorkerLogsDO> & PagedMigrationExportStub;
    await logsStub.ingestLogs([
      {
        timestamp: 1000,
        level: 'log',
        message: 'first',
        exception: null,
        scriptVersion: 'v1',
      },
      {
        timestamp: 1001,
        level: 'warn',
        message: 'second',
        exception: null,
        scriptVersion: 'v1',
      },
    ]);

    const firstLogPage = await logsStub.exportD1MigrationTable({
      table: 'logs',
      limit: 1,
    });
    expect(firstLogPage).toMatchObject({
      exportVersion: 1,
      table: 'logs',
      cursor: null,
      hasMore: true,
    });
    expect(firstLogPage.rows[0].message).toBe('first');

    const secondLogPage = await logsStub.exportD1MigrationTable({
      table: 'logs',
      cursor: firstLogPage.nextCursor,
      limit: 10,
    });
    expect(secondLogPage.hasMore).toBe(false);
    expect(secondLogPage.rows.map((entry) => entry.message)).toEqual(['second']);
  });

  it('imports exported pages idempotently for added and updated DO rows', async () => {
    const appIndex = new AppIndexDatabase(testEnv.APP_DB!);
    const { userId } = await createUser(
      testEnv,
      `d1-export-idempotent-${crypto.randomUUID()}@example.com`,
      'password123',
      'Original Name',
    );
    const { org: firstOrg } = await createOrg(
      testEnv,
      'First Import Org',
      userId,
    );
    const userStub = testEnv.USER.get(
      testEnv.USER.idFromName(userId),
    ) as DurableObjectStub<UserDO> & UserMigrationExportStub;

    const firstProfilePage = await userStub.exportD1MigrationTable({
      table: 'profile',
      limit: 10,
    });
    await appIndex.importD1MigrationRows({
      namespace: 'user',
      objectId: userId,
      tableName: firstProfilePage.table,
      keyColumns: firstProfilePage.keyColumns,
      rows: firstProfilePage.rows,
    });
    const importedProfileRows = await appIndex.listD1MigrationImportRows({
      namespace: 'user',
      objectId: userId,
      tableName: 'profile',
    });
    await appIndex.importD1MigrationRows({
      namespace: 'user',
      objectId: userId,
      tableName: firstProfilePage.table,
      keyColumns: firstProfilePage.keyColumns,
      rows: firstProfilePage.rows,
    });
    expect(
      await appIndex.listD1MigrationImportRows({
        namespace: 'user',
        objectId: userId,
        tableName: 'profile',
      }),
    ).toHaveLength(importedProfileRows.length);

    await updateUserProfile(testEnv, userId, { name: 'Updated Name' });
    const updatedProfilePage = await userStub.exportD1MigrationTable({
      table: 'profile',
      limit: 10,
    });
    await appIndex.importD1MigrationRows({
      namespace: 'user',
      objectId: userId,
      tableName: updatedProfilePage.table,
      keyColumns: updatedProfilePage.keyColumns,
      rows: updatedProfilePage.rows,
    });
    const profileRows = await appIndex.listD1MigrationImportRows({
      namespace: 'user',
      objectId: userId,
      tableName: 'profile',
    });
    expect(profileRows).toHaveLength(importedProfileRows.length);
    const dataProfileRow = profileRows.find((row) => row.row_key === '["data"]');
    expect(dataProfileRow).toBeTruthy();
    expect(JSON.parse(dataProfileRow!.row_json).value).toContain('Updated Name');

    const firstOrgsPage = await userStub.exportD1MigrationTable({
      table: 'orgs',
      limit: 10,
    });
    await appIndex.importD1MigrationRows({
      namespace: 'user',
      objectId: userId,
      tableName: firstOrgsPage.table,
      keyColumns: firstOrgsPage.keyColumns,
      rows: firstOrgsPage.rows,
    });
    const { org: secondOrg } = await createOrg(testEnv, 'Second Import Org', userId);
    const backfillOrgsPage = await userStub.exportD1MigrationTable({
      table: 'orgs',
      limit: 10,
    });
    const backfillScan = appIndex.beginD1MigrationTableScan();
    await appIndex.importD1MigrationRows({
      namespace: 'user',
      objectId: userId,
      tableName: backfillOrgsPage.table,
      keyColumns: backfillOrgsPage.keyColumns,
      rows: backfillOrgsPage.rows,
      scanId: backfillScan.scanId,
    });
    await appIndex.importD1MigrationRows({
      namespace: 'user',
      objectId: userId,
      tableName: backfillOrgsPage.table,
      keyColumns: backfillOrgsPage.keyColumns,
      rows: backfillOrgsPage.rows,
      scanId: backfillScan.scanId,
    });
    await appIndex.completeD1MigrationTableScan({
      namespace: 'user',
      objectId: userId,
      tableName: 'orgs',
      scanId: backfillScan.scanId,
    });
    const orgRows = await appIndex.listD1MigrationImportRows({
      namespace: 'user',
      objectId: userId,
      tableName: 'orgs',
    });
    expect(orgRows).toHaveLength(2);
    expect(orgRows.map((row) => JSON.parse(row.row_json).org_id)).toContain(
      firstOrg.id,
    );

    await userStub.removeOrg(firstOrg.id);
    const deletionBackfillPage = await userStub.exportD1MigrationTable({
      table: 'orgs',
      limit: 10,
    });
    const deletionScan = appIndex.beginD1MigrationTableScan();
    await appIndex.importD1MigrationRows({
      namespace: 'user',
      objectId: userId,
      tableName: deletionBackfillPage.table,
      keyColumns: deletionBackfillPage.keyColumns,
      rows: deletionBackfillPage.rows,
      scanId: deletionScan.scanId,
    });
    await appIndex.completeD1MigrationTableScan({
      namespace: 'user',
      objectId: userId,
      tableName: 'orgs',
      scanId: deletionScan.scanId,
    });
    const prunedOrgRows = await appIndex.listD1MigrationImportRows({
      namespace: 'user',
      objectId: userId,
      tableName: 'orgs',
    });
    expect(prunedOrgRows).toHaveLength(1);
    expect(prunedOrgRows.map((row) => JSON.parse(row.row_json).org_id)).toEqual([
      secondOrg.id,
    ]);

    await userStub.invalidateSessions();
    const firstMetadataExport = await userStub.exportD1MigrationMetadata();
    expect(firstMetadataExport.kv.sessionInvalidatedAt).toEqual(
      expect.any(Number),
    );
    await appIndex.importD1MigrationMetadata({
      namespace: 'user',
      objectId: userId,
      metadata: firstMetadataExport.kv,
    });
    await appIndex.importD1MigrationMetadata({
      namespace: 'user',
      objectId: userId,
      metadata: firstMetadataExport.kv,
    });
    const importedMetadata = await appIndex.getD1MigrationImportMetadata({
      namespace: 'user',
      objectId: userId,
    });
    expect(importedMetadata).toBeTruthy();
    expect(JSON.parse(importedMetadata!.metadata_json)).toMatchObject({
      sessionInvalidatedAt: firstMetadataExport.kv.sessionInvalidatedAt,
      pendingSalesPrompt: null,
    });
  });

  it('exports small key-value migration records that are intentionally single-object', async () => {
    const { userId } = await createUser(
      testEnv,
      `d1-export-kv-${crypto.randomUUID()}@example.com`,
      'password123',
      'D1 Export KV User',
    );
    const { defaultWorkspaceId } = await createOrg(
      testEnv,
      'D1 Export KV Org',
      userId,
    );
    const workspaceStub = testEnv.WORKSPACE.get(
      testEnv.WORKSPACE.idFromName(defaultWorkspaceId),
    ) as DurableObjectStub<WorkspaceDO> & WorkspaceMigrationExportStub;
    const workspaceModelPickerConfig = {
      ...defaultWorkspaceModelPickerConfig(),
      use_org_defaults: false,
    };
    await workspaceStub.setModelPickerConfig(workspaceModelPickerConfig);
    const workspaceMetadata = await workspaceStub.exportD1MigrationMetadata();
    expect(workspaceMetadata.kv.modelPickerConfig).toMatchObject({
      use_org_defaults: false,
    });

    const fsWorkspaceId = `workspace-${crypto.randomUUID()}`;
    const fsStub = testEnv.WORKSPACE_FS.get(
      testEnv.WORKSPACE_FS.idFromName(fsWorkspaceId),
    ) as DurableObjectStub<WorkspaceFilesystemDO> & {
      exportD1MigrationMetadata(): Promise<any>;
    };
    const project = await fsStub.createProject({
      workspaceId: fsWorkspaceId,
      name: 'export-project',
      description: 'Project metadata export test',
    });
    await fsStub.setLegacyWorkspaceMigrationState({
      status: 'queued',
      attempts: 1,
    });
    const fsExport = await fsStub.exportD1MigrationMetadata();
    expect(fsExport.note).toContain('file contents remain');
    expect(fsExport.kv.projects.some((row: any) => row.id === project.id)).toBe(true);

    const orgSlug = `export-slug-${crypto.randomUUID()}`;
    const orgSlugStub = testEnv.ORG_SLUG.get(
      testEnv.ORG_SLUG.idFromName(orgSlug),
    ) as DurableObjectStub<OrgSlugDO> & { exportD1MigrationRecord(): any };
    await orgSlugStub.claim('org-export-1');
    expect((await orgSlugStub.exportD1MigrationRecord()).owner).toMatchObject({
      orgId: 'org-export-1',
    });

    const handle = `export-handle-${crypto.randomUUID()}`;
    const handleStub = testEnv.EMAIL_HANDLE.get(
      testEnv.EMAIL_HANDLE.idFromName(handle),
    ) as DurableObjectStub<EmailHandleDO> & { exportD1MigrationRecord(): any };
    await handleStub.claim('workspace-export-1');
    expect((await handleStub.exportD1MigrationRecord()).owner).toMatchObject({
      workspaceId: 'workspace-export-1',
    });

    const telegramStub = testEnv.TELEGRAM_REGISTRY.get(
      testEnv.TELEGRAM_REGISTRY.idFromName(`telegram-${crypto.randomUUID()}`),
    ) as DurableObjectStub<TelegramRegistryDO> & { exportD1MigrationRecords(): any };
    await telegramStub.putSetupToken('setup-token', {
      workspaceId: 'workspace-export-1',
      orgId: 'org-export-1',
      integrationId: 'integration-export-1',
      createdBy: 'user-export-1',
    } as any);
    await telegramStub.bindChat('chat-1', {
      workspaceId: 'workspace-export-1',
      orgId: 'org-export-1',
      integrationId: 'integration-export-1',
    } as any);
    const telegramExport = await telegramStub.exportD1MigrationRecords();
    expect(telegramExport.setupTokens).toHaveLength(1);
    expect(telegramExport.chatBindings).toHaveLength(1);

    const slackStub = testEnv.SLACK_TEAM_REGISTRY.get(
      testEnv.SLACK_TEAM_REGISTRY.idFromName(`team-${crypto.randomUUID()}`),
    ) as DurableObjectStub<SlackTeamRegistryDO> & {
      exportD1MigrationRecords(): any;
    };
    await slackStub.upsertInstallation({
      workspace_id: 'workspace-export-1',
      org_id: 'org-export-1',
      integration_id: 'integration-export-1',
      team_id: 'T123',
      updated_at: Date.now(),
    });
    expect((await slackStub.exportD1MigrationRecords()).installations).toHaveLength(1);
  });
});
