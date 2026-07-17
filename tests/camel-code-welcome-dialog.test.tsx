import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CamelCodeWelcomeDialog } from "@/components/camel-code-welcome-dialog";

vi.mock("@/components/wave-ribbon", () => ({
  WaveRibbon: () => null,
}));

describe("CamelCodeWelcomeDialog", () => {
  it("renders camelCode throughout the welcome copy", () => {
    render(
      <CamelCodeWelcomeDialog
        open
        onOpenChange={vi.fn()}
        onSeePremiumModels={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "You're on camelCode" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/self-hosted model, camelCode/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/priority access to camelCode/),
    ).toBeInTheDocument();
  });
});
