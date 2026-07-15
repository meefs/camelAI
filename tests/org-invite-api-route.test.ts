import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn((env) => env);
const getSessionMock = vi.fn();
const createInvitationsMock = vi.fn();
const isOrgAdminMock = vi.fn();
const getBillableTeamSeatCountForOrgMock = vi.fn();
const ensureTeamSubscriptionSeatCapacityMock = vi.fn();
const bestEffortEnsureTeamSubscriptionSeatCapacityMock = vi.fn();
const bestEffortReleaseTeamSeatCapacityReservationMock = vi.fn();
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
    ensureTeamSubscriptionSeatCapacity:
      ensureTeamSubscriptionSeatCapacityMock,
    bestEffortEnsureTeamSubscriptionSeatCapacity:
      bestEffortEnsureTeamSubscriptionSeatCapacityMock,
    bestEffortReleaseTeamSeatCapacityReservation:
      bestEffortReleaseTeamSeatCapacityReservationMock,
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

function confirmedSeatSync(overrides: Record<string, unknown> = {}) {
  return {
    status: "capacity_confirmed",
    org: { id: "org_team", name: "Team Org", billing_seat_count: 4 },
    targetSeatCount: 4,
    previousStripeSeatCount: 3,
    stripeQuantityChanged: true,
    paidIncreaseConfirmed: true,
    metadataSynced: true,
    orgSeatStateSynced: true,
    pendingBillingSeatAllowance: 0,
    seatReservation: {
      operationId: "reserve_invite",
      subscriptionId: "sub_team",
    },
    ...overrides,
  };
}

