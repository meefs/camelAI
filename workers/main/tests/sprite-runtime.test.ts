import { describe, it, expect, vi } from 'vitest';
import { WorkspaceContainer, getContainerIdForWorkspace, getWorkspaceContainer } from '../src/workspace-container';
import type { WorkspaceContainerEnv } from '../src/workspace-container';
import type { OrgDO } from '../src/auth';
import type { WorkspaceDO } from '../src/workspace';

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

  const runtime = new WorkspaceContainer(fakeEnv, workspaceId, orgId);
  return runtime.buildEnvVars();
}

describe('sprite runtime', () => {
  it('derives runtime ID from workspace ID', () => {
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

  it('prefixes runtime ID with ws-', () => {
    const id = getContainerIdForWorkspace('abc');
    expect(id.startsWith('ws-')).toBe(true);
  });

  it('passes workspaceId and orgId to runtime env', async () => {
    const envVars = await buildEnvVarsForTest('ws-1', 'org-1');
    expect(envVars.WORKSPACE_ID).toBe('ws-1');
    expect(envVars.ORG_ID).toBe('org-1');
  });

  it('reuses cached runtime per workspace for same env object', () => {
    const env = {} as WorkspaceContainerEnv;
    const a = getWorkspaceContainer(env, 'ws-1', 'org-1');
    const b = getWorkspaceContainer(env, 'ws-1', 'org-1');
    expect(a).toBe(b);
  });
});
