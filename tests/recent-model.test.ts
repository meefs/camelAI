import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRecentModel, setRecentModel } from '@/lib/recent-model';

describe('recent model localStorage helpers', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null for empty or invalid storage values', () => {
    const scope = { orgId: 'org-a', workspaceId: 'ws-a' };
    expect(getRecentModel(scope)).toBeNull();

    window.localStorage.setItem('camelai.recentModel.org-a.ws-a', 'nope');
    expect(getRecentModel(scope)).toBeNull();
  });

  it('round-trips a valid model by org and workspace scope', () => {
    const scope = { orgId: 'org-a', workspaceId: 'ws-a' };
    setRecentModel(scope, 'opus');

    expect(getRecentModel(scope)).toBe('opus');
    expect(getRecentModel({ orgId: 'org-a', workspaceId: 'ws-b' })).toBeNull();
    expect(getRecentModel({ orgId: 'org-b', workspaceId: 'ws-a' })).toBeNull();
  });

  it('is safe without a browser window', () => {
    vi.stubGlobal('window', undefined);

    expect(getRecentModel({ orgId: 'org-a', workspaceId: 'ws-a' })).toBeNull();
    expect(() =>
      setRecentModel({ orgId: 'org-a', workspaceId: 'ws-a' }, 'opus'),
    ).not.toThrow();
  });

  it('is safe when localStorage methods throw', () => {
    const storagePrototype = Object.getPrototypeOf(window.localStorage) as Storage;
    const getItemSpy = vi
      .spyOn(storagePrototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('blocked');
      });
    const setItemSpy = vi
      .spyOn(storagePrototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('blocked');
      });

    expect(getRecentModel({ orgId: 'org-a', workspaceId: 'ws-a' })).toBeNull();
    expect(() =>
      setRecentModel({ orgId: 'org-a', workspaceId: 'ws-a' }, 'opus'),
    ).not.toThrow();

    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
  });
});
