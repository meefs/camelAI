import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ThinkingBlock } from '@/components/tool-call/thinking-block';

describe('ThinkingBlock', () => {
  it('renders the streaming label and pulsing dot while active', () => {
    render(<ThinkingBlock thinking="Working through it" isStreaming />);

    expect(screen.getByRole('button', { name: 'Thinking…' })).toBeInTheDocument();
    expect(document.querySelector('.thinking-block__dot')).toHaveClass(
      'bg-blue-500',
      'animate-pulse',
      'motion-reduce:animate-none',
    );
  });

  it('renders the complete label and muted dot when inactive', () => {
    render(<ThinkingBlock thinking="Finished thought" />);

    expect(screen.getByRole('button', { name: 'Thought' })).toBeInTheDocument();
    expect(document.querySelector('.thinking-block__dot')).toHaveClass('bg-green-500');
    expect(document.querySelector('.thinking-block__dot')).not.toHaveClass('animate-pulse');
  });

  it('treats the runtime Thinking label as the ordinary Thought label when complete', () => {
    render(<ThinkingBlock thinking="Finished runtime reasoning" label="Thinking" />);

    expect(screen.getByRole('button', { name: 'Thought' })).toBeInTheDocument();
  });

  it('preserves custom labels and appends an ellipsis while streaming', () => {
    const { rerender } = render(<ThinkingBlock thinking="Plan content" label="Plan" />);

    expect(screen.getByRole('button', { name: 'Plan' })).toBeInTheDocument();

    rerender(<ThinkingBlock thinking="Plan content" label="Plan" isStreaming />);
    expect(screen.getByRole('button', { name: 'Plan…' })).toBeInTheDocument();
  });

  it('toggles expanded state and renders thinking through MarkdownRenderer', async () => {
    const user = userEvent.setup();
    render(<ThinkingBlock thinking={"**Plan**\n\n- Write tests"} isStreaming />);

    const trigger = screen.getByRole('button', { name: 'Thinking…' });
    const chevron = document.querySelector('.thinking-block__chevron');
    expect(screen.queryByTestId('markdown-renderer')).not.toBeInTheDocument();
    expect(chevron).not.toHaveClass('rotate-90');

    await user.click(trigger);

    expect(chevron).toHaveClass('rotate-90');
    expect(screen.getByText('Plan')).toHaveClass('font-semibold');
    expect(screen.getByText('Write tests').closest('li')).toBeInTheDocument();
  });

  it('renders summary boxes when summaries are present', () => {
    render(
      <ThinkingBlock
        thinking="Raw thought"
        summaries={['Picked a state machine.', 'Validation belongs at the boundary.']}
        defaultExpanded
      />,
    );

    expect(screen.getByText('Summary 1')).toBeInTheDocument();
    expect(screen.getByText('Summary 2')).toBeInTheDocument();
    expect(screen.getByText('Picked a state machine.')).toBeInTheDocument();
    expect(screen.getByText('Validation belongs at the boundary.')).toBeInTheDocument();
  });

  it('omits summaries and markdown for empty content', () => {
    render(<ThinkingBlock thinking="   " defaultExpanded />);

    expect(screen.queryByText(/Summary/)).not.toBeInTheDocument();
    expect(document.querySelector('.thinking-block__markdown')).not.toBeInTheDocument();
  });

  it('renders provider-indented prose as prose instead of an accidental code block', () => {
    const { container } = render(
      <ThinkingBlock thinking="    Let me deploy now" defaultExpanded />,
    );

    expect(container.querySelector('pre code')).not.toBeInTheDocument();
    expect(screen.getByText('Let me deploy now').closest('p')).toBeInTheDocument();
  });

  it('dedents provider-indented markdown without flattening nested list indentation', () => {
    const { container } = render(
      <ThinkingBlock thinking={"    - Parent item\n        - Child item"} defaultExpanded />,
    );

    expect(container.querySelector('pre code')).not.toBeInTheDocument();
    expect(container.querySelector('ul ul')).toBeInTheDocument();
    expect(screen.getByText('Child item').closest('li')).toBeInTheDocument();
  });

  it('preserves indented code blocks after removing provider-wide indentation', () => {
    const { container } = render(
      <ThinkingBlock thinking={"    Example:\n\n        const answer = 42;"} defaultExpanded />,
    );

    expect(screen.getByText('Example:').closest('p')).toBeInTheDocument();
    expect(container.querySelector('pre code')?.textContent).toBe('const answer = 42;');
  });

  it('preserves indentation inside explicit fenced code blocks', () => {
    const { container } = render(
      <ThinkingBlock thinking={'```ts\n    const answer = 42;\n```'} isStreaming defaultExpanded />,
    );

    expect(container.querySelector('pre code')?.textContent).toBe('    const answer = 42;');
  });

  it('keeps reduced-motion classes on animated elements', () => {
    render(<ThinkingBlock thinking="Animated content" isStreaming defaultExpanded />);

    expect(document.querySelector('.thinking-block__dot')).toHaveClass('motion-reduce:animate-none');
    expect(screen.getByText('Animated content').closest("[data-slot='collapsible-content']")).toHaveClass(
      'motion-reduce:animate-none',
    );
  });
});
