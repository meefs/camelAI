import { describe, expect, it } from 'vitest';

import {
  assertEmailDomainAllowed,
  EMAIL_DOMAIN_BLOCKED_ERROR,
  findBlockedEmailDomain,
  getEmailDomain,
  isEmailDomainBlocked,
  parseEmailDomainBlocklist,
} from '@/lib/email-domain-blocklist';

describe('email domain blocklist helpers', () => {
  it('parses and normalizes configured domains', () => {
    expect(
      parseEmailDomainBlocklist(' mailinator.com, @tempmail.com\nMAILINATOR.COM ; '),
    ).toEqual(['mailinator.com', 'tempmail.com']);
  });

  it('extracts a normalized email domain', () => {
    expect(getEmailDomain(' User@Sub.Example.com ')).toBe('sub.example.com');
  });

  it('matches exact blocked domains', () => {
    expect(
      findBlockedEmailDomain('user@mailinator.com', 'mailinator.com,tempmail.com'),
    ).toBe('mailinator.com');
    expect(isEmailDomainBlocked('user@mailinator.com', 'mailinator.com,tempmail.com')).toBe(true);
  });

  it('matches blocked parent domains against subdomains', () => {
    expect(
      findBlockedEmailDomain('user@mx.mailinator.com', 'mailinator.com'),
    ).toBe('mailinator.com');
    expect(isEmailDomainBlocked('user@mx.mailinator.com', 'mailinator.com')).toBe(true);
  });

  it('does not block unrelated domains', () => {
    expect(findBlockedEmailDomain('user@example.com', 'mailinator.com')).toBeNull();
    expect(isEmailDomainBlocked('user@example.com', 'mailinator.com')).toBe(false);
  });

  it('throws the blocked-domain error marker for blocked emails', () => {
    expect(() =>
      assertEmailDomainAllowed('user@mailinator.com', 'mailinator.com'),
    ).toThrow(EMAIL_DOMAIN_BLOCKED_ERROR);
  });
});
