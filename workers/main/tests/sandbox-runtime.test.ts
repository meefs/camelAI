import { describe, it, expect } from 'vitest';
import { WorkspaceContainer } from '../src/workspace-container';
import type { WorkspaceContainerEnv } from '../src/workspace-container';

describe('sandbox runtime', () => {
  it('creates independent instances per call', () => {
    const env = {} as WorkspaceContainerEnv;
    const a = new WorkspaceContainer(env, 'ws-1', 'org-1');
    const b = new WorkspaceContainer(env, 'ws-1', 'org-1');
    expect(a).not.toBe(b);
  });
});
