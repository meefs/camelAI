'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useFetcher, useNavigate, useRevalidator } from 'react-router';
import { clearWarmupCache } from './use-workspace-warmup';

/**
 * Hook for logging out the current user.
 * After logout, navigates to /login.
 */
export function useLogout() {
  const fetcher = useFetcher();
  const navigate = useNavigate();

  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.success) {
      clearWarmupCache();
      navigate('/login');
    }
  }, [fetcher.state, fetcher.data, navigate]);

  const logout = useCallback(() => {
    fetcher.submit(null, { method: 'post', action: '/api/auth/logout' });
  }, [fetcher]);

  return {
    logout,
    isLoggingOut: fetcher.state !== 'idle',
  };
}

type PendingPromise = {
  resolve: () => void;
  reject: (error: Error) => void;
};

/**
 * Hook for switching the current workspace.
 * React Router will automatically revalidate loaders after the switch.
 * Returns a Promise that resolves when the switch completes successfully.
 */
export function useSwitchWorkspace() {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const pendingRef = useRef<PendingPromise | null>(null);

  // Resolve or reject the pending promise when the fetcher completes
  useEffect(() => {
    if (fetcher.state === 'idle' && pendingRef.current) {
      const pending = pendingRef.current;
      pendingRef.current = null;

      if (fetcher.data?.error) {
        pending.reject(new Error(fetcher.data.error));
      } else {
        pending.resolve();
      }
    }
  }, [fetcher.state, fetcher.data]);

  const switchWorkspace = useCallback(
    (workspaceId: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        pendingRef.current = { resolve, reject };
        fetcher.submit(JSON.stringify({ workspaceId }), {
          method: 'post',
          action: '/api/auth/switch-workspace',
          encType: 'application/json',
        });
      });
    },
    [fetcher]
  );

  return {
    switchWorkspace,
    isSwitching: fetcher.state !== 'idle',
    error: fetcher.data?.error as string | undefined,
  };
}

/**
 * Hook for switching the current organization.
 * React Router will automatically revalidate loaders after the switch.
 * Returns a Promise that resolves when the switch completes successfully.
 */
export function useSwitchOrg() {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const pendingRef = useRef<PendingPromise | null>(null);

  // Resolve or reject the pending promise when the fetcher completes
  useEffect(() => {
    if (fetcher.state === 'idle' && pendingRef.current) {
      const pending = pendingRef.current;
      pendingRef.current = null;

      if (fetcher.data?.error) {
        pending.reject(new Error(fetcher.data.error));
      } else {
        pending.resolve();
      }
    }
  }, [fetcher.state, fetcher.data]);

  const switchOrg = useCallback(
    (orgId: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        pendingRef.current = { resolve, reject };
        fetcher.submit(JSON.stringify({ orgId }), {
          method: 'post',
          action: '/api/auth/switch-org',
          encType: 'application/json',
        });
      });
    },
    [fetcher]
  );

  return {
    switchOrg,
    isSwitching: fetcher.state !== 'idle',
    error: fetcher.data?.error as string | undefined,
  };
}

/**
 * Hook for logging in a user.
 * On success, navigates to the redirect URL or home page.
 */
export function useLogin() {
  const fetcher = useFetcher();
  const navigate = useNavigate();

  // Navigate on success
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data && !fetcher.data.error) {
      // Get redirect from URL params or default to home
      const params = new URLSearchParams(window.location.search);
      const redirectTo = params.get('redirect') || '/';
      navigate(redirectTo);
    }
  }, [fetcher.state, fetcher.data, navigate]);

  return {
    login: (email: string, password: string) => {
      fetcher.submit(JSON.stringify({ email, password }), {
        method: 'post',
        action: '/api/auth/login',
        encType: 'application/json',
      });
    },
    isLoggingIn: fetcher.state !== 'idle',
    error: fetcher.data?.error as string | undefined,
  };
}

/**
 * Hook for signing up a new user.
 * On success, navigates to the home page.
 */
export function useSignup() {
  const fetcher = useFetcher();
  const navigate = useNavigate();

  // Navigate on success
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data && !fetcher.data.error) {
      navigate('/');
    }
  }, [fetcher.state, fetcher.data, navigate]);

  return {
    signup: (
      email: string,
      password: string,
      options?: {
        name?: string;
        redirectTo?: string;
        turnstileToken?: string;
      }
    ) => {
      fetcher.submit(
        JSON.stringify({
          email,
          password,
          name: options?.name,
          redirectTo: options?.redirectTo,
          turnstileToken: options?.turnstileToken,
        }),
        {
          method: 'post',
          action: '/api/auth/signup',
          encType: 'application/json',
        }
      );
    },
    isSigningUp: fetcher.state !== 'idle',
    error: fetcher.data?.error as string | undefined,
  };
}

/**
 * Hook to manually trigger a revalidation of auth data.
 * Use this after making changes that affect auth state but don't go through
 * the standard action flow (e.g., after accepting an invitation).
 */
export function useRefreshAuth() {
  const revalidator = useRevalidator();

  return {
    refreshAuth: () => revalidator.revalidate(),
    isRefreshing: revalidator.state === 'loading',
  };
}
