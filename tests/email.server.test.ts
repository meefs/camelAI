import { describe, expect, it, vi } from 'vitest';
import {
  buildInvitationUrl,
  resolveAppBaseUrl,
  sendOrgInvitationEmail,
} from '@/lib/email.server';
import { SELFHOST_OUTBOUND_EMAIL_DISABLED_MESSAGE } from '@/lib/selfhost-capabilities';

describe('email.server', () => {
  it('resolves base URL from WORKER_BASE_URL when provided', () => {
    const baseUrl = resolveAppBaseUrl(
      { WORKER_BASE_URL: 'https://staging.camelai.dev/' },
      new URL('https://example.com/foo')
    );

    expect(baseUrl).toBe('https://staging.camelai.dev');
  });

  it('falls back to request origin when WORKER_BASE_URL is missing or invalid', () => {
    const fallbackUrl = resolveAppBaseUrl(
      { WORKER_BASE_URL: '' },
      new URL('https://example.com/foo')
    );
    const invalidUrl = resolveAppBaseUrl(
      { WORKER_BASE_URL: 'not-a-valid-url' },
      new URL('https://example.com/foo')
    );

    expect(fallbackUrl).toBe('https://example.com');
    expect(invalidUrl).toBe('https://example.com');
  });

  it('builds an absolute invitation URL', () => {
    const url = buildInvitationUrl(
      'https://camelai.dev/',
      'org_123',
      'inv_456'
    );

    expect(url).toBe('https://camelai.dev/invitations/org_123/inv_456');
  });

  it('skips invite email when binding is not configured', async () => {
    const result = await sendOrgInvitationEmail({
      env: { EMAIL_FROM_ADDRESS: 'no-reply@mail.camelai.com', EMAIL: undefined },
      to: 'invitee@example.com',
      orgName: 'Acme',
      inviterName: 'Owner',
      role: 'member',
      invitationUrl: 'https://camelai.dev/invitations/org/inv',
      expiresAt: Date.now() + 3600_000,
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'Cloudflare Email Sending binding EMAIL is not configured',
    });
  });

  it('skips invite email when sender address is missing', async () => {
    const result = await sendOrgInvitationEmail({
      env: {
        EMAIL_FROM_ADDRESS: undefined,
        EMAIL: { send: async () => ({ messageId: 'msg_1' }) },
      },
      to: 'invitee@example.com',
      orgName: 'Acme',
      inviterName: 'Owner',
      role: 'member',
      invitationUrl: 'https://camelai.dev/invitations/org/inv',
      expiresAt: Date.now() + 3600_000,
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'EMAIL_FROM_ADDRESS is not configured',
    });
  });

  it('never sends through a configured Cloudflare binding in self-host mode', async () => {
    const send = vi.fn();
    const result = await sendOrgInvitationEmail({
      env: {
        CF_ACCOUNT_ID: 'selfhost',
        EMAIL_FROM_ADDRESS: 'no-reply@example.com',
        EMAIL: { send },
      },
      to: 'invitee@example.com',
      orgName: 'Acme',
      inviterName: 'Owner',
      role: 'member',
      invitationUrl: 'https://selfhost.example/invitations/org/inv',
      expiresAt: Date.now() + 3600_000,
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: SELFHOST_OUTBOUND_EMAIL_DISABLED_MESSAGE,
    });
    expect(send).not.toHaveBeenCalled();
  });
});
