import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  fetcherSubmit: vi.fn(),
  loaderData: {
    current: {
      orgId: "org_123",
      orgName: "camelAI",
      teamContext: {
        memberCount: 0,
        appCount: 0,
        integrations: [],
      },
      byokProviderLabel: null,
      stripeConfigured: true,
      creditPacks: [
        {
          id: "price_credit_1000",
          creditsLabel: "10.00 credits",
          priceLabel: "$10.00",
        },
      ],
    },
  },
  outletContext: {
    current: {
      completeOnboarding: vi.fn(),
      skipToChat: vi.fn(),
      teamMode: false,
      onboardingComplete: false,
      billingAccessReady: false,
      userEmail: "new@example.com",
      emailVerificationRequired: false,
      emailVerified: true,
      legacyMigration: null,
    },
  },
}));

vi.mock("react-router", async () => {
  const actual =
    await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    Form: (props: React.ComponentProps<"form">) => <form {...props} />,
    useLoaderData: () => testState.loaderData.current,
    useOutletContext: () => testState.outletContext.current,
    useFetcher: () => ({
      state: "idle",
      data: undefined,
      formData: undefined,
      submit: testState.fetcherSubmit,
      Form: ({ children }: { children: ReactNode }) => <form>{children}</form>,
    }),
  };
});

const { default: OnboardingWelcomeRoute } =
  await import("@/routes/_onboarding.welcome");

describe("OnboardingWelcomeRoute Pay as you go", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the Pay as you go choice dialog before starting hosted credits", async () => {
    const user = userEvent.setup();
    render(<OnboardingWelcomeRoute />);

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      screen.getByRole("dialog", { name: /continue with pay as you go/i }),
    ).toBeInTheDocument();
    expect(testState.fetcherSubmit).not.toHaveBeenCalled();
  });

  it("opens the API key dialog from the Pay as you go choice", async () => {
    const user = userEvent.setup();
    render(<OnboardingWelcomeRoute />);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(
      screen.getByRole("button", { name: /bring your own api key/i }),
    );

    expect(
      screen.getByRole("dialog", { name: /add your api key/i }),
    ).toBeInTheDocument();
    expect(testState.fetcherSubmit).not.toHaveBeenCalled();
  });

  it("opens credit pack selection from the Pay as you go choice", async () => {
    const user = userEvent.setup();
    render(<OnboardingWelcomeRoute />);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: /purchase credits/i }));

    expect(
      screen.getByRole("dialog", { name: /top up credits/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("10.00 credits")).toBeInTheDocument();
    expect(screen.getByText("$10.00")).toBeInTheDocument();
    expect(testState.fetcherSubmit).not.toHaveBeenCalled();
  });
});
