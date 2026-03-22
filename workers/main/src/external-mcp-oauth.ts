/**
 * OAuth 2.1 server provider for the external MCP server.
 *
 * Implements dynamic client registration (RFC 7591), authorization code
 * flow with PKCE, access/refresh tokens, and token verification.
 *
 * All state is stored in APP_KV with prefixes:
 *   mcp_client:{clientId}        – registered client metadata
 *   mcp_authcode:{code}          – pending authorization code (5 min TTL)
 *   mcp_token:{accessToken}      – access token → grant info (1 hour TTL)
 *   mcp_refresh:{refreshToken}   – refresh token → grant info (30 day TTL)
 */

import type { KVNamespace } from '@cloudflare/workers-types';

// ── Types ────────────────────────────────────────────────────────────

export interface OAuthClientRecord {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  client_name?: string;
  client_uri?: string;
  scope?: string;
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}

export interface AuthCodeRecord {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  user_id: string;
  org_id: string;
  workspace_id: string;
  state?: string;
  created_at: number;
}

export interface TokenGrantRecord {
  client_id: string;
  user_id: string;
  org_id: string;
  workspace_id: string;
  scopes: string[];
  created_at: number;
  expires_at: number;
}

export interface RefreshGrantRecord extends TokenGrantRecord {
  access_token: string;
}

// ── Constants ────────────────────────────────────────────────────────

const AUTH_CODE_TTL = 5 * 60; // 5 minutes
const ACCESS_TOKEN_TTL = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days

const KV_PREFIX_CLIENT = 'mcp_client:';
const KV_PREFIX_AUTHCODE = 'mcp_authcode:';
const KV_PREFIX_TOKEN = 'mcp_token:';
const KV_PREFIX_REFRESH = 'mcp_refresh:';

// ── Helpers ──────────────────────────────────────────────────────────

