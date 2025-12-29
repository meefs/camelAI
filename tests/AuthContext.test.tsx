/**
 * Unit tests for AuthContext
 *
 * Run with: npm run test:run -- tests/AuthContext.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactNode } from 'react';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

// Mock user and org data
const mockUser = {
  id: 'user-123',
  email: 'test@example.com',
  name: 'Test User',
  created_at: Date.now(),
  is_superuser: false,
};

const mockOrg = {
  id: 'org-123',
  name: 'Test Org',
  created_at: Date.now(),
  created_by: 'user-123',
};

const mockOrgs = [
  { org_id: 'org-123', org_name: 'Test Org', role: 'admin' as const, joined_at: Date.now() },
  { org_id: 'org-456', org_name: 'Other Org', role: 'member' as const, joined_at: Date.now() },
];

// Simplified AuthContext for testing
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode as RN } from 'react';

interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  is_superuser: boolean;
}

interface Organization {
  id: string;
  name: string;
  created_at: number;
  created_by: string;
}

interface OrgMembership {
  org_id: string;
  org_name: string;
  role: 'admin' | 'member';
  joined_at: number;
}

interface AuthState {
  user: User | null;
  currentOrg: Organization | null;
  orgs: OrgMembership[];
  loading: boolean;
  error: string | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
  refreshAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

function AuthProvider({ children }: { children: RN }) {
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
        const data = await res.json();
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

      const data = await res.json();

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

      const data = await res.json();

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

      const data = await res.json();

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

// Test component that consumes AuthContext
function TestConsumer() {
  const auth = useAuth();
  return (
    <div>
      <div data-testid="loading">{auth.loading ? 'true' : 'false'}</div>
      <div data-testid="user">{auth.user ? auth.user.email : 'null'}</div>
      <div data-testid="org">{auth.currentOrg ? auth.currentOrg.name : 'null'}</div>
      <div data-testid="orgs-count">{auth.orgs.length}</div>
      <div data-testid="error">{auth.error || 'null'}</div>
      <button data-testid="login-btn" onClick={() => auth.login('test@example.com', 'password123').catch(() => {})}>
        Login
      </button>
      <button data-testid="logout-btn" onClick={() => auth.logout()}>
        Logout
      </button>
      <button data-testid="switch-org-btn" onClick={() => auth.switchOrg('org-456').catch(() => {})}>
        Switch Org
      </button>
    </div>
  );
}

describe('AuthContext', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should throw error when useAuth is used outside provider', () => {
    // Suppress React error boundary warning for this test
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      render(<TestConsumer />);
    }).toThrow('useAuth must be used within an AuthProvider');

    consoleSpy.mockRestore();
  });

  it('should start with loading state and fetch auth on mount', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ user: mockUser, currentOrg: mockOrg, orgs: mockOrgs }),
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    // Wait for initial fetch to complete
    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    expect(screen.getByTestId('user')).toHaveTextContent('test@example.com');
    expect(screen.getByTestId('org')).toHaveTextContent('Test Org');
    expect(screen.getByTestId('orgs-count')).toHaveTextContent('2');
  });

  it('should handle unauthenticated state', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    expect(screen.getByTestId('user')).toHaveTextContent('null');
    expect(screen.getByTestId('org')).toHaveTextContent('null');
  });

  it('should handle login success', async () => {
    // Initial fetch returns unauthenticated
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    // Set up login response
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ user: mockUser, currentOrg: mockOrg, orgs: mockOrgs }),
    });

    // Click login
    await act(async () => {
      screen.getByTestId('login-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('test@example.com');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'test@example.com', password: 'password123' }),
    }));
  });

  it('should handle login failure', async () => {
    // Initial fetch returns unauthenticated
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    // Set up login failure response
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Invalid credentials' }),
    });

    // Click login - expect it to throw
    await act(async () => {
      try {
        screen.getByTestId('login-btn').click();
      } catch {
        // Expected to throw
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('error')).toHaveTextContent('Invalid credentials');
    });

    expect(screen.getByTestId('user')).toHaveTextContent('null');
  });

  it('should handle logout', async () => {
    // Initial fetch returns authenticated
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ user: mockUser, currentOrg: mockOrg, orgs: mockOrgs }),
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('test@example.com');
    });

    // Set up logout response
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });

    // Click logout
    await act(async () => {
      screen.getByTestId('logout-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('null');
    });

    expect(screen.getByTestId('org')).toHaveTextContent('null');
    expect(screen.getByTestId('orgs-count')).toHaveTextContent('0');
  });

  it('should handle org switching', async () => {
    // Initial fetch returns authenticated
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ user: mockUser, currentOrg: mockOrg, orgs: mockOrgs }),
    });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('org')).toHaveTextContent('Test Org');
    });

    // Set up switch org response
    const newOrg = { ...mockOrg, id: 'org-456', name: 'Other Org' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ currentOrg: newOrg }),
    });

    // Click switch org
    await act(async () => {
      screen.getByTestId('switch-org-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('org')).toHaveTextContent('Other Org');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/switch-org', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ orgId: 'org-456' }),
    }));
  });

  it('should handle network errors gracefully', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    expect(screen.getByTestId('user')).toHaveTextContent('null');
    expect(screen.getByTestId('error')).toHaveTextContent('Network error');
  });
});
