import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_CATALOG } from '@/lib/model-catalog';
import OrganizationModelsPage from '@/routes/_app.settings.organization.models';

const loaderDataMock = vi.hoisted(() => vi.fn());
const fetcherSubmitMock = vi.hoisted(() => vi.fn());
const fetcherFormDataMock = vi.hoisted(() =>
  vi.fn((): FormData | null => null),
);
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock('react-router', () => ({
  redirect: vi.fn((url: string) => new Response(null, {
    status: 302,
    headers: { Location: url },
  })),
  useFetcher: () => ({
    state: 'idle',
    data: null,
    formData: fetcherFormDataMock(),
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

function loaderData(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'org',
    selectedWorkspaceId: null,
    workspaces: [
      {
        id: 'ws_123',
        name: 'Only Workspace',
        avatarColor: '#2563eb',
        avatarContent: 'O',
        hasCustomConfig: false,
      },
    ],
    useOrgDefaults: false,
    config: {
      usePlatformDefaults: true,
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
    ...overrides,
  };
}

describe('organization model settings UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetcherFormDataMock.mockReturnValue(null);
  });

  it('hides the workspace-scope entrypoint for a single-workspace org', () => {
    loaderDataMock.mockReturnValue(loaderData());

    render(<OrganizationModelsPage />);

    expect(screen.queryByText('Org default')).not.toBeInTheDocument();
    expect(screen.queryByText('Only Workspace')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Use org defaults for this workspace'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Use platform model defaults'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'camelAI defaults' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Custom list' })).toBeInTheDocument();
  });

  it('shows workspace override controls for a single-workspace org', () => {
    loaderDataMock.mockReturnValue(loaderData({
      scope: 'ws',
      selectedWorkspaceId: 'ws_123',
      useOrgDefaults: true,
    }));

    render(<OrganizationModelsPage />);

    expect(screen.getByRole('tab', { name: 'Follow org' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Custom list' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Use org defaults for this workspace'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Inheriting from org defaults/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "This workspace follows your org's setting, which is currently camelAI's default lineup.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Org default')).not.toBeInTheDocument();
    expect(screen.queryByText('Only Workspace')).not.toBeInTheDocument();
  });

  it('renders org defaults as a read-only picker list', () => {
    loaderDataMock.mockReturnValue(loaderData());

    render(<OrganizationModelsPage />);

    expect(
      screen.getByText(
        'Kept up to date by camelAI. New models appear automatically and retired models are removed.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('In the picker')).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'remove' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'add' })).not.toBeInTheDocument();
    expect(screen.queryByText('Additional models')).not.toBeInTheDocument();
    expect(
      screen.getByText('Switch to a custom list to edit which models appear.'),
    ).toBeInTheDocument();
  });

  it('renders org custom lists with edit controls', () => {
    loaderDataMock.mockReturnValue(loaderData({
      config: {
        usePlatformDefaults: false,
        inPicker: [
          {
            entry: MODEL_CATALOG.sonnet,
            addedAt: 1,
            isDefault: true,
          },
        ],
        additional: [MODEL_CATALOG['gpt-5.6-terra']],
        capacity: { used: 1, max: 10 },
      },
    }));

    render(<OrganizationModelsPage />);

    expect(
      screen.getByText(
        "You manage this list. New models won't be added automatically.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('In your picker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'remove' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'add' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Clear Sonnet 5 as default' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Additional models')).toBeInTheDocument();
  });

  it('renders an empty state when every visible model is already in the picker', () => {
    loaderDataMock.mockReturnValue(loaderData({
      config: {
        usePlatformDefaults: false,
        inPicker: [
          {
            entry: MODEL_CATALOG.sonnet,
            addedAt: 1,
            isDefault: true,
          },
        ],
        additional: [],
        capacity: { used: 1, max: 1 },
      },
    }));

    render(<OrganizationModelsPage />);

    expect(screen.getByText('Additional models')).toBeInTheDocument();
    expect(screen.getByText('0 available')).toBeInTheDocument();
    expect(
      screen.getByText('Models you remove will show up here.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'add' })).not.toBeInTheDocument();
  });


  it('describes a workspace following a custom org list', () => {
    loaderDataMock.mockReturnValue(loaderData({
      scope: 'ws',
      selectedWorkspaceId: 'ws_123',
      useOrgDefaults: true,
      config: {
        usePlatformDefaults: false,
        inPicker: [
          {
            entry: MODEL_CATALOG.sonnet,
            addedAt: 1,
            isDefault: true,
          },
          {
            entry: MODEL_CATALOG['gpt-5.6-terra'],
            addedAt: 2,
            isDefault: false,
          },
        ],
        additional: [MODEL_CATALOG['gpt-5.5']],
        capacity: { used: 2, max: 10 },
      },
    }));

    render(<OrganizationModelsPage />);

    expect(
      screen.getByText(
        "This workspace follows your org's setting, which is currently a custom list.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('In the picker')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'remove' })).not.toBeInTheDocument();
    expect(screen.queryByText('Additional models')).not.toBeInTheDocument();
  });

  it('renders workspace custom lists with edit controls', () => {
    loaderDataMock.mockReturnValue(loaderData({
      scope: 'ws',
      selectedWorkspaceId: 'ws_123',
      useOrgDefaults: false,
      config: {
        usePlatformDefaults: false,
        inPicker: [
          {
            entry: MODEL_CATALOG.sonnet,
            addedAt: 1,
            isDefault: false,
          },
        ],
        additional: [MODEL_CATALOG['gpt-5.6-terra']],
        capacity: { used: 1, max: 10 },
      },
    }));

    render(<OrganizationModelsPage />);

    expect(
      screen.getByText(
        "This workspace has its own list. New models won't be added automatically, and changes to org settings won't affect it.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('In your picker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'remove' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'add' })).toBeInTheDocument();
    expect(screen.getByText('Additional models')).toBeInTheDocument();
  });

  it('lets legacy workspace platform-default overrides freeze by removing a model', () => {
    loaderDataMock.mockReturnValue(loaderData({
      scope: 'ws',
      selectedWorkspaceId: 'ws_123',
      useOrgDefaults: false,
      config: {
        usePlatformDefaults: true,
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
    }));

    render(<OrganizationModelsPage />);

    expect(screen.getByRole('button', { name: 'remove' })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Clear Sonnet 5 as default' }),
    ).toBeDisabled();
    expect(screen.queryByText('Additional models')).not.toBeInTheDocument();
  });

  it('uses neutral follow-org copy during an optimistic workspace follow switch', () => {
    const formData = new FormData();
    formData.set('intent', 'setUseOrgDefaults');
    formData.set('useOrgDefaults', 'true');
    fetcherFormDataMock.mockReturnValue(formData);
    loaderDataMock.mockReturnValue(loaderData({
      scope: 'ws',
      selectedWorkspaceId: 'ws_123',
      useOrgDefaults: false,
      config: {
        usePlatformDefaults: false,
        inPicker: [
          {
            entry: MODEL_CATALOG.sonnet,
            addedAt: 1,
            isDefault: false,
          },
        ],
        additional: [MODEL_CATALOG['gpt-5.6-terra']],
        capacity: { used: 1, max: 10 },
      },
    }));

    render(<OrganizationModelsPage />);

    expect(
      screen.getByText("This workspace follows your org's setting."),
    ).toBeInTheDocument();
  });

  it('uses plain empty-list copy in read-only mode', () => {
    loaderDataMock.mockReturnValue(loaderData({
      config: {
        usePlatformDefaults: true,
        inPicker: [],
        additional: [],
        capacity: { used: 0, max: 10 },
      },
    }));

    render(<OrganizationModelsPage />);

    expect(screen.getByText('No models in the picker.')).toBeInTheDocument();
    expect(
      screen.queryByText('No models in the picker. Add at least one below for your team to chat.'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Switch to a custom list to edit which models appear.'),
    ).not.toBeInTheDocument();
  });
});