function generateId(length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64url(new Uint8Array(hash));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// ── OAuth Provider ───────────────────────────────────────────────────

export class ExternalMcpOAuthProvider {
  constructor(private kv: KVNamespace) {}

  // ─── Dynamic Client Registration (RFC 7591) ─────────────────────

  async registerClient(metadata: {
    redirect_uris: string[];
    client_name?: string;
    client_uri?: string;
    scope?: string;
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
  }): Promise<OAuthClientRecord> {
    if (!metadata.redirect_uris?.length) {
      throw new OAuthError('invalid_client_metadata', 'redirect_uris is required');
    }

    const client_id = generateId(16);
    const authMethod = metadata.token_endpoint_auth_method ?? 'client_secret_post';
    const isPublicClient = authMethod === 'none';
    const now = Math.floor(Date.now() / 1000);

    const record: OAuthClientRecord = {
      client_id,
      // Only issue a secret for confidential clients
      ...(!isPublicClient && { client_secret: generateId(32) }),
      client_id_issued_at: now,
      redirect_uris: metadata.redirect_uris,
      client_name: metadata.client_name,
      client_uri: metadata.client_uri,
      scope: metadata.scope,
      grant_types: metadata.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: metadata.response_types ?? ['code'],
      token_endpoint_auth_method: authMethod,
    };

    await this.kv.put(`${KV_PREFIX_CLIENT}${client_id}`, JSON.stringify(record));
    return record;
  }

  async getClient(clientId: string): Promise<OAuthClientRecord | null> {
    const raw = await this.kv.get(`${KV_PREFIX_CLIENT}${clientId}`);
    if (!raw) return null;
    return JSON.parse(raw) as OAuthClientRecord;
  }

  // ─── Authorization Code ─────────────────────────────────────────

  async createAuthorizationCode(params: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    scopes: string[];
    user_id: string;
    org_id: string;
    workspace_id: string;
    state?: string;
  }): Promise<string> {
    const code = generateId(32);
    const record: AuthCodeRecord = {
      ...params,
      created_at: Math.floor(Date.now() / 1000),
    };
    await this.kv.put(`${KV_PREFIX_AUTHCODE}${code}`, JSON.stringify(record), {
      expirationTtl: AUTH_CODE_TTL,
    });
    return code;
  }

  async exchangeAuthorizationCode(
    clientId: string,
    code: string,
    codeVerifier?: string,
    redirectUri?: string,
  ): Promise<{ access_token: string; refresh_token: string; token_type: string; expires_in: number; scope?: string }> {
    const raw = await this.kv.get(`${KV_PREFIX_AUTHCODE}${code}`);
    if (!raw) {
      throw new OAuthError('invalid_grant', 'Authorization code is invalid or expired');
    }

    const record = JSON.parse(raw) as AuthCodeRecord;

    // Delete immediately (single-use)
    await this.kv.delete(`${KV_PREFIX_AUTHCODE}${code}`);

    // Validate client
    if (record.client_id !== clientId) {
      throw new OAuthError('invalid_grant', 'Authorization code was issued to a different client');
    }

    // Validate redirect_uri
    if (redirectUri && record.redirect_uri !== redirectUri) {
      throw new OAuthError('invalid_grant', 'redirect_uri mismatch');
    }

    // Validate PKCE
    if (record.code_challenge) {
      if (!codeVerifier) {
        throw new OAuthError('invalid_grant', 'code_verifier is required');
      }
      const challenge = await sha256(codeVerifier);
      if (challenge !== record.code_challenge) {
        throw new OAuthError('invalid_grant', 'code_verifier does not match code_challenge');
      }
    }

    // Issue tokens
    return this.issueTokens(clientId, record.user_id, record.org_id, record.workspace_id, record.scopes);
  }

  // ─── Token Issuance ─────────────────────────────────────────────

  private async issueTokens(
    clientId: string,
    userId: string,
    orgId: string,
    workspaceId: string,
    scopes: string[],
  ): Promise<{ access_token: string; refresh_token: string; token_type: string; expires_in: number; scope?: string }> {
    const now = Math.floor(Date.now() / 1000);
    const access_token = generateId(32);
    const refresh_token = generateId(32);

    const grant: TokenGrantRecord = {
      client_id: clientId,
      user_id: userId,
      org_id: orgId,
      workspace_id: workspaceId,
      scopes,
      created_at: now,
      expires_at: now + ACCESS_TOKEN_TTL,
    };

    const refreshGrant: RefreshGrantRecord = {
      ...grant,
      access_token,
      expires_at: now + REFRESH_TOKEN_TTL,
    };

    await Promise.all([
      this.kv.put(`${KV_PREFIX_TOKEN}${access_token}`, JSON.stringify(grant), {
        expirationTtl: ACCESS_TOKEN_TTL,
      }),
      this.kv.put(`${KV_PREFIX_REFRESH}${refresh_token}`, JSON.stringify(refreshGrant), {
        expirationTtl: REFRESH_TOKEN_TTL,
      }),
    ]);

    return {
      access_token,
      refresh_token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL,
      scope: scopes.length ? scopes.join(' ') : undefined,
    };
  }

  // ─── Refresh Token ──────────────────────────────────────────────

  async exchangeRefreshToken(
    clientId: string,
    refreshToken: string,
  ): Promise<{ access_token: string; refresh_token: string; token_type: string; expires_in: number; scope?: string }> {
    const raw = await this.kv.get(`${KV_PREFIX_REFRESH}${refreshToken}`);
    if (!raw) {
      throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired');
    }

    const record = JSON.parse(raw) as RefreshGrantRecord;

    if (record.client_id !== clientId) {
      throw new OAuthError('invalid_grant', 'Refresh token was issued to a different client');
    }

    // Revoke old access token and refresh token
    await Promise.all([
      this.kv.delete(`${KV_PREFIX_TOKEN}${record.access_token}`),
      this.kv.delete(`${KV_PREFIX_REFRESH}${refreshToken}`),
    ]);

    // Issue new token pair
    return this.issueTokens(clientId, record.user_id, record.org_id, record.workspace_id, record.scopes);
  }

  // ─── Token Verification ────────────────────────────────────────

  async verifyAccessToken(token: string): Promise<TokenGrantRecord | null> {
    const raw = await this.kv.get(`${KV_PREFIX_TOKEN}${token}`);
    if (!raw) return null;

    const grant = JSON.parse(raw) as TokenGrantRecord;
    const now = Math.floor(Date.now() / 1000);
    if (grant.expires_at <= now) return null;

    return grant;
  }

  // ─── Token Revocation ──────────────────────────────────────────

  async revokeToken(token: string, tokenTypeHint?: string): Promise<void> {
    if (tokenTypeHint === 'refresh_token') {
      await this.kv.delete(`${KV_PREFIX_REFRESH}${token}`);
    } else if (tokenTypeHint === 'access_token') {
      await this.kv.delete(`${KV_PREFIX_TOKEN}${token}`);
    } else {
      // Try both
      await Promise.all([
        this.kv.delete(`${KV_PREFIX_TOKEN}${token}`),
        this.kv.delete(`${KV_PREFIX_REFRESH}${token}`),
      ]);
    }
  }
}

// ── OAuth Error ──────────────────────────────────────────────────────

export class OAuthError extends Error {
  constructor(
    public readonly error: string,
    public readonly error_description?: string,
  ) {
    super(error_description ?? error);
    this.name = 'OAuthError';
  }

  toJSON() {
    return {
      error: this.error,
      ...(this.error_description && { error_description: this.error_description }),
    };
  }

  toResponse(status = 400): Response {
    return new Response(JSON.stringify(this.toJSON()), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
}
