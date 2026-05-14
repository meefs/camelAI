import { describe, expect, it, vi } from 'vitest';
import {
  buildRemoteMcpAuthorizationUrl,
  discoverRemoteMcpOAuth,
  exchangeRemoteMcpOAuthCode,
  registerRemoteMcpOAuthClient,
} from '../src/remote-mcp-oauth';

describe('remote MCP OAuth flow', () => {
  it('discovers metadata, registers dynamically, and exchanges the code with the resource parameter', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === 'https://mcp.example.com/mcp') {
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="wiki:read"',
          },
        });
      }
      if (target === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
        return Response.json({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com/tenant'],
          scopes_supported: ['wiki:read'],
        });
      }
      if (target === 'https://auth.example.com/.well-known/oauth-authorization-server/tenant') {
        return Response.json({
          issuer: 'https://auth.example.com/tenant',
          authorization_endpoint: 'https://auth.example.com/tenant/authorize',
          token_endpoint: 'https://auth.example.com/tenant/token',
          registration_endpoint: 'https://auth.example.com/tenant/register',
        });
      }
      if (target === 'https://auth.example.com/tenant/register') {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          redirect_uris: ['https://app.example.com/api/integrations/remote_mcp/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: 'wiki:read',
        });
        return Response.json({
          client_id: 'client-1',
          token_endpoint_auth_method: 'none',
        });
      }
      if (target === 'https://auth.example.com/tenant/token') {
        expect(init?.method).toBe('POST');
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('client_id')).toBe('client-1');
        expect(body.get('code')).toBe('code-1');
        expect(body.get('code_verifier')).toBe('verifier-1');
        expect(body.get('resource')).toBe('https://mcp.example.com/mcp');
        return Response.json({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      return new Response('not found', { status: 404 });
    });

    const discovery = await discoverRemoteMcpOAuth('https://mcp.example.com/mcp', fetchMock as typeof fetch);
    expect(discovery).toMatchObject({
      authorizationServer: 'https://auth.example.com/tenant',
      resource: 'https://mcp.example.com/mcp',
      scope: 'wiki:read',
    });

    const client = await registerRemoteMcpOAuthClient(
      discovery,
      'https://app.example.com/api/integrations/remote_mcp/callback',
      fetchMock as typeof fetch
    );
    expect(client.client_id).toBe('client-1');

    const authorizationUrl = new URL(buildRemoteMcpAuthorizationUrl({
      discovery,
      client,
      redirectUri: 'https://app.example.com/api/integrations/remote_mcp/callback',
      state: 'state-1',
      codeChallenge: 'challenge-1',
    }));
    expect(authorizationUrl.searchParams.get('resource')).toBe('https://mcp.example.com/mcp');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');

    await expect(exchangeRemoteMcpOAuthCode({
      tokenEndpoint: 'https://auth.example.com/tenant/token',
      clientId: 'client-1',
      tokenEndpointAuthMethod: 'none',
      code: 'code-1',
      redirectUri: 'https://app.example.com/api/integrations/remote_mcp/callback',
      codeVerifier: 'verifier-1',
      resource: 'https://mcp.example.com/mcp',
    }, fetchMock as typeof fetch)).resolves.toMatchObject({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
    });
  });
});
