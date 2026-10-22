import { describe, expect, it } from 'vitest';
import { rejectCrossOriginMutation } from '../workers/main/src/browser-request-security';

const url = 'https://staging.camelai.dev/api/workspaces/ws/settings';
const check = (headers: Record<string, string>, method = 'POST') =>
  rejectCrossOriginMutation(new Request(url, { method, headers }));

describe('browser write boundary', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects sibling-origin %s even with same-site cookies', (method) => {
    expect(check({ Origin: 'https://evil.apps.staging.camelai.dev', 'Sec-Fetch-Site': 'same-site', Cookie: 'session=x' }, method)?.status).toBe(403);
  });
  it.each(['null', 'https://staging.camelai.dev.evil.test', 'https://evil.test', 'http://staging.camelai.dev'])('rejects Origin %s', (Origin) => {
    expect(check({ Origin })?.status).toBe(403);
  });
  it('accepts same-origin forms and JSON writes', () => {
    expect(check({ Origin: new URL(url).origin, Cookie: 'session=x', 'Content-Type': 'application/x-www-form-urlencoded' })).toBeNull();
    expect(check({ 'Sec-Fetch-Site': 'same-origin', Cookie: 'session=x' })).toBeNull();
  });
  it('checks Referer for older browsers', () => {
    expect(check({ Referer: 'https://staging.camelai.dev/settings', Cookie: 'session=x' })).toBeNull();
    expect(check({ Referer: 'https://evil.test/settings', Cookie: 'session=x' })?.status).toBe(403);
  });
  it('fails closed for cookie writes without source metadata', () => {
    expect(check({ Cookie: 'session=x' })?.status).toBe(403);
    expect(check({ Cookie: 'session=x', 'Sec-Fetch-Site': 'none' })?.status).toBe(403);
  });
  it('preserves non-browser explicit-token callers and safe navigations', () => {
    expect(check({ Authorization: 'Bearer example' })).toBeNull();
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(check({ Origin: 'https://evil.test' }, method)).toBeNull();
  });
});
