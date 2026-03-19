import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyUserBanner } from '@/components/legacy-user-banner';

let fetcherState: 'idle' | 'submitting' = 'idle';
let fetcherData: { success?: boolean; error?: string } | undefined = undefined;
const submitMock = vi.fn();
const { toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn(),
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useFetcher: () => ({
      state: fetcherState,
      data: fetcherData,
      formData: undefined,
      submit: submitMock,
    }),
  };
});

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
  },
}));

describe('LegacyUserBanner', () => {
  beforeEach(() => {
    fetcherState = 'idle';
    fetcherData = undefined;
    submitMock.mockReset();
    toastErrorMock.mockClear();
    window.localStorage.clear();
    submitMock.mockImplementation(() => {
      fetcherState = 'submitting';
    });
  });

  it('renders nothing when show is false', () => {
    render(<LegacyUserBanner show={false} userId="test-user-1" />);

    expect(
      screen.queryByText("Things look different? Here's why")
    ).not.toBeInTheDocument();
  });

  it('starts collapsed and expands in place', async () => {
    const user = userEvent.setup();

    render(<LegacyUserBanner show={true} userId="test-user-1" />);

    expect(screen.getByText('👋')).toBeInTheDocument();

    expect(
      screen.queryByRole('link', { name: /take me to my analytics workspace/i })
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: /things look different\? here's why/i })
    );

    expect(
      screen.getByRole('link', { name: /take me to my analytics workspace/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /got it, don't show again/i })
    ).toBeInTheDocument();
  });

  it('temporarily hides the banner with the x button without posting to the API', async () => {
    const user = userEvent.setup();

    render(<LegacyUserBanner show={true} userId="test-user-1" />);

    await user.click(
      screen.getByRole('button', { name: /hide legacy user notice for now/i })
    );

    expect(submitMock).not.toHaveBeenCalled();
    expect(Number(window.localStorage.getItem('legacy_banner_snoozed_until:test-user-1'))).toBeGreaterThan(Date.now());
    expect(
      screen.queryByText("Things look different? Here's why")
    ).not.toBeInTheDocument();
  });

  it('stays hidden when a future snooze timestamp exists', () => {
    window.localStorage.setItem(
      'legacy_banner_snoozed_until:test-user-1',
      String(Date.now() + 60 * 60 * 1000)
    );

    render(<LegacyUserBanner show={true} userId="test-user-1" />);

    expect(
      screen.queryByText("Things look different? Here's why")
    ).not.toBeInTheDocument();
  });

  it('permanently dismisses from the expanded CTA and clears any snooze', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      'legacy_banner_snoozed_until:test-user-1',
      String(Date.now() + 60 * 60 * 1000)
    );
    window.localStorage.removeItem('legacy_banner_snoozed_until:test-user-1');

    render(<LegacyUserBanner show={true} userId="test-user-1" />);

    await user.click(
      screen.getByRole('button', { name: /things look different\? here's why/i })
    );
    await user.click(
      screen.getByRole('button', { name: /got it, don't show again/i })
    );

    expect(submitMock).toHaveBeenCalledWith(
      {},
      { method: 'post', action: '/api/legacy-banner/dismiss' }
    );
    expect(window.localStorage.getItem('legacy_banner_snoozed_until:test-user-1')).toBeNull();
  });

  it('restores the banner and shows an error toast when permanent dismissal fails', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<LegacyUserBanner show={true} userId="test-user-1" />);

    await user.click(
      screen.getByRole('button', { name: /things look different\? here's why/i })
    );
    await user.click(
      screen.getByRole('button', { name: /got it, don't show again/i })
    );

    fetcherState = 'idle';
    fetcherData = { error: 'Dismiss failed' };
    rerender(<LegacyUserBanner show={true} userId="test-user-1" />);

    expect(
      await screen.findByText("Things look different? Here's why")
    ).toBeInTheDocument();
    expect(toastErrorMock).toHaveBeenCalledWith('Dismiss failed');
  });
});
