import { describe, expect, it } from "vitest";
import { validateProjectRuntimeProxy, validateSandboxProxy } from "../src/sandbox-auth.js";

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

  it("accepts a runtime bearer shared secret", () => {
    const result = validateSandboxProxy(
      request({
        ...identityHeaders,
        authorization: "Bearer runtime-secret",
      }),
      { PROJECT_RUNTIME_PROXY_SECRET: "runtime-secret" },
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
        "x-project-runtime-secret": "runtime-secret",
      }),
      { PROJECT_RUNTIME_PROXY_SECRET: "runtime-secret" },
    );

    expect(result).toEqual({ valid: false });
  });
});

describe("validateProjectRuntimeProxy", () => {
  it("accepts the runtime-injected project header", () => {
    const result = validateProjectRuntimeProxy(
      request({
        "x-project-runtime-project": "ca-00000000000000000000000000000000-web-app",
        "x-project-runtime-secret": "runtime-secret",
      }),
      { PROJECT_RUNTIME_PROXY_SECRET: "runtime-secret" },
    );

    expect(result).toEqual({
      valid: true,
      projectId: "ca-00000000000000000000000000000000-web-app",
    });
  });

  it("accepts runtime bearer auth for project runtime proxy identity", () => {
    const result = validateProjectRuntimeProxy(
      request({
        "x-project-runtime-project": "ca-00000000000000000000000000000000-web-app",
        authorization: "Bearer runtime-secret",
      }),
      { PROJECT_RUNTIME_PROXY_SECRET: "runtime-secret" },
    );

    expect(result).toEqual({
      valid: true,
      projectId: "ca-00000000000000000000000000000000-web-app",
    });
  });

  it("accepts project runtime mTLS for project runtime proxy identity", () => {
    const result = validateProjectRuntimeProxy(
      request({
        "x-project-runtime-project": "ca-00000000000000000000000000000000-web-app",
      }, {
        tlsClientAuth: {
          certVerified: "SUCCESS",
          certFingerprintSHA256: "aa:bb:cc",
        },
      }),
      {},
    );

    expect(result).toEqual({
      valid: true,
      projectId: "ca-00000000000000000000000000000000-web-app",
    });
  });

  it("rejects sandbox shared secret auth for project runtime proxy identity", () => {
    const result = validateProjectRuntimeProxy(
      request({
        "x-project-runtime-project": "ca-00000000000000000000000000000000-web-app",
        "x-sandbox-secret": "sandbox-secret",
      }),
      {
        PROJECT_RUNTIME_PROXY_SECRET: "runtime-secret",
        SANDBOX_PROXY_SECRET: "sandbox-secret",
      },
    );

    expect(result).toEqual({ valid: false });
  });

  it("rejects unverified mTLS for project runtime proxy identity", () => {
    const result = validateProjectRuntimeProxy(
      request({
        "x-project-runtime-project": "ca-00000000000000000000000000000000-web-app",
      }, {
        tlsClientAuth: {
          certVerified: "FAILED",
        },
      }),
      {},
    );

    expect(result).toEqual({ valid: false });
  });

  it("rejects chiridion project id headers for project runtime proxy identity", () => {
    const result = validateProjectRuntimeProxy(
      request({
        "x-chiridion-project-id": "ca-00000000000000000000000000000000-web-app",
        authorization: "Bearer runtime-secret",
      }),
      { PROJECT_RUNTIME_PROXY_SECRET: "runtime-secret" },
    );

    expect(result).toEqual({ valid: false });
  });

  it("rejects project-only runtime proxy requests without a project id", () => {
    const result = validateProjectRuntimeProxy(
      request({
        authorization: "Bearer runtime-secret",
      }),
      { PROJECT_RUNTIME_PROXY_SECRET: "runtime-secret" },
    );

    expect(result).toEqual({ valid: false });
  });
});
