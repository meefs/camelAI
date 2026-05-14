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
    vi.unstubAllGlobals();
    requireSessionMock.mockResolvedValue({
      session: {
        user_id: "user_123",
        org_id: "org_123",
        workspace_id: "ws_123",
      },
    });
  });

  it("redirects already-onboarded users back to the app shell even without billing access", async () => {
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
      STRIPE_MODE: "test",
      STRIPE_SECRET_KEY: "sk_test_123",
      LEGACY_STRIPE_MIGRATION_CUSTOMERS:
        "email,customer_id,active_legacy_subscription_count,legacy_subscription_ids,legacy_subscription_item_ids,legacy_price_names,legacy_price_ids,total_legacy_quantity,customer_name,customer_user_id\nlegacy@example.com,cus_123,1,sub_123,si_123,Individual,price_1QIfnqGvliMKf4vHaDTMG2Mu,1,Legacy,user_123",
    };
    getAuthEnvMock.mockReturnValue(authEnv);
    getEnvMock.mockReturnValue(env);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          id: "sub_123",
          status: "active",
          customer: "cus_123",
          items: {
            data: [
              {
                id: "si_123",
                quantity: 1,
                price: "price_1QIfnqGvliMKf4vHaDTMG2Mu",
              },
            ],
          },
        }),
      })),
    );

    await expect(
      loader({
        request: new Request("https://camelai.dev/onboarding"),
        context: {},
      } as never),
    ).rejects.toSatisfy((response: unknown) => {
      return (
        response instanceof Response &&
        response.status === 302 &&
        response.headers.get("Location") === "/chat"
      );
    });
    expect(userStub.getAuthBootstrap).toHaveBeenCalled();
    expect(orgStub.getLlmProviderConfig).toHaveBeenCalled();
  });
});
