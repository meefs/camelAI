/**
 * Workspace container routing tests using Cloudflare Vitest pool
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkspaceContainer, getContainerIdForWorkspace, getWorkspaceContainer } from '../src/workspace-container';
import type { WorkspaceContainerEnv } from '../src/workspace-container';
import type { OrgDO } from '../src/auth';
import type { WorkspaceDO } from '../src/workspace';

// Mock the OpenRouter key functions to avoid actual crypto in tests
vi.mock('../src/openrouter-keys', () => ({
  decryptOpenRouterKey: vi.fn().mockResolvedValue('sk-or-test-key-12345'),
  encryptOpenRouterKey: vi.fn().mockResolvedValue('mock-encrypted'),
  createOpenRouterKey: vi.fn(),
  getKeyHash: vi.fn().mockReturnValue('test-hash'),
}));

function buildEnvVarsForTest(workspaceId: string, orgId: string) {
  const fakeEnv = {
    TOKEN_SIGNING_SECRET: 'test-signing-secret-for-unit-tests-only',
    INTEGRATION_SECRET_KEY: 'test-integration-secret-key',
    WORKER_BASE_URL: 'https://test.chiridion.app',
    ORG: {
      get: () => ({
        getInfo: async () => ({ created_by: 'user-1', name: 'Test Org' }),
        // Return a mock key record - the actual decryption is mocked below
        getOpenRouterKeyRecord: async () => ({
          key_hash: 'test-hash',
          key_encrypted: 'mock-encrypted-value',
          name: 'Test Key',
        }),
      }),
      idFromName: (name: string) => name,
    } as unknown as DurableObjectNamespace<OrgDO>,
    WORKSPACE: {
      get: () => ({
        getIntegrations: async () => [],
      }),
      idFromName: (name: string) => name,
    } as unknown as DurableObjectNamespace<WorkspaceDO>,
  } as unknown as WorkspaceContainerEnv;

  const container = {
    env: fakeEnv,
    workspaceId: null,
    orgId: null,
  } as unknown as WorkspaceContainer;

  return WorkspaceContainer.prototype.buildEnvVars.call(container, workspaceId, orgId) as Promise<Record<string, string>>;
}

describe('container routing', () => {
  it('derives container ID from workspace ID', () => {
    const id = getContainerIdForWorkspace('workspace-123');
    expect(id).toBe('ws-workspace-123');
  });

  it('sanitizes special characters in workspace ID', () => {
    const id = getContainerIdForWorkspace('ws:with/chars');
    expect(id).toBe('ws-ws_with_chars');
  });

  it('truncates long workspace IDs to 63 chars', () => {
    const longId = 'w'.repeat(100);
    const id = getContainerIdForWorkspace(longId);
    expect(id.length).toBeLessThanOrEqual(63);
  });

  it('prefixes container ID with ws-', () => {
    const id = getContainerIdForWorkspace('abc');
    expect(id.startsWith('ws-')).toBe(true);
  });

  it('routes WebSocket to correct container', () => {
    const idFromName = vi.fn((name: string) => name as unknown);
    const get = vi.fn((id: unknown) => ({ id }));
    const env = {
      SANDBOX: { idFromName, get },
    } as unknown as WorkspaceContainerEnv;

    getWorkspaceContainer(env, 'ws:with/chars');

    expect(idFromName).toHaveBeenCalledWith('ws-ws_with_chars');
    expect(get).toHaveBeenCalledWith('ws-ws_with_chars');
  });

  it('passes workspaceId and orgId to container env', async () => {
    const envVars = await buildEnvVarsForTest('ws-1', 'org-1');
    expect(envVars.WORKSPACE_ID).toBe('ws-1');
    expect(envVars.ORG_ID).toBe('org-1');
  });

  it('sets R2 prefix to {orgId}/{workspaceId}/', async () => {
    const envVars = await buildEnvVarsForTest('ws-1', 'org-1');
    expect(envVars.R2_PREFIX).toBe('org-1/ws-1/');
  });

  it('keeps legacy R2 prefix for org-id workspaces', async () => {
    const envVars = await buildEnvVarsForTest('org-legacy', 'org-legacy');
    expect(envVars.R2_PREFIX).toBe('org-legacy/');
  });
});
