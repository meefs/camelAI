import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const getOrgSettingsSummaryMock = vi.fn();
const getOrgMembersMock = vi.fn();
const listOrgWorkspacesMock = vi.fn();
const getOrgMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-do", () => ({
  getOrgSettingsSummary: getOrgSettingsSummaryMock,
  getOrgMembers: getOrgMembersMock,
  listOrgWorkspaces: listOrgWorkspacesMock,
  getOrg: getOrgMock,
  createOrg: vi.fn(),
  removeOrgMember: vi.fn(),
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => null,
}));

vi.mock("@/components/settings/settings-header", () => ({
  SettingsHeader: () => null,
}));

vi.mock("@/components/settings/org-memberships-list", () => ({
  OrgMembershipsList: () => null,
}));

const { loader } = await import("@/routes/_app.settings.organizations");

describe("organizations settings loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({ env: true });
    getAuthEnvMock.mockReturnValue({ auth: true });
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_1" },
      currentOrg: { id: "org_1" },
      orgs: [
        {
          org_id: "org_1",
          org_name: "Primary",
          role: "owner",
          joined_at: 10,
        },
        {
          org_id: "org_2",
          org_name: "Side Project",
          role: "member",
          joined_at: 20,
        },
      ],
    });
    getOrgSettingsSummaryMock.mockImplementation(
      async (_authEnv: unknown, orgId: string) => {
        if (orgId === "org_1") {
          return {
            billing_plan: "pro",
            billing_status: "active",
            member_count: 3,
            workspace_count: 2,
          };
        }
        return {
          billing_plan: "starter",
          billing_status: "trialing",
          member_count: 1,
          workspace_count: 1,
        };
      },
    );
  });

  it("loads one settings summary per org instead of separate member/workspace/info calls", async () => {
    const result = await loader({
      request: new Request("https://camelai.test/settings/organizations"),
      context: {},
      params: {},
    } as never);

    expect(getOrgSettingsSummaryMock).toHaveBeenCalledTimes(2);
    expect(getOrgSettingsSummaryMock).toHaveBeenNthCalledWith(
      1,
      { auth: true },
      "org_1",
    );
    expect(getOrgSettingsSummaryMock).toHaveBeenNthCalledWith(
      2,
      { auth: true },
      "org_2",
    );
    expect(getOrgMembersMock).not.toHaveBeenCalled();
    expect(listOrgWorkspacesMock).not.toHaveBeenCalled();
    expect(getOrgMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      currentOrgId: "org_1",
      currentUserId: "user_1",
      orgs: [
        {
          org_id: "org_1",
          billing_plan: "pro",
          member_count: 3,
          workspace_count: 2,
        },
        {
          org_id: "org_2",
          billing_plan: "starter",
          member_count: 1,
          workspace_count: 1,
        },
      ],
    });
  });
});
