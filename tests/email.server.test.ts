import { describe, expect, it } from 'vitest';
import {
  buildInvitationUrl,
  resolveAppBaseUrl,
  sendOrgInvitationEmail,
} from '@/lib/email.server';

describe('email.server', () => {
  it('resolves base URL from WORKER_BASE_URL when provided', () => {
    const baseUrl = resolveAppBaseUrl(
      { WORKER_BASE_URL: 'https://staging.chiridion.ai/' },
      new URL('https://example.com/foo')
    );

    expect(baseUrl).toBe('https://staging.chiridion.ai');
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
      'https://chiridion.ai/',
      'org_123',
      'inv_456'
    );

    expect(url).toBe('https://chiridion.ai/invitations/org_123/inv_456');
  });

  it('skips invite email when binding is not configured', async () => {
    const result = await sendOrgInvitationEmail({
      env: { EMAIL: undefined, EMAIL_FROM_ADDRESS: 'no-reply@chiridion.ai' },
      to: 'invitee@example.com',
      orgName: 'Acme',
      inviterName: 'Owner',
      role: 'member',
      invitationUrl: 'https://chiridion.ai/invitations/org/inv',
      expiresAt: Date.now() + 3600_000,
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'No email provider configured (Gmail API or Cloudflare EMAIL binding)',
    });
  });

  it('skips invite email when sender address is missing', async () => {
    const result = await sendOrgInvitationEmail({
      env: {
        EMAIL: {
          send: async () => undefined,
        },
        EMAIL_FROM_ADDRESS: undefined,
      },
      to: 'invitee@example.com',
      orgName: 'Acme',
      inviterName: 'Owner',
      role: 'member',
      invitationUrl: 'https://chiridion.ai/invitations/org/inv',
      expiresAt: Date.now() + 3600_000,
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'EMAIL_FROM_ADDRESS is not configured',
    });
  });
});
