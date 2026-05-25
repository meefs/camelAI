import { beforeEach, describe, expect, it, vi } from 'vitest';

const cloudflareEmailSendMock = vi.fn().mockResolvedValue({
  success: true,
  messageId: 'msg_456',
});
const emailBinding = { send: vi.fn() };

vi.mock('@/lib/cloudflare-email.server', () => ({
  sendEmail: cloudflareEmailSendMock,
}));

const { sendHelpConfirmationEmail } = await import('@/lib/email.server');

const env = {
  EMAIL_FROM_ADDRESS: 'no-reply@mail.camelai.com',
  EMAIL: emailBinding,
};

describe('Cloudflare email delivery payload', () => {
  beforeEach(() => {
    cloudflareEmailSendMock.mockClear();
  });

  it('sends to normalized recipient with cc and reply-to', async () => {
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
    expect(cloudflareEmailSendMock).toHaveBeenCalledTimes(1);

    const [config, payload] = cloudflareEmailSendMock.mock.calls[0];
    expect(config).toEqual({
      email: emailBinding,
      fromAddress: 'no-reply@mail.camelai.com',
    });
    expect(payload.to).toBe('user@example.com');
    expect(payload.cc).toBe('support@camelai.com');
    expect(payload.replyTo).toBe('support@camelai.com');
  });
});
