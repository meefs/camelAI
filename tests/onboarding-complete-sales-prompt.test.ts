import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

const { action } = await import("@/routes/api/onboarding.complete");

describe("onboarding complete flow", () => {
  let userStub: {
    getEmailVerificationStatus: ReturnType<typeof vi.fn>;
    updateOnboarding: ReturnType<typeof vi.fn>;
    getPendingSalesPrompt: ReturnType<typeof vi.fn>;
    clearPendingSalesPrompt: ReturnType<typeof vi.fn>;
    consumePendingSalesPrompt: ReturnType<typeof vi.fn>;
  };

  function makeCurrentOrg({
    billingStatus = "active",
    billingPlan = "starter",
    purchasedCreditsCents = 0,
    grantedCreditsCents = 0,
  }: {
    billingStatus?: string;
    billingPlan?: string;
    purchasedCreditsCents?: number;
    grantedCreditsCents?: number;
  } = {}) {
    return {
      id: "org_123",
      billing_status: billingStatus,
      billing_plan: billingPlan,
      billing_credit_purchase_total_cents: purchasedCreditsCents,
      billing_credit_grant_total_cents: grantedCreditsCents,
    };
  }

  function setAuthContext(
    overrides: Partial<Awaited<ReturnType<typeof requireAuthContextMock>>> = {},
  ) {
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", name: "Illiana Reed" },
      currentOrg: makeCurrentOrg(),
      currentOrgLlmProviderConfig: null,
      currentWorkspace: { id: "ws_123" },
      orgs: [{ org_id: "org_123" }],
      onboarding: { completed_at: null },
      ...overrides,
    });
  }

  function completeRequest(init?: RequestInit) {
    return new Request("https://camelai.dev/api/onboarding/complete", {
      method: "POST",
      ...init,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();

    userStub = {
      getEmailVerificationStatus: vi.fn().mockResolvedValue({
        required: false,
        verified: true,
      }),
      updateOnboarding: vi.fn().mockResolvedValue(undefined),
      getPendingSalesPrompt: vi.fn().mockReturnValue("Build me a CRM"),
      clearPendingSalesPrompt: vi.fn(),
      consumePendingSalesPrompt: vi.fn(),
    };

    setAuthContext();
    getAuthEnvMock.mockReturnValue({
      USER: {
        idFromName: (id: string) => id,
        get: () => userStub,
      },
    });
    getEnvMock.mockReturnValue({});
  });

  it("requires POST", async () => {
    const response = await action({
      request: completeRequest({ method: "GET" }),
      context: {},
    } as never);

    expect(response.status).toBe(405);
    expect(requireAuthContextMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Method not allowed",
    });
  });

  it("blocks completion until required email verification passes", async () => {
    userStub.getEmailVerificationStatus.mockResolvedValue({
      required: true,
      verified: false,
    });

    const response = await action({
      request: completeRequest(),
      context: {},
    } as never);

    expect(response.status).toBe(403);
    expect(userStub.updateOnboarding).not.toHaveBeenCalled();
    expect(userStub.getPendingSalesPrompt).not.toHaveBeenCalled();
    expect(userStub.clearPendingSalesPrompt).not.toHaveBeenCalled();
    expect(userStub.consumePendingSalesPrompt).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Please verify your email before completing onboarding.",
    });
  });

  it("requires a selected workspace", async () => {
    setAuthContext({ currentWorkspace: null });

    const response = await action({
      request: completeRequest(),
      context: {},
    } as never);

    expect(response.status).toBe(400);
    expect(userStub.getEmailVerificationStatus).not.toHaveBeenCalled();
    expect(userStub.updateOnboarding).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "No workspace selected",
    });
  });

  it("requires an effective provider config when choosing BYOK", async () => {
    const response = await action({
      request: completeRequest({
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessChoice: "byok" }),
      }),
      context: {},
    } as never);

    expect(response.status).toBe(400);
    expect(userStub.updateOnboarding).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Add an API key before continuing with your own provider.",
    });
  });

  it("completes onboarding with camelCode and no paid billing access", async () => {
    setAuthContext({
      currentOrg: makeCurrentOrg({
        billingStatus: "inactive",
        billingPlan: "free",
      }),
    });

    const response = await action({
      request: completeRequest(),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(userStub.updateOnboarding).toHaveBeenCalledWith({
      completed_at: expect.any(Number),
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      redirectTo: "/chat",
    });
  });

  it("marks onboarding complete for ready hosted billing and redirects to chat", async () => {
    const response = await action({
      request: completeRequest(),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(userStub.updateOnboarding).toHaveBeenCalledWith({
      completed_at: expect.any(Number),
    });
    expect(userStub.getPendingSalesPrompt).not.toHaveBeenCalled();
    expect(userStub.clearPendingSalesPrompt).not.toHaveBeenCalled();
    expect(userStub.consumePendingSalesPrompt).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      success: true,
      redirectTo: "/chat",
    });
  });

  it("marks onboarding complete for hosted credit access and redirects to chat", async () => {
    setAuthContext({
      currentOrg: makeCurrentOrg({
        billingStatus: "inactive",
        billingPlan: "payg",
        purchasedCreditsCents: 500,
      }),
    });

    const response = await action({
      request: completeRequest(),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(userStub.updateOnboarding).toHaveBeenCalledWith({
      completed_at: expect.any(Number),
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      redirectTo: "/chat",
    });
  });

  it("marks onboarding complete for enterprise orgs and redirects to chat", async () => {
    setAuthContext({
      currentOrg: makeCurrentOrg({
        billingStatus: "enterprise",
        billingPlan: "enterprise",
      }),
    });

    const response = await action({
      request: completeRequest(),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(userStub.updateOnboarding).toHaveBeenCalledWith({
      completed_at: expect.any(Number),
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      redirectTo: "/chat",
    });
  });

  it("marks onboarding complete for BYOK access and redirects to chat", async () => {
    setAuthContext({
      currentOrg: makeCurrentOrg({
        billingStatus: "inactive",
        billingPlan: "free",
      }),
      currentOrgLlmProviderConfig: { provider: "openai" },
    });

    const response = await action({
      request: completeRequest({
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessChoice: "byok" }),
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(userStub.updateOnboarding).toHaveBeenCalledWith({
      completed_at: expect.any(Number),
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      redirectTo: "/chat",
    });
  });

  it("returns chat for already-completed onboarding without updating or recovering a thread", async () => {
    setAuthContext({
      onboarding: { completed_at: Date.now() },
    });

    const response = await action({
      request: completeRequest(),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(userStub.updateOnboarding).not.toHaveBeenCalled();
    expect(userStub.getPendingSalesPrompt).not.toHaveBeenCalled();
    expect(userStub.clearPendingSalesPrompt).not.toHaveBeenCalled();
    expect(userStub.consumePendingSalesPrompt).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      success: true,
      redirectTo: "/chat",
    });
  });
});
