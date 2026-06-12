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
}: {
  initialConnections: ConnectionListItem[];
  initialMentionProjects: MentionableProject[];
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
            orgId="org_1"
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
    { initialEntries: ["/connections?selected=conn_foo"] },
  );

  render(<RouterProvider router={router} />);
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
});
