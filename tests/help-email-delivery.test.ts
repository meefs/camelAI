import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendEmailMock = vi.fn().mockResolvedValue({
  success: true,
  messageId: 'msg_123',
});
const emailBinding = { send: vi.fn() };

vi.mock('@/lib/cloudflare-email.server', () => ({
  sendEmail: sendEmailMock,
}));

const { sendHelpConfirmationEmail, sendHelpSupportEmail } = await import(
  '@/lib/email.server'
);

const env = {
  EMAIL_FROM_ADDRESS: 'no-reply@mail.camelai.com',
  EMAIL: emailBinding,
};

describe('help email delivery', () => {
  beforeEach(() => {
    sendEmailMock.mockClear();
  });

  it('sendHelpConfirmationEmail sends with expected subject and recipient', async () => {
    await sendHelpConfirmationEmail({
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

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [, payload] = sendEmailMock.mock.calls[0];
    expect(payload.to).toBe('user@example.com');
    expect(payload.cc).toBe('support@camelai.com');
    expect(payload.replyTo).toBe('support@camelai.com');
    expect(payload.subject).toBe('We received your request - Agent freezes on upload');
    expect(payload.htmlBody).toContain(
      'https://camelai.dev/camelAI-fullname-logo-lightmode.png'
    );
  });

  it('sendHelpSupportEmail sends to support with triage subject format', async () => {
    await sendHelpSupportEmail({
      env,
      to: 'support@camelai.com',
      userName: 'Jane Doe',
      userEmail: 'jane@example.com',
      userId: 'usr_123',
      orgName: 'Acme Inc',
      orgSlug: 'acme-inc',
      orgId: 'org_123',
      billingPlan: 'Pro',
      billingStatus: 'active',
      workspaceName: 'My Project',
      workspaceId: 'ws_123',
      pageUrl: 'https://camelai.com/chat/abc123',
      category: 'Bug report',
      severity: 'High',
      subject: 'Agent freezes on large file upload',
      description: 'Full description',
      submittedAt: '2026-02-19T14:32:00.000Z',
      userAgent: 'Mozilla/5.0',
      screenSize: '1440x900',
      referer: 'https://camelai.com/chat/abc123',
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [, payload] = sendEmailMock.mock.calls[0];
    expect(payload.to).toBe('support@camelai.com');
    expect(payload.subject).toBe(
      '[High] [Bug] Agent freezes on large file upload - Jane Doe (acme-inc)'
    );
    expect(payload.htmlBody).toContain('Payment tier');
    expect(payload.htmlBody).toContain('Pro');
    expect(payload.textBody).toContain('Payment tier');
    expect(payload.textBody).toContain('Pro');
  });

  it('both helpers produce non-empty HTML and plain text bodies', async () => {
    await sendHelpConfirmationEmail({
      env,
      to: 'user@example.com',
      firstName: 'Jane',
      userEmail: 'user@example.com',
      category: 'Question',
      severity: 'Low',
      subject: 'Question about billing',
      description: 'Can I switch plans?',
    });
    await sendHelpSupportEmail({
      env,
      to: 'support@camelai.com',
      userName: null,
      userEmail: 'user@example.com',
      userId: 'usr_123',
      orgName: 'Acme Inc',
      orgSlug: 'acme-inc',
      orgId: 'org_123',
      billingPlan: 'Pay as you go',
      billingStatus: 'free',
      workspaceName: null,
      workspaceId: null,
      pageUrl: null,
      category: 'Question',
      severity: 'Low',
      subject: 'Question about billing',
      description: 'Can I switch plans?',
      submittedAt: '2026-02-19T14:32:00.000Z',
      userAgent: null,
      screenSize: null,
      referer: null,
    });

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    for (const [, payload] of sendEmailMock.mock.calls) {
      expect(typeof payload.htmlBody).toBe('string');
      expect(payload.htmlBody.length).toBeGreaterThan(0);
      expect(typeof payload.textBody).toBe('string');
      expect(payload.textBody.length).toBeGreaterThan(0);
    }
  });

  it('sendHelpConfirmationEmail truncates long descriptions before rendering', async () => {
    await sendHelpConfirmationEmail({
      env,
      to: 'user@example.com',
      firstName: 'Jane',
      userEmail: 'user@example.com',
      category: 'Bug report',
      severity: 'High',
      subject: 'Long description test',
      description: 'x'.repeat(520),
    });

    const [, payload] = sendEmailMock.mock.calls[0];
    expect(payload.htmlBody).toContain(`${'x'.repeat(497)}...`);
    expect(payload.htmlBody).not.toContain('x'.repeat(520));
  });
});
