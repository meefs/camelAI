import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const getAuthEnvMock = vi.fn((env) => env);
const getEnvMock = vi.fn();
const createInvitationsMock = vi.fn();
const getOrgMembersWithWorkspaceAccessMock = vi.fn();
const getOrgInvitationsMock = vi.fn();
const createSubscriptionUpdatePortalSessionMock = vi.fn();
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
    createSubscriptionUpdatePortalSession:
      createSubscriptionUpdatePortalSessionMock,
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

function makeRequest(
  intent: "createInvitation" | "buyTeamCapacity",
  fields: Record<string, string | string[]>,
) {
  const formData = new FormData();
  formData.set("intent", intent);
  if (intent === "createInvitation") formData.set("role", "member");
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

function arrange(args: {
  org?: ReturnType<typeof makeOrg>;
  memberEmails?: string[];
  invitationEmails?: string[];
} = {}) {
  const org = args.org ?? makeOrg();
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
    user: {
      id: "owner_123",
      email: "owner@example.com",
      name: "Owner",
    },
  });
  getOrgMembersWithWorkspaceAccessMock.mockResolvedValue(
    (args.memberEmails ?? ["owner@example.com"]).map((email, index) => ({
      user: { id: `user_${index}`, email },
      role: index === 0 ? "owner" : "member",
    })),
  );
  getOrgInvitationsMock.mockResolvedValue(
    (args.invitationEmails ?? []).map((email, index) => ({
      id: `inv_existing_${index}`,
      email,
      expires_at: Date.now() + 60_000,
    })),
  );
  return { env, org };
}

describe("team settings invitation capacity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireOrgAdminMock.mockResolvedValue(undefined);
    sendOrgInvitationEmailMock.mockResolvedValue({ status: "sent" });
    createSubscriptionUpdatePortalSessionMock.mockResolvedValue(
      "https://billing.stripe.test/confirm",
    );
  });

  it("creates invitations locally when paid capacity is available", async () => {
    const { env } = arrange({
      memberEmails: ["owner@example.com", "member@example.com"],
      invitationEmails: ["pending@example.com"],
    });
    createInvitationsMock.mockResolvedValue([
      {
        id: "inv_new",
        email: "new@example.com",
        expires_at: 1_800_000_000_000,
      },
    ]);

    const result = await action({
      request: makeRequest("createInvitation", {
        emails: [
          "member@example.com",
          "pending@example.com",
          "new@example.com",
        ],
      }),
      context: {},
    } as never);

    expect(createInvitationsMock).toHaveBeenCalledWith(
      env,
      "org_123",
      ["new@example.com"],
      "member",
      "owner_123",
    );
    expect(createSubscriptionUpdatePortalSessionMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      invited: [{ email: "new@example.com", invitation_id: "inv_new" }],
      skipped: [
        { email: "member@example.com", reason: "already_member" },
        { email: "pending@example.com", reason: "already_invited" },
      ],
    });
  });

  it("blocks invitations without enough paid capacity and does not call Stripe", async () => {
    arrange({
      org: makeOrg({ billing_seat_count: 3 }),
      memberEmails: ["owner@example.com", "a@example.com", "b@example.com"],
    });

    const result = await action({
      request: makeRequest("createInvitation", {
        emails: ["new@example.com"],
      }),
      context: {},
    } as never);

    expect(result).toMatchObject({
      success: false,
      error: "insufficient_paid_seats",
      billing: {
        coveredSeatCount: 3,
        occupiedSeatCount: 3,
        nextSeatCount: 4,
        addedSeatCount: 1,
      },
    });
    expect(createInvitationsMock).not.toHaveBeenCalled();
    expect(createSubscriptionUpdatePortalSessionMock).not.toHaveBeenCalled();
  });

  it("opens a Stripe-hosted exact capacity purchase separately", async () => {
    const { env, org } = arrange({
      org: makeOrg({ billing_seat_count: 3 }),
      memberEmails: ["owner@example.com", "a@example.com", "b@example.com"],
    });

    const result = await action({
      request: makeRequest("buyTeamCapacity", { requestedInviteCount: "1" }),
      context: {},
    } as never);

    expect(createSubscriptionUpdatePortalSessionMock).toHaveBeenCalledWith({
      env,
      org,
      plan: "team",
      seatCount: 4,
      returnUrl: "https://camelai.test/settings/organization/team",
    });
    expect(result).toEqual({
      billingPortalUrl: "https://billing.stripe.test/confirm",
    });
    expect(createInvitationsMock).not.toHaveBeenCalled();
  });

  it("maps an atomic OrgDO capacity race back to the buy-seats state", async () => {
    arrange();
    createInvitationsMock.mockRejectedValue(
      new Error("Your current billing plan includes 5 seats."),
    );

    const result = await action({
      request: makeRequest("createInvitation", {
        emails: ["new@example.com"],
      }),
      context: {},
    } as never);

    expect(result).toMatchObject({
      success: false,
      error: "insufficient_paid_seats",
      billing: {
        coveredSeatCount: 5,
      },
    });
  });
});
