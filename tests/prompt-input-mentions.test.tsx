import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { PromptInput } from '@/components/prompt-input';
import type { AtMentionEntity, Integration } from '@/types';
import { projectsToMentionables } from '@/lib/mentions';

vi.mock('@/hooks/use-voice-recording', () => ({
  useVoiceRecording: () => ({
    state: 'idle',
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
    isSupported: false,
    analyser: null,
    recordingStartTime: null,
  }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

const connection: Integration = {
  id: 'integration-1',
  integration_type: 'postgres',
  name: 'Customers DB',
  category: 'databases',
  auth_method: 'api_key',
  config: {},
  created_by: 'user-1',
  created_at: 1,
  updated_at: 1,
  has_credentials: true,
};

const project: AtMentionEntity = {
  kind: 'project',
  id: 'ca-workspace-alpha-site',
  name: 'Alpha Site',
  description: 'Marketing site rebuild',
  created_at: 2,
  updated_at: 2,
};

const lateAlphabetProject: AtMentionEntity = {
  ...project,
  id: 'ca-workspace-zebra-site',
  name: 'Zebra Site',
};

const mixedMentionables: AtMentionEntity[] = [
  { ...connection, kind: 'connection' },
  project,
];

function ControlledPromptInput({
  mentionMenuSide,
  mentionables = mixedMentionables,
}: {
  mentionMenuSide?: 'top' | 'bottom';
  mentionables?: AtMentionEntity[];
}) {
  const [value, setValue] = useState('');

  return (
    <PromptInput
      value={value}
      onChange={setValue}
      onSubmit={vi.fn()}
      enableVoiceRecording={false}
      mentionables={mentionables}
      mentionMenuSide={mentionMenuSide}
    />
  );
}

describe('PromptInput mentions', () => {
  it('can render the mention menu below the composer', async () => {
    const user = userEvent.setup();
    render(<ControlledPromptInput mentionMenuSide="bottom" />);

    await user.type(screen.getByRole('textbox'), '@');

    expect(await screen.findByText('Customers DB')).toBeInTheDocument();
    expect(screen.getByText('Alpha Site')).toBeInTheDocument();
    expect(screen.queryByText('Projects')).not.toBeInTheDocument();
    expect(screen.queryByText('Connections')).not.toBeInTheDocument();
    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector('[data-slot="popover-content"]')).toHaveAttribute(
        'data-side',
        'bottom',
      );
    });
  });

  it('renders one flat interleaved list across projects and connections', async () => {
    const user = userEvent.setup();
    render(<ControlledPromptInput mentionables={[
      { ...connection, kind: 'connection' },
      lateAlphabetProject,
    ]} />);

    await user.type(screen.getByRole('textbox'), '@');

    const connectionRow = await screen.findByText('Customers DB');
    const projectRow = screen.getByText('Zebra Site');
    expect(
      connectionRow.compareDocumentPosition(projectRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps keyboard selection aligned with the flat visual order', async () => {
    const user = userEvent.setup();
    render(<ControlledPromptInput mentionables={[
      { ...connection, kind: 'connection' },
      lateAlphabetProject,
    ]} />);

    const textbox = screen.getByRole('textbox');
    await user.type(textbox, '@');
    expect(await screen.findByText('Customers DB')).toBeInTheDocument();

    await user.keyboard('{Enter}');

    expect(textbox).toHaveValue('@customers_db ');
  });

  it('reports mention trigger activity even when stale items have no matches', async () => {
    const user = userEvent.setup();
    const onMentionMenuOpenChange = vi.fn();
    function NoMatchPromptInput() {
      const [value, setValue] = useState('');
      return (
        <PromptInput
          value={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          enableVoiceRecording={false}
          mentionables={[{ ...connection, kind: 'connection' }]}
          onMentionMenuOpenChange={onMentionMenuOpenChange}
        />
      );
    }

    render(<NoMatchPromptInput />);
    await user.type(screen.getByRole('textbox'), '@new_project');

    expect(screen.queryByText('Customers DB')).not.toBeInTheDocument();
    expect(onMentionMenuOpenChange).toHaveBeenCalledWith(true);
  });

  it('renders only source project rows when mapped projects include clones', async () => {
    const user = userEvent.setup();
    const sourceProjects = [
      {
        id: 'ca-workspace-alpha-site',
        name: 'Alpha Site',
        description: 'Marketing site rebuild',
        createdAt: '2026-06-10T12:00:00.000Z',
        updatedAt: '2026-06-11T12:00:00.000Z',
        clones: [
          {
            id: 'ca-workspace-alpha-site-v2',
            name: 'Alpha Site v2',
            description: 'Clone experiment',
            createdAt: '2026-06-11T12:00:00.000Z',
            updatedAt: '2026-06-11T12:00:00.000Z',
          },
        ],
      },
    ] as const;
    render(<ControlledPromptInput mentionables={projectsToMentionables(sourceProjects)} />);

    await user.type(screen.getByRole('textbox'), '@');

    expect(await screen.findByText('Alpha Site')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Site v2')).not.toBeInTheDocument();
    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.queryByText('Clone')).not.toBeInTheDocument();
  });
});
