import { beforeEach, describe, expect, it, vi } from "vitest";

const { getWorkspaceAccess, getWorkspaceAccessContext } = await import("@/lib/auth-do");

describe("getWorkspaceAccess", () => {
  let workspaceStub: {
    getInfoAndMemberAccess: ReturnType<typeof vi.fn>;
    getInfo: ReturnType<typeof vi.fn>;
    getMemberAccess: ReturnType<typeof vi.fn>;
  };
  let orgStub: {
    getWorkspaceRecord: ReturnType<typeof vi.fn>;
    getWorkspaceAccessContext: ReturnType<typeof vi.fn>;
  };
  let env: {
    APP_KV: {
      get(key: string): Promise<string | null>;
      put(key: string, value: string): Promise<void>;
    };
    WORKSPACE: {
      idFromName(id: string): string;
      get(id: string): typeof workspaceStub;
    };
    ORG: {
      idFromName(id: string): string;
      get(id: string): typeof orgStub;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceStub = {
      getInfoAndMemberAccess: vi.fn().mockResolvedValue({
        info: {
          id: "ws_123",
          org_id: "org_123",
          archived: false,
        },
        memberAccess: {
          access_level: "full",
        },
      }),
      getInfo: vi.fn(async () => {
        throw new Error("unexpected workspace info read");
      }),
      getMemberAccess: vi.fn(async () => {
        throw new Error("unexpected member access read");
      }),
    };
    orgStub = {
      getWorkspaceRecord: vi.fn().mockResolvedValue({
        id: "ws_123",
        org_id: "org_123",
        archived: false,
      }),
      getWorkspaceAccessContext: vi.fn().mockResolvedValue({
        workspace: {
          id: "ws_123",
          org_id: "org_123",
          archived: false,
        },
        access: "full",
      }),
    };
    env = {
      APP_KV: {
        get: vi.fn(async (key: string) =>
          key === "workspace_org:ws_123" ? "org_123" : null,
        ),
        put: vi.fn(async () => undefined),
      },
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    };
  });

  it("uses the OrgDO workspace access context RPC", async () => {
    await expect(
      getWorkspaceAccess(env as never, "ws_123", "user_123"),
    ).resolves.toBe("full");
    await expect(
      getWorkspaceAccessContext(env as never, "ws_123", "user_123"),
    ).resolves.toMatchObject({
      workspace: { id: "ws_123", org_id: "org_123" },
      access: "full",
    });

    expect(orgStub.getWorkspaceAccessContext).toHaveBeenCalledWith(
      "ws_123",
      "user_123",
    );
    expect(workspaceStub.getInfoAndMemberAccess).not.toHaveBeenCalled();
    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(workspaceStub.getMemberAccess).not.toHaveBeenCalled();
  });

  it("falls back to WorkspaceDO metadata when workspace-org indexes are missing", async () => {
    env.APP_KV.get = vi.fn(async () => null);
    workspaceStub.getInfo.mockResolvedValueOnce({
      id: "ws_123",
      org_id: "org_123",
      archived: false,
    });

    await expect(
      getWorkspaceAccess(env as never, "ws_123", "user_123"),
    ).resolves.toBe("full");

    expect(workspaceStub.getInfo).toHaveBeenCalled();
    expect(env.APP_KV.put).toHaveBeenCalledWith(
      "workspace_org:ws_123",
      "org_123",
    );
    expect(orgStub.getWorkspaceAccessContext).toHaveBeenCalledWith(
      "ws_123",
      "user_123",
    );
  });

  it("fails when the OrgDO workspace access context RPC is missing", async () => {
    const error = new Error("No such RPC method getWorkspaceAccessContext");
    orgStub.getWorkspaceAccessContext.mockRejectedValueOnce(error);

    await expect(
      getWorkspaceAccess(env as never, "ws_123", "user_123"),
    ).rejects.toBe(error);

    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(workspaceStub.getMemberAccess).not.toHaveBeenCalled();
  });

  it("retries transient OrgDO workspace access context RPC failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    orgStub.getWorkspaceAccessContext
      .mockRejectedValueOnce(
        new Error("Durable Object reset because its code was updated."),
      )
      .mockResolvedValueOnce({
        workspace: {
          id: "ws_123",
          org_id: "org_123",
          archived: false,
        },
        access: "none",
      });

    await expect(
      getWorkspaceAccess(env as never, "ws_123", "user_123"),
    ).resolves.toBe("none");

    expect(orgStub.getWorkspaceAccessContext).toHaveBeenCalledTimes(2);
    expect(workspaceStub.getInfoAndMemberAccess).not.toHaveBeenCalled();
    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(workspaceStub.getMemberAccess).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
