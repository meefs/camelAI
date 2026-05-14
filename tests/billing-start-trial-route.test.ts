import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const getEnvMock = vi.fn();
const createSubscriptionCheckoutSessionMock = vi.fn();
const getBillableTeamSeatCountForOrgMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/billing.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing.server")>();
  return {
    ...actual,
    createSubscriptionCheckoutSession: createSubscriptionCheckoutSessionMock,
    getBillableTeamSeatCountForOrg: getBillableTeamSeatCountForOrgMock,
  };
});

const { action } = await import("@/routes/api/billing.start-trial");

describe("billing start-trial route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({ STRIPE_MODE: "test" });
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: {
        id: "org_123",
        name: "Org",
        slug: "org",
        billing_status: "inactive",
        billing_plan: "free",
      },
    });
    createSubscriptionCheckoutSessionMock.mockResolvedValue(
      "https://billing.stripe.test/checkout",
    );
    getBillableTeamSeatCountForOrgMock.mockResolvedValue(3);
  });

  it("creates checkout with chat return URLs for the takeover flow", async () => {
    const formData = new FormData();
    formData.set("plan", "team");

    const response = await action({
      request: new Request("https://camelai.test/api/billing/start-trial", {
        method: "POST",
        body: formData,
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      checkoutUrl: "https://billing.stripe.test/checkout",
    });
    expect(getBillableTeamSeatCountForOrgMock).toHaveBeenCalledWith(
      { STRIPE_MODE: "test" },
      "org_123",
    );
    expect(createSubscriptionCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customerEmail: "owner@example.com",
        successUrl: "https://camelai.test/chat?checkout=success",
        cancelUrl: "https://camelai.test/chat?checkout=cancelled",
        plan: "team",
        seatCount: 3,
      }),
    );
  });

  it("rejects non-trial plans", async () => {
    const formData = new FormData();
    formData.set("plan", "free");

    const response = await action({
      request: new Request("https://camelai.test/api/billing/start-trial", {
        method: "POST",
        body: formData,
      }),
      context: {},
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Choose Starter, Pro, or Team to start a trial.",
    });
    expect(createSubscriptionCheckoutSessionMock).not.toHaveBeenCalled();
  });
});
