/**
 * Tests for auth action hooks.
 *
 * These hooks use useFetcher() to perform auth mutations.
 * React Router auto-revalidates loaders after fetcher actions complete.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';

// Mock react-router's useFetcher and useNavigate
const mockSubmit = vi.fn();
const mockNavigate = vi.fn();
const mockRevalidate = vi.fn();

vi.mock('react-router', () => ({
  useFetcher: vi.fn(() => ({
    submit: mockSubmit,
    state: 'idle',
    data: null,
  })),
  useNavigate: vi.fn(() => mockNavigate),
  useRevalidator: vi.fn(() => ({
    revalidate: mockRevalidate,
    state: 'idle',
  })),
}));

// Mock clearWarmupCache
vi.mock('@/hooks/use-workspace-warmup', () => ({
  clearWarmupCache: vi.fn(),
}));

describe('useLogout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should submit logout request to correct endpoint', async () => {
    const { useFetcher } = await import('react-router');
    const { useLogout } = await import('@/hooks/use-auth-actions');

    const { result } = renderHook(() => useLogout());

    act(() => {
      result.current.logout();
    });

    expect(mockSubmit).toHaveBeenCalledWith(null, {
      method: 'post',
      action: '/api/auth/logout',
    });
  });

  it('should report isLoggingOut based on fetcher state', async () => {
    const { useFetcher } = await import('react-router');
    const { useLogout } = await import('@/hooks/use-auth-actions');

    // Test idle state
    vi.mocked(useFetcher).mockReturnValue({
      submit: mockSubmit,
      state: 'idle',
      data: null,
    } as any);

    const { result: idleResult } = renderHook(() => useLogout());
    expect(idleResult.current.isLoggingOut).toBe(false);

    // Test submitting state
    vi.mocked(useFetcher).mockReturnValue({
      submit: mockSubmit,
      state: 'submitting',
      data: null,
    } as any);

    const { result: submittingResult } = renderHook(() => useLogout());
    expect(submittingResult.current.isLoggingOut).toBe(true);
  });
});

describe('useSwitchWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should submit switch request with JSON body', async () => {
    const { useNavigate, useFetcher } = await import('react-router');
    const { useSwitchWorkspace } = await import('@/hooks/use-auth-actions');

    const { result } = renderHook(() => useSwitchWorkspace());

    act(() => {
      result.current.switchWorkspace('workspace-123');
    });

    expect(mockSubmit).toHaveBeenCalledWith(
      JSON.stringify({ workspaceId: 'workspace-123' }),
      {
        method: 'post',
        action: '/api/auth/switch-workspace',
        encType: 'application/json',
      }
    );
  });

  it('should return a Promise that resolves on success', async () => {
    vi.resetModules();
    const { useFetcher } = await import('react-router');
    const { useSwitchWorkspace } = await import('@/hooks/use-auth-actions');

    // Start with submitting state
    let mockState = 'submitting';
    let mockData: { success?: boolean; error?: string } | null = null;
    vi.mocked(useFetcher).mockImplementation(() => ({
      submit: mockSubmit,
      state: mockState,
      data: mockData,
    } as any));

    const { result, rerender } = renderHook(() => useSwitchWorkspace());

    let resolved = false;
    let rejected = false;
    act(() => {
      result.current.switchWorkspace('workspace-123').then(
        () => { resolved = true; },
        () => { rejected = true; }
      );
    });

    expect(resolved).toBe(false);
    expect(rejected).toBe(false);

    // Simulate fetcher completing successfully
    mockState = 'idle';
    mockData = { success: true };
    vi.mocked(useFetcher).mockImplementation(() => ({
      submit: mockSubmit,
      state: mockState,
      data: mockData,
    } as any));
    rerender();

    // Wait for microtask to resolve promise
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(resolved).toBe(true);
    expect(rejected).toBe(false);
  });

  it('should return a Promise that rejects on error', async () => {
    vi.resetModules();
    const { useFetcher } = await import('react-router');
    const { useSwitchWorkspace } = await import('@/hooks/use-auth-actions');

    // Start with submitting state
    let mockState = 'submitting';
    let mockData: { success?: boolean; error?: string } | null = null;
    vi.mocked(useFetcher).mockImplementation(() => ({
      submit: mockSubmit,
      state: mockState,
      data: mockData,
    } as any));

    const { result, rerender } = renderHook(() => useSwitchWorkspace());

    let resolved = false;
    let rejectedError: unknown = null;
    act(() => {
      result.current.switchWorkspace('workspace-123').then(
        () => { resolved = true; },
        (err) => { rejectedError = err; }
      );
    });

    expect(resolved).toBe(false);
    expect(rejectedError).toBe(null);

    // Simulate fetcher completing with error
    mockState = 'idle';
    mockData = { error: 'Workspace not found' };
    vi.mocked(useFetcher).mockImplementation(() => ({
      submit: mockSubmit,
      state: mockState,
      data: mockData,
    } as any));
    rerender();

    // Wait for microtask to resolve promise
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(resolved).toBe(false);
    expect(rejectedError).toBeInstanceOf(Error);
    expect((rejectedError as Error).message).toBe('Workspace not found');
  });

  it('should report isSwitching based on fetcher state', async () => {
    const { useFetcher } = await import('react-router');
    const { useSwitchWorkspace } = await import('@/hooks/use-auth-actions');

    vi.mocked(useFetcher).mockReturnValue({
      submit: mockSubmit,
      state: 'loading',
      data: null,
    } as any);

    const { result } = renderHook(() => useSwitchWorkspace());
    expect(result.current.isSwitching).toBe(true);
  });

  it('should expose error from fetcher data', async () => {
    const { useFetcher } = await import('react-router');
    const { useSwitchWorkspace } = await import('@/hooks/use-auth-actions');

    vi.mocked(useFetcher).mockReturnValue({
      submit: mockSubmit,
      state: 'idle',
      data: { error: 'Workspace not found' },
    } as any);

    const { result } = renderHook(() => useSwitchWorkspace());
    expect(result.current.error).toBe('Workspace not found');
  });
});

describe('useSwitchOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should submit switch request with JSON body', async () => {
    const { useFetcher } = await import('react-router');
    const { useSwitchOrg } = await import('@/hooks/use-auth-actions');

    const { result } = renderHook(() => useSwitchOrg());

    act(() => {
      result.current.switchOrg('org-456');
    });

    expect(mockSubmit).toHaveBeenCalledWith(
      JSON.stringify({ orgId: 'org-456' }),
      {
        method: 'post',
        action: '/api/auth/switch-org',
        encType: 'application/json',
      }
    );
  });

  it('should return a Promise that resolves on success', async () => {
    vi.resetModules();
    const { useFetcher } = await import('react-router');
    const { useSwitchOrg } = await import('@/hooks/use-auth-actions');

    // Start with submitting state
    let mockState = 'submitting';
    let mockData: { success?: boolean; error?: string } | null = null;
    vi.mocked(useFetcher).mockImplementation(() => ({
      submit: mockSubmit,
      state: mockState,
      data: mockData,
    } as any));

    const { result, rerender } = renderHook(() => useSwitchOrg());

    let resolved = false;
    let rejected = false;
    act(() => {
      result.current.switchOrg('org-456').then(
        () => { resolved = true; },
        () => { rejected = true; }
      );
    });

    expect(resolved).toBe(false);
    expect(rejected).toBe(false);

    // Simulate fetcher completing successfully
    mockState = 'idle';
    mockData = { success: true };
    vi.mocked(useFetcher).mockImplementation(() => ({
      submit: mockSubmit,
      state: mockState,
      data: mockData,
    } as any));
    rerender();

    // Wait for microtask to resolve promise
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(resolved).toBe(true);
    expect(rejected).toBe(false);
  });

  it('should return a Promise that rejects on error', async () => {
    vi.resetModules();
    const { useFetcher } = await import('react-router');
    const { useSwitchOrg } = await import('@/hooks/use-auth-actions');

    // Start with submitting state
    let mockState = 'submitting';
    let mockData: { success?: boolean; error?: string } | null = null;
    vi.mocked(useFetcher).mockImplementation(() => ({
      submit: mockSubmit,
      state: mockState,
      data: mockData,
    } as any));

    const { result, rerender } = renderHook(() => useSwitchOrg());

    let resolved = false;
    let rejectedError: unknown = null;
    act(() => {
      result.current.switchOrg('org-456').then(
        () => { resolved = true; },
        (err) => { rejectedError = err; }
      );
    });

    expect(resolved).toBe(false);
    expect(rejectedError).toBe(null);

    // Simulate fetcher completing with error
    mockState = 'idle';
    mockData = { error: 'Org not found' };
    vi.mocked(useFetcher).mockImplementation(() => ({
      submit: mockSubmit,
      state: mockState,
      data: mockData,
    } as any));
    rerender();

    // Wait for microtask to resolve promise
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(resolved).toBe(false);
    expect(rejectedError).toBeInstanceOf(Error);
    expect((rejectedError as Error).message).toBe('Org not found');
  });
});

describe('useRefreshAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call revalidator.revalidate()', async () => {
    const { useRefreshAuth } = await import('@/hooks/use-auth-actions');

    const { result } = renderHook(() => useRefreshAuth());

    act(() => {
      result.current.refreshAuth();
    });

    expect(mockRevalidate).toHaveBeenCalled();
  });

  it('should report isRefreshing based on revalidator state', async () => {
    const { useRevalidator } = await import('react-router');
    const { useRefreshAuth } = await import('@/hooks/use-auth-actions');

    vi.mocked(useRevalidator).mockReturnValue({
      revalidate: mockRevalidate,
      state: 'loading',
    } as any);

    const { result } = renderHook(() => useRefreshAuth());
    expect(result.current.isRefreshing).toBe(true);
  });
});

describe('useLogin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should submit login request with credentials', async () => {
    const { useFetcher } = await import('react-router');
    const { useLogin } = await import('@/hooks/use-auth-actions');

    const { result } = renderHook(() => useLogin());

    act(() => {
      result.current.login('test@example.com', 'password123');
    });

    expect(mockSubmit).toHaveBeenCalledWith(
      JSON.stringify({ email: 'test@example.com', password: 'password123' }),
      {
        method: 'post',
        action: '/api/auth/login',
        encType: 'application/json',
      }
    );
  });
});

describe('useSignup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should submit signup request with credentials and optional name', async () => {
    const { useFetcher } = await import('react-router');
    const { useSignup } = await import('@/hooks/use-auth-actions');

    const { result } = renderHook(() => useSignup());

    act(() => {
      result.current.signup('test@example.com', 'password123', 'Test User');
    });

    expect(mockSubmit).toHaveBeenCalledWith(
      JSON.stringify({ email: 'test@example.com', password: 'password123', name: 'Test User' }),
      {
        method: 'post',
        action: '/api/auth/signup',
        encType: 'application/json',
      }
    );
  });

  it('should handle signup without name', async () => {
    const { useFetcher } = await import('react-router');
    const { useSignup } = await import('@/hooks/use-auth-actions');

    const { result } = renderHook(() => useSignup());

    act(() => {
      result.current.signup('test@example.com', 'password123');
    });

    expect(mockSubmit).toHaveBeenCalledWith(
      JSON.stringify({ email: 'test@example.com', password: 'password123', name: undefined }),
      {
        method: 'post',
        action: '/api/auth/signup',
        encType: 'application/json',
      }
    );
  });
});