describe("legacy organization invitation API billing guard", () => {
  const orgStub = {
    getInvitationByEmail: vi.fn(async () => null),
    getInfo: vi.fn(async () => ({
      id: "org_team",
      name: "Team Org",
      billing_status: "active",
      billing_plan: "team",
      billing_subscription_id: "sub_team",
      billing_subscription_status: "active",
    })),
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
    ensureTeamSubscriptionSeatCapacityMock.mockResolvedValue(
      confirmedSeatSync(),
    );
    bestEffortEnsureTeamSubscriptionSeatCapacityMock.mockResolvedValue(null);
    bestEffortReleaseTeamSeatCapacityReservationMock.mockResolvedValue(null);
    bestEffortSyncTeamSubscriptionSeatCountMock.mockResolvedValue(null);
    sendOrgInvitationEmailMock.mockResolvedValue({ status: "sent" });
  });

  it("does not create an invitation when the immediate seat charge fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    ensureTeamSubscriptionSeatCapacityMock.mockRejectedValue(
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
    expect(ensureTeamSubscriptionSeatCapacityMock).toHaveBeenCalledWith(
      env,
      "org_team",
      expect.objectContaining({
        pendingReservedSeatDelta: 1,
        targetSeatCount: 4,
        prorationBehavior: "always_invoice",
        itemUpdateIdempotencyKey: expect.stringMatching(
          /^team-seat-sync:org_team:4:invite:/,
        ),
      }),
    );
    expect(createInvitationsMock).not.toHaveBeenCalled();
    expect(sendOrgInvitationEmailMock).not.toHaveBeenCalled();
    expect(bestEffortSyncTeamSubscriptionSeatCountMock).not.toHaveBeenCalled();
    expect(
      bestEffortEnsureTeamSubscriptionSeatCapacityMock,
    ).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("creates the invitation only after Stripe confirms the paid seat", async () => {
    ensureTeamSubscriptionSeatCapacityMock.mockResolvedValue(
      confirmedSeatSync(),
    );
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
      ensureTeamSubscriptionSeatCapacityMock.mock.invocationCallOrder[0],
    ).toBeLessThan(createInvitationsMock.mock.invocationCallOrder[0]);
    expect(
      createInvitationsMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      bestEffortReleaseTeamSeatCapacityReservationMock.mock
        .invocationCallOrder[0],
    );
    expect(bestEffortReleaseTeamSeatCapacityReservationMock).toHaveBeenCalledWith(
      env,
      "org_team",
      {
        operationId: "reserve_invite",
        subscriptionId: "sub_team",
      },
    );
    expect(createInvitationsMock).toHaveBeenCalledWith(
      env,
      "org_team",
      ["new@example.com"],
      "member",
      "owner_123",
      { pendingBillingSeatAllowance: 0 },
    );
    expect(
      bestEffortEnsureTeamSubscriptionSeatCapacityMock,
    ).toHaveBeenCalledWith(env, "org_team", {
      reason: "api_invitation_created",
      targetSeatCount: 4,
    });
  });

  it("keeps confirmed paid capacity when invitation persistence fails", async () => {
    ensureTeamSubscriptionSeatCapacityMock.mockResolvedValue(
      confirmedSeatSync({
        org: { id: "org_team", name: "Team Org", billing_seat_count: 3 },
        orgSeatStateSynced: false,
        pendingBillingSeatAllowance: 1,
      }),
    );
    createInvitationsMock.mockRejectedValue(
      new Error("temporary invitation failure"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await action({
      request: makeRequest(),
      context: {},
      params: { id: "org_team" },
    } as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "temporary invitation failure",
    });
    expect(createInvitationsMock).toHaveBeenCalledWith(
      env,
      "org_team",
      ["new@example.com"],
      "member",
      "owner_123",
      { pendingBillingSeatAllowance: 1 },
    );
    expect(bestEffortReleaseTeamSeatCapacityReservationMock).toHaveBeenCalledWith(
      env,
      "org_team",
      expect.objectContaining({ operationId: "reserve_invite" }),
    );
    expect(bestEffortSyncTeamSubscriptionSeatCountMock).not.toHaveBeenCalled();
    expect(
      bestEffortEnsureTeamSubscriptionSeatCapacityMock,
    ).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("uses an already-paid fifth seat for a one-address partial retry", async () => {
    ensureTeamSubscriptionSeatCapacityMock.mockResolvedValue(
      confirmedSeatSync({
        org: { id: "org_team", name: "Team Org", billing_seat_count: 5 },
        requestedSeatCount: 4,
        targetSeatCount: 5,
        previousStripeSeatCount: 5,
        stripeQuantityChanged: false,
        paidIncreaseConfirmed: false,
      }),
    );
    createInvitationsMock.mockResolvedValue([
      {
        id: "inv_partial_retry",
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
    expect(ensureTeamSubscriptionSeatCapacityMock).toHaveBeenCalledWith(
      env,
      "org_team",
      expect.objectContaining({
        pendingReservedSeatDelta: 1,
        targetSeatCount: 4,
      }),
    );
    expect(
      bestEffortEnsureTeamSubscriptionSeatCapacityMock,
    ).toHaveBeenCalledWith(env, "org_team", {
      reason: "api_invitation_created",
      targetSeatCount: 5,
    });
    expect(bestEffortSyncTeamSubscriptionSeatCountMock).not.toHaveBeenCalled();
  });

  it("creates enterprise invitations without calling Team seat billing", async () => {
    orgStub.getInfo.mockResolvedValueOnce({
      id: "org_team",
      name: "Enterprise Org",
      billing_status: "enterprise",
      billing_plan: "enterprise",
      billing_subscription_id: null,
      billing_subscription_status: null,
    } as never);
    createInvitationsMock.mockResolvedValue([
      {
        id: "inv_enterprise",
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
      id: "inv_enterprise",
      email: "new@example.com",
    });
    expect(getBillableTeamSeatCountForOrgMock).not.toHaveBeenCalled();
    expect(ensureTeamSubscriptionSeatCapacityMock).not.toHaveBeenCalled();
    expect(
      bestEffortEnsureTeamSubscriptionSeatCapacityMock,
    ).not.toHaveBeenCalled();
    expect(createInvitationsMock).toHaveBeenCalledWith(
      env,
      "org_team",
      ["new@example.com"],
      "member",
      "owner_123",
      undefined,
    );
  });
});
