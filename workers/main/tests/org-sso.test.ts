import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createOrg, createUser, type TestEnv } from "./test-helpers";
import type { OrgSsoConfig } from "../src/org-sso";
import { canCreateEnterpriseSsoUser } from "../src/identity/user-do";

const testEnv = env as unknown as TestEnv;

async function freshOrg() {
  const email = `sso-${crypto.randomUUID()}@example.com`;
  const { userId } = await createUser(testEnv, email, "password", "SSO Admin");
  const { org } = await createOrg(testEnv, "SSO Org", userId);
  return {
    userId,
    orgStub: testEnv.ORG.get(testEnv.ORG.idFromName(org.id)),
  };
}

function config(actor: string): OrgSsoConfig {
  return {
    enabled: true,
    connection_id: crypto.randomUUID(),
    protocol: "oidc",
    issuer: "https://idp.example.com",
    client_id: "client",
    client_secret_encrypted: "ciphertext",
    client_auth_method: "client_secret_post",
    email_claim: "email",
    email_domains: ["example.com"],
    jit_provisioning_enabled: false,
    config_version: 1,
    session_ttl_seconds: 28_800,
    updated_at: Date.now(),
    updated_by: actor,
  };
}

describe("OrgDO enterprise SSO state", () => {
  it("creates enterprise SSO users as verified non-superusers", async () => {
    const userId = crypto.randomUUID();
    const user = await testEnv.USER.get(
      testEnv.USER.idFromName(userId),
    ).createUserFromEnterpriseSso(
      userId,
      `enterprise-${userId}@example.com`,
      "Enterprise User",
    );
    expect(user).toMatchObject({
      id: userId,
      is_superuser: false,
    });
    expect(user.email_verified_at).toBeTypeOf("number");
  });

  it("refuses to create a superuser identity through enterprise SSO", () => {
    expect(canCreateEnterpriseSsoUser("admin-one@example.com")).toBe(false);
    expect(canCreateEnterpriseSsoUser("member@example.com")).toBe(true);
  });

  it("atomically consumes a login transaction once", async () => {
    const { orgStub } = await freshOrg();
    const transaction = {
      id: crypto.randomUUID(),
      connection_id: "connection",
      config_version: 1,
      pkce_verifier: "verifier",
      nonce: "nonce",
      browser_binding_hash: "binding-hash",
      link_user_id: null,
      redirect_path: "/chat",
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    };
    await orgStub.createSsoTransaction(transaction);
    await expect(
      orgStub.consumeSsoTransaction(transaction.id, "wrong-hash"),
    ).resolves.toBeNull();
    await expect(
      orgStub.consumeSsoTransaction(transaction.id, "binding-hash"),
    ).resolves.toMatchObject(transaction);
    await expect(
      orgStub.consumeSsoTransaction(transaction.id, "binding-hash"),
    ).resolves.toBeNull();
  });

  it("does not return an expired transaction", async () => {
    const { orgStub } = await freshOrg();
    const id = crypto.randomUUID();
    await orgStub.createSsoTransaction({
      id,
      connection_id: "connection",
      config_version: 1,
      pkce_verifier: "verifier",
      nonce: "nonce",
      browser_binding_hash: "binding-hash",
      link_user_id: null,
      redirect_path: "/",
      created_at: Date.now() - 20_000,
      expires_at: Date.now() - 10_000,
    });
    await expect(
      orgStub.consumeSsoTransaction(id, "binding-hash"),
    ).resolves.toBeNull();
  });

  it("stores connection tests for their initiating admin and consumes only successful tests", async () => {
    const { orgStub, userId } = await freshOrg();
    const candidate = { ...config(userId), enabled: false };
    const id = crypto.randomUUID();
    await orgStub.createSsoConnectionTest({
      id,
      actor_user_id: userId,
      base_config_version: 0,
      config: candidate,
      status: "pending",
      checks: {
        discovery_document_found: true,
        authorization_endpoint_found: true,
        token_endpoint_found: true,
        jwks_loaded: true,
        token_exchange_succeeded: false,
      },
      identity: null,
      error: null,
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
      completed_at: null,
    });
    await expect(
      orgStub.getSsoConnectionTest(id, "different-user"),
    ).resolves.toBeNull();
    await expect(
      orgStub.consumeSuccessfulSsoConnectionTest(id, userId),
    ).resolves.toBeNull();

    await orgStub.completeSsoConnectionTest(id, userId, {
      status: "succeeded",
      checks: {
        discovery_document_found: true,
        authorization_endpoint_found: true,
        token_endpoint_found: true,
        jwks_loaded: true,
        token_exchange_succeeded: true,
      },
      identity: {
        email: "admin@example.com",
        domain: "example.com",
        email_verified: true,
        hosted_domain: "example.com",
      },
      error: null,
      completed_at: Date.now(),
    });
    await expect(
      orgStub.consumeSuccessfulSsoConnectionTest(id, userId),
    ).resolves.toMatchObject({
      id,
      status: "succeeded",
      identity: { email: "admin@example.com" },
    });
    await expect(orgStub.getSsoConnectionTest(id, userId)).resolves.toBeNull();
  });

  it("does not return an expired connection test", async () => {
    const { orgStub, userId } = await freshOrg();
    const id = crypto.randomUUID();
    await orgStub.createSsoConnectionTest({
      id,
      actor_user_id: userId,
      base_config_version: 0,
      config: { ...config(userId), enabled: false },
      status: "pending",
      checks: {
        discovery_document_found: true,
        authorization_endpoint_found: true,
        token_endpoint_found: true,
        jwks_loaded: true,
        token_exchange_succeeded: false,
      },
      identity: null,
      error: null,
      created_at: Date.now() - 20_000,
      expires_at: Date.now() - 10_000,
      completed_at: null,
    });
    await expect(orgStub.getSsoConnectionTest(id, userId)).resolves.toBeNull();
  });

  it("version-bumps on disable so issued sessions are revocable", async () => {
    const { orgStub, userId } = await freshOrg();
    const active = config(userId);
    await orgStub.setSsoConfig(active, userId);
    const disabled = await orgStub.disableSsoConfig(userId);
    expect(disabled).toMatchObject({ enabled: false, config_version: 2 });
    await expect(orgStub.getSsoConfig()).resolves.toMatchObject({
      enabled: false,
      config_version: 2,
    });
  });

  it("keys external identities by connection, issuer, and subject", async () => {
    const { orgStub } = await freshOrg();
    await expect(
      orgStub.bindSsoIdentity(
        "connection-a",
        "https://one.example",
        "same-sub",
        "user-a",
        "a@example.com",
      ),
    ).resolves.toBe("user-a");
    await expect(
      orgStub.bindSsoIdentity(
        "connection-b",
        "https://two.example",
        "same-sub",
        "user-b",
        "b@example.com",
      ),
    ).resolves.toBe("user-b");
    await expect(
      orgStub.getSsoIdentityUserId(
        "connection-a",
        "https://one.example",
        "same-sub",
      ),
    ).resolves.toBe("user-a");
    await expect(
      orgStub.getSsoIdentityUserId(
        "connection-b",
        "https://two.example",
        "same-sub",
      ),
    ).resolves.toBe("user-b");
  });
});
