import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const removeThreadMembershipMocks = new Map<string, ReturnType<typeof vi.fn>>();

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-helpers", () => ({
  getAuthEnv: getAuthEnvMock,
}));

const { removeDeletedThreadFromOrgGroups } = await import(
  "@/lib/chat-groups.server"
);

describe("removeDeletedThreadFromOrgGroups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeThreadMembershipMocks.clear();
    getEnvMock.mockReturnValue({});
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: (id: string) => id,
        get: () => ({
          getMembers: vi.fn().mockResolvedValue([
            { user_id: "user_1" },
            { user_id: "user_2" },
            { user_id: "user_3" },
          ]),
        }),
      },
      USER: {
        idFromName: (id: string) => id,
        get: (id: string) => {
          const removeThreadMembership =
            removeThreadMembershipMocks.get(id) ?? vi.fn().mockResolvedValue(undefined);
          removeThreadMembershipMocks.set(id, removeThreadMembership);
          return { removeThreadMembership };
        },
      },
    });
  });

  it("removes deleted thread memberships from every org member", async () => {
    await removeDeletedThreadFromOrgGroups({}, "org_1", "thread_1");

    expect(removeThreadMembershipMocks.get("user_1")).toHaveBeenCalledWith("thread_1");
    expect(removeThreadMembershipMocks.get("user_2")).toHaveBeenCalledWith("thread_1");
    expect(removeThreadMembershipMocks.get("user_3")).toHaveBeenCalledWith("thread_1");
  });
});
