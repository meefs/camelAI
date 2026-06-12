import { act, fireEvent, render, screen } from '@testing-library/react';
import type { HTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '@/components/model-picker';
import { MODEL_CATALOG } from '@/lib/model-catalog';

vi.mock('@/components/model-logo', () => ({
  ModelLogo: ({ model }: { model: string }) => (
    <span aria-hidden="true" data-testid={`model-logo-${model}`} />
  ),
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-slot="dropdown-menu-content">{children}</div>
  ),
  DropdownMenuItem: ({
    asChild,
    children,
    onSelect,
    ...props
  }: Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> & {
    asChild?: boolean;
    children: ReactNode;
    onSelect?: () => void;
  }) => {
    void asChild;
    return (
      <div
        data-slot="dropdown-menu-item"
        role="menuitem"
        tabIndex={0}
        onClick={() => onSelect?.()}
        {...props}
      >
        {children}
      </div>
    );
  },
  DropdownMenuSeparator: () => <div data-slot="dropdown-menu-separator" />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children }: { children: ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
  HoverCardTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

function getModelItem(label: string): HTMLElement {
  const item = screen
    .getAllByText(label)
    .map((element) => element.closest('[data-slot="dropdown-menu-item"]'))
    .find((element): element is HTMLElement => element !== null);

  if (!item) {
    throw new Error(`Missing model item: ${label}`);
  }
  return item;
}

function renderPicker() {
  render(
    <ModelPicker
      value="opus-4.8"
      onValueChange={vi.fn()}
      options={[
        MODEL_CATALOG['fable-5'],
        MODEL_CATALOG['opus-4.8'],
        MODEL_CATALOG.sonnet,
        MODEL_CATALOG['deepseek-v4-flash'],
      ]}
      isOrgAdmin={false}
    />,
  );
}

describe('ModelPicker metadata card state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a single metadata card as keyboard focus moves between models', () => {
    renderPicker();

    fireEvent.focus(getModelItem('Opus 4.8'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Opus 4.8');
    expect(
      screen.getByLabelText('Intelligence rating: 4.5 out of 5'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Cost rating: 4 out of 5')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Speed rating: 2 out of 5'),
    ).toBeInTheDocument();

    fireEvent.focus(getModelItem('Sonnet 4.6'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Sonnet 4.6');
    expect(
      screen.getByLabelText('Intelligence rating: 3.5 out of 5'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Speed rating: 3.5 out of 5'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('cost')).toHaveLength(1);

    fireEvent.blur(getModelItem('Sonnet 4.6'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('delays pointer metadata and cancels pending opens on leave', () => {
    renderPicker();

    const opusItem = getModelItem('Opus 4.8');
    fireEvent.pointerEnter(opusItem);
    act(() => vi.advanceTimersByTime(149));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.pointerLeave(opusItem);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.pointerEnter(opusItem);
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Opus 4.8');

    fireEvent.pointerEnter(getModelItem('Sonnet 4.6'));
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Sonnet 4.6');
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
  });

  it('renders cost buckets with muted placeholder dollar signs', () => {
    renderPicker();

    fireEvent.focus(getModelItem('DeepSeek V4 Flash'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('DeepSeek V4 Flash');
    expect(screen.getByLabelText('Cost rating: 1 out of 5')).toHaveTextContent(
      '$$$$$',
    );

    fireEvent.focus(getModelItem('Fable 5'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Fable 5');
    expect(screen.getByLabelText('Cost rating: 5 out of 5')).toHaveTextContent(
      '$$$$$',
    );
  });
});
