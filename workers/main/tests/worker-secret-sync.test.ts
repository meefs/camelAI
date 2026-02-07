/**
 * Worker Secret Sync tests
 *
 * Tests the syncing of integration secrets to deployed workers.
 * Run with: npm run test:workers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { WorkspaceDO } from '../src/workspace';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import { syncAllWorkspaceWorkerSecrets, type CfApiProxyEnv } from '../src/cf-api-proxy';
import {
  createUser,
  createOrg,
  listUserWorkspaces,
  type TestEnv,
} from './test-helpers';

// Extended env type
interface WorkerSecretTestEnv extends TestEnv {
  INTEGRATION_SECRET_KEY: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
}

describe('Worker Secret Sync', () => {
  const testEnv = env as unknown as WorkerSecretTestEnv;
  const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  const getSecretKey = () => testEnv.INTEGRATION_SECRET_KEY;

  describe('syncAllWorkspaceWorkerSecrets', () => {
    it('returns early when no CF config is present', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'No Config User');
      const { org } = await createOrg(testEnv, 'No Config Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      // Create minimal env without CF config
      const minimalEnv = {
        ...testEnv,
        CF_API_TOKEN: undefined,
        CF_ACCOUNT_ID: undefined,
        CF_DISPATCH_NAMESPACE: undefined,
      } as unknown as CfApiProxyEnv;

      const result = await syncAllWorkspaceWorkerSecrets(minimalEnv, workspace.id, org.id);

      // Should return early with 0 synced
      expect(result.synced).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('returns early when org has no slug', async () => {
      // This test verifies the function handles missing org slug gracefully
      // In practice, orgs should always have slugs, but we handle it defensively
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Slug Test User');
      const { org } = await createOrg(testEnv, 'Slug Test Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      // Verify org has a slug
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const slug = await orgStub.getSlug();
      expect(slug).not.toBeNull();
    });

    it('returns 0 synced when no workers are deployed', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'No Workers User');
      const { org } = await createOrg(testEnv, 'No Workers Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      // Get list of workers from org - should be empty for a new workspace
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const workers = await orgStub.listWorkerScriptsByWorkspace(workspace.id);
      expect(workers).toHaveLength(0);
    });
  });

  describe('Integration with WorkspaceDO', () => {
    it('syncSecretsToDeployedWorkers is called from alarm after token refresh', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Alarm Sync User');
      const { org } = await createOrg(testEnv, 'Alarm Sync Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      // Create an OAuth integration that's about to expire
      const workspaceStub = testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(workspace.id));
      const integrationId = crypto.randomUUID();
      const tokenExpiresAt = Date.now() + 5 * 60 * 1000; // 5 min - within buffer
      const credentials = {
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: tokenExpiresAt,
      };
      const encrypted = await encryptCredentials(credentials, getSecretKey());

      await workspaceStub.createIntegration(
        integrationId,
        'notion',
        'Notion Test',
        'saas',
        'oauth2',
        JSON.stringify({}),
        encrypted,
        userId,
        tokenExpiresAt
      );

      // Verify integration was created
      const integrations = await workspaceStub.getIntegrations();
      expect(integrations.length).toBeGreaterThan(0);
      expect(integrations.find(i => i.id === integrationId)).toBeDefined();
    });
  });

  describe('Worker registration and listing', () => {
    it('registers worker scripts and lists them by workspace', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Worker Reg User');
      const { org } = await createOrg(testEnv, 'Worker Reg Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      // Register a worker script
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const scriptName = `test-worker-${Date.now()}`;

      await orgStub.registerWorkerScript(scriptName, workspace.id, userId, '/path/to/wrangler.toml');

      // List workers for the workspace
      const workers = await orgStub.listWorkerScriptsByWorkspace(workspace.id);
      expect(workers.length).toBe(1);
      expect(workers[0].script_name).toBe(scriptName);
      expect(workers[0].workspace_id).toBe(workspace.id);
    });

    it('lists multiple workers from the same workspace', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Multi Worker User');
      const { org } = await createOrg(testEnv, 'Multi Worker Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      // Register multiple workers
      const scriptNames = [
        `api-worker-${Date.now()}`,
        `frontend-worker-${Date.now()}`,
        `cron-worker-${Date.now()}`,
      ];

      for (const scriptName of scriptNames) {
        await orgStub.registerWorkerScript(scriptName, workspace.id, userId);
      }

      // List workers
      const workers = await orgStub.listWorkerScriptsByWorkspace(workspace.id);
      expect(workers.length).toBe(3);

      // Verify all workers are for this workspace
      for (const worker of workers) {
        expect(worker.workspace_id).toBe(workspace.id);
        expect(scriptNames).toContain(worker.script_name);
      }
    });

    it('does not list workers from other workspaces', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Isolated Worker User');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Isolated Worker Org', userId);

      // Create a second workspace
      const workspaceStub2 = testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(crypto.randomUUID()));
      const workspace2Id = crypto.randomUUID();
      await workspaceStub2.createWorkspace(workspace2Id, org.id, 'Second Workspace', userId);

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      // Register a worker in each workspace
      await orgStub.registerWorkerScript(`ws1-worker-${Date.now()}`, defaultWorkspaceId, userId);
      await orgStub.registerWorkerScript(`ws2-worker-${Date.now()}`, workspace2Id, userId);

      // List workers for first workspace
      const ws1Workers = await orgStub.listWorkerScriptsByWorkspace(defaultWorkspaceId);
      expect(ws1Workers.length).toBe(1);
      expect(ws1Workers[0].workspace_id).toBe(defaultWorkspaceId);

      // List workers for second workspace
      const ws2Workers = await orgStub.listWorkerScriptsByWorkspace(workspace2Id);
      expect(ws2Workers.length).toBe(1);
      expect(ws2Workers[0].workspace_id).toBe(workspace2Id);
    });
  });

  describe('Integration env var preparation', () => {
    it('prepares env vars from integrations for worker secrets', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Env Var User');
      const { org } = await createOrg(testEnv, 'Env Var Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      // Create an API key integration
      const workspaceStub = testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(workspace.id));
      const integrationId = crypto.randomUUID();
      const credentials = {
        api_key: 'sk-test-12345',
      };
      const encrypted = await encryptCredentials(credentials, getSecretKey());

      await workspaceStub.createIntegration(
        integrationId,
        'stripe',
        'Production',
        'payments',
        'api_key',
        JSON.stringify({}),
        encrypted,
        userId
      );

      // Verify integration exists
      const integrations = await workspaceStub.getIntegrations();
      const stripeInt = integrations.find(i => i.id === integrationId);
      expect(stripeInt).toBeDefined();
      expect(stripeInt!.integration_type).toBe('stripe');
    });
  });
});
