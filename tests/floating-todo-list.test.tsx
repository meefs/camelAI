import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FloatingTodoList } from '@/components/floating-todo';

describe('FloatingTodoList', () => {
  it('renders todo labels from raw tool payload aliases', () => {
    render(
      <FloatingTodoList
        isStreaming
        todos={[
          { step: 'Inspect logs', status: 'inProgress' },
          {
            title: 'Patch proxy env',
            status: 'running',
            active_form: 'Patching proxy env',
          },
          'Retry deploy',
        ] as any}
      />,
    );

    expect(screen.getByText('0 out of 3 tasks completed')).toBeInTheDocument();
    expect(screen.getByText('1. Inspect logs')).toBeInTheDocument();
    expect(screen.getByText('2. Patching proxy env')).toBeInTheDocument();
    expect(screen.getByText('3. Retry deploy')).toBeInTheDocument();
  });
});
