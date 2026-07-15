import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const getAuthEnvMock = vi.fn((env) => env);
const getEnvMock = vi.fn();
const createInvitationsMock = vi.fn();
const getOrgMembersWithWorkspaceAccessMock = vi.fn();
const getOrgInvitationsMock = vi.fn();
const ensureTeamSubscriptionSeatCapacityMock = vi.fn();
const bestEffortEnsureTeamSubscriptionSeatCapacityMock = vi.fn();
const bestEffortReleaseTeamSeatCapacityReservationMock = vi.fn();
const bestEffortSyncTeamSubscriptionSeatCountMock = vi.fn();
const sendOrgInvitationEmailMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
  requireOrgAdmin: requireOrgAdminMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-do", () => ({
  createInvitations: createInvitationsMock,
  removeOrgMember: vi.fn(),
  updateOrgMemberRole: vi.fn(),
  transferOrgOwnership: vi.fn(),
  setWorkspaceAccess: vi.fn(),
  updateInvitationWorkspaceAccess: vi.fn(),
  getOrgMembersWithWorkspaceAccess: getOrgMembersWithWorkspaceAccessMock,
  getOrgInvitations: getOrgInvitationsMock,
  listOrgWorkspaces: vi.fn(),
}));

vi.mock("@/lib/billing.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing.server")>();
  return {
    ...actual,
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

const { action } = await import("@/routes/_app.settings.organization.team");

function makeOrg(overrides: Record<string, unknown> = {}) {
  return {
    id: "org_123",
    name: "Team Org",
    slug: "team-org",
    billing_status: "active",
    billing_plan: "team",
    billing_seat_count: 5,
    billing_subscription_id: "sub_team",
    billing_subscription_status: "active",
    ...overrides,
  };
}

function makeRequest(fields: Record<string, string | string[]>) {
  const formData = new FormData();
  formData.set("intent", "createInvitation");
  formData.set("role", "member");
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const item of value) formData.append(key, item);
    } else {
      formData.set(key, value);
    }
  }
  return new Request("https://camelai.test/settings/organization/team", {
    method: "POST",
    body: formData,
  });
}

function confirmedSeatSync(overrides: Record<string, unknown> = {}) {
  return {
    status: "capacity_confirmed",
    org: makeOrg({ billing_seat_count: 4 }),
    targetSeatCount: 4,
    previousStripeSeatCount: 3,
    stripeQuantityChanged: true,
    paidIncreaseConfirmed: true,
    metadataSynced: true,
    orgSeatStateSynced: true,
    pendingBillingSeatAllowance: 0,
    seatReservation: {
      operationId: "reserve_batch",
      subscriptionId: "sub_team",
    },
    ...overrides,
  };
}

function arrangePaidSeatInvitation() {
  const org = makeOrg({ billing_seat_count: 3 });
  const env = {
    ORG: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => ({ getInfo: vi.fn(async () => org) })),
    },
  };
  getEnvMock.mockReturnValue(env);
  requireAuthContextMock.mockResolvedValue({
    currentOrg: org,
    user: { id: "owner_123", email: "owner@example.com" },
  });
  getOrgMembersWithWorkspaceAccessMock.mockResolvedValue([
    { user: { id: "owner_123", email: "owner@example.com" }, role: "owner" },
    { user: { id: "a", email: "a@example.com" }, role: "member" },
    { user: { id: "b", email: "b@example.com" }, role: "member" },
  ]);
  getOrgInvitationsMock.mockResolvedValue([]);
  return { env, org };
}

