import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { AdminMcpOAuthProvider } from "../src/admin-mcp-oauth";
import { handleAdminMcp } from "../src/routes/admin-mcp";
import { handleOAuthMetadata, handleResourceMetadata } from "../src/routes/well-known";
import type { Env as WorkerEnv } from "../src/types";
import { action as tokenAction } from "../../../src/routes/api/admin.oauth.token";
import {
  createOrg,
  createUser,
  type TestEnv,
  updateUserProfile,
} from "./test-helpers";

const testEnv = env as unknown as TestEnv & WorkerEnv;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function codeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(hash));
}

async function issueAdminMcpToken(userId: string): Promise<string> {
  const oauth = new AdminMcpOAuthProvider(testEnv.APP_KV);
  const client = await oauth.registerClient({
    client_name: "Test MCP Client",
    redirect_uris: ["http://localhost:4321/callback"],
  });
  const verifier = `verifier-${crypto.randomUUID()}`;
  const resource = "https://example.com/api/admin/mcp";
  const code = await oauth.createAuthorizationCode({
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: await codeChallenge(verifier),
    user_id: userId,
    resource,
  });
  const token = await oauth.exchangeAuthorizationCode(
    client.client_id,
    code,
    verifier,
    client.redirect_uris[0],
    resource,
  );
  return token.access_token;
}

