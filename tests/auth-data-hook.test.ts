/**
 * Tests for useAuthData and useOptionalAuthData hooks.
 *
 * These hooks access auth state from the _app layout's loader data
 * using React Router's useRouteLoaderData().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock useRouteLoaderData
const mockUseRouteLoaderData = vi.fn();

vi.mock('react-router', () => ({
  useRouteLoaderData: (...args: unknown[]) => mockUseRouteLoaderData(...args),
}));

describe('useAuthData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('should return auth state from _app loader data', async () => {
    const mockAuthState = {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      currentOrg: { id: 'org-1', name: 'Test Org' },
      currentWorkspace: { id: 'ws-1', name: 'Test Workspace' },
      orgs: [{ org_id: 'org-1', org_name: 'Test Org', role: 'owner' }],
      workspaces: [{ id: 'ws-1', name: 'Test Workspace' }],
      allWorkspaces: [{ id: 'ws-1', name: 'Test Workspace' }],
      loading: false,
      error: null,
    };

    mockUseRouteLoaderData.mockReturnValue({ authState: mockAuthState });

    const { useAuthData } = await import('@/hooks/use-auth-data');
    const { result } = renderHook(() => useAuthData());

    expect(result.current).toEqual(mockAuthState);
    expect(mockUseRouteLoaderData).toHaveBeenCalledWith('routes/_app');
  });

  it('should throw error when used outside _app layout', async () => {
    mockUseRouteLoaderData.mockReturnValue(undefined);

    const { useAuthData } = await import('@/hooks/use-auth-data');

    expect(() => {
      renderHook(() => useAuthData());
    }).toThrow('useAuthData must be used within a route under _app layout');
  });

  it('should throw error when authState is missing from loader data', async () => {
    mockUseRouteLoaderData.mockReturnValue({ someOtherData: 'foo' });

    const { useAuthData } = await import('@/hooks/use-auth-data');

    expect(() => {
      renderHook(() => useAuthData());
    }).toThrow('useAuthData must be used within a route under _app layout');
  });
});

describe('useOptionalAuthData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('should return auth state when available', async () => {
    const mockAuthState = {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      currentOrg: { id: 'org-1', name: 'Test Org' },
      currentWorkspace: null,
      orgs: [],
      workspaces: [],
      allWorkspaces: [],
      loading: false,
      error: null,
    };

    mockUseRouteLoaderData.mockReturnValue({ authState: mockAuthState });

    const { useOptionalAuthData } = await import('@/hooks/use-auth-data');
    const { result } = renderHook(() => useOptionalAuthData());

    expect(result.current).toEqual(mockAuthState);
  });

  it('should return null when used outside _app layout', async () => {
    mockUseRouteLoaderData.mockReturnValue(undefined);

    const { useOptionalAuthData } = await import('@/hooks/use-auth-data');
    const { result } = renderHook(() => useOptionalAuthData());

    expect(result.current).toBeNull();
  });

  it('should return null when authState is missing', async () => {
    mockUseRouteLoaderData.mockReturnValue({ someOtherData: 'foo' });

    const { useOptionalAuthData } = await import('@/hooks/use-auth-data');
    const { result } = renderHook(() => useOptionalAuthData());

    expect(result.current).toBeNull();
  });
});
