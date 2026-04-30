import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyMigrationDialog } from "@/components/billing/legacy-migration-dialog";

let fetcherState: "idle" | "submitting" = "idle";
let fetcherData: { success?: boolean; error?: string } | undefined = undefined;
let fetcherFormData: FormData | undefined = undefined;
const submitMock = vi.fn();

vi.mock("react-router", async () => {
  const actual =
    await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({
      state: fetcherState,
      data: fetcherData,
      formData: fetcherFormData,
      submit: submitMock,
    }),
  };
});

describe("LegacyMigrationDialog", () => {
  beforeEach(() => {
    fetcherState = "idle";
    fetcherData = undefined;
    fetcherFormData = undefined;
    submitMock.mockReset();
    submitMock.mockImplementation((payload: Record<string, string>) => {
      fetcherState = "submitting";
      fetcherFormData = new FormData();
      for (const [key, value] of Object.entries(payload)) {
        fetcherFormData.set(key, value);
      }
    });
  });

  it("renders nothing for users who are not eligible", () => {
    render(<LegacyMigrationDialog migration={null} />);

    expect(
      screen.queryByText("Move your legacy subscription to camelAI"),
    ).not.toBeInTheDocument();
  });

  it("submits the selected v2 plan without starting a new login flow", async () => {
    const user = userEvent.setup();

    render(
      <LegacyMigrationDialog
        migration={{
          eligible: true,
          customerId: "cus_123",
          activeLegacySubscriptionCount: 1,
          defaultPlan: "pro",
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /switch to pro/i }));

    expect(submitMock).toHaveBeenCalledWith(
      { plan: "pro" },
      {
        method: "post",
        action: "/api/billing/legacy-migration",
      },
    );
  });

  it("does not block other app menus while visible", async () => {
    const user = userEvent.setup();
    const menuClick = vi.fn();

    render(
      <>
        <button type="button" onClick={menuClick}>
          Workspace menu
        </button>
        <LegacyMigrationDialog
          migration={{
            eligible: true,
            customerId: "cus_123",
            activeLegacySubscriptionCount: 1,
            defaultPlan: "pro",
          }}
        />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Workspace menu" }));

    expect(menuClick).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Move your legacy subscription to camelAI"),
    ).toBeInTheDocument();
  });

  it("renders embedded in the paywall without a dismiss control", () => {
    render(
      <LegacyMigrationDialog
        variant="embedded"
        migration={{
          eligible: true,
          customerId: "cus_123",
          activeLegacySubscriptionCount: 1,
          defaultPlan: "pro",
        }}
      />,
    );

    const prompt = screen.getByRole("dialog", {
      name: "Move your legacy subscription to camelAI",
    });
    expect(prompt.className).not.toContain("fixed");
    expect(
      screen.queryByRole("button", {
        name: /dismiss legacy subscription migration/i,
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Recommended:\s*Pro/i)).toBeInTheDocument();
  });

  it("routes multiple legacy subscriptions to manual migration", () => {
    render(
      <LegacyMigrationDialog
        variant="embedded"
        migration={{
          eligible: true,
          customerId: "cus_123",
          activeLegacySubscriptionCount: 2,
          defaultPlan: "team",
        }}
      />,
    );

    expect(
      screen.getByText(/multiple active legacy subscriptions/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /contact us/i })).toHaveAttribute(
      "href",
      expect.stringContaining("mailto:support@camelai.com"),
    );
    expect(
      screen.queryByRole("button", { name: /switch to team/i }),
    ).not.toBeInTheDocument();
  });
});
