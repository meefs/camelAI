import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn((env) => env);
const getSessionMock = vi.fn();
const createInvitationsMock = vi.fn();
const isOrgAdminMock = vi.fn();
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

describe("legacy organization invitation API capacity guard", () => {
  const orgStub = {
    getInvitationByEmail: vi.fn(async () => null),
    getInfo: vi.fn(async () => ({
      id: "org_team",
      name: "Team Org",
      billing_status: "active",
      billing_plan: "team",
      billing_seat_count: 3,
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
    sendOrgInvitationEmailMock.mockResolvedValue({ status: "sent" });
  });

  it("creates an invitation locally without a billing mutation", async () => {
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
    expect(createInvitationsMock).toHaveBeenCalledWith(
      env,
      "org_team",
      ["new@example.com"],
      "member",
      "owner_123",
    );
    await expect(response.json()).resolves.toMatchObject({
      id: "inv_new",
      email: "new@example.com",
      email_delivery: "sent",
    });
  });

  it("returns a capacity conflict when OrgDO rejects the invitation", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    createInvitationsMock.mockRejectedValue(
      new Error("Your current billing plan includes 3 seats."),
    );

    const response = await action({
      request: makeRequest(),
      context: {},
      params: { id: "org_team" },
    } as never);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "insufficient_paid_seats",
      message: "Your current billing plan includes 3 seats.",
    });
    expect(sendOrgInvitationEmailMock).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
