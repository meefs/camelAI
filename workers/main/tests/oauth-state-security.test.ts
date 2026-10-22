import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, type TestEnv } from './test-helpers';
import { validateAndConsumeIntegrationOAuthState } from '../src/integration-oauth-state';
import { requireSession } from '../src/helpers/auth';
import { AdminMcpOAuthProvider, isAllowedOAuthRedirectUri } from '../src/admin-mcp-oauth';

vi.mock('../src/helpers/auth', () => ({ requireSession: vi.fn() }));
const testEnv = env as unknown as TestEnv;

describe('durable OAuth replay prevention', () => {
  it('admits only one concurrent callback even if KV keeps returning the consumed state', async () => {
    const { user } = await createUser(testEnv, `${crypto.randomUUID()}@example.com`, "Password123!", "OAuth Test");
    vi.mocked(requireSession).mockResolvedValue({ session: { user_id: user.id } } as never);
    const data = { user_id: user.id, workspace_id: 'workspace', integration_type: 'slack', created_at: Date.now(), redirect_url: '/connections' };
    const kv = { get: vi.fn(async () => data), delete: vi.fn(async () => {}) } as unknown as KVNamespace;
    const context = { req: new Request('https://example.com/callback'), env: testEnv as never };
    const state = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => validateAndConsumeIntegrationOAuthState(kv, state, context)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await validateAndConsumeIntegrationOAuthState(kv, state, context)).toBeNull();
  });
  it('rejects another browser user and stale KV entries before consuming them', async () => {
    vi.mocked(requireSession).mockResolvedValue({ session: { user_id: 'different-user' } } as never);
    const data = { user_id: 'owner', workspace_id: 'workspace', created_at: Date.now(), integration_type: 'slack' };
    const kv = { get: async () => data, delete: vi.fn() } as unknown as KVNamespace;
    const context = { req: new Request('https://example.com/callback'), env: testEnv as never };
    expect(await validateAndConsumeIntegrationOAuthState(kv, 'state', context)).toBeNull();
    data.created_at -= 301_000;
    expect(await validateAndConsumeIntegrationOAuthState(kv, 'state', context)).toBeNull();
    expect(kv.delete).not.toHaveBeenCalled();
  });
  it('rejects reused admin codes and refresh tokens despite stale KV reads', async () => {
    const { user } = await createUser(testEnv, `${crypto.randomUUID()}@example.com`, "Password123!", "OAuth Test");
    const store = new Map<string, string>();
    const kv = { get: async (key: string) => store.get(key) ?? null, put: async (key: string, value: string) => { store.set(key, value); }, delete: async () => {} } as unknown as KVNamespace;
    const oauth = new AdminMcpOAuthProvider(kv, testEnv.USER);
    const verifier = 'a'.repeat(43);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const code = await oauth.createAuthorizationCode({ client_id: 'client', redirect_uri: 'https://example.com/callback', code_challenge: challenge, user_id: user.id, resource: 'https://example.com/mcp' });
    const redeem = () => oauth.exchangeAuthorizationCode('client', code, verifier, 'https://example.com/callback');
    const results = await Promise.allSettled([redeem(), redeem(), redeem()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const token = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof redeem>>>).value;
    const refresh = () => oauth.exchangeRefreshToken('client', token.refresh_token);
    expect((await Promise.allSettled([refresh(), refresh()])).filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
});

it.each(['https://user:password@example.com/callback', 'https://example.com/callback#fragment', 'https://example.com/\\evil', 'https://example.com/white space'])('rejects unsafe admin redirect %s', (url) => {
  expect(isAllowedOAuthRedirectUri(url)).toBe(false);
});

it('does not replace a linked provider subject during concurrent linking', async () => {
  const { user } = await createUser(testEnv, `${crypto.randomUUID()}@example.com`, 'Password123!', 'OAuth Test');
  const stub = testEnv.USER.get(testEnv.USER.idFromName(user.id));
  const outcomes = await Promise.allSettled([stub.linkOAuthProvider('google', 'first'), stub.linkOAuthProvider('google', 'second')]);
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const linked = await stub.getOAuthProvider('google');
  expect(['first', 'second']).toContain(linked?.provider_id);
});
