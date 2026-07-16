import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  BillingDialogPresenceProvider,
  useBillingDialogPresence,
} from "@/hooks/use-billing-dialog-presence";

function PresenceProbe() {
  const { isSidebarBillingDialogOpen, setSidebarBillingDialogOpen } =
    useBillingDialogPresence();

  return (
    <>
      <output>{isSidebarBillingDialogOpen ? "open" : "closed"}</output>
      <button
        type="button"
        onClick={() => setSidebarBillingDialogOpen(true)}
      >
        Open sidebar billing
      </button>
      <button
        type="button"
        onClick={() => setSidebarBillingDialogOpen(false)}
      >
        Close sidebar billing
      </button>
    </>
  );
}

describe("BillingDialogPresenceProvider", () => {
  it("shares sidebar billing-dialog presence with Chat consumers", async () => {
    const user = userEvent.setup();
    render(
      <BillingDialogPresenceProvider>
        <PresenceProbe />
      </BillingDialogPresenceProvider>,
    );

    expect(screen.getByText("closed")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Open sidebar billing" }),
    );
    expect(screen.getByText("open")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Close sidebar billing" }),
    );
    expect(screen.getByText("closed")).toBeInTheDocument();
  });
});
