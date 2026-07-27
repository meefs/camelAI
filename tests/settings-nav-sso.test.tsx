import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { SettingsNav } from "@/components/settings/settings-nav";

describe("settings navigation SSO access", () => {
  it("shows SSO to an organization admin who is not the owner", () => {
    render(
      <MemoryRouter initialEntries={["/settings/organization/sso"]}>
        <SettingsNav isOrgAdmin isOrgOwner={false} selfhostRuntime={false} />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("link", { name: "SSO" })).not.toHaveLength(0);
  });

  it("hides SSO from regular organization members", () => {
    render(
      <MemoryRouter initialEntries={["/settings/profile"]}>
        <SettingsNav
          isOrgAdmin={false}
          isOrgOwner={false}
          selfhostRuntime={false}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("link", { name: "SSO" })).toBeNull();
  });
});
