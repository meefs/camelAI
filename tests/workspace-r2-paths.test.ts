import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceScopedR2Key,
  getWorkspaceR2Prefix,
} from '@/lib/workspace-r2-paths';

describe('workspace-r2-paths', () => {
  it('uses org/workspace prefix', () => {
    expect(getWorkspaceR2Prefix('org-1', 'ws-1')).toBe('org-1/ws-1');
    expect(
      buildWorkspaceScopedR2Key('org-1', 'ws-1', 'user-uploads/file.txt')
    ).toBe('org-1/ws-1/user-uploads/file.txt');
  });

  it('still includes workspaceId when ids happen to match', () => {
    expect(getWorkspaceR2Prefix('org-1', 'org-1')).toBe('org-1/org-1');
    expect(
      buildWorkspaceScopedR2Key('org-1', 'org-1', 'user-uploads/file.txt')
    ).toBe('org-1/org-1/user-uploads/file.txt');
  });

  it('trims leading slash from relative path', () => {
    expect(
      buildWorkspaceScopedR2Key('org-1', 'org-1', '/user-outputs/result.json')
    ).toBe('org-1/org-1/user-outputs/result.json');
  });
});
