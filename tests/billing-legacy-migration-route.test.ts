import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const getEnvMock = vi.fn();
const migrateLegacyStripeSubscriptionMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
  requireOrgAdmin: requireOrgAdminMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/billing.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing.server")>();
  return {
    ...actual,
    migrateLegacyStripeSubscription: migrateLegacyStripeSubscriptionMock,
  };
});

const { action } = await import("@/routes/api/billing.legacy-migration");

function makeRequest(plan: string) {
  const formData = new FormData();
  formData.set("plan", plan);
  return new Request("https://camelai.test/api/billing/legacy-migration", {
    method: "POST",
    body: formData,
  });
}

describe("legacy billing migration route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireOrgAdminMock.mockResolvedValue(undefined);
  });

  it("uses billable seats including active invitations for Team migration", async () => {
    const org = {
      id: "org_123",
      name: "Legacy Team",
      slug: "legacy-team",
      billing_status: "inactive",
      billing_plan: "free",
      billing_subscription_id: null,
    };
    const orgStub = {
      getInfo: vi.fn(async () => org),
      getMemberCount: vi.fn(async () => 2),
      getInvitations: vi.fn(async () => [
        { expires_at: Date.now() + 60_000 },
        { expires_at: Date.now() - 60_000 },
      ]),
    };
    const env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
    };
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });
    migrateLegacyStripeSubscriptionMock.mockResolvedValue({
      ...org,
      billing_status: "active",
      billing_plan: "team",
      billing_seat_count: 3,
    });

    const response = await action({
      request: makeRequest("team"),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(migrateLegacyStripeSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        userEmail: "owner@example.com",
        plan: "team",
        seatCount: 3,
      }),
    );
  });
});
