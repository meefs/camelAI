/**
 * OAuth 2.1 provider for the admin MCP server.
 *
 * This is intentionally separate from the workspace external API OAuth provider:
 * admin MCP grants have no workspace binding and must be re-authorized as a
 * superuser before every protected resource request.
 */

export interface AdminMcpOAuthClientRecord {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  scope?: string;
  created_at: number;
}

export interface AdminMcpAuthCodeRecord {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  user_id: string;
  resource: string;
  state?: string;
  created_at: number;
}

export interface AdminMcpTokenGrantRecord {
  client_id: string;
  user_id: string;
  scopes: string[];
  resource: string;
  created_at: number;
  expires_at: number;
}

interface RefreshGrantRecord extends AdminMcpTokenGrantRecord {
  access_token: string;
}

const AUTH_CODE_TTL = 5 * 60;
const ACCESS_TOKEN_TTL = 60 * 60;
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60;

const KV_PREFIX_CLIENT = "admin_mcp_client:";
const KV_PREFIX_AUTHCODE = "admin_mcp_authcode:";
const KV_PREFIX_TOKEN = "admin_mcp_token:";
const KV_PREFIX_REFRESH = "admin_mcp_refresh:";

export const ADMIN_MCP_SCOPE = "admin:mcp";

function generateId(prefix = "", length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return `${prefix}${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(hash));
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function isCursorOAuthRedirectUri(url: URL): boolean {
  return url.protocol === "cursor:"
    && url.hostname === "anysphere.cursor-mcp"
    && url.pathname === "/oauth/callback"
    && !url.port
    && !url.username
    && !url.password
    && !url.search
    && !url.hash;
}

export function isAllowedOAuthRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      || (url.protocol === "http:" && isLoopbackHostname(url.hostname))
      || isCursorOAuthRedirectUri(url);
  } catch {
    return false;
  }
}

function normalizeScopes(scope: string | null | undefined): string[] {
  const scopes = (scope ?? ADMIN_MCP_SCOPE)
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return scopes.length ? scopes : [ADMIN_MCP_SCOPE];
}

export class AdminMcpOAuthProvider {
  constructor(
    private kv: KVNamespace,
    private staticClientId?: string,
    private staticRedirectUris: string[] = [],
  ) {}

  async registerClient(metadata: {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    response_types?: string[];
    scope?: string;
    token_endpoint_auth_method?: string;
  }): Promise<AdminMcpOAuthClientRecord> {
    const redirectUris = metadata.redirect_uris ?? [];
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      throw new OAuthError("invalid_client_metadata", "redirect_uris is required");
    }
    if (!redirectUris.every((uri) => typeof uri === "string" && isAllowedOAuthRedirectUri(uri))) {
      throw new OAuthError(
        "invalid_client_metadata",
        "redirect_uris must be HTTPS, loopback HTTP, or a supported native-app callback URL",
      );
    }
    if (
      metadata.token_endpoint_auth_method &&
      metadata.token_endpoint_auth_method !== "none"
    ) {
      throw new OAuthError("invalid_client_metadata", "Only public clients are supported");
    }

    const now = Math.floor(Date.now() / 1000);
    const client: AdminMcpOAuthClientRecord = {
      client_id: generateId("admin_mcp_client_"),
      client_name: metadata.client_name,
      redirect_uris: redirectUris,
      grant_types: metadata.grant_types?.length ? metadata.grant_types : ["authorization_code", "refresh_token"],
      response_types: metadata.response_types?.length ? metadata.response_types : ["code"],
      token_endpoint_auth_method: "none",
      scope: metadata.scope,
      created_at: now,
    };

    await this.kv.put(`${KV_PREFIX_CLIENT}${client.client_id}`, JSON.stringify(client), {
      expirationTtl: REFRESH_TOKEN_TTL,
    });
    return client;
  }

  async validateClient(clientId: string, redirectUri?: string): Promise<boolean> {
    if (this.staticClientId && clientId === this.staticClientId) {
      if (this.staticRedirectUris.length === 0) return false;
      return !redirectUri || this.staticRedirectUris.includes(redirectUri);
    }

    const client = await this.getClient(clientId);
    if (!client) return false;
    return !redirectUri || client.redirect_uris.includes(redirectUri);
  }

  async getClient(clientId: string): Promise<AdminMcpOAuthClientRecord | null> {
    const raw = await this.kv.get(`${KV_PREFIX_CLIENT}${clientId}`);
    return raw ? (JSON.parse(raw) as AdminMcpOAuthClientRecord) : null;
  }

  async createAuthorizationCode(params: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    scope?: string | null;
    user_id: string;
    resource: string;
    state?: string;
  }): Promise<string> {
    const code = generateId();
    const record: AdminMcpAuthCodeRecord = {
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge,
      scopes: normalizeScopes(params.scope),
      user_id: params.user_id,
      resource: params.resource,
      state: params.state,
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
    resource?: string,
  ): Promise<{ access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string }> {
    const raw = await this.kv.get(`${KV_PREFIX_AUTHCODE}${code}`);
    if (!raw) throw new OAuthError("invalid_grant", "Authorization code is invalid or expired");

    const record = JSON.parse(raw) as AdminMcpAuthCodeRecord;
    await this.kv.delete(`${KV_PREFIX_AUTHCODE}${code}`);

    if (record.client_id !== clientId) throw new OAuthError("invalid_grant", "Code issued to a different client");
    if (!redirectUri) throw new OAuthError("invalid_grant", "redirect_uri is required");
    if (record.redirect_uri !== redirectUri) throw new OAuthError("invalid_grant", "redirect_uri mismatch");
    if (resource && record.resource !== resource) throw new OAuthError("invalid_target", "resource mismatch");

    if (record.code_challenge) {
      if (!codeVerifier) throw new OAuthError("invalid_grant", "code_verifier is required");
      const challenge = await sha256(codeVerifier);
      if (challenge !== record.code_challenge) throw new OAuthError("invalid_grant", "code_verifier mismatch");
    }

    return this.issueTokens(clientId, record.user_id, record.resource, record.scopes);
  }

  async exchangeRefreshToken(
    clientId: string,
    refreshToken: string,
    resource?: string,
  ): Promise<{ access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string }> {
    const raw = await this.kv.get(`${KV_PREFIX_REFRESH}${refreshToken}`);
    if (!raw) throw new OAuthError("invalid_grant", "Refresh token is invalid or expired");

    const record = JSON.parse(raw) as RefreshGrantRecord;
    if (record.client_id !== clientId) throw new OAuthError("invalid_grant", "Refresh token issued to a different client");
    if (resource && record.resource !== resource) throw new OAuthError("invalid_target", "resource mismatch");

    await Promise.all([
      this.kv.delete(`${KV_PREFIX_TOKEN}${record.access_token}`),
      this.kv.delete(`${KV_PREFIX_REFRESH}${refreshToken}`),
    ]);

    return this.issueTokens(clientId, record.user_id, record.resource, record.scopes);
  }

  async verifyAccessToken(token: string, resource: string): Promise<AdminMcpTokenGrantRecord | null> {
    const raw = await this.kv.get(`${KV_PREFIX_TOKEN}${token}`);
    if (!raw) return null;
    const grant = JSON.parse(raw) as AdminMcpTokenGrantRecord;
    if (grant.expires_at <= Math.floor(Date.now() / 1000)) return null;
    if (grant.resource !== resource) return null;
    return grant;
  }

  async revokeToken(token: string, tokenTypeHint?: string): Promise<void> {
    if (tokenTypeHint === "refresh_token") {
      await this.kv.delete(`${KV_PREFIX_REFRESH}${token}`);
    } else if (tokenTypeHint === "access_token") {
      await this.kv.delete(`${KV_PREFIX_TOKEN}${token}`);
    } else {
      await Promise.all([
        this.kv.delete(`${KV_PREFIX_TOKEN}${token}`),
        this.kv.delete(`${KV_PREFIX_REFRESH}${token}`),
      ]);
    }
  }

  private async issueTokens(
    clientId: string,
    userId: string,
    resource: string,
    scopes: string[],
  ): Promise<{ access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string }> {
    const now = Math.floor(Date.now() / 1000);
    const access_token = generateId();
    const refresh_token = generateId();
    const grant: AdminMcpTokenGrantRecord = {
      client_id: clientId,
      user_id: userId,
      scopes,
      resource,
      created_at: now,
      expires_at: now + ACCESS_TOKEN_TTL,
    };
    const refreshGrant: RefreshGrantRecord = {
      ...grant,
      access_token,
      expires_at: now + REFRESH_TOKEN_TTL,
    };

    await Promise.all([
      this.kv.put(`${KV_PREFIX_TOKEN}${access_token}`, JSON.stringify(grant), { expirationTtl: ACCESS_TOKEN_TTL }),
      this.kv.put(`${KV_PREFIX_REFRESH}${refresh_token}`, JSON.stringify(refreshGrant), { expirationTtl: REFRESH_TOKEN_TTL }),
    ]);

    return {
      access_token,
      refresh_token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL,
      scope: scopes.join(" "),
    };
  }
}

export class OAuthError extends Error {
  constructor(public readonly error: string, public readonly error_description?: string) {
    super(error_description ?? error);
    this.name = "OAuthError";
  }

  toJSON() {
    return { error: this.error, ...(this.error_description && { error_description: this.error_description }) };
  }

  toResponse(status = 400): Response {
    return Response.json(this.toJSON(), {
      status,
      headers: { "cache-control": "no-store" },
    });
  }
}
