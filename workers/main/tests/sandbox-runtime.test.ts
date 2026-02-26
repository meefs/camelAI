import { describe, it, expect, vi } from 'vitest';
import { WorkspaceContainer } from '../src/workspace-container';
import type { WorkspaceContainerEnv } from '../src/workspace-container';

describe('sandbox runtime', () => {
  it('creates independent instances per call', () => {
    const env = {} as WorkspaceContainerEnv;
    const a = new WorkspaceContainer(env, 'ws-1', 'org-1');
    const b = new WorkspaceContainer(env, 'ws-1', 'org-1');
    expect(a).not.toBe(b);
  });

  it('returns false when integration env refresh cannot fetch vars', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const env = {
      INTEGRATION_SECRET_KEY: 'test-secret',
      WORKSPACE: {
        idFromName() {
          throw new Error('workspace lookup failed');
        },
      },
    } as unknown as WorkspaceContainerEnv;

    const container = new WorkspaceContainer(env, 'ws-1', 'org-1');
    await expect(container.refreshIntegrationEnvVars()).resolves.toBe(false);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
