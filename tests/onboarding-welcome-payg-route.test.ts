import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSessionMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const getOrgOnboardingWelcomeContextMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  getAuthEnv: getAuthEnvMock,
  requireSession: requireSessionMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-do", () => ({
  getOrgOnboardingWelcomeContext: getOrgOnboardingWelcomeContextMock,
}));

const { loader } = await import("@/routes/_onboarding.welcome");

describe("OnboardingWelcomeRoute loader", () => {
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
  });

  it("returns only rendered data without loading Stripe or provider context", async () => {
    const result = await loader({
      request: new Request("https://camelai.test/onboarding"),
      context: {},
      params: {},
    } as never);

    expect(getEnvMock).not.toHaveBeenCalled();
    expect(getAuthEnvMock).not.toHaveBeenCalled();
    expect(getOrgOnboardingWelcomeContextMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      orgName: "camelAI",
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

    expect(getOrgOnboardingWelcomeContextMock).toHaveBeenCalledWith(
      { auth: true },
      "org_123",
      "ws_123",
    );
    expect(result).toEqual({
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
