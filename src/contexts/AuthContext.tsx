'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import type { AuthState } from '@/types';
import { getAuthState, login as loginAction, logout as logoutAction, signup as signupAction, switchOrg as switchOrgAction } from '@/lib/server-actions/auth';

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
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
      orgs: [],
      loading: true,
      error: null,
    }
  );

  const refreshAuth = useCallback(async () => {
    try {
      const data = await getAuthState();
      if (data) {
        setState({
          user: data.user,
          currentOrg: data.currentOrg,
          orgs: data.orgs,
          loading: false,
          error: null,
        });
      } else {
        setState({
          user: null,
          currentOrg: null,
          orgs: [],
          loading: false,
          error: null,
        });
      }
    } catch (e) {
      setState({
        user: null,
        currentOrg: null,
        orgs: [],
        loading: false,
        error: String(e),
      });
    }
  }, []);

  useEffect(() => {
    if (!initialState) {
      refreshAuth();
    }
  }, [initialState, refreshAuth]);

  const login = async (email: string, password: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const data = await loginAction(email, password);

      setState({
        user: data.user,
        currentOrg: data.currentOrg,
        orgs: data.orgs,
        loading: false,
        error: null,
      });
    } catch (e) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : 'Login failed',
      }));
      throw e;
    }
  };

  const signup = async (email: string, password: string, name?: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const data = await signupAction(email, password, name);

      setState({
        user: data.user,
        currentOrg: data.currentOrg,
        orgs: data.orgs,
        loading: false,
        error: null,
      });
    } catch (e) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : 'Signup failed',
      }));
      throw e;
    }
  };

  const logout = async () => {
    try {
      await logoutAction();
    } finally {
      setState({
        user: null,
        currentOrg: null,
        orgs: [],
        loading: false,
        error: null,
      });
    }
  };

  const switchOrg = async (orgId: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const currentOrg = await switchOrgAction(orgId);

      setState((prev) => ({
        ...prev,
        currentOrg,
        loading: false,
        error: null,
      }));
    } catch (e) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : 'Failed to switch organization',
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
        refreshAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
