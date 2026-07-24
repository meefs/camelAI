import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  createDispatcherSession,
  createWorkerAuthToken,
  getDispatcherSession,
  isWorkerAuthCallbackOriginValid,
  touchDispatcherSession,
  validateAndConsumeAuthToken,
  validateWorkerSessionForOrg,
} from "../src/worker-auth";
import { createOrg, createUser, type TestEnv } from "./test-helpers";
import type { OrgSsoConfig } from "../src/org-sso";

const testEnv = env as unknown as TestEnv;

function constraints(expiresAt: number | null = Date.now() + 60 * 60 * 1000) {
  return {
    auth_source: "enterprise_oidc" as const,
    user_email: "person@example.com",
    expires_at: expiresAt,
    sso_connection_id: "connection-1",
    sso_config_version: 3,
  };
}

describe("private-app constrained sessions", () => {
  it("binds one-time tokens to the exact dispatcher callback origin", () => {
    expect(isWorkerAuthCallbackOriginValid(
      "https://private-app.camelai.app",
      "https://private-app.camelai.app/__chiridion_auth/callback",
    )).toBe(true);
    expect(isWorkerAuthCallbackOriginValid(
      "https://private-app.camelai.app",
      "https://private-app.apps.camelai.dev/__chiridion_auth/callback",
    )).toBe(false);
  });

  it("propagates enterprise constraints through a one-time token", async () => {
    const token = await createWorkerAuthToken(testEnv.APP_KV, {
      user_id: "user-1",
      org_id: "org-1",
      state: "state-1",
      script_name: "private-app",
      callback_origin: "https://private-app.camelai.app",
      ...constraints(),
    });
    await expect(validateAndConsumeAuthToken(testEnv.APP_KV, token)).resolves.toMatchObject({
      security_version: 1,
      user_id: "user-1",
      org_id: "org-1",
      callback_origin: "https://private-app.camelai.app",
      auth_source: "enterprise_oidc",
      sso_connection_id: "connection-1",
      sso_config_version: 3,
    });
    await expect(validateAndConsumeAuthToken(testEnv.APP_KV, token)).resolves.toBeNull();
  });

  it("rejects legacy unversioned and expired dispatcher sessions", async () => {
    const legacyId = crypto.randomUUID();
    await testEnv.SESSIONS.put(`worker_session:${legacyId}`, JSON.stringify({
      user_id: "user-1",
      org_id: "org-1",
      created_at: Date.now(),
      last_accessed: Date.now(),
    }));
    await expect(getDispatcherSession(testEnv.SESSIONS, legacyId)).resolves.toBeNull();
    await expect(testEnv.SESSIONS.get(`worker_session:${legacyId}`)).resolves.toBeNull();

    await expect(createDispatcherSession(testEnv.SESSIONS, {
      user_id: "user-1",
      org_id: "org-1",
      ...constraints(Date.now() - 1),
    })).rejects.toThrow("expired");
  });

  it("retains constraints and never extends a dispatcher session past absolute expiry", async () => {
    const expiresAt = Date.now() + 2 * 60 * 1000;
    const { sessionId } = await createDispatcherSession(testEnv.SESSIONS, {
      user_id: "user-1",
      org_id: "org-1",
      ...constraints(expiresAt),
    });
    await expect(getDispatcherSession(testEnv.SESSIONS, sessionId)).resolves.toMatchObject({
      security_version: 1,
      expires_at: expiresAt,
      auth_source: "enterprise_oidc",
    });
    await expect(touchDispatcherSession(testEnv.SESSIONS, sessionId)).resolves.toMatchObject({
      expires_at: expiresAt,
    });
  });

  it("rejects an enterprise session for any other organization before an OrgDO lookup", async () => {
    await expect(validateWorkerSessionForOrg(
      {} as never,
      {
        user_id: "user-1",
        org_id: "org-1",
        ...constraints(),
      },
      "org-2",
    )).resolves.toBe(false);
  });

  it("revalidates enterprise configuration and revokes a dispatcher session immediately", async () => {
    const email = `dispatcher-sso-${crypto.randomUUID()}@example.com`;
    const { userId } = await createUser(testEnv, email, "password", "Dispatcher SSO");
    const { org } = await createOrg(testEnv, "Dispatcher SSO Org", userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.setInfo({ ...org, billing_status: "enterprise" });
    const config: OrgSsoConfig = {
      enabled: true,
      connection_id: "connection-1",
      protocol: "oidc",
      issuer: "https://idp.example.com",
      client_id: "client",
      client_secret_encrypted: "ciphertext",
      client_auth_method: "client_secret_post",
      email_claim: "email",
      email_domains: ["example.com"],
      config_version: 3,
      session_ttl_seconds: 28_800,
      updated_at: Date.now(),
      updated_by: userId,
    };
    await orgStub.setSsoConfig(config, userId);
    const session = {
      user_id: userId,
      org_id: org.id,
      ...constraints(),
      user_email: email,
    };
    await expect(validateWorkerSessionForOrg(testEnv, session, org.id)).resolves.toBe(true);
    await orgStub.disableSsoConfig(userId);
    await expect(validateWorkerSessionForOrg(testEnv, session, org.id)).resolves.toBe(false);
  });

  it("preserves normal multi-org private-app behavior while rechecking membership", async () => {
    const isMember = vi.fn(async () => true);
    const orgNamespace = {
      idFromName: (id: string) => id,
      get: () => ({ isMember }),
    };
    await expect(validateWorkerSessionForOrg(
      { ORG: orgNamespace } as never,
      {
        user_id: "user-1",
        org_id: "org-1",
        auth_source: null,
        user_email: null,
        expires_at: null,
        sso_connection_id: null,
        sso_config_version: null,
      },
      "org-2",
    )).resolves.toBe(true);
    expect(isMember).toHaveBeenCalledWith("user-1");
  });
});
