import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleAdminMcp } from "../src/routes/admin-mcp";
import type { Env as WorkerEnv } from "../src/types";
import { createAccessJwt, jsonResponse } from "../../../tests/helpers/access-jwt";
import { createUser, type TestEnv, updateUserProfile } from "./test-helpers";

const testEnv = env as unknown as TestEnv & WorkerEnv;
const AUD = "admin-mcp-test-aud";

// The JWKS is cached by URL, so each test gets its own team domain.
function accessEnv(teamDomain: string | undefined) {
  return {
    ...testEnv,
    ADMIN_MCP_ACCESS_TEAM_DOMAIN: teamDomain,
    ADMIN_MCP_ACCESS_AUD: teamDomain ? AUD : undefined,
  } as unknown as WorkerEnv;
}

function uniqueTeamDomain(): string {
  return `https://team-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`;
}

async function assertionFor(teamDomain: string, email: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const { token, publicJwk } = await createAccessJwt({
    iss: teamDomain,
    aud: [AUD],
    email,
    iat: now,
    exp: now + 600,
    ...overrides,
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const value = url instanceof Request ? url.url : url.toString();
    if (value === `${teamDomain}/cdn-cgi/access/certs`) return jsonResponse({ keys: [publicJwk] });
    return new Response(null, { status: 404 });
  }));
  return token;
}

function listTools(headers: Record<string, string>, workerEnv: WorkerEnv) {
  return handleAdminMcp({
    req: new Request("https://example.com/api/admin/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    env: workerEnv,
    ctx: {} as ExecutionContext,
    url: new URL("https://example.com/api/admin/mcp"),
    match: [] as unknown as RegExpMatchArray,
  });
}

// Production resolves users through the `email:` key (getUserByEmail in
// src/lib/auth-do.ts); the shared createUser helper writes a bare-email key.
async function user(email: string, name: string): Promise<string> {
  const { userId } = await createUser(testEnv, email, "password123", name);
  await testEnv.EMAIL_TO_USER.put(`email:${email.toLowerCase()}`, userId);
  return userId;
}

async function superuser(email: string): Promise<string> {
  const userId = await user(email, "Admin User");
  await updateUserProfile(testEnv, userId, { is_superuser: true });
  return userId;
}

afterEach(() => vi.unstubAllGlobals());

describe("admin MCP Cloudflare Access identity", () => {
  it("lets a superuser in with a verified Access assertion and no bearer token", async () => {
    const email = `access-super-${crypto.randomUUID()}@example.com`;
    await superuser(email);
    const teamDomain = uniqueTeamDomain();
    const token = await assertionFor(teamDomain, email.toUpperCase());

    const response = await listTools({ "Cf-Access-Jwt-Assertion": token }, accessEnv(teamDomain));

    expect(response?.status).toBe(200);
    const rpc = (await response?.json()) as { result?: { tools?: Array<{ name: string }> } };
    expect(rpc.result?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "admin_api_request" })]));
  });

  it("uses the Access identity even when Access forwards its own bearer token", async () => {
    const email = `access-bearer-${crypto.randomUUID()}@example.com`;
    await superuser(email);
    const teamDomain = uniqueTeamDomain();
    const token = await assertionFor(teamDomain, email);

    const response = await listTools(
      { "Cf-Access-Jwt-Assertion": token, authorization: "Bearer not-an-admin-mcp-token" },
      accessEnv(teamDomain),
    );

    expect(response?.status).toBe(200);
  });

  it("rejects a verified Access identity that is not a superuser", async () => {
    const email = `access-user-${crypto.randomUUID()}@example.com`;
    await user(email, "Regular User");
    const teamDomain = uniqueTeamDomain();
    const token = await assertionFor(teamDomain, email);

    const response = await listTools({ "Cf-Access-Jwt-Assertion": token }, accessEnv(teamDomain));

    expect(response?.status).toBe(403);
  });

  it("rejects a verified Access identity with no matching user", async () => {
    const teamDomain = uniqueTeamDomain();
    const token = await assertionFor(teamDomain, `nobody-${crypto.randomUUID()}@example.com`);

    const response = await listTools({ "Cf-Access-Jwt-Assertion": token }, accessEnv(teamDomain));

    expect(response?.status).toBe(403);
  });

  it("rejects assertions for another audience, issuer, or past expiry without falling back", async () => {
    const email = `access-bad-${crypto.randomUUID()}@example.com`;
    await superuser(email);
    const now = Math.floor(Date.now() / 1000);
    for (const overrides of [
      { aud: ["some-other-app"] },
      { iss: "https://attacker.cloudflareaccess.com" },
      { exp: now - 60 },
    ]) {
      const teamDomain = uniqueTeamDomain();
      const token = await assertionFor(teamDomain, email, overrides);
      const response = await listTools({ "Cf-Access-Jwt-Assertion": token }, accessEnv(teamDomain));
      expect(response?.status, JSON.stringify(overrides)).toBe(401);
      vi.unstubAllGlobals();
    }
  });

  it("rejects an assertion signed by a key the team domain does not publish", async () => {
    const email = `access-forged-${crypto.randomUUID()}@example.com`;
    await superuser(email);
    const teamDomain = uniqueTeamDomain();
    const now = Math.floor(Date.now() / 1000);
    const forged = await createAccessJwt({ iss: teamDomain, aud: [AUD], email, iat: now, exp: now + 600 });
    await assertionFor(teamDomain, email); // publishes a different key under the same kid

    const response = await listTools({ "Cf-Access-Jwt-Assertion": forged.token }, accessEnv(teamDomain));

    expect(response?.status).toBe(401);
  });

  it("ignores the Access header entirely when the admin MCP Access settings are unset", async () => {
    const email = `access-off-${crypto.randomUUID()}@example.com`;
    await superuser(email);
    const teamDomain = uniqueTeamDomain();
    const token = await assertionFor(teamDomain, email);

    const response = await listTools({ "Cf-Access-Jwt-Assertion": token }, accessEnv(undefined));

    expect(response?.status).toBe(401);
    expect(response?.headers.get("www-authenticate")).toContain('realm="admin-mcp"');
  });
});
