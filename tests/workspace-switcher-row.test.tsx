import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WorkspaceSwitcherWorkspaceRowText } from "@/components/sidebar/workspace-switcher";

function getOrgLine(container: HTMLElement) {
  const orgLine = container.querySelector(
    '[data-slot="workspace-switcher-org-line"]',
  );
  expect(orgLine).toBeInTheDocument();
  expect(orgLine).toHaveClass("h-4");
  return orgLine as HTMLElement;
}

describe("WorkspaceSwitcherWorkspaceRowText", () => {
  it("renders the workspace name and org name when available", () => {
    const { container } = render(
      <WorkspaceSwitcherWorkspaceRowText
        workspaceName="Production"
        orgName="Camel AI"
        isOrgNameLoading={false}
      />,
    );

    const orgLine = getOrgLine(container);
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText("Camel AI")).toBeInTheDocument();
    expect(orgLine.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("reserves the org line and shows a skeleton while org names load", () => {
    const { container } = render(
      <WorkspaceSwitcherWorkspaceRowText
        workspaceName="Production"
        orgName={null}
        isOrgNameLoading
      />,
    );

    const orgLine = getOrgLine(container);
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(orgLine.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
  });

  it("reserves the org line when org names loaded but this name is missing", () => {
    const { container } = render(
      <WorkspaceSwitcherWorkspaceRowText
        workspaceName="Production"
        orgName={null}
        isOrgNameLoading={false}
      />,
    );

    const orgLine = getOrgLine(container);
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(orgLine).toBeEmptyDOMElement();
  });
});
