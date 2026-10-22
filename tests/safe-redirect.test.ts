import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from '../src/lib/safe-redirect';
import { sanitizeOAuthRedirectPath } from '../workers/main/src/routes/oauth-helpers';

describe('safe redirects', () => {
  it.each(['//evil.test', '/\\evil.test', '/\t/evil.test', '/\n/evil.test', 'https://evil.test', '/a/..//evil.test'])('rejects browser-normalized external path %j', (path) => {
    expect(safeRedirectPath(path)).toBe('/');
    expect(sanitizeOAuthRedirectPath(path)).toBe('/connections');
  });
  it('preserves local continuations and nested OAuth URLs', () => {
    const path = '/api/admin/oauth/authorize?redirect_uri=https%3A%2F%2Flocalhost%2Fcallback#step';
    expect(safeRedirectPath(path)).toBe(path);
    expect(safeRedirectPath('/chat?url=https://example.com')).toBe('/chat?url=https://example.com');
    expect(safeRedirectPath(null)).toBe('/');
  });
});
