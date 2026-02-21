import { beforeEach, describe, expect, it, vi } from 'vitest';

const resendSendMock = vi.fn().mockResolvedValue({
  success: true,
  messageId: 'msg_456',
});

vi.mock('@/lib/resend.server', () => ({
  sendEmail: resendSendMock,
}));

const { sendHelpConfirmationEmail } = await import('@/lib/email.server');

const env = {
  EMAIL_FROM_ADDRESS: 'no-reply@mail.camelai.com',
  RESEND_API_KEY: 're_test_123',
};

describe('Resend email delivery payload', () => {
  beforeEach(() => {
    resendSendMock.mockClear();
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
    expect(resendSendMock).toHaveBeenCalledTimes(1);

    const [config, payload] = resendSendMock.mock.calls[0];
    expect(config).toEqual({
      apiKey: 're_test_123',
      fromAddress: 'no-reply@mail.camelai.com',
    });
    expect(payload.to).toBe('user@example.com');
    expect(payload.cc).toBe('support@camelai.com');
    expect(payload.replyTo).toBe('support@camelai.com');
  });
});
