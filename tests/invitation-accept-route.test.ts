import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn((env) => env);
const getSessionMock = vi.fn();
const createSessionCookieHeaderMock = vi.fn(() => "session=updated");
const acceptInvitationMock = vi.fn();
const getInvitationMock = vi.fn();
const listOrgWorkspacesMock = vi.fn();
const switchSessionOrgMock = vi.fn();
const bestEffortEnsureTeamSubscriptionSeatCapacityMock = vi.fn();
const bestEffortSyncTeamSubscriptionSeatCountMock = vi.fn();
const requireAccessMappedOrgMock = vi.fn();

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-helpers", () => ({
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/auth.server", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/cookies.server", () => ({
  createSessionCookieHeader: createSessionCookieHeaderMock,
}));

vi.mock("@/lib/auth-do", () => ({
  acceptInvitation: acceptInvitationMock,
  getInvitation: getInvitationMock,
  listOrgWorkspaces: listOrgWorkspacesMock,
  switchSessionOrg: switchSessionOrgMock,
}));

vi.mock("@/lib/billing.server", () => ({
  bestEffortEnsureTeamSubscriptionSeatCapacity:
    bestEffortEnsureTeamSubscriptionSeatCapacityMock,
  bestEffortSyncTeamSubscriptionSeatCount:
    bestEffortSyncTeamSubscriptionSeatCountMock,
}));

vi.mock("@/lib/cloudflare-access-auth.server", () => ({
  requireAccessMappedOrg: requireAccessMappedOrgMock,
}));

const { action } = await import(
  "@/routes/api/invitations.$orgId.$invitationId"
);

describe("invitation acceptance Team capacity", () => {
  const session = {
    user_id: "user_invited",
    org_id: "org_previous",
    workspace_id: "workspace_previous",
    created_at: Date.now(),
    user_name: "Invited User",
    user_email: "invited@example.com",
    auth_source: "password",
  };
  const env = {
    USER: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => ({
        getProfile: vi.fn(async () => ({
          id: "user_invited",
          email: "invited@example.com",
        })),
      })),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue(env);
    getSessionMock.mockResolvedValue({ session });
    getInvitationMock.mockResolvedValue({
      id: "inv_recovered",
      email: "invited@example.com",
      role: "member",
      org: { id: "org_team", name: "Team Org" },
    });
    requireAccessMappedOrgMock.mockResolvedValue(null);
    bestEffortEnsureTeamSubscriptionSeatCapacityMock.mockResolvedValue({
      status: "capacity_confirmed",
      requestedSeatCount: 4,
      targetSeatCount: 5,
      previousStripeSeatCount: 5,
      stripeQuantityChanged: false,
    });
    acceptInvitationMock.mockResolvedValue(true);
    listOrgWorkspacesMock.mockResolvedValue([{ id: "workspace_team" }]);
    switchSessionOrgMock.mockResolvedValue("signed-session-token");
  });

  it("preserves remaining paid capacity before and after accepting a recovered invite", async () => {
    const response = await action({
      request: new Request(
        "https://camelai.test/api/invitations/org_team/inv_recovered",
        { method: "POST" },
      ),
      context: {},
      params: { orgId: "org_team", invitationId: "inv_recovered" },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      org: { id: "org_team" },
      workspace: { id: "workspace_team" },
    });
    expect(
      bestEffortEnsureTeamSubscriptionSeatCapacityMock,
    ).toHaveBeenNthCalledWith(1, env, "org_team", {
      reason: "invitation_accept_before_membership",
    });
    expect(
      bestEffortEnsureTeamSubscriptionSeatCapacityMock,
    ).toHaveBeenNthCalledWith(2, env, "org_team", {
      reason: "invitation_accepted",
    });
    expect(
      bestEffortEnsureTeamSubscriptionSeatCapacityMock.mock
        .invocationCallOrder[0],
    ).toBeLessThan(acceptInvitationMock.mock.invocationCallOrder[0]);
    expect(acceptInvitationMock.mock.invocationCallOrder[0]).toBeLessThan(
      bestEffortEnsureTeamSubscriptionSeatCapacityMock.mock
        .invocationCallOrder[1],
    );
    expect(bestEffortSyncTeamSubscriptionSeatCountMock).not.toHaveBeenCalled();
  });
});
