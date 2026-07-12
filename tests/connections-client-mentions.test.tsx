import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import ConnectionsClient from "@/components/pages/connections/connections-client";
import type { ConnectionListItem } from "@/lib/connections-shared";
import type { MentionableProject } from "@/lib/mentions";

const { writeDraftMock } = vi.hoisted(() => ({
  writeDraftMock: vi.fn(),
}));

vi.mock("@/hooks/use-auth-data", () => ({
  useAuthData: () => ({
    currentOrg: { id: "org_1" },
    currentWorkspace: { id: "ws_1" },
    orgs: [{ org_id: "org_1", role: "admin" }],
  }),
}));

vi.mock("@/hooks/use-draft-persistence", () => ({
  writeDraft: writeDraftMock,
}));

vi.mock("@/components/page-header", () => ({
  PageHeader: () => <header>Connections</header>,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("1024px"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  Object.defineProperty(window, "ResizeObserver", {
    writable: true,
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
});

function connection(overrides: Partial<ConnectionListItem> = {}): ConnectionListItem {
  return {
    id: "conn_foo",
    integration_type: "postgres",
    name: "Foo",
    category: "databases",
    auth_method: "api_key",
    config: {},
    created_by: "user_1",
    created_at: 2,
    updated_at: 2,
    has_credentials: true,
    ...overrides,
  };
}

function renderConnectionsClient({
  initialConnections,
  initialMentionProjects,
  initialEntry = "/connections?selected=conn_foo",
}: {
  initialConnections: ConnectionListItem[];
  initialMentionProjects: MentionableProject[];
  initialEntry?: string;
}) {
  const router = createMemoryRouter(
    [
      {
        path: "/connections",
        element: (
          <ConnectionsClient
            initialConnections={initialConnections}
            initialMentionProjects={initialMentionProjects}
            connectionTypes={[]}
            categories={[]}
            workspaceId="ws_1"
            workspaceEmailAddress={null}
            emailInboxEnabled={false}
            emailHandle={null}
            workspaceCreatedBy={null}
            workspaceCreatedAt={null}
          />
        ),
      },
      {
        path: "/chat",
        element: <div>Chat</div>,
      },
    ],
    { initialEntries: [initialEntry] },
  );

  const { container } = render(<RouterProvider router={router} />);
  return { router, container };
}

describe("ConnectionsClient mention slugs", () => {
  it("preserves connection slugs when displaying and seeding colliding mentions", async () => {
    const user = userEvent.setup();
    const project: MentionableProject = {
      kind: "project",
      id: "ca-ws_1-foo",
      name: "Foo",
      description: "Project with the base slug",
      created_at: 1,
      updated_at: 1,
    };

    renderConnectionsClient({
      initialConnections: [connection()],
      initialMentionProjects: [project],
    });

    expect(await screen.findByText("@foo")).toBeInTheDocument();
    expect(screen.queryByText("@foo-2")).not.toBeInTheDocument();

    const openButtons = screen.getAllByRole("button", { name: "Open in chat" });
    await user.click(openButtons[openButtons.length - 1]!);

    expect(writeDraftMock).toHaveBeenCalledWith("ws_1", null, "@foo ", []);
  });

  it("swaps selected panel content and row highlight immediately", async () => {
    const user = userEvent.setup();
    renderConnectionsClient({
      initialConnections: [
        connection({ id: "conn_foo", name: "Foo" }),
        connection({ id: "conn_bar", name: "Bar", updated_at: 3 }),
      ],
      initialMentionProjects: [],
      initialEntry: "/connections",
    });

    const fooRow = await screen.findByRole("button", { name: /Foo/ });
    const barRow = screen.getByRole("button", { name: /Bar/ });

    await user.click(fooRow);

    expect(screen.getByRole("heading", { name: "Foo" })).toBeInTheDocument();
    expect(fooRow).toHaveClass("bg-muted/70");
    expect(barRow).not.toHaveClass("bg-muted/70");

    await user.click(barRow);

    expect(screen.getByRole("heading", { name: "Bar" })).toBeInTheDocument();
    expect(barRow).toHaveClass("bg-muted/70");
    expect(fooRow).not.toHaveClass("bg-muted/70");

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("heading", { name: "Bar" })).not.toBeInTheDocument();
    expect(barRow).not.toHaveClass("bg-muted/70");
  });
});

describe("ConnectionsClient panel long-name layout", () => {
  const LONG_NAME =
    "Thread Review Dashboard API Test bearerToken Connection Example Name";

  it("keeps the panel content constrained when the connection name is long", async () => {
    const { container } = renderConnectionsClient({
      initialConnections: [connection({ name: LONG_NAME })],
      initialMentionProjects: [],
    });

    // The Radix ScrollArea content wrapper defaults to `display: table`, which
    // expands to its widest child and clips everything once a long, unbreakable
    // name forces it past the fixed panel width. The viewport override swaps it
    // back to a block pinned to the viewport width so children can truncate/wrap.
    const viewports = Array.from(
      container.querySelectorAll("[data-slot='scroll-area-viewport']"),
    );
    const panelViewport = viewports.find((node) =>
      node.className.includes("[&>div]:!block"),
    );
    expect(panelViewport).toBeTruthy();
    expect(panelViewport?.className).toContain("[&>div]:!w-full");

    // The title still truncates to a single line within the constrained width.
    const heading = await screen.findByRole("heading", { name: LONG_NAME });
    expect(heading).toHaveClass("truncate", "min-w-0", "flex-1");
    expect(heading).toHaveAttribute("title", LONG_NAME);

    // The mention pill truncates and keeps the always-visible copy button in
    // view instead of overflowing the value column (block flex, not inline-flex
    // which would shrink-to-fit and push the button off-screen).
    const copyButton = screen.getByRole("button", { name: "Copy mention" });
    const mentionRow = copyButton.parentElement;
    expect(mentionRow).toHaveClass("flex");
    expect(mentionRow).not.toHaveClass("inline-flex");
    expect(mentionRow?.querySelector("code")).toHaveClass("min-w-0", "truncate");
  });
});
