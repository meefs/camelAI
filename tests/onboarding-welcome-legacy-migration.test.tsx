import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useLoaderDataMock = vi.fn();
const useOutletContextMock = vi.fn();

vi.mock("react-router", async () => {
  const actual =
    await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLoaderData: useLoaderDataMock,
    useOutletContext: useOutletContextMock,
    useFetcher: () => ({
      state: "idle",
      data: undefined,
      formData: undefined,
      submit: vi.fn(),
      Form: ({ children }: { children: ReactNode }) => <form>{children}</form>,
    }),
  };
});

const { default: OnboardingWelcomeRoute } =
  await import("@/routes/_onboarding.welcome");

describe("OnboardingWelcomeRoute legacy migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLoaderDataMock.mockReturnValue({
      orgId: "org_123",
      orgName: "camelAI",
      teamContext: {
        memberCount: 0,
        appCount: 0,
        integrations: [],
      },
      trialAvailable: false,
    });
    useOutletContextMock.mockReturnValue({
      completeOnboarding: vi.fn(),
      skipToChat: vi.fn(),
      teamMode: false,
      onboardingComplete: true,
      billingAccessReady: false,
      userEmail: "legacy@example.com",
      emailVerificationRequired: false,
      emailVerified: true,
      legacyMigration: {
        eligible: true,
        customerId: "cus_123",
        activeLegacySubscriptionCount: 1,
        defaultPlan: "pro",
      },
    });
  });

  it("puts legacy migration directly on the paywall before the normal plan picker", () => {
    render(<OnboardingWelcomeRoute />);

    const prompt = screen.getByRole("dialog", {
      name: "Move your legacy subscription to camelAI",
    });
    expect(prompt.className).not.toContain("fixed");
    expect(screen.getByText("Choose your plan")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /switch to pro/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /dismiss legacy subscription migration/i,
      }),
    ).not.toBeInTheDocument();
  });
});
