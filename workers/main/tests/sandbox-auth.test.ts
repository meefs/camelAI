import { describe, expect, it } from "vitest";
import { validateSandboxProxy } from "../src/sandbox-auth.js";

function request(headers: Record<string, string>, cf?: unknown): Request {
  const req = new Request("https://worker.test/internal", { headers });
  if (cf) {
    Object.defineProperty(req, "cf", {
      value: cf,
      configurable: true,
    });
  }
  return req;
}

const identityHeaders = {
  "x-chiridion-org-id": "org-1",
  "x-chiridion-workspace-id": "workspace-1",
  "x-chiridion-user-id": "user-1",
  "x-chiridion-thread-id": "thread-1",
  "x-chiridion-project-id": "project-1",
};

describe("validateSandboxProxy", () => {
  it("accepts the legacy sandbox shared secret header", () => {
    const result = validateSandboxProxy(
      request({
        ...identityHeaders,
        "x-sandbox-secret": "sandbox-secret",
      }),
      { SANDBOX_PROXY_SECRET: "sandbox-secret" },
    );

    expect(result).toMatchObject({
      valid: true,
      orgId: "org-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
    });
  });

  it("accepts a sandbox bearer shared secret", () => {
    const result = validateSandboxProxy(
      request({
        ...identityHeaders,
        authorization: "Bearer sandbox-secret",
      }),
      { SANDBOX_PROXY_SECRET: "sandbox-secret" },
    );

    expect(result).toMatchObject({
      valid: true,
      orgId: "org-1",
      workspaceId: "workspace-1",
    });
  });

  it("accepts a Cloudflare-verified mTLS client certificate", () => {
    const result = validateSandboxProxy(
      request(identityHeaders, {
        tlsClientAuth: {
          certVerified: "SUCCESS",
        },
      }),
      {},
    );

    expect(result).toMatchObject({
      valid: true,
      orgId: "org-1",
      workspaceId: "workspace-1",
    });
  });

  it("does not require Worker-side mTLS certificate fingerprints", () => {
    const result = validateSandboxProxy(
      request(identityHeaders, {
        tlsClientAuth: {
          certVerified: "SUCCESS",
          certFingerprintSHA256: "aa:bb:cc",
        },
      }),
      {},
    );

    expect(result).toMatchObject({
      valid: true,
      orgId: "org-1",
      workspaceId: "workspace-1",
    });
  });

  it("rejects revoked mTLS client certificates", () => {
    const result = validateSandboxProxy(
      request(identityHeaders, {
        tlsClientAuth: {
          certVerified: "SUCCESS",
          certRevoked: "1",
        },
      }),
      {},
    );

    expect(result).toEqual({ valid: false });
  });

  it("rejects authenticated requests without required identity headers", () => {
    const result = validateSandboxProxy(
      request({
        "x-sandbox-secret": "sandbox-secret",
      }),
      { SANDBOX_PROXY_SECRET: "sandbox-secret" },
    );

    expect(result).toEqual({ valid: false });
  });
});
