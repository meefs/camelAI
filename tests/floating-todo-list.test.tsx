import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FloatingTodoList } from '@/components/floating-todo';

const RAW_TODOS = [
  { step: 'Inspect logs', status: 'inProgress' },
  {
    title: 'Patch proxy env',
    status: 'running',
    active_form: 'Patching proxy env',
  },
  'Retry deploy',
] as any;

describe('FloatingTodoList', () => {
  it('is collapsed by default and expands on header click', () => {
    render(<FloatingTodoList todos={RAW_TODOS} />);

    expect(screen.getByText('0 out of 3 tasks completed')).toBeInTheDocument();
    expect(screen.queryByText('1. Inspect logs')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('0 out of 3 tasks completed'));

    expect(screen.getByText('1. Inspect logs')).toBeInTheDocument();
  });

  it('renders todo labels from raw tool payload aliases', () => {
    render(<FloatingTodoList todos={RAW_TODOS} />);

    fireEvent.click(screen.getByText('0 out of 3 tasks completed'));

    expect(screen.getByText('1. Inspect logs')).toBeInTheDocument();
    expect(screen.getByText('2. Patching proxy env')).toBeInTheDocument();
    expect(screen.getByText('3. Retry deploy')).toBeInTheDocument();
  });
});
