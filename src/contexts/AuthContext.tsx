'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import type { AuthState } from '@/types';
import { useAutoWarmup, clearWarmupCache } from '@/hooks/use-workspace-warmup';

// API functions for React Router (replaces server actions)
async function fetchAuthState(): Promise<AuthState | null> {
  try {
    const response = await fetch('/api/auth/state');
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function loginApi(email: string, password: string): Promise<{ success: boolean; error?: string }> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json() as { error?: string };
  if (!response.ok) {
    return { success: false, error: data.error || 'Login failed' };
  }
  return { success: true };
}

async function signupApi(email: string, password: string, name?: string): Promise<{ success: boolean; error?: string }> {
  const response = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  const data = await response.json() as { error?: string };
  if (!response.ok) {
    return { success: false, error: data.error || 'Signup failed' };
  }
  return { success: true };
}

async function logoutApi(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
}

async function switchOrgApi(orgId: string): Promise<void> {
  const response = await fetch('/api/auth/switch-org', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgId }),
  });
  if (!response.ok) {
    const data = await response.json() as { error?: string };
    throw new Error(data.error || 'Failed to switch organization');
  }
}

async function switchWorkspaceApi(workspaceId: string): Promise<void> {
  const response = await fetch('/api/auth/switch-workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  });
  if (!response.ok) {
    const data = await response.json() as { error?: string };
    throw new Error(data.error || 'Failed to switch workspace');
  }
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
  switchWorkspace: (workspaceId: string) => Promise<void>;
  refreshAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export function useOptionalAuth() {
  return useContext(AuthContext);
}

interface AuthProviderProps {
  children: ReactNode;
  initialState?: AuthState;
}

export function AuthProvider({ children, initialState }: AuthProviderProps) {
  const [state, setState] = useState<AuthState>(
    initialState ?? {
      user: null,
      currentOrg: null,
      currentWorkspace: null,
      orgs: [],
      workspaces: [],
      allWorkspaces: [],
      loading: true,
      error: null,
    }
  );

  const safeSetState = useCallback((newState: AuthState | ((prev: AuthState) => AuthState)) => {
    setState(newState);
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      const data = await fetchAuthState();
      if (data) {
        safeSetState({
          user: data.user,
          currentOrg: data.currentOrg,
          currentWorkspace: data.currentWorkspace ?? null,
          orgs: data.orgs,
          workspaces: data.workspaces ?? [],
          allWorkspaces: data.allWorkspaces ?? [],
          loading: false,
          error: null,
        });
      } else {
        safeSetState({
          user: null,
          currentOrg: null,
          currentWorkspace: null,
          orgs: [],
          workspaces: [],
          allWorkspaces: [],
          loading: false,
          error: null,
        });
      }
    } catch (e) {
      safeSetState({
        user: null,
        currentOrg: null,
        currentWorkspace: null,
        orgs: [],
        workspaces: [],
        allWorkspaces: [],
        loading: false,
        error: String(e),
      });
    }
  }, [safeSetState]);

  useEffect(() => {
    if (!initialState) {
      refreshAuth();
    }
  }, [initialState, refreshAuth]);

  // Automatically warm up the current workspace when it changes
  // This triggers on login, signup, workspace switch, org switch, and initial load
  useAutoWarmup(state.currentWorkspace?.id);

  const login = async (email: string, password: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const result = await loginApi(email, password);

      if (!result.success) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: result.error || 'Login failed',
        }));
        throw new Error(result.error || 'Login failed');
      }

      // Refresh auth state after successful login
      await refreshAuth();
    } catch (e) {
      // Handle unexpected errors (network, DO failures, etc.)
      const error = e instanceof Error ? e.message : 'Login failed';
      setState((prev) => ({
        ...prev,
        loading: false,
        error,
      }));
      throw e;
    }
  };

  const signup = async (email: string, password: string, name?: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const result = await signupApi(email, password, name);

      if (!result.success) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: result.error || 'Signup failed',
        }));
        throw new Error(result.error || 'Signup failed');
      }

      // Refresh auth state after successful signup
      await refreshAuth();
    } catch (e) {
      // Handle unexpected errors (network, DO failures, etc.)
      const error = e instanceof Error ? e.message : 'Signup failed';
      setState((prev) => ({
        ...prev,
        loading: false,
        error,
      }));
      throw e;
    }
  };

  const logout = async () => {
    let error: string | null = null;
    try {
      await logoutApi();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Logout failed';
    }

    // Clear warmup cache so next login triggers fresh warmup
    clearWarmupCache();

    // Always clear local state, even if server logout failed
    setState({
      user: null,
      currentOrg: null,
      currentWorkspace: null,
      orgs: [],
      workspaces: [],
      allWorkspaces: [],
      loading: false,
      error,
    });
  };

  const switchOrg = async (orgId: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      await switchOrgApi(orgId);
      // After switching org, refresh to get new workspace state
      await refreshAuth();
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Failed to switch organization';
      setState((prev) => ({
        ...prev,
        loading: false,
        error,
      }));
      throw e;
    }
  };

  const switchWorkspace = async (workspaceId: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      await switchWorkspaceApi(workspaceId);
      await refreshAuth();
    } catch (e) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : 'Failed to switch workspace',
      }));
      throw e;
    }
  };

  return (
    <AuthContext.Provider
      value={{
        ...state,
        login,
        signup,
        logout,
        switchOrg,
        switchWorkspace,
        refreshAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
