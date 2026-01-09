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
          orgs: data.orgs,
          loading: false,
          error: null,
        });
      } else {
        safeSetState({
          user: null,
          currentOrg: null,
          orgs: [],
          loading: false,
          error: null,
        });
      }
    } catch (e) {
      safeSetState({
        user: null,
        currentOrg: null,
        orgs: [],
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

  const login = async (email: string, password: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

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
      orgs: result.data.orgs,
      loading: false,
      error: null,
    });
  };

  const signup = async (email: string, password: string, name?: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

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
      orgs: result.data.orgs,
      loading: false,
      error: null,
    });
  };

  const logout = async () => {
    const result = await logoutAction();

    // Always clear local state, even if server logout failed
    setState({
      user: null,
      currentOrg: null,
      orgs: [],
      loading: false,
      error: result.success ? null : result.error,
    });
  };

  const switchOrg = async (orgId: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    const result = await switchOrgAction(orgId);

    if (!result.success) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: result.error,
      }));
      throw new Error(result.error);
    }

    setState((prev) => ({
      ...prev,
      currentOrg: result.data,
      loading: false,
      error: null,
    }));
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