describe("team settings bulk invitation action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireOrgAdminMock.mockResolvedValue(undefined);
    ensureTeamSubscriptionSeatCapacityMock.mockResolvedValue(
      confirmedSeatSync(),
    );
    bestEffortEnsureTeamSubscriptionSeatCapacityMock.mockResolvedValue(null);
    bestEffortReleaseTeamSeatCapacityReservationMock.mockResolvedValue(null);
    bestEffortSyncTeamSubscriptionSeatCountMock.mockResolvedValue(null);
    sendOrgInvitationEmailMock.mockResolvedValue({ status: "sent" });
  });

  it("creates bulk invitations and skips already present emails", async () => {
    const org = makeOrg();
    const orgStub = { getInfo: vi.fn(async () => org) };
    const env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
    };
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      currentOrg: org,
      user: { id: "owner_123", email: "owner@example.com", name: "Owner" },
    });
    getOrgMembersWithWorkspaceAccessMock.mockResolvedValue([
      { user: { id: "owner_123", email: "owner@example.com" }, role: "owner" },
      {
        user: { id: "member_123", email: "member@example.com" },
        role: "member",
      },
    ]);
    getOrgInvitationsMock.mockResolvedValue([
      { id: "inv_existing", email: "invited@example.com", expires_at: Date.now() + 60_000 },
    ]);
    createInvitationsMock.mockResolvedValue([
      { id: "inv_new_1", email: "new1@example.com", expires_at: 123 },
      { id: "inv_new_2", email: "new2@example.com", expires_at: 456 },
    ]);

    const result = await action({
      request: makeRequest({
        emails: [
          "member@example.com",
          "invited@example.com",
          "new1@example.com",
          "new2@example.com",
          "NEW1@example.com",
        ],
        disclosed_next_seat_count: "5",
        disclosed_added_seat_count: "0",
      }),
      context: {},
    } as never);

    expect(createInvitationsMock).toHaveBeenCalledWith(
      env,
      "org_123",
      ["new1@example.com", "new2@example.com"],
      "member",
      "owner_123",
      { pendingBillingSeatAllowance: 0 },
    );
    expect(ensureTeamSubscriptionSeatCapacityMock).not.toHaveBeenCalled();
    expect(sendOrgInvitationEmailMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      success: true,
      invited: [
        { email: "new1@example.com", invitation_id: "inv_new_1" },
        { email: "new2@example.com", invitation_id: "inv_new_2" },
      ],
      skipped: [
        { email: "new1@example.com", reason: "duplicate" },
        { email: "member@example.com", reason: "already_member" },
        { email: "invited@example.com", reason: "already_invited" },
      ],
      failed: [],
    });
  });

  it("rejects stale billing disclosures before syncing Stripe", async () => {
    const org = makeOrg({ billing_seat_count: 3 });
    const env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ getInfo: vi.fn(async () => org) })),
      },
    };
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      currentOrg: org,
      user: { id: "owner_123", email: "owner@example.com" },
    });
    getOrgMembersWithWorkspaceAccessMock.mockResolvedValue([
      { user: { id: "owner_123", email: "owner@example.com" }, role: "owner" },
      { user: { id: "a", email: "a@example.com" }, role: "member" },
      { user: { id: "b", email: "b@example.com" }, role: "member" },
    ]);
    getOrgInvitationsMock.mockResolvedValue([]);

    const result = await action({
      request: makeRequest({
        emails: ["new@example.com"],
        disclosed_next_seat_count: "3",
        disclosed_added_seat_count: "0",
      }),
      context: {},
    } as never);

    expect(result).toMatchObject({
      success: false,
      error: "stale_billing_context",
      billing: { addedSeatCount: 1, nextSeatCount: 4 },
    });
    expect(ensureTeamSubscriptionSeatCapacityMock).not.toHaveBeenCalled();
    expect(createInvitationsMock).not.toHaveBeenCalled();
  });

  it("does not create invitations when paid seat sync fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const org = makeOrg({ billing_seat_count: 3 });
    const env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ getInfo: vi.fn(async () => org) })),
      },
    };
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      currentOrg: org,
      user: { id: "owner_123", email: "owner@example.com" },
    });
    getOrgMembersWithWorkspaceAccessMock.mockResolvedValue([
      { user: { id: "owner_123", email: "owner@example.com" }, role: "owner" },
      { user: { id: "a", email: "a@example.com" }, role: "member" },
      { user: { id: "b", email: "b@example.com" }, role: "member" },
    ]);
    getOrgInvitationsMock.mockResolvedValue([]);
    ensureTeamSubscriptionSeatCapacityMock.mockRejectedValue(
      new Error("Stripe unavailable"),
    );

    const result = await action({
      request: makeRequest({
        emails: ["new@example.com"],
        disclosed_next_seat_count: "4",
        disclosed_added_seat_count: "1",
      }),
      context: {},
    } as never);

    expect(result).toMatchObject({
      success: false,
      error: "billing_update_failed",
    });
    expect(ensureTeamSubscriptionSeatCapacityMock).toHaveBeenCalledWith(
      env,
      "org_123",
      expect.objectContaining({
        pendingReservedSeatDelta: 1,
        targetSeatCount: 4,
        prorationBehavior: "always_invoice",
        itemUpdateIdempotencyKey: expect.stringMatching(
          /^team-seat-sync:org_123:4:/,
        ),
      }),
    );
    expect(createInvitationsMock).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("revalidates billing disclosures immediately before paid seat sync", async () => {
    const org = makeOrg({ billing_seat_count: 3 });
    const orgStub = { getInfo: vi.fn(async () => org) };
    const env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
    };
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      currentOrg: org,
      user: { id: "owner_123", email: "owner@example.com" },
    });
    getOrgMembersWithWorkspaceAccessMock
      .mockResolvedValueOnce([
        { user: { id: "owner_123", email: "owner@example.com" }, role: "owner" },
        { user: { id: "a", email: "a@example.com" }, role: "member" },
        { user: { id: "b", email: "b@example.com" }, role: "member" },
      ])
      .mockResolvedValueOnce([
        { user: { id: "owner_123", email: "owner@example.com" }, role: "owner" },
        { user: { id: "a", email: "a@example.com" }, role: "member" },
        { user: { id: "b", email: "b@example.com" }, role: "member" },
        { user: { id: "c", email: "c@example.com" }, role: "member" },
      ]);
    getOrgInvitationsMock.mockResolvedValue([]);

    const result = await action({
      request: makeRequest({
        emails: ["new@example.com"],
        disclosed_next_seat_count: "4",
        disclosed_added_seat_count: "1",
      }),
      context: {},
    } as never);

    expect(result).toMatchObject({
      success: false,
      error: "stale_billing_context",
      billing: { addedSeatCount: 2, nextSeatCount: 5 },
    });
    expect(ensureTeamSubscriptionSeatCapacityMock).not.toHaveBeenCalled();
    expect(createInvitationsMock).not.toHaveBeenCalled();
  });

  it("does not pass extra invite allowance after paid seat sync succeeds", async () => {
    const org = makeOrg({ billing_seat_count: 3 });
    const orgStub = { getInfo: vi.fn(async () => org) };
    const env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
    };
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      currentOrg: org,
      user: { id: "owner_123", email: "owner@example.com" },
    });
    getOrgMembersWithWorkspaceAccessMock.mockResolvedValue([
      { user: { id: "owner_123", email: "owner@example.com" }, role: "owner" },
      { user: { id: "a", email: "a@example.com" }, role: "member" },
      { user: { id: "b", email: "b@example.com" }, role: "member" },
    ]);
    getOrgInvitationsMock.mockResolvedValue([]);
    ensureTeamSubscriptionSeatCapacityMock.mockResolvedValue(
      confirmedSeatSync(),
    );
    createInvitationsMock.mockResolvedValue([
      { id: "inv_new", email: "new@example.com", expires_at: 123 },
    ]);

    const result = await action({
      request: makeRequest({
        emails: ["new@example.com"],
        disclosed_next_seat_count: "4",
        disclosed_added_seat_count: "1",
      }),
      context: {},
    } as never);

    expect(ensureTeamSubscriptionSeatCapacityMock).toHaveBeenCalledWith(
      env,
      "org_123",
      expect.objectContaining({
        pendingReservedSeatDelta: 1,
        targetSeatCount: 4,
        prorationBehavior: "always_invoice",
        itemUpdateIdempotencyKey: expect.stringMatching(
          /^team-seat-sync:org_123:4:/,
        ),
      }),
    );
    expect(createInvitationsMock).toHaveBeenCalledWith(
      env,
      "org_123",
      ["new@example.com"],
      "member",
      "owner_123",
      { pendingBillingSeatAllowance: 0 },
    );
    expect(
      createInvitationsMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      bestEffortReleaseTeamSeatCapacityReservationMock.mock
        .invocationCallOrder[0],
    );
    expect(bestEffortReleaseTeamSeatCapacityReservationMock).toHaveBeenCalledWith(
      env,
      "org_123",
      {
        operationId: "reserve_batch",
        subscriptionId: "sub_team",
      },
    );
    expect(result).toMatchObject({
      success: true,
      invited: [{ email: "new@example.com", invitation_id: "inv_new" }],
      skipped: [],
      failed: [],
    });
  });

  it("creates invitations after confirmed capacity even when metadata repair fails", async () => {
    const { env } = arrangePaidSeatInvitation();
    ensureTeamSubscriptionSeatCapacityMock.mockResolvedValue(
      confirmedSeatSync({ metadataSynced: false }),
    );
    createInvitationsMock.mockResolvedValue([
      { id: "inv_new", email: "new@example.com", expires_at: 123 },
    ]);

    const result = await action({
      request: makeRequest({
        emails: ["new@example.com"],
        disclosed_next_seat_count: "4",
        disclosed_added_seat_count: "1",
      }),
      context: {},
    } as never);

    expect(result).toMatchObject({ success: true });
    expect(createInvitationsMock).toHaveBeenCalledWith(
      env,
      "org_123",
      ["new@example.com"],
      "member",
      "owner_123",
      { pendingBillingSeatAllowance: 0 },
    );
    expect(
      bestEffortEnsureTeamSubscriptionSeatCapacityMock,
    ).toHaveBeenCalledWith(
      env,
      "org_123",
      { reason: "bulk_invitations_created", targetSeatCount: 4 },
    );
  });

  it("creates invitations against confirmed capacity while Org seat repair retries", async () => {
    const { env, org } = arrangePaidSeatInvitation();
    ensureTeamSubscriptionSeatCapacityMock.mockResolvedValue(
      confirmedSeatSync({
        org,
        orgSeatStateSynced: false,
        pendingBillingSeatAllowance: 1,
      }),
    );
    createInvitationsMock.mockResolvedValue([
      { id: "inv_new", email: "new@example.com", expires_at: 123 },
    ]);

    const result = await action({
      request: makeRequest({
        emails: ["new@example.com"],
        disclosed_next_seat_count: "4",
        disclosed_added_seat_count: "1",
      }),
      context: {},
    } as never);

    expect(result).toMatchObject({ success: true });
    expect(createInvitationsMock).toHaveBeenCalledWith(
      env,
      "org_123",
      ["new@example.com"],
      "member",
      "owner_123",
      { pendingBillingSeatAllowance: 1 },
    );
  });

  it("preserves paid capacity after invitation failure and succeeds on retry", async () => {
    const { env } = arrangePaidSeatInvitation();
    ensureTeamSubscriptionSeatCapacityMock
      .mockResolvedValueOnce(confirmedSeatSync())
      .mockResolvedValueOnce(
        confirmedSeatSync({
          previousStripeSeatCount: 4,
          stripeQuantityChanged: false,
          paidIncreaseConfirmed: false,
        }),
      );
    createInvitationsMock
      .mockRejectedValueOnce(new Error("temporary invitation failure"))
      .mockResolvedValueOnce([
        { id: "inv_retry", email: "new@example.com", expires_at: 123 },
      ]);
    const requestFields = {
      emails: ["new@example.com"],
      disclosed_next_seat_count: "4",
      disclosed_added_seat_count: "1",
    };

    await expect(
      action({
        request: makeRequest(requestFields),
        context: {},
      } as never),
    ).resolves.toMatchObject({
      success: false,
      error: "temporary invitation failure",
    });
    await expect(
      action({
        request: makeRequest(requestFields),
        context: {},
      } as never),
    ).resolves.toMatchObject({
      success: true,
      invited: [{ invitation_id: "inv_retry" }],
    });

    expect(ensureTeamSubscriptionSeatCapacityMock).toHaveBeenCalledTimes(2);
    expect(createInvitationsMock).toHaveBeenCalledTimes(2);
    expect(
      bestEffortEnsureTeamSubscriptionSeatCapacityMock,
    ).toHaveBeenCalledTimes(
      1,
    );
    expect(
      bestEffortEnsureTeamSubscriptionSeatCapacityMock,
    ).toHaveBeenCalledWith(
      env,
      "org_123",
      { reason: "bulk_invitations_created", targetSeatCount: 4 },
    );
    expect(bestEffortSyncTeamSubscriptionSeatCountMock).not.toHaveBeenCalled();
  });

  it("keeps a 3-to-5 paid increase through partial retries of a failed batch", async () => {
    const { env, org } = arrangePaidSeatInvitation();
    const invitations: Array<{
      id: string;
      email: string;
      expires_at: number;
    }> = [];
    getOrgInvitationsMock.mockImplementation(async () => invitations);
    ensureTeamSubscriptionSeatCapacityMock.mockImplementation(async () => {
      org.billing_seat_count = 5;
      return confirmedSeatSync({
        org,
        requestedSeatCount: 5,
        targetSeatCount: 5,
        previousStripeSeatCount: 3,
      });
    });
    createInvitationsMock
      .mockRejectedValueOnce(new Error("temporary batch persistence failure"))
      .mockImplementationOnce(async (_env, _orgId, emails: string[]) => {
        const created = {
          id: "inv_a",
          email: emails[0],
          expires_at: Date.now() + 60_000,
        };
        invitations.push(created);
        return [created];
      })
      .mockImplementationOnce(async (_env, _orgId, emails: string[]) => {
        const created = {
          id: "inv_b",
          email: emails[0],
          expires_at: Date.now() + 60_000,
        };
        invitations.push(created);
        return [created];
      });

    await expect(
      action({
        request: makeRequest({
          emails: ["first@example.com", "second@example.com"],
          disclosed_next_seat_count: "5",
          disclosed_added_seat_count: "2",
        }),
        context: {},
      } as never),
    ).resolves.toMatchObject({
      success: false,
      error: "temporary batch persistence failure",
    });

    await expect(
      action({
        request: makeRequest({
          emails: ["first@example.com"],
          disclosed_next_seat_count: "4",
          disclosed_added_seat_count: "0",
        }),
        context: {},
      } as never),
    ).resolves.toMatchObject({
      success: true,
      invited: [{ email: "first@example.com", invitation_id: "inv_a" }],
    });

    await expect(
      action({
        request: makeRequest({
          emails: ["second@example.com"],
          disclosed_next_seat_count: "5",
          disclosed_added_seat_count: "0",
        }),
        context: {},
      } as never),
    ).resolves.toMatchObject({
      success: true,
      invited: [{ email: "second@example.com", invitation_id: "inv_b" }],
    });

    expect(ensureTeamSubscriptionSeatCapacityMock).toHaveBeenCalledTimes(1);
    expect(ensureTeamSubscriptionSeatCapacityMock).toHaveBeenCalledWith(
      env,
      "org_123",
      expect.objectContaining({
        pendingReservedSeatDelta: 2,
        targetSeatCount: 5,
      }),
    );
    expect(createInvitationsMock).toHaveBeenCalledTimes(3);
    expect(bestEffortEnsureTeamSubscriptionSeatCapacityMock).toHaveBeenCalledTimes(
      2,
    );
    expect(
      bestEffortEnsureTeamSubscriptionSeatCapacityMock,
    ).toHaveBeenNthCalledWith(1, env, "org_123", {
      reason: "bulk_invitations_created",
      targetSeatCount: undefined,
    });
    expect(
      bestEffortEnsureTeamSubscriptionSeatCapacityMock,
    ).toHaveBeenNthCalledWith(2, env, "org_123", {
      reason: "bulk_invitations_created",
      targetSeatCount: undefined,
    });
    expect(bestEffortSyncTeamSubscriptionSeatCountMock).not.toHaveBeenCalled();
    expect(org.billing_seat_count).toBe(5);
    expect(invitations.map(({ email }) => email)).toEqual([
      "first@example.com",
      "second@example.com",
    ]);
  });
});
