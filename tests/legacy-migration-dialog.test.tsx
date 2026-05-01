import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LegacyMigrationDialog } from "@/components/billing/legacy-migration-dialog";

describe("LegacyMigrationDialog", () => {
  it("renders nothing for users who are not eligible", () => {
    render(
      <LegacyMigrationDialog
        migration={null}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(
      screen.queryByText(/welcome back/i),
    ).not.toBeInTheDocument();
  });

  it("renders the disclosure modal for a single active legacy subscription", () => {
    render(
      <LegacyMigrationDialog
        migration={{
          eligible: true,
          customerId: "cus_123",
          activeLegacySubscriptionCount: 1,
          defaultPlan: "pro",
        }}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(
      screen.getByText(/welcome back\. camelai is a new product now/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/cancel your existing subscription/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/unused legacy subscription credit/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/prevent the old subscription from renewing/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/existing subscriber/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/one switch, no double billing/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /app\.camelai\.com/i }),
    ).toHaveAttribute("href", "https://app.camelai.com");
    expect(
      screen.getByRole("button", { name: /see plans/i }),
    ).toBeInTheDocument();
  });

  it("invokes the supplied primary action when provided", async () => {
    const user = userEvent.setup();
    const handlePrimary = vi.fn();

    render(
      <LegacyMigrationDialog
        migration={{
          eligible: true,
          customerId: "cus_123",
          activeLegacySubscriptionCount: 1,
          defaultPlan: "pro",
        }}
        open
        onOpenChange={() => {}}
        primaryAction={{ label: "Go to billing", onClick: handlePrimary }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /go to billing/i }));

    expect(handlePrimary).toHaveBeenCalledTimes(1);
  });

  it("closes the modal when the default primary action is clicked", async () => {
    const user = userEvent.setup();
    const handleOpenChange = vi.fn();

    render(
      <LegacyMigrationDialog
        migration={{
          eligible: true,
          customerId: "cus_123",
          activeLegacySubscriptionCount: 1,
          defaultPlan: "pro",
        }}
        open
        onOpenChange={handleOpenChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /see plans/i }));

    expect(handleOpenChange).toHaveBeenCalledWith(false);
  });

  it("routes multiple legacy subscriptions to manual migration", () => {
    render(
      <LegacyMigrationDialog
        migration={{
          eligible: true,
          customerId: "cus_123",
          activeLegacySubscriptionCount: 2,
          defaultPlan: "team",
        }}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(
      screen.getByText(/let's migrate this one manually/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /contact support/i }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("mailto:support@camelai.com"),
    );
    expect(
      screen.queryByRole("button", { name: /see plans/i }),
    ).not.toBeInTheDocument();
  });
});
