import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MODEL_CATALOG } from '@/lib/model-catalog';
import OrganizationModelsPage from '@/routes/_app.settings.organization.models';

const loaderDataMock = vi.hoisted(() => vi.fn());
const fetcherSubmitMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock('react-router', () => ({
  redirect: vi.fn((url: string) => new Response(null, {
    status: 302,
    headers: { Location: url },
  })),
  useFetcher: () => ({
    state: 'idle',
    data: null,
    submit: fetcherSubmitMock,
  }),
  useLoaderData: () => loaderDataMock(),
  useLocation: () => ({
    pathname: '/settings/organization/models',
    search: '?scope=ws&workspaceId=ws_123',
  }),
  useNavigate: () => navigateMock,
}));

vi.mock('@/lib/auth.server', () => ({
  requireAuthContext: vi.fn(),
  requireOrgAdmin: vi.fn(),
  getAuthEnv: vi.fn(),
}));

vi.mock('@/lib/auth-do', () => ({
  listOrgWorkspaces: vi.fn(),
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: vi.fn(),
}));

vi.mock('@/components/model-logo', () => ({
  ModelLogo: ({ model }: { model: string }) => (
    <span aria-hidden="true" data-testid={`model-logo-${model}`} />
  ),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe('organization model settings UI', () => {
  it('shows a workspace-scope entrypoint for a single-workspace org', () => {
    loaderDataMock.mockReturnValue({
      scope: 'org',
      selectedWorkspaceId: null,
      workspaces: [
        {
          id: 'ws_123',
          name: 'Only Workspace',
          avatarColor: '#2563eb',
          hasCustomConfig: false,
        },
      ],
      useOrgDefaults: false,
      config: {
        inPicker: [
          {
            entry: MODEL_CATALOG.sonnet,
            addedAt: 1,
            isDefault: true,
          },
        ],
        additional: [],
        capacity: { used: 1, max: 10 },
      },
    });

    render(<OrganizationModelsPage />);

    expect(screen.getByText('Org default')).toBeInTheDocument();
    expect(screen.getByText('Only Workspace')).toBeInTheDocument();
    expect(
      screen.queryByText('Use org defaults for this workspace'),
    ).not.toBeInTheDocument();
  });

  it('shows workspace override controls for a single-workspace org', () => {
    loaderDataMock.mockReturnValue({
      scope: 'ws',
      selectedWorkspaceId: 'ws_123',
      workspaces: [
        {
          id: 'ws_123',
          name: 'Only Workspace',
          avatarColor: '#2563eb',
          hasCustomConfig: false,
        },
      ],
      useOrgDefaults: true,
      config: {
        inPicker: [
          {
            entry: MODEL_CATALOG.sonnet,
            addedAt: 1,
            isDefault: true,
          },
        ],
        additional: [],
        capacity: { used: 1, max: 10 },
      },
    });

    render(<OrganizationModelsPage />);

    expect(
      screen.getByText('Use org defaults for this workspace'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Inheriting from org defaults/i)).toBeInTheDocument();
    expect(screen.getByText('Org default')).toBeInTheDocument();
    expect(screen.getByText('Only Workspace')).toBeInTheDocument();
  });
});
