import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  fetcherSubmit: vi.fn(),
  loaderData: {
    current: {
      orgName: "camelAI",
      teamContext: {
        memberCount: 0,
        appCount: 0,
        integrations: [],
      },
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

describe("OnboardingWelcomeRoute free onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.outletContext.current.completeOnboarding.mockResolvedValue(
      undefined,
    );
  });

  it("continues directly to chat without a billing choice", async () => {
    const user = userEvent.setup();
    render(<OnboardingWelcomeRoute />);

    await user.click(
      screen.getByRole("button", { name: "Continue to chat" }),
    );

    expect(testState.outletContext.current.completeOnboarding).toHaveBeenCalledTimes(1);
    expect(testState.fetcherSubmit).not.toHaveBeenCalled();
    expect(screen.queryByText("Pay as you go")).not.toBeInTheDocument();
    expect(screen.queryByText("Bring your own API key")).not.toBeInTheDocument();
  });
});
