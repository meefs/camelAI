import type { ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetHelpDialog } from '@/components/get-help-dialog';
import { HELP_DESCRIPTION_MAX_LENGTH } from '@/lib/help';

let fetcherState: 'idle' | 'submitting' = 'idle';
let fetcherData: unknown = undefined;

const useFetcherMock = vi.fn();
const { toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

function FetcherForm(props: ComponentProps<'form'>) {
  return <form {...props} />;
}

vi.mock('react-router', () => ({
  useFetcher: () => useFetcherMock(),
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

describe('GetHelpDialog', () => {
  beforeEach(() => {
    fetcherState = 'idle';
    fetcherData = undefined;
    toastSuccessMock.mockClear();
    toastErrorMock.mockClear();
    useFetcherMock.mockImplementation(() => ({
      state: fetcherState,
      data: fetcherData,
      Form: FetcherForm,
    }));
  });

  it('renders dialog when open is true', () => {
    render(<GetHelpDialog open={true} onOpenChange={() => undefined} />);

    expect(screen.getByText('Get Help')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Tell us what you need help with. We'll get back to you via email."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText('The more detail you include, the faster we can help.')
    ).toBeInTheDocument();
  });

  it('does not render when open is false', () => {
    render(<GetHelpDialog open={false} onOpenChange={() => undefined} />);

    expect(screen.queryByText('Get Help')).not.toBeInTheDocument();
  });

  it('severity defaults to low', async () => {
    render(<GetHelpDialog open={true} onOpenChange={() => undefined} />);

    await waitFor(() => {
      const severityInput = document.querySelector(
        'input[name="severity"]'
      ) as HTMLInputElement | null;
      expect(severityInput?.value).toBe('low');
    });
  });

  it('submit button is disabled when description is empty', () => {
    render(<GetHelpDialog open={true} onOpenChange={() => undefined} />);

    const submitButton = screen.getByRole('button', { name: 'Submit' });
    expect(submitButton).toBeDisabled();
  });

  it('caps description textarea height', () => {
    render(<GetHelpDialog open={true} onOpenChange={() => undefined} />);

    const textarea = screen.getByLabelText('Description');
    expect(textarea).toHaveClass('max-h-[240px]');
  });

  it('enforces description max length on the textarea', () => {
    render(<GetHelpDialog open={true} onOpenChange={() => undefined} />);

    const textarea = screen.getByLabelText('Description');
    expect(textarea).toHaveAttribute(
      'maxlength',
      HELP_DESCRIPTION_MAX_LENGTH.toString()
    );
  });

  it('shows loading state while submitting', () => {
    fetcherState = 'submitting';

    render(<GetHelpDialog open={true} onOpenChange={() => undefined} />);

    const submitButton = screen.getByRole('button', { name: /Sending.../ });
    expect(submitButton).toBeDisabled();
    expect(screen.getByText('Sending...')).toBeInTheDocument();
  });

  it('calls onOpenChange(false) when cancel is clicked', () => {
    const onOpenChange = vi.fn();
    render(<GetHelpDialog open={true} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('includes hidden pageUrl and screenSize fields', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1280,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 720,
    });

    render(<GetHelpDialog open={true} onOpenChange={() => undefined} />);

    await waitFor(() => {
      const pageUrlInput = document.querySelector(
        'input[name="pageUrl"]'
      ) as HTMLInputElement | null;
      const screenSizeInput = document.querySelector(
        'input[name="screenSize"]'
      ) as HTMLInputElement | null;

      expect(pageUrlInput?.value).toBe(window.location.href);
      expect(screenSizeInput?.value).toBe('1280x720');
    });
  });

  it('shows success toast and closes dialog after successful submission', async () => {
    fetcherData = { success: true };
    const onOpenChange = vi.fn();

    render(<GetHelpDialog open={true} onOpenChange={onOpenChange} />);

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        'Help request sent! Check your email for confirmation.'
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('links submit button to the rendered form via form attribute', () => {
    render(<GetHelpDialog open={true} onOpenChange={() => undefined} />);

    const form = document.querySelector('form') as HTMLFormElement | null;
    const submitButton = screen.getByRole('button', { name: 'Submit' });

    expect(form?.id).toBeTruthy();
    expect(submitButton).toHaveAttribute('form', form?.id);
  });
});
