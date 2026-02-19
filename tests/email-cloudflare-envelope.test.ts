import { beforeEach, describe, expect, it, vi } from 'vitest';

const cloudflareSendMock = vi.fn().mockResolvedValue(undefined);

class MockEmailMessage {
  from: string;
  to: string;
  raw: ReadableStream | string;

  constructor(from: string, to: string, raw: ReadableStream | string) {
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}

vi.mock('cloudflare:email', () => ({
  EmailMessage: MockEmailMessage,
}));

vi.mock('@/lib/gmail.server', () => ({
  sendEmail: vi.fn(),
  isGmailConfigured: vi.fn(() => false),
  getGmailConfig: vi.fn(() => null),
}));

const { sendHelpConfirmationEmail } = await import('@/lib/email.server');

const env = {
  EMAIL: {
    send: cloudflareSendMock,
  },
  EMAIL_FROM_ADDRESS: 'no-reply@camelai.com',
  GMAIL_SERVICE_ACCOUNT_EMAIL: 'svc@camelai.com',
  GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY: 'private-key',
  GMAIL_SENDER_EMAIL: 'no-reply@camelai.com',
};

describe('Cloudflare email envelope recipients', () => {
  beforeEach(() => {
    cloudflareSendMock.mockClear();
  });

  it('sends Cloudflare envelope to both To and Cc recipients', async () => {
    const result = await sendHelpConfirmationEmail({
      env,
      to: 'User@Example.com',
      firstName: 'Jane',
      userEmail: 'user@example.com',
      category: 'Bug report',
      severity: 'High',
      subject: 'Agent freezes on upload',
      description: 'Details',
      cc: 'support@camelai.com',
      replyTo: 'support@camelai.com',
    });

    expect(result).toEqual({ status: 'sent' });
    expect(cloudflareSendMock).toHaveBeenCalledTimes(2);

    const envelopeRecipients = cloudflareSendMock.mock.calls
      .map(([message]) => (message as MockEmailMessage).to)
      .sort();
    expect(envelopeRecipients).toEqual(['support@camelai.com', 'user@example.com']);

    for (const [message] of cloudflareSendMock.mock.calls) {
      expect((message as MockEmailMessage).raw).toContain('Cc: support@camelai.com');
    }
  });
});
