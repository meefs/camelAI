import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const getAuthEnvMock = vi.fn((env) => env);
const getEnvMock = vi.fn();
const createInvitationsMock = vi.fn();
const getOrgMembersWithWorkspaceAccessMock = vi.fn();
const getOrgInvitationsMock = vi.fn();
const syncTeamSubscriptionSeatCountMock = vi.fn();
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

describe("team settings bulk invitation action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireOrgAdminMock.mockResolvedValue(undefined);
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
    expect(syncTeamSubscriptionSeatCountMock).not.toHaveBeenCalled();
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
    expect(syncTeamSubscriptionSeatCountMock).not.toHaveBeenCalled();
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
    syncTeamSubscriptionSeatCountMock.mockRejectedValue(
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
    expect(syncTeamSubscriptionSeatCountMock).toHaveBeenCalledWith(
      env,
      "org_123",
      expect.objectContaining({
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
    expect(syncTeamSubscriptionSeatCountMock).not.toHaveBeenCalled();
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
    syncTeamSubscriptionSeatCountMock.mockResolvedValue(undefined);
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

    expect(syncTeamSubscriptionSeatCountMock).toHaveBeenCalledWith(
      env,
      "org_123",
      expect.objectContaining({
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
    expect(result).toMatchObject({
      success: true,
      invited: [{ email: "new@example.com", invitation_id: "inv_new" }],
      skipped: [],
      failed: [],
    });
  });
});
