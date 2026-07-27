import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { CamelCodePickerAlert } from "@/components/camel-code-picker-alert";

function renderAlert(isOrgAdmin: boolean) {
  return render(
    <MemoryRouter>
      <CamelCodePickerAlert
        isOrgAdmin={isOrgAdmin}
        settingsHref="/settings/organization/models?scope=ws&workspaceId=ws_123"
      />
    </MemoryRouter>,
  );
}

describe("CamelCodePickerAlert", () => {
  it("uses the existing alert and slotted button styles for admins", () => {
    renderAlert(true);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Premium models are paused")).toBeInTheDocument();
    expect(
      screen.getByText("Add camelCode to this picker to continue for free."),
    ).toBeInTheDocument();

    const settingsLink = screen.getByRole("link", {
      name: "Open model settings",
    });
    expect(settingsLink).toHaveAttribute(
      "href",
      "/settings/organization/models?scope=ws&workspaceId=ws_123",
    );
    expect(settingsLink).toHaveAttribute("data-slot", "button");
    expect(settingsLink.closest("button")).toBeNull();
  });

  it("directs members to an admin without showing an inaccessible link", () => {
    renderAlert(false);

    expect(
      screen.getByText(
        "Ask an organization admin to add camelCode to this picker.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open model settings" }),
    ).not.toBeInTheDocument();
  });
});
