import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn((env) => env);
const getSessionMock = vi.fn();
const createInvitationsMock = vi.fn();
const isOrgAdminMock = vi.fn();
const getBillableTeamSeatCountForOrgMock = vi.fn();
const syncTeamSubscriptionSeatCountMock = vi.fn();
const bestEffortSyncTeamSubscriptionSeatCountMock = vi.fn();
const sendOrgInvitationEmailMock = vi.fn();

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-helpers", () => ({
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/auth.server", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/auth-do", () => ({
  createInvitations: createInvitationsMock,
  getInvitation: vi.fn(),
  isOrgAdmin: isOrgAdminMock,
}));

vi.mock("@/lib/billing.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing.server")>();
  return {
    ...actual,
    getBillableTeamSeatCountForOrg: getBillableTeamSeatCountForOrgMock,
    syncTeamSubscriptionSeatCount: syncTeamSubscriptionSeatCountMock,
    bestEffortSyncTeamSubscriptionSeatCount:
      bestEffortSyncTeamSubscriptionSeatCountMock,
  };
});

vi.mock("@/lib/email.server", () => ({
  buildInvitationUrl: (_baseUrl: string, orgId: string, invitationId: string) =>
    `https://camelai.test/invitations/${orgId}/${invitationId}`,
  resolveAppBaseUrl: () => "https://camelai.test",
  sendOrgInvitationEmail: sendOrgInvitationEmailMock,
}));

const { action } = await import("@/routes/api/orgs.$id.invite");

function makeRequest() {
  return new Request("https://camelai.test/api/orgs/org_team/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "new@example.com", role: "member" }),
  });
}

describe("legacy organization invitation API billing guard", () => {
  const orgStub = {
    getInvitationByEmail: vi.fn(async () => null),
    getInfo: vi.fn(async () => ({ id: "org_team", name: "Team Org" })),
  };
  const env = {
    ORG: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => orgStub),
    },
    USER: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => ({
        getProfile: vi.fn(async () => ({
          id: "owner_123",
          email: "owner@example.com",
          name: "Owner",
        })),
      })),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue(env);
    getSessionMock.mockResolvedValue({ session: { user_id: "owner_123" } });
    isOrgAdminMock.mockResolvedValue(true);
    getBillableTeamSeatCountForOrgMock.mockResolvedValue(4);
    bestEffortSyncTeamSubscriptionSeatCountMock.mockResolvedValue(null);
    sendOrgInvitationEmailMock.mockResolvedValue({ status: "sent" });
  });

  it("does not create an invitation when the immediate seat charge fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    syncTeamSubscriptionSeatCountMock.mockRejectedValue(
      new Error("Stripe payment failed"),
    );

    const response = await action({
      request: makeRequest(),
      context: {},
      params: { id: "org_team" },
    } as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Stripe payment failed",
    });
    expect(syncTeamSubscriptionSeatCountMock).toHaveBeenCalledWith(
      env,
      "org_team",
      expect.objectContaining({
        targetSeatCount: 4,
        prorationBehavior: "always_invoice",
        itemUpdateIdempotencyKey: expect.stringMatching(
          /^team-seat-sync:org_team:4:invite:/,
        ),
      }),
    );
    expect(createInvitationsMock).not.toHaveBeenCalled();
    expect(sendOrgInvitationEmailMock).not.toHaveBeenCalled();
    expect(bestEffortSyncTeamSubscriptionSeatCountMock).toHaveBeenCalledWith(
      env,
      "org_team",
      { reason: "api_invite_create_failed" },
    );
    consoleError.mockRestore();
  });

  it("creates the invitation only after Stripe confirms the paid seat", async () => {
    syncTeamSubscriptionSeatCountMock.mockResolvedValue(undefined);
    createInvitationsMock.mockResolvedValue([
      {
        id: "inv_new",
        email: "new@example.com",
        role: "member",
        expires_at: 1_800_000_000_000,
      },
    ]);

    const response = await action({
      request: makeRequest(),
      context: {},
      params: { id: "org_team" },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "inv_new",
      email: "new@example.com",
      email_delivery: "sent",
    });
    expect(
      syncTeamSubscriptionSeatCountMock.mock.invocationCallOrder[0],
    ).toBeLessThan(createInvitationsMock.mock.invocationCallOrder[0]);
    expect(createInvitationsMock).toHaveBeenCalledWith(
      env,
      "org_team",
      ["new@example.com"],
      "member",
      "owner_123",
      { pendingBillingSeatAllowance: 0 },
    );
  });
});
