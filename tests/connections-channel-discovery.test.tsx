import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import ConnectionsClient from "@/components/pages/connections/connections-client";
import {
  getIntegrationDefinition,
  type IntegrationDefinition,
} from "@/lib/integration-registry";
import type { ConnectionListItem } from "@/lib/connections-shared";

const authState = vi.hoisted(() => ({ role: "admin" }));

vi.mock("@/hooks/use-auth-data", () => ({
  useAuthData: () => ({
    currentOrg: { id: "org_1" },
    currentWorkspace: { id: "ws_1" },
    orgs: [{ org_id: "org_1", role: authState.role }],
  }),
}));

vi.mock("@/hooks/use-draft-persistence", () => ({
  writeDraft: vi.fn(),
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

beforeEach(() => {
  authState.role = "admin";
  window.localStorage.clear();
});

function definitions(types: string[]): IntegrationDefinition[] {
  return types.map((type) => {
    const definition = getIntegrationDefinition(type);
    if (!definition) throw new Error(`Missing integration definition: ${type}`);
    return definition;
  });
}

function connection(
  overrides: Partial<ConnectionListItem> = {},
): ConnectionListItem {
  return {
    id: "slack_1",
    integration_type: "slack",
    name: "Camel Slack",
    category: "communication",
    auth_method: "oauth2",
    config: {},
    created_by: "user_1",
    created_at: 2,
    updated_at: 2,
    has_credentials: true,
    ...overrides,
  };
}

function renderConnections({
  connectionTypes = definitions([
    "slack",
    "telegram",
    "discord_channel",
    "sendgrid",
  ]),
  initialConnections = [],
}: {
  connectionTypes?: IntegrationDefinition[];
  initialConnections?: ConnectionListItem[];
} = {}) {
  const router = createMemoryRouter(
    [
      {
        path: "/connections",
        element: (
          <ConnectionsClient
            initialConnections={initialConnections}
            initialMentionProjects={[]}
            connectionTypes={connectionTypes}
            categories={["communication"]}
            workspaceId="ws_1"
            workspaceEmailAddress="camel@example.com"
            emailInboxEnabled
            emailHandle="camel"
            workspaceCreatedBy="user_1"
            workspaceCreatedAt={1}
          />
        ),
      },
    ],
    { initialEntries: ["/connections"] },
  );

  return {
    router,
    ...render(<RouterProvider router={router} />),
  };
}

describe("connections channel picker", () => {
  it("shows only available channels plus the included Email item", async () => {
    const user = userEvent.setup();
    const { router } = renderConnections();

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    const dialog = screen.getByRole("dialog");
    const allPanel = within(dialog).getByRole("tabpanel");
    expect(within(allPanel).getAllByText("Channel")).toHaveLength(3);

    await user.click(within(dialog).getByRole("tab", { name: "Channels" }));
    const channelPanel = within(dialog).getByRole("tabpanel");
    expect(within(channelPanel).getAllByRole("button")).toHaveLength(4);
    expect(within(channelPanel).getByText("Slack")).toBeInTheDocument();
    expect(within(channelPanel).getByText("Telegram")).toBeInTheDocument();
    expect(within(channelPanel).getByText("Discord")).toBeInTheDocument();
    expect(within(channelPanel).getByText("Email")).toBeInTheDocument();
    expect(
      within(channelPanel).getByText("Included with every workspace"),
    ).toBeInTheDocument();
    expect(within(channelPanel).queryByText("SendGrid")).not.toBeInTheDocument();
    expect(within(channelPanel).getAllByText("Channel")).toHaveLength(3);

    await user.click(within(channelPanel).getByRole("button", { name: /Email/ }));
    await waitFor(() => expect(router.state.location.search).toBe("?selected=email"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not advertise Discord when its integration type is unavailable", async () => {
    const user = userEvent.setup();
    renderConnections({
      connectionTypes: definitions(["slack", "telegram", "sendgrid"]),
    });

    await user.click(screen.getByRole("button", { name: "Add connection" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("tab", { name: "Channels" }));
    const channelPanel = within(dialog).getByRole("tabpanel");

    expect(within(channelPanel).getByText("Slack")).toBeInTheDocument();
    expect(within(channelPanel).getByText("Telegram")).toBeInTheDocument();
    expect(within(channelPanel).getByText("Email")).toBeInTheDocument();
    expect(within(channelPanel).queryByText("Discord")).not.toBeInTheDocument();
  });
});

describe("channel connection suggestions", () => {
  it("shows available unconnected channels and persists dismissals per workspace", async () => {
    const user = userEvent.setup();
    const firstRender = renderConnections();

    expect(
      await screen.findByRole("button", { name: "Connect Slack" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect Telegram" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect Discord" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Hide Telegram suggestion" }),
    );
    expect(
      screen.queryByRole("button", { name: "Connect Telegram" }),
    ).not.toBeInTheDocument();
    expect(
      JSON.parse(
        window.localStorage.getItem(
          "camelai.connections.channel-suggestions.ws_1",
        ) ?? "[]",
      ),
    ).toEqual(["telegram"]);

    firstRender.unmount();
    renderConnections();
    expect(
      await screen.findByRole("button", { name: "Connect Slack" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect Telegram" }),
    ).not.toBeInTheDocument();
  });

  it("introduces the Discord flow before the security acknowledgement", async () => {
    const user = userEvent.setup();
    renderConnections();

    await user.click(
      await screen.findByRole("button", { name: "Connect Discord" }),
    );
    const dialog = screen.getByRole("dialog");
    const introduction = within(dialog).getByText(
      "You'll choose a Discord server, then return here to select one text channel.",
    );
    const securityTitle = within(dialog).getByText(
      "Discord members can instruct this workspace",
    );
    const acknowledgement = within(dialog).getByRole("checkbox");

    expect(
      introduction.compareDocumentPosition(securityTitle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      securityTitle.compareDocumentPosition(acknowledgement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Add Camel to Discord" }),
    ).toBeDisabled();
  });

  it("hides suggestions for connected, gated, searched, and non-admin channels", async () => {
    const user = userEvent.setup();
    const firstRender = renderConnections({
      connectionTypes: definitions(["slack", "telegram"]),
      initialConnections: [connection()],
    });

    expect(
      await screen.findByRole("button", { name: "Connect Telegram" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect Slack" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect Discord" }),
    ).not.toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText("Search connections..."),
      "telegram",
    );
    expect(
      screen.queryByRole("button", { name: "Connect Telegram" }),
    ).not.toBeInTheDocument();

    firstRender.unmount();
    authState.role = "member";
    renderConnections();
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Connect Slack" }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Add connection" }),
    ).not.toBeInTheDocument();
  });
});

describe("channel row attention badges", () => {
  it("marks unfinished Discord setup and names reinstall consistently", async () => {
    const user = userEvent.setup();
    renderConnections({
      initialConnections: [
        connection({
          id: "discord_1",
          integration_type: "discord_channel",
          name: "Camel HQ",
          config: {
            guild_name: "Camel HQ",
            status: "pending_channel",
          },
        }),
      ],
    });

    expect(await screen.findByText("Finish setup")).toBeInTheDocument();
    const moreButtons = screen.getAllByRole("button", { name: "More" });
    await user.click(moreButtons.at(-1)!);
    expect(
      screen.getByRole("menuitem", { name: "Reinstall bot" }),
    ).toBeInTheDocument();
  });
});
