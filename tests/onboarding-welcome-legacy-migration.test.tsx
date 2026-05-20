import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("auto-opens the legacy disclosure modal with the migration explainer", () => {
    render(<OnboardingWelcomeRoute />);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      /welcome back\. camelai is a new product now/i,
    );
    expect(dialog).toHaveTextContent(/cancel your existing subscription/i);
    expect(
      screen.getByRole("button", { name: /see plans/i }),
    ).toBeInTheDocument();
  });

  it("reveals the legacy switch-to-plan picker after dismissing the modal", async () => {
    const user = userEvent.setup();
    render(<OnboardingWelcomeRoute />);

    await user.click(screen.getByRole("button", { name: /see plans/i }));

    expect(screen.getByText("Choose your plan")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /switch to pro/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /why am i seeing this\?/i }),
    ).toBeInTheDocument();
  });

  it("reopens the disclosure modal when the picker 'Why am I seeing this?' link is clicked", async () => {
    const user = userEvent.setup();
    render(<OnboardingWelcomeRoute />);

    await user.click(screen.getByRole("button", { name: /see plans/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /why am i seeing this\?/i }),
    );

    expect(screen.getByRole("dialog")).toHaveTextContent(
      /welcome back\. camelai is a new product now/i,
    );
  });

  it("disables the picker and surfaces the support contact for accounts with multiple active subscriptions", async () => {
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
        activeLegacySubscriptionCount: 2,
        defaultPlan: "team",
      },
    });

    const user = userEvent.setup();
    render(<OnboardingWelcomeRoute />);

    await user.click(screen.getByRole("link", { name: /contact support/i }));

    expect(
      screen.getByText(
        /this account has multiple active subscriptions\. contact support@camelai\.com/i,
      ),
    ).toBeInTheDocument();
  });
});
