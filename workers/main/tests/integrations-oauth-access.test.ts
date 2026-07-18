import { describe, expect, it, vi } from "vitest";
import {
  integrationOAuthCallbackUrl,
  verifyWorkspaceManageConnectionsAccess,
} from "../src/routes/integrations.js";

function makeEnv({
  isAdmin,
  accessLevel = "full",
  isMember = true,
  archived = false,
}: {
  isAdmin: boolean;
  accessLevel?: "full" | "none";
  isMember?: boolean;
  archived?: boolean;
}) {
  const workspaceStub = {
    getInfo: vi.fn(async () =>
      archived ? { id: "ws_1", org_id: "org_1", archived: true } : { id: "ws_1", org_id: "org_1", archived: false },
    ),
    getMemberAccess: vi.fn(async () => ({ access_level: accessLevel })),
  };
  const orgStub = {
    getWorkspaceRecord: vi.fn(async () =>
      archived ? { id: "ws_1", org_id: "org_1", archived: true } : { id: "ws_1", org_id: "org_1", archived: false },
    ),
    getWorkspaceAccess: vi.fn(async () => accessLevel),
    isMember: vi.fn(async () => isMember),
    isAdmin: vi.fn(async () => isAdmin),
  };

  return {
    APP_KV: {
      get: vi.fn(async (key: string) =>
        key === "workspace_org:ws_1" ? "org_1" : null,
      ),
      put: vi.fn(async () => undefined),
    },
    WORKSPACE: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => workspaceStub),
    },
    ORG: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => orgStub),
    },
    workspaceStub,
    orgStub,
  };
}

describe("verifyWorkspaceManageConnectionsAccess", () => {
  it("rejects archived workspaces", async () => {
    const env = makeEnv({ archived: true, isAdmin: true });

    await expect(
      verifyWorkspaceManageConnectionsAccess(env as never, "ws_1", "user_1"),
    ).resolves.toEqual({ ok: false, error: "workspace_not_found" });

    expect(env.orgStub.isMember).not.toHaveBeenCalled();
    expect(env.workspaceStub.getMemberAccess).not.toHaveBeenCalled();
    expect(env.orgStub.isAdmin).not.toHaveBeenCalled();
  });

  it("rejects users who are no longer org members", async () => {
    const env = makeEnv({ isAdmin: true, isMember: false });

    await expect(
      verifyWorkspaceManageConnectionsAccess(env as never, "ws_1", "user_1"),
    ).resolves.toEqual({ ok: false, error: "access_denied" });

    expect(env.workspaceStub.getMemberAccess).not.toHaveBeenCalled();
    expect(env.orgStub.isAdmin).not.toHaveBeenCalled();
  });

  it('rejects users with workspace access_level "none"', async () => {
    const env = makeEnv({ isAdmin: true, accessLevel: "none" });

    await expect(
      verifyWorkspaceManageConnectionsAccess(env as never, "ws_1", "user_1"),
    ).resolves.toEqual({ ok: false, error: "access_denied" });

    expect(env.orgStub.isAdmin).not.toHaveBeenCalled();
  });

  it("rejects full-access workspace members who are not org admins", async () => {
    const env = makeEnv({ isAdmin: false });

    await expect(
      verifyWorkspaceManageConnectionsAccess(env as never, "ws_1", "user_1"),
    ).resolves.toEqual({ ok: false, error: "admin_required" });

    expect(env.orgStub.isMember).toHaveBeenCalledWith("user_1");
    expect(env.orgStub.getWorkspaceAccess).toHaveBeenCalledWith("ws_1", "user_1");
    expect(env.workspaceStub.getMemberAccess).not.toHaveBeenCalled();
    expect(env.orgStub.isAdmin).toHaveBeenCalledWith("user_1");
  });

  it("allows org admins with full workspace access", async () => {
    const env = makeEnv({ isAdmin: true });

    await expect(
      verifyWorkspaceManageConnectionsAccess(env as never, "ws_1", "user_1"),
    ).resolves.toEqual({ ok: true, orgId: "org_1" });
  });
});

describe("integrationOAuthCallbackUrl", () => {
  it("derives the public callback origin from the incoming request URL", () => {
    expect(
      integrationOAuthCallbackUrl(
        new URL("https://staging.camelai.dev/api/integrations/google_analytics/oauth?redirect=/connections"),
        "google_analytics",
      ),
    ).toBe("https://staging.camelai.dev/api/integrations/google_analytics/callback");
  });

  it("preserves local ports and safely encodes the integration type", () => {
    expect(
      integrationOAuthCallbackUrl(new URL("http://localhost:3001/connections"), "custom provider"),
    ).toBe("http://localhost:3001/api/integrations/custom%20provider/callback");
  });
});
