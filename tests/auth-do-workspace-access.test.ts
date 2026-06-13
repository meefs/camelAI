import { beforeEach, describe, expect, it, vi } from "vitest";

const { getWorkspaceAccess, getWorkspaceAccessContext } = await import("@/lib/auth-do");

describe("getWorkspaceAccess", () => {
  let workspaceStub: {
    getInfoAndMemberAccess: ReturnType<typeof vi.fn>;
    getInfo: ReturnType<typeof vi.fn>;
    getMemberAccess: ReturnType<typeof vi.fn>;
  };
  let orgStub: {
    getInfo: ReturnType<typeof vi.fn>;
    isMember: ReturnType<typeof vi.fn>;
  };
  let env: {
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
      getInfo: vi.fn().mockResolvedValue({
        id: "org_123",
        archived: false,
      }),
      isMember: vi.fn().mockResolvedValue(true),
    };
    env = {
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

  it("uses the workspace info/access bootstrap RPC", async () => {
    await expect(
      getWorkspaceAccess(env as never, "ws_123", "user_123"),
    ).resolves.toBe("full");
    await expect(
      getWorkspaceAccessContext(env as never, "ws_123", "user_123"),
    ).resolves.toMatchObject({
      workspace: { id: "ws_123", org_id: "org_123" },
      access: "full",
    });

    expect(workspaceStub.getInfoAndMemberAccess).toHaveBeenCalledWith(
      "user_123",
    );
    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(workspaceStub.getMemberAccess).not.toHaveBeenCalled();
    expect(orgStub.isMember).toHaveBeenCalledWith("user_123");
  });

  it("falls back when the bootstrap RPC is unavailable", async () => {
    workspaceStub.getInfoAndMemberAccess.mockRejectedValueOnce(
      new TypeError('Durable Object does not implement "getInfoAndMemberAccess"'),
    );
    workspaceStub.getInfo.mockResolvedValueOnce({
      id: "ws_123",
      org_id: "org_123",
      archived: false,
    });
    workspaceStub.getMemberAccess.mockResolvedValueOnce({
      access_level: "none",
    });

    await expect(
      getWorkspaceAccess(env as never, "ws_123", "user_123"),
    ).resolves.toBe("none");

    expect(workspaceStub.getInfo).toHaveBeenCalled();
    expect(workspaceStub.getMemberAccess).toHaveBeenCalledWith("user_123");
  });
});
