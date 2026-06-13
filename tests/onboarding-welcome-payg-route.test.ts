import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const requireSessionMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const getOrgProviderContextMock = vi.fn();
const getOrgOnboardingWelcomeContextMock = vi.fn();
const activatePayAsYouGoPlanMock = vi.fn();
const createCreditsCheckoutSessionMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  getAuthEnv: getAuthEnvMock,
  requireAuthContext: requireAuthContextMock,
  requireOrgAdmin: requireOrgAdminMock,
  requireSession: requireSessionMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-do", () => ({
  getOrgOnboardingWelcomeContext: getOrgOnboardingWelcomeContextMock,
  getOrgProviderContext: getOrgProviderContextMock,
}));

vi.mock("@/lib/billing.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing.server")>();
  return {
    ...actual,
    activatePayAsYouGoPlan: activatePayAsYouGoPlanMock,
    createCreditsCheckoutSession: createCreditsCheckoutSessionMock,
    createSubscriptionCheckoutSession: vi.fn(),
    getBillableTeamSeatCountForOrg: vi.fn(),
    hasOrgUsedSubscriptionTrial: vi.fn(() => true),
  };
});

const { action, loader } = await import("@/routes/_onboarding.welcome");

describe("OnboardingWelcomeRoute Pay as you go action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({ STRIPE_MODE: "test" });
    getAuthEnvMock.mockReturnValue({ auth: true });
    requireSessionMock.mockResolvedValue({
      session: {
        org_id: "org_123",
        workspace_id: "ws_123",
      },
    });
    getOrgProviderContextMock.mockResolvedValue({
      info: {
        id: "org_123",
        name: "New Org",
        slug: "new-org",
      },
      llmProviderConfig: null,
    });
    getOrgOnboardingWelcomeContextMock.mockResolvedValue({
      info: {
        id: "org_123",
        name: "New Org",
        slug: "new-org",
      },
      llmProviderConfig: null,
      memberCount: 4,
      appCount: 2,
      integrations: ["Primary DB", "Slack"],
    });
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: {
        id: "org_123",
        name: "New Org",
        slug: "new-org",
        billing_status: "inactive",
        billing_plan: "free",
        billing_seat_count: 1,
      },
    });
    activatePayAsYouGoPlanMock.mockResolvedValue({
      id: "org_123",
      name: "New Org",
      slug: "new-org",
      billing_status: "inactive",
      billing_plan: "payg",
      billing_seat_count: 1,
    });
    createCreditsCheckoutSessionMock.mockResolvedValue(
      "https://billing.stripe.test/credits-checkout",
    );
  });

  it("activates Pay as you go and redirects to credit checkout", async () => {
    const formData = new FormData();
    formData.set("intent", "buyCredits");
    formData.set("priceId", "price_credit_1000");

    await expect(
      action({
        request: new Request("https://camelai.test/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {},
      } as never),
    ).rejects.toSatisfy((response: unknown) => {
      return (
        response instanceof Response &&
        response.status === 302 &&
        response.headers.get("Location") ===
          "https://billing.stripe.test/credits-checkout"
      );
    });

    expect(requireOrgAdminMock).toHaveBeenCalledWith(
      expect.any(Request),
      {},
      "org_123",
    );
    expect(activatePayAsYouGoPlanMock).toHaveBeenCalledWith({
      env: { STRIPE_MODE: "test" },
      org: expect.objectContaining({ id: "org_123" }),
    });
    expect(createCreditsCheckoutSessionMock).toHaveBeenCalledWith({
      env: { STRIPE_MODE: "test" },
      org: expect.objectContaining({
        id: "org_123",
        billing_plan: "payg",
      }),
      customerEmail: "owner@example.com",
      successUrl: "https://camelai.test/onboarding?checkout=success",
      cancelUrl: "https://camelai.test/onboarding?checkout=cancelled",
      priceId: "price_credit_1000",
    });
  });

  it("loads org/provider context through the combined helper", async () => {
    const result = await loader({
      request: new Request("https://camelai.test/onboarding"),
      context: {},
      params: {},
    } as never);

    expect(getOrgProviderContextMock).toHaveBeenCalledWith(
      { auth: true },
      "org_123",
    );
    expect(getOrgOnboardingWelcomeContextMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      orgId: "org_123",
      orgName: "camelAI",
      byokProviderLabel: null,
      teamContext: {
        memberCount: 0,
        appCount: 0,
        integrations: [],
      },
    });
  });

  it("loads team context through the combined helper", async () => {
    const result = await loader({
      request: new Request("https://camelai.test/onboarding?team=1"),
      context: {},
      params: {},
    } as never);

    expect(getOrgProviderContextMock).not.toHaveBeenCalled();
    expect(getOrgOnboardingWelcomeContextMock).toHaveBeenCalledWith(
      { auth: true },
      "org_123",
      "ws_123",
    );
    expect(result).toMatchObject({
      orgId: "org_123",
      orgName: "New Org",
      teamContext: {
        memberCount: 4,
        appCount: 2,
        integrations: ["Primary DB", "Slack"],
      },
    });
  });

  it("propagates unexpected team context load failures", async () => {
    getOrgOnboardingWelcomeContextMock.mockRejectedValueOnce(
      new Error("org summary unavailable"),
    );

    await expect(
      loader({
        request: new Request("https://camelai.test/onboarding?team=1"),
        context: {},
        params: {},
      } as never),
    ).rejects.toThrow("org summary unavailable");
  });
});
