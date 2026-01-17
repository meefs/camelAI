'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import type { AuthState } from '@/types';
import {
  getAuthState,
  login as loginAction,
  logout as logoutAction,
  signup as signupAction,
  switchOrg as switchOrgAction,
  switchWorkspace as switchWorkspaceAction,
} from '@/lib/server-actions/auth';
import { useAutoWarmup, clearWarmupCache } from '@/hooks/use-workspace-warmup';

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
      loading: true,
      error: null,
    }
  );

  const safeSetState = useCallback((newState: AuthState | ((prev: AuthState) => AuthState)) => {
    setState(newState);
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      const data = await getAuthState();
      if (data) {
        safeSetState({
          user: data.user,
          currentOrg: data.currentOrg,
          currentWorkspace: data.currentWorkspace ?? null,
          orgs: data.orgs,
          workspaces: data.workspaces ?? [],
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
      const result = await loginAction(email, password);

      if (!result.success) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: result.error,
        }));
        throw new Error(result.error);
      }

      setState({
        user: result.data.user,
        currentOrg: result.data.currentOrg,
        currentWorkspace: result.data.currentWorkspace ?? null,
        orgs: result.data.orgs,
        workspaces: result.data.workspaces ?? [],
        loading: false,
        error: null,
      });
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
      const result = await signupAction(email, password, name);

      if (!result.success) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: result.error,
        }));
        throw new Error(result.error);
      }

      setState({
        user: result.data.user,
        currentOrg: result.data.currentOrg,
        currentWorkspace: result.data.currentWorkspace ?? null,
        orgs: result.data.orgs,
        workspaces: result.data.workspaces ?? [],
        loading: false,
        error: null,
      });
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
      await logoutAction();
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
      loading: false,
      error,
    });
  };

  const switchOrg = async (orgId: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      await switchOrgAction(orgId);
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
      await switchWorkspaceAction(workspaceId);
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
