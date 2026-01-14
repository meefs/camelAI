/**
 * Unit tests for AuthContext
 *
 * Run with: npm run test:run -- tests/AuthContext.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

// Mock the server actions module
vi.mock('@/lib/server-actions/auth', () => ({
  login: vi.fn(),
  signup: vi.fn(),
  logout: vi.fn(),
  switchOrg: vi.fn(),
  switchWorkspace: vi.fn(),
  getAuthState: vi.fn(),
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

// Import after mocking
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import * as authActions from '@/lib/server-actions/auth';

// Mock data
const mockUser = {
  id: 'user-123',
  email: 'test@example.com',
  name: 'Test User',
  created_at: Date.now(),
  is_superuser: false,
  avatar: { color: '#000', content: 'TU' },
  is_orphaned: false,
};

const mockOrg = {
  id: 'org-123',
  name: 'Test Org',
  created_at: Date.now(),
  created_by: 'user-123',
  billing_status: 'free' as const,
  archived: false,
  archived_at: null,
};

const mockWorkspace = {
  id: 'ws-123',
  name: 'Test Workspace',
  org_id: 'org-123',
  description: null,
  created_at: Date.now(),
  created_by: 'user-123',
  avatar: { color: '#000', content: 'TW' },
  archived: false,
  archived_at: null,
  access_level: 'full' as const,
};

const mockOrgs = [
  { org_id: 'org-123', org_name: 'Test Org', role: 'admin' as const, joined_at: Date.now(), last_workspace_id: null },
  {
    org_id: 'org-456',
    org_name: 'Other Org',
    role: 'member' as const,
    joined_at: Date.now(),
    last_workspace_id: null,
  },
];

const mockAuthPayload = {
  user: mockUser,
  currentOrg: mockOrg,
  currentWorkspace: mockWorkspace,
  orgs: mockOrgs,
  workspaces: [mockWorkspace],
};

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
      <button
        data-testid="login-btn"
        onClick={() => auth.login('test@example.com', 'password123').catch(() => {})}
      >
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
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no initial auth
    vi.mocked(authActions.getAuthState).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should throw error when useAuth is used outside provider', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      render(<TestConsumer />);
    }).toThrow('useAuth must be used within an AuthProvider');

    consoleSpy.mockRestore();
  });

  it('should start with loading state and fetch auth on mount', async () => {
    vi.mocked(authActions.getAuthState).mockResolvedValue(mockAuthPayload);

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
    vi.mocked(authActions.getAuthState).mockResolvedValue(null);

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
    vi.mocked(authActions.getAuthState).mockResolvedValue(null);
    vi.mocked(authActions.login).mockResolvedValue({ success: true, data: mockAuthPayload });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    // Click login
    await act(async () => {
      screen.getByTestId('login-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('test@example.com');
    });

    expect(authActions.login).toHaveBeenCalledWith('test@example.com', 'password123');
  });

  it('should handle login failure', async () => {
    vi.mocked(authActions.getAuthState).mockResolvedValue(null);
    vi.mocked(authActions.login).mockResolvedValue({ success: false, error: 'Invalid credentials' });

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    // Click login
    await act(async () => {
      screen.getByTestId('login-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('error')).toHaveTextContent('Invalid credentials');
    });

    expect(screen.getByTestId('user')).toHaveTextContent('null');
  });

  it('should handle logout', async () => {
    vi.mocked(authActions.getAuthState).mockResolvedValue(mockAuthPayload);
    vi.mocked(authActions.logout).mockResolvedValue(undefined);

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('test@example.com');
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
    expect(authActions.logout).toHaveBeenCalled();
  });

  it('should handle org switching', async () => {
    const otherOrg = { ...mockOrg, id: 'org-456', name: 'Other Org' };
    vi.mocked(authActions.getAuthState)
      .mockResolvedValueOnce(mockAuthPayload) // initial load
      .mockResolvedValueOnce({
        ...mockAuthPayload,
        currentOrg: otherOrg,
      }); // after switch
    vi.mocked(authActions.switchOrg).mockResolvedValue(otherOrg);

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('org')).toHaveTextContent('Test Org');
    });

    // Click switch org
    await act(async () => {
      screen.getByTestId('switch-org-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('org')).toHaveTextContent('Other Org');
    });

    expect(authActions.switchOrg).toHaveBeenCalledWith('org-456');
  });

  it('should handle network errors gracefully', async () => {
    vi.mocked(authActions.getAuthState).mockRejectedValue(new Error('Network error'));

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

  it('should use initialState when provided', async () => {
    // getAuthState should NOT be called when initialState is provided
    vi.mocked(authActions.getAuthState).mockResolvedValue(null);

    render(
      <AuthProvider
        initialState={{
          user: mockUser,
          currentOrg: mockOrg,
          currentWorkspace: mockWorkspace,
          orgs: mockOrgs,
          workspaces: [mockWorkspace],
          loading: false,
          error: null,
        }}
      >
        <TestConsumer />
      </AuthProvider>
    );

    // Should immediately show user without loading
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('user')).toHaveTextContent('test@example.com');

    // getAuthState should not have been called since we provided initialState
    expect(authActions.getAuthState).not.toHaveBeenCalled();
  });
});