function mcpRequest(body: unknown, token?: string): Request {
  return new Request("https://example.com/api/admin/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function routeContext(req: Request) {
  const url = new URL(req.url);
  return {
    req,
    env: testEnv,
    ctx: {} as ExecutionContext,
    url,
    match: [] as unknown as RegExpMatchArray,
  };
}

describe("admin MCP OAuth resource", () => {
  it("advertises a distinct admin OAuth issuer for the admin MCP resource", async () => {
    const resourceResponse = await handleResourceMetadata(routeContext(
      new Request("https://example.com/.well-known/oauth-protected-resource?resource=https%3A%2F%2Fexample.com%2Fapi%2Fadmin%2Fmcp"),
    ));
    expect(resourceResponse?.status).toBe(200);
    await expect(resourceResponse?.json()).resolves.toMatchObject({
      resource: "https://example.com/api/admin/mcp",
      authorization_servers: ["https://example.com/api/admin/oauth"],
    });

    const pathResourceResponse = await handleResourceMetadata(routeContext(
      new Request("https://example.com/.well-known/oauth-protected-resource/api/admin/mcp"),
    ));
    expect(pathResourceResponse?.status).toBe(200);
    await expect(pathResourceResponse?.json()).resolves.toMatchObject({
      resource: "https://example.com/api/admin/mcp",
      authorization_servers: ["https://example.com/api/admin/oauth"],
    });

    const adminMetadataResponse = await handleOAuthMetadata(routeContext(
      new Request("https://example.com/.well-known/oauth-authorization-server/api/admin/oauth"),
    ));
    expect(adminMetadataResponse?.status).toBe(200);
    await expect(adminMetadataResponse?.json()).resolves.toMatchObject({
      issuer: "https://example.com/api/admin/oauth",
      authorization_endpoint: "https://example.com/api/admin/oauth/authorize",
      token_endpoint: "https://example.com/api/admin/oauth/token",
    });

    const issuerMetadataResponse = await handleOAuthMetadata(routeContext(
      new Request("https://example.com/api/admin/oauth"),
    ));
    expect(issuerMetadataResponse?.status).toBe(200);
    await expect(issuerMetadataResponse?.json()).resolves.toMatchObject({
      issuer: "https://example.com/api/admin/oauth",
      authorization_endpoint: "https://example.com/api/admin/oauth/authorize",
      token_endpoint: "https://example.com/api/admin/oauth/token",
    });

    const issuerWellKnownMetadataResponse = await handleOAuthMetadata(routeContext(
      new Request("https://example.com/api/admin/oauth/.well-known/oauth-authorization-server"),
    ));
    expect(issuerWellKnownMetadataResponse?.status).toBe(200);
    await expect(issuerWellKnownMetadataResponse?.json()).resolves.toMatchObject({
      issuer: "https://example.com/api/admin/oauth",
      authorization_endpoint: "https://example.com/api/admin/oauth/authorize",
      token_endpoint: "https://example.com/api/admin/oauth/token",
    });

    const workspaceMetadataResponse = await handleOAuthMetadata(routeContext(
      new Request("https://example.com/.well-known/oauth-authorization-server"),
    ));
    expect(workspaceMetadataResponse?.status).toBe(200);
    await expect(workspaceMetadataResponse?.json()).resolves.toMatchObject({
      issuer: "https://example.com",
      authorization_endpoint: "https://example.com/api/ext/oauth/authorize",
    });
  });

  it("requires redirect_uri during authorization-code token exchange", async () => {
    const oauth = new AdminMcpOAuthProvider(testEnv.APP_KV);
    const client = await oauth.registerClient({
      client_name: "Redirect URI Test Client",
      redirect_uris: ["http://localhost:4321/callback"],
    });
    const verifier = `verifier-${crypto.randomUUID()}`;
    const code = await oauth.createAuthorizationCode({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge: await codeChallenge(verifier),
      user_id: crypto.randomUUID(),
      resource: "https://example.com/api/admin/mcp",
    });
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      resource: "https://example.com/api/admin/mcp",
    });

    const response = await tokenAction({
      request: new Request("https://example.com/api/admin/oauth/token", {
        method: "POST",
        body: body.toString(),
      }),
      context: { cloudflare: { env: testEnv } },
      params: {},
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_request",
      error_description: "redirect_uri is required",
    });
  });

  it("binds static admin clients to configured redirect URIs", async () => {
    const oauth = new AdminMcpOAuthProvider(
      testEnv.APP_KV,
      "static-admin-client",
      ["https://trusted.example/callback", "http://localhost:4321/callback"],
    );

    await expect(
      oauth.validateClient("static-admin-client", "https://trusted.example/callback"),
    ).resolves.toBe(true);
    await expect(
      oauth.validateClient("static-admin-client", "https://attacker.example/callback"),
    ).resolves.toBe(false);
    await expect(
      oauth.validateClient("static-admin-client", "http://localhost:9999/callback"),
    ).resolves.toBe(false);
    await expect(
      oauth.validateClient("static-admin-client"),
    ).resolves.toBe(true);
  });

  it("fails closed for static admin clients without a redirect URI allowlist", async () => {
    const oauth = new AdminMcpOAuthProvider(testEnv.APP_KV, "static-admin-client");

    await expect(
      oauth.validateClient("static-admin-client", "https://trusted.example/callback"),
    ).resolves.toBe(false);
    await expect(
      oauth.validateClient("static-admin-client"),
    ).resolves.toBe(false);
  });

  it("challenges unauthenticated MCP requests with protected resource metadata", async () => {
    const response = await handleAdminMcp({
      req: mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(401);
    expect(response?.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource",
    );
  });

  it("rejects valid OAuth tokens after the user loses superuser access", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-demoted-${crypto.randomUUID()}@example.com`,
      "password123",
      "Demoted User",
    );
    await createOrg(testEnv, "Demoted Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);
    await updateUserProfile(testEnv, userId, { is_superuser: false });

    const response = await handleAdminMcp({
      req: mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({
      details: "Admin access required",
    });
  });

  it("rejects org owners who are not superusers", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-org-owner-${crypto.randomUUID()}@example.com`,
      "password123",
      "Org Owner",
    );
    await createOrg(testEnv, "Org Owner Org", userId);
    const token = await issueAdminMcpToken(userId);

    const response = await handleAdminMcp({
      req: mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({
      details: "Admin access required",
    });
  });

  it("allows superusers to list admin MCP tools", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-super-${crypto.randomUUID()}@example.com`,
      "password123",
      "Admin User",
    );
    await createOrg(testEnv, "Admin Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);

    const response = await handleAdminMcp({
      req: mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "admin_api_request" }),
          expect.objectContaining({ name: "admin_openapi" }),
          expect.objectContaining({ name: "get_admin_stats" }),
          expect.objectContaining({ name: "search_users" }),
          expect.objectContaining({ name: "search_orgs" }),
          expect.objectContaining({ name: "search_threads" }),
          expect.objectContaining({ name: "search_workspaces" }),
          expect.objectContaining({ name: "search_apps" }),
          expect.objectContaining({ name: "list_bans" }),
          expect.objectContaining({ name: "set_user_credits" }),
        ]),
      },
    });
  });

  it("bridges MCP tool calls into the admin API", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-openapi-${crypto.randomUUID()}@example.com`,
      "password123",
      "OpenAPI Admin",
    );
    await createOrg(testEnv, "OpenAPI Admin Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);

    const response = await handleAdminMcp({
      req: mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "admin_openapi", arguments: {} },
        },
        token,
      ),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(200);
    const rpc = (await response?.json()) as any;
    expect(rpc.result.content[0].text).toContain("camelAI Admin API");
  });

  it("supports named admin API tools", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-stats-${crypto.randomUUID()}@example.com`,
      "password123",
      "Stats Admin",
    );
    await createOrg(testEnv, "Stats Admin Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);

    const response = await handleAdminMcp({
      req: mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_admin_stats", arguments: {} },
        },
        token,
      ),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(200);
    const rpc = (await response?.json()) as any;
    const text = rpc.result.content[0].text as string;
    expect(text).toContain("body_json");
    expect(text).toContain("total_users");
  });
});
