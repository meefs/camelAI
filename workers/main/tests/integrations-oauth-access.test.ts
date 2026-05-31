import { describe, expect, it, vi } from "vitest";
import { verifyWorkspaceManageConnectionsAccess } from "../src/routes/integrations.js";

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
    isMember: vi.fn(async () => isMember),
    isAdmin: vi.fn(async () => isAdmin),
  };

  return {
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
    expect(env.workspaceStub.getMemberAccess).toHaveBeenCalledWith("user_1");
    expect(env.orgStub.isAdmin).toHaveBeenCalledWith("user_1");
  });

  it("allows org admins with full workspace access", async () => {
    const env = makeEnv({ isAdmin: true });

    await expect(
      verifyWorkspaceManageConnectionsAccess(env as never, "ws_1", "user_1"),
    ).resolves.toEqual({ ok: true, orgId: "org_1" });
  });
});
