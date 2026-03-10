import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireAuthContextMock = vi.fn();

vi.mock('@/lib/auth.server', () => ({
  requireAuthContext: requireAuthContextMock,
}));

const { loader } = await import('@/routes/_app');

describe('_app loader onboarding redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthContextMock.mockResolvedValue({
      onboarding: { completed_at: null },
      emailVerification: { required: false, verified: true },
      user: { id: 'user_123' },
      currentOrg: { id: 'org_123' },
      currentWorkspace: { id: 'ws_123' },
      orgs: [],
      workspaces: [],
      allWorkspaces: [],
      orgWorkspaceCount: 1,
      resignedSessionCookie: null,
    });
  });

  it('redirects incomplete users to /onboarding without prompt_key', async () => {
    await expect(
      loader({
        request: new Request('https://camelai.dev/chat?prompt_key=sales-key-123'),
        context: {},
      } as never)
    ).rejects.toSatisfy((response: unknown) => {
      return response instanceof Response
        && response.status === 302
        && response.headers.get('Location') === '/onboarding';
    });
  });
});
