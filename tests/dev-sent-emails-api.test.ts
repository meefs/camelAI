import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireAuthContextMock = vi.fn();
const getEnvMock = vi.fn();
const isDevEmailOutboxEnabledMock = vi.fn();
const listDevEmailOutboxEntriesMock = vi.fn();
const getDevEmailOutboxEntryByIdMock = vi.fn();

vi.mock('@/lib/auth.server', () => ({
  requireAuthContext: requireAuthContextMock,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/dev-email-outbox', () => ({
  isDevEmailOutboxEnabled: isDevEmailOutboxEnabledMock,
  listDevEmailOutboxEntries: listDevEmailOutboxEntriesMock,
  getDevEmailOutboxEntryById: getDevEmailOutboxEntryByIdMock,
}));

const { loader: listLoader } = await import('@/routes/api/dev.sent-emails');
const { loader: detailLoader } = await import('@/routes/api/dev.sent-emails.$id');

describe('dev sent emails api authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({});
    isDevEmailOutboxEnabledMock.mockReturnValue(true);
    requireAuthContextMock.mockResolvedValue({
      user: { is_superuser: true },
    });
    listDevEmailOutboxEntriesMock.mockResolvedValue({
      entries: [],
      cursor: null,
      listComplete: true,
    });
    getDevEmailOutboxEntryByIdMock.mockResolvedValue({
      id: 'email_123',
      createdAt: '2026-02-19T00:00:00.000Z',
      to: 'user@example.com',
      cc: 'support@camelai.com',
      replyTo: 'support@camelai.com',
      subject: 'Subject',
      textBody: 'Text',
      htmlBody: '<p>Text</p>',
      status: 'sent',
      transport: 'cloudflare_email',
    });
  });

  it('rejects non-superusers for list endpoint', async () => {
    requireAuthContextMock.mockResolvedValue({
      user: { is_superuser: false },
    });

    const response = await listLoader({
      request: new Request('https://camelai.com/api/dev/sent-emails'),
      context: {},
    } as never);

    expect(response.status).toBe(403);
    expect(listDevEmailOutboxEntriesMock).not.toHaveBeenCalled();
  });

  it('rejects non-superusers for detail endpoint', async () => {
    requireAuthContextMock.mockResolvedValue({
      user: { is_superuser: false },
    });

    const response = await detailLoader({
      request: new Request('https://camelai.com/api/dev/sent-emails/email_123'),
      context: {},
      params: { id: 'email_123' },
    } as never);

    expect(response.status).toBe(403);
    expect(getDevEmailOutboxEntryByIdMock).not.toHaveBeenCalled();
  });

  it('allows superusers for list endpoint', async () => {
    const response = await listLoader({
      request: new Request('https://camelai.com/api/dev/sent-emails'),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(listDevEmailOutboxEntriesMock).toHaveBeenCalledTimes(1);
  });

  it('allows superusers for detail endpoint', async () => {
    const response = await detailLoader({
      request: new Request('https://camelai.com/api/dev/sent-emails/email_123'),
      context: {},
      params: { id: 'email_123' },
    } as never);

    expect(response.status).toBe(200);
    expect(getDevEmailOutboxEntryByIdMock).toHaveBeenCalledTimes(1);
  });
});
