import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSessionMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireSession: requireSessionMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

const { loader } = await import("@/routes/_onboarding");

describe("onboarding legacy migration loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionMock.mockResolvedValue({
      session: {
        user_id: "user_123",
        org_id: "org_123",
        workspace_id: "ws_123",
      },
    });
  });

  it("shows migration eligibility to already logged-in v2 users without billing access", async () => {
    const orgInfo = {
      id: "org_123",
      name: "Legacy Org",
      slug: "legacy-org",
      billing_status: "inactive",
      billing_plan: "free",
      billing_subscription_id: null,
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue(orgInfo),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
    };
    const userStub = {
      getAuthBootstrap: vi.fn().mockResolvedValue({
        profile: {
          id: "user_123",
          email: "legacy@example.com",
        },
        onboarding: { completed_at: Date.now() },
      }),
      getEmailVerificationStatus: vi.fn().mockResolvedValue({
        required: false,
        verified: true,
      }),
    };
    const authEnv = {
      USER: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => userStub),
      },
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
    };
    const env = {
      ...authEnv,
      LEGACY_STRIPE_MIGRATION_CUSTOMERS:
        "email,customer_id,active_legacy_subscription_count,legacy_subscription_ids,legacy_subscription_item_ids,legacy_price_names,legacy_price_ids,total_legacy_quantity,customer_name,customer_user_id\nlegacy@example.com,cus_123,1,sub_123,si_123,Individual,price_1QIfnqGvliMKf4vHaDTMG2Mu,1,Legacy,user_123",
    };
    getAuthEnvMock.mockReturnValue(authEnv);
    getEnvMock.mockReturnValue(env);

    const result = await loader({
      request: new Request("https://camelai.dev/onboarding"),
      context: {},
    } as never);

    expect(result).toMatchObject({
      userEmail: "legacy@example.com",
      onboardingComplete: true,
      billingAccessReady: false,
      legacyMigration: {
        eligible: true,
        customerId: "cus_123",
        activeLegacySubscriptionCount: 1,
        defaultPlan: "pro",
      },
    });
    expect(userStub.getAuthBootstrap).toHaveBeenCalled();
    expect(orgStub.getLlmProviderConfig).toHaveBeenCalled();
  });
});
