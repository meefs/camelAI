import { describe, expect, it } from 'vitest';
import { sanitizeRedirectPath } from '../src/routes/oauth';

describe('oauth redirect sanitization', () => {
  it('preserves prompt_key redirects with query strings intact', () => {
    expect(sanitizeRedirectPath('/chat?prompt_key=abc123')).toBe('/chat?prompt_key=abc123');
  });

  it('rejects unsafe redirect values', () => {
    expect(sanitizeRedirectPath('https://evil.example')).toBe('/');
    expect(sanitizeRedirectPath('//evil.example')).toBe('/');
  });
});
