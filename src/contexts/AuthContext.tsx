'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import type { User, Organization, OrgMembership, AuthState } from '@/types';

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
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [state, setState] = useState<AuthState>({
    user: null,
    currentOrg: null,
    orgs: [],
    loading: true,
    error: null,
  });

  const refreshAuth = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json() as {
          user: User;
          currentOrg: Organization;
          orgs: OrgMembership[];
        };
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
    refreshAuth();
  }, [refreshAuth]);

  const login = async (email: string, password: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json() as {
        error?: string;
        user: User;
        currentOrg: Organization;
        orgs: OrgMembership[];
      };

      if (!res.ok) {
        throw new Error(data.error || 'Login failed');
      }

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
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
      });

      const data = await res.json() as {
        error?: string;
        user: User;
        currentOrg: Organization;
        orgs: OrgMembership[];
      };

      if (!res.ok) {
        throw new Error(data.error || 'Signup failed');
      }

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
      await fetch('/api/auth/logout', { method: 'POST' });
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
      const res = await fetch('/api/auth/switch-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId }),
      });

      const data = await res.json() as {
        error?: string;
        currentOrg: Organization;
      };

      if (!res.ok) {
        throw new Error(data.error || 'Failed to switch organization');
      }

      setState((prev) => ({
        ...prev,
        currentOrg: data.currentOrg,
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
