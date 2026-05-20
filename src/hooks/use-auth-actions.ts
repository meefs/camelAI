'use client';

import { useCallback, useRef, useState } from 'react';
import { useNavigate, useRevalidator } from 'react-router';
import { clearWarmupCache } from './use-workspace-warmup';

type AuthActionResponse = {
  success?: boolean;
  error?: string;
  redirect?: string;
};

async function postJsonAction(
  url: string,
  body?: Record<string, unknown>,
): Promise<AuthActionResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json')
    ? ((await response.json()) as AuthActionResponse)
    : {};

  if (!response.ok || data.error) {
    throw new Error(
      data.error ?? `Request failed with status ${response.status}`,
    );
  }

  return data;
}

/**
 * Hook for logging out the current user.
 * After logout, navigates to /login.
 */
export function useLogout() {
  const navigate = useNavigate();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const logout = useCallback(async () => {
    setIsLoggingOut(true);
    setError(undefined);
    try {
      await postJsonAction('/api/auth/logout');
      clearWarmupCache();
      navigate('/login');
    } catch (caught) {
      const nextError =
        caught instanceof Error ? caught.message : 'Failed to log out';
      setError(nextError);
      console.error('Failed to log out:', caught);
    } finally {
      setIsLoggingOut(false);
    }
  }, [navigate]);

  return {
    logout,
    isLoggingOut,
    error,
  };
}

let activeWorkspaceSwitchController: AbortController | null = null;

export class WorkspaceSwitchSupersededError extends Error {
  constructor() {
    super('Workspace switch was superseded');
    this.name = 'WorkspaceSwitchSupersededError';
  }
}

export function isWorkspaceSwitchSupersededError(
  error: unknown,
): error is WorkspaceSwitchSupersededError {
  return error instanceof WorkspaceSwitchSupersededError;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Hook for switching the current workspace.
 * Explicitly revalidates loaders after the session cookie changes.
 * Returns a Promise that resolves when the switch completes successfully.
 */
export function useSwitchWorkspace() {
  const revalidator = useRevalidator();
  const requestIdRef = useRef(0);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const switchWorkspace = useCallback(
    async (workspaceId: string): Promise<void> => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setIsSwitching(true);
      setError(undefined);
      activeWorkspaceSwitchController?.abort();
      const controller = new AbortController();
      activeWorkspaceSwitchController = controller;

      try {
        const response = await fetch('/api/auth/switch-workspace', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ workspaceId }),
          credentials: 'same-origin',
          signal: controller.signal,
        });
        const contentType = response.headers.get('content-type') ?? '';
        const data = contentType.includes('application/json')
          ? ((await response.json()) as { error?: string })
          : {};

        if (!response.ok || data.error) {
          throw new Error(data.error ?? 'Failed to switch workspace');
        }

        revalidator.revalidate();
      } catch (caught) {
        if (isAbortError(caught)) {
          throw new WorkspaceSwitchSupersededError();
        }

        const nextError =
          caught instanceof Error
            ? caught
            : new Error('Failed to switch workspace');
        if (requestIdRef.current === requestId) {
          setError(nextError.message);
        }
        throw nextError;
      } finally {
        if (activeWorkspaceSwitchController === controller) {
          activeWorkspaceSwitchController = null;
        }
        if (requestIdRef.current === requestId) {
          setIsSwitching(false);
        }
      }
    },
    [revalidator]
  );

  return {
    switchWorkspace,
    isSwitching,
    error,
  };
}

/**
 * Hook for switching the current organization.
 * Explicitly revalidates loaders after the session cookie changes.
 * Returns a Promise that resolves when the switch completes successfully.
 */
export function useSwitchOrg() {
  const revalidator = useRevalidator();
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const switchOrg = useCallback(
    async (orgId: string): Promise<void> => {
      setIsSwitching(true);
      setError(undefined);
      try {
        await postJsonAction('/api/auth/switch-org', { orgId });
        revalidator.revalidate();
      } catch (caught) {
        const nextError =
          caught instanceof Error
            ? caught
            : new Error('Failed to switch organization');
        setError(nextError.message);
        throw nextError;
      } finally {
        setIsSwitching(false);
      }
    },
    [revalidator]
  );

  return {
    switchOrg,
    isSwitching,
    error,
  };
}

/**
 * Hook for logging in a user.
 * On success, navigates to the redirect URL or home page.
 */
export function useLogin() {
  const navigate = useNavigate();
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      setIsLoggingIn(true);
      setError(undefined);
      try {
        const data = await postJsonAction('/api/auth/login', {
          email,
          password,
        });
        if (data.redirect) {
          navigate(data.redirect);
          return;
        }

        const params = new URLSearchParams(window.location.search);
        const redirectTo = params.get('redirect') || '/';
        navigate(redirectTo);
      } catch (caught) {
        const nextError =
          caught instanceof Error ? caught.message : 'Failed to log in';
        setError(nextError);
      } finally {
        setIsLoggingIn(false);
      }
    },
    [navigate],
  );

  return {
    login,
    isLoggingIn,
    error,
  };
}

/**
 * Hook for signing up a new user.
 * On success, navigates to the home page.
 */
export function useSignup() {
  const navigate = useNavigate();
  const [isSigningUp, setIsSigningUp] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const signup = useCallback(
    async (
      email: string,
      password: string,
      options?: {
        name?: string;
        redirectTo?: string;
        turnstileToken?: string;
      },
    ): Promise<void> => {
      setIsSigningUp(true);
      setError(undefined);
      try {
        const data = await postJsonAction('/api/auth/signup', {
          email,
          password,
          name: options?.name,
          redirectTo: options?.redirectTo,
          turnstileToken: options?.turnstileToken,
        });
        navigate(data.redirect ?? options?.redirectTo ?? '/');
      } catch (caught) {
        const nextError =
          caught instanceof Error ? caught.message : 'Failed to sign up';
        setError(nextError);
      } finally {
        setIsSigningUp(false);
      }
    },
    [navigate],
  );

  return {
    signup,
    isSigningUp,
    error,
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
