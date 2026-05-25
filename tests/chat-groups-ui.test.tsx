import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import {
  ChatTabBar,
  MAX_OPEN_CHAT_TABS_PER_GROUP,
  RenameGroupDialog,
  TabRightSlot,
} from "@/components/chat-tab-bar";
import {
  ChatGroupCollapsedIcon,
  ChatGroupRightSlot,
  ChatGroupsList,
  CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
} from "@/components/sidebar/chat-groups-list";
import {
  applyLiveRunningStatuses,
  ChatGroupsProvider,
  getThreadIdsRequiringSnapshotRevalidation,
  getCloseGroupRedirect,
  getGroupLandingHref,
  hasPendingCompletionSummaries,
  mergeLiveAndLocalThreadStatuses,
  mergeActiveChatGroup,
  reconcileLocalThreadStatusesWithSnapshot,
  reconcileThreadSummaryPatchesWithGroups,
  shouldMarkActiveIdleThreadViewed,
  shouldMarkActiveUnreadThreadViewed,
  shouldRevalidateThreadStatusUpdate,
  useChatGroups,
} from "@/hooks/use-chat-groups";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { ChatGroup, ChatGroupThreadSummary, ChatGroupView } from "@/types";

const moveGroups: ChatGroup[] = [
  {
    id: "group_1",
    org_id: "org_1",
    workspace_id: "workspace_1",
    name: "Launch",
    last_active_thread_id: null,
    created_at: 1,
    updated_at: 1,
  },
];

function makeThreadSummary(
  overrides: Partial<ChatGroupThreadSummary> &
    Pick<ChatGroupThreadSummary, "id" | "title">,
): ChatGroupThreadSummary {
  const updatedAt = overrides.updated_at ?? 1;
  return {
    model: "haiku",
    updated_at: updatedAt,
    status: "idle",
    membership: "open",
    last_active_at: updatedAt,
    latest_user_message: null,
    latest_user_message_at: null,
    running_activity_text: null,
    running_activity_at: null,
    last_assistant_completed_at: null,
    last_assistant_summary: null,
    last_assistant_summary_status: null,
    running_started_at: null,
    ...overrides,
  };
}

const groupView: ChatGroupView = {
  ...moveGroups[0],
  open_thread_ids: ["thread_1"],
  closed_thread_ids: [],
  open_threads: [
    makeThreadSummary({
      id: "thread_1",
      title: "API plan",
      updated_at: 1,
      status: "idle",
    }),
  ],
  closed_threads: [],
  member_count: 1,
  status: "idle",
};

const multiChatGroupView: ChatGroupView = {
  ...groupView,
  id: "group_multi",
  open_thread_ids: ["thread_1", "thread_2"],
  open_threads: [
    ...groupView.open_threads,
    makeThreadSummary({
      id: "thread_2",
      title: "UI polish",
      updated_at: 2,
      status: "idle",
    }),
  ],
  member_count: 2,
};

function groupViewWithThreadRevision(
  title: string,
  updatedAt: number,
): ChatGroupView {
  return {
    ...groupView,
    open_threads: [
      {
        ...groupView.open_threads[0],
        title,
        updated_at: updatedAt,
      },
    ],
  };
}

function ChatGroupsProviderProbe({ threadId = "thread_1" }: { threadId?: string }) {
  const { groups } = useChatGroups();
  const thread = groups
    .flatMap((group) => [...group.open_threads, ...group.closed_threads])
    .find((candidate) => candidate.id === threadId);
  return (
    <div data-testid="thread-title">
      {thread?.title ?? ""}
    </div>
  );
}

function authLoaderState(chatGroups: ChatGroupView[]) {
  return {
    authState: {
      user: { id: "user_1" },
      currentWorkspace: { id: "workspace_1" },
      currentOrg: { id: "org_1" },
      orgs: [],
    },
    chatGroups,
  };
}

class MockStatusWebSocket {
  static instances: MockStatusWebSocket[] = [];

  readonly url: string;
  readonly listeners = new Map<string, Set<(event: MessageEvent | Event) => void>>();

  constructor(url: string) {
    this.url = url;
    MockStatusWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent | Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    for (const listener of this.listeners.get("close") ?? []) {
      listener(new Event("close"));
    }
  }

  emit(payload: unknown) {
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    for (const listener of this.listeners.get("message") ?? []) {
      listener(event);
    }
  }
}

beforeEach(() => {
  MockStatusWebSocket.instances = [];
  window.localStorage.removeItem(CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY);
  window.localStorage.removeItem(
    "camelai:close-chat-group-confirmation-suppressed",
  );
});

function renderTabBar(overrides: Partial<React.ComponentProps<typeof ChatTabBar>> = {}) {
  const props: React.ComponentProps<typeof ChatTabBar> = {
    groupId: "group_1",
    groupName: "Launch",
    openTabs: [
      { threadId: "thread_1", title: "API plan", model: "haiku", status: "idle" },
      {
        threadId: "thread_2",
        title: "UI polish",
        model: "haiku",
        status: "running",
      },
    ],
    closedTabs: [
      {
        threadId: "thread_3",
        title: "Archived idea",
        model: "haiku",
        status: "idle",
      },
    ],
    activeThreadId: "thread_1",
    moveGroups,
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onRenameTab: vi.fn(),
    onReorderTabs: vi.fn(),
    onNewTab: vi.fn(),
    onReopenClosedTab: vi.fn(),
    onRenameGroup: vi.fn(),
    onMoveTabToGroup: vi.fn(),
    ...overrides,
  };

  const result = render(
    <MemoryRouter>
      <SidebarProvider>
        <ChatTabBar {...props} />
      </SidebarProvider>
    </MemoryRouter>,
  );
  return { ...props, ...result };
}

describe("ChatTabBar", () => {
  it("selects existing tabs and opens a new tab", () => {
    const onSelectTab = vi.fn();
    const onNewTab = vi.fn();
    renderTabBar({ onSelectTab, onNewTab });

    fireEvent.click(screen.getByRole("button", { name: "Open UI polish" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat in this group" }));

    expect(onSelectTab).toHaveBeenCalledWith("thread_2");
    expect(onNewTab).toHaveBeenCalledTimes(1);
  });

  it("soft-disables new tabs at ten open chats without a tooltip", async () => {
    const user = userEvent.setup();
    const onNewTab = vi.fn();
    renderTabBar({
      onNewTab,
      openTabs: Array.from({ length: MAX_OPEN_CHAT_TABS_PER_GROUP }, (_, index) => ({
        threadId: `thread_${index + 1}`,
        title: `Open chat ${index + 1}`,
        model: "haiku",
        status: "idle",
      })),
      closedTabs: [
        {
          threadId: "thread_closed",
          title: "Archived idea",
          model: "haiku",
          status: "idle",
        },
      ],
      activeThreadId: "thread_1",
    });

    const newChatButton = screen.getByRole("button", {
      name: "New chat in this group",
    });
    expect(newChatButton).toBeDisabled();
    expect(newChatButton).toHaveClass("disabled:pointer-events-none");

    await user.hover(newChatButton);
    expect(screen.queryByText("New chat")).not.toBeInTheDocument();
    await user.click(newChatButton);
    expect(onNewTab).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Closed chat tabs" }));
    expect(await screen.findByText("Archived idea")).toBeInTheDocument();
  });

  it("reopens closed tabs from the overflow menu", async () => {
    const onReopenClosedTab = vi.fn();
    renderTabBar({ onReopenClosedTab });

    fireEvent.click(screen.getByRole("button", { name: "Closed chat tabs" }));
    fireEvent.click(await screen.findByText("Archived idea"));

    expect(onReopenClosedTab).toHaveBeenCalledWith("thread_3");
  });

  it("closes the move-to-group context submenu immediately after selecting a group", async () => {
    const onMoveTabToGroup = vi.fn();
    renderTabBar({
      onMoveTabToGroup,
      moveGroups: [
        ...moveGroups,
        {
          id: "group_2",
          org_id: "org_1",
          workspace_id: "workspace_1",
          name: "Research",
          last_active_thread_id: null,
          created_at: 2,
          updated_at: 2,
        },
      ],
    });

    fireEvent.contextMenu(screen.getByRole("button", { name: "Open API plan" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to group" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Research" }));

    expect(onMoveTabToGroup).toHaveBeenCalledWith("thread_1", "group_2");
    expect(screen.queryByRole("menuitem", { name: "Research" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Move to group" })).not.toBeInTheDocument();
  });

  it("renders stable right slots for idle, running, and unread tabs", () => {
    const { rerender } = render(<TabRightSlot status="idle" model="haiku" />);
    expect(screen.getByAltText("claude")).toBeInTheDocument();

    rerender(<TabRightSlot status="running" model="haiku" />);
    expect(screen.getByLabelText("Agent is working")).toHaveClass("animate-spin");

    rerender(<TabRightSlot status="unread" model="haiku" />);
    expect(screen.getByLabelText("Awaiting your review")).toHaveClass("bg-red-500");
  });

  it("allows spaces while renaming a chat tab", () => {
    renderTabBar();

    fireEvent.click(screen.getByLabelText("Rename API plan"));
    const input = screen.getByDisplayValue("API plan");
    fireEvent.keyDown(input, { key: " ", code: "Space" });
    fireEvent.change(input, { target: { value: "API plan v2" } });

    expect(input).toHaveValue("API plan v2");
  });

  it("focuses the rename input when renaming from the context menu", async () => {
    const user = userEvent.setup();
    renderTabBar();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Open API plan" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename chat" }));

    const input = await screen.findByDisplayValue("API plan");
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("never renders the active tab as unread", () => {
    renderTabBar({
      activeThreadId: "thread_1",
      openTabs: [
        {
          threadId: "thread_1",
          title: "API plan",
          model: "haiku",
          status: "unread",
        },
      ],
      closedTabs: [],
    });

    const tab = screen.getByRole("button", { name: "Open API plan" });
    expect(within(tab).queryByLabelText("Awaiting your review")).not.toBeInTheDocument();
    expect(within(tab).getByAltText("claude")).toBeInTheDocument();
  });

  it("keeps hover actions overlaid without changing tab width classes", () => {
    const onCloseTab = vi.fn();
    renderTabBar({ onCloseTab });

    const tab = screen.getByRole("button", { name: "Open API plan" });
    expect(tab).toHaveClass("w-44");
    expect(screen.getByLabelText("Rename API plan")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Close API plan"));

    expect(tab).toHaveClass("w-44");
    expect(onCloseTab).toHaveBeenCalledWith("thread_1");
  });

  it("renders the indicator before the title and shows empty titles as New chat", () => {
    renderTabBar({
      openTabs: [
        { threadId: "thread_1", title: "", model: "haiku", status: "idle" },
      ],
      closedTabs: [],
    });

    const tab = screen.getByRole("button", { name: "Open New chat" });
    const title = within(tab).getByText("New chat");
    const logo = within(tab).getByAltText("claude");

    expect(
      Boolean(tab.compareDocumentPosition(logo) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    expect(
      Boolean(logo.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("uses a gradient fade on hover actions and the closed-tabs icon", () => {
    renderTabBar();

    const tab = screen.getByRole("button", { name: "Open API plan" });
    const fade = tab.querySelector("[aria-hidden='true'].bg-gradient-to-l");
    expect(fade).toBeTruthy();
    expect(fade).not.toHaveClass("ring-1");
    expect(document.querySelector(".lucide-circle-fading-plus")).toBeTruthy();
    expect(document.querySelector(".lucide-chevron-down")).toBeNull();
  });

  it("layers a solid hover overlay matching the tab background under a thin feather", () => {
    renderTabBar();

    const activeTab = screen.getByRole("button", { name: "Open API plan" });
    const inactiveTab = screen.getByRole("button", { name: "Open UI polish" });

    const activeOverlays = activeTab.querySelectorAll("[aria-hidden='true']");
    const inactiveOverlays = inactiveTab.querySelectorAll("[aria-hidden='true']");

    expect(activeOverlays[0]).toHaveClass("bg-background");
    expect(activeOverlays[0]).not.toHaveClass("bg-gradient-to-l");
    expect(activeOverlays[1]).toHaveClass("bg-gradient-to-l");
    expect(activeOverlays[1]).toHaveClass("from-background");
    expect(activeOverlays[1]).toHaveClass("w-2.5");

    expect(inactiveOverlays[0].className).toMatch(/bg-\[color-mix\(/);
    expect(inactiveOverlays[1]).toHaveClass("bg-gradient-to-l");
    expect(inactiveOverlays[1].className).toMatch(/from-\[color-mix\(/);
  });

  it("anchors active and inactive tab titles to the same baseline", () => {
    renderTabBar();

    const activeTab = screen.getByRole("button", { name: "Open API plan" });
    const inactiveTab = screen.getByRole("button", { name: "Open UI polish" });

    expect(activeTab).toHaveClass("pb-0.5");
    expect(inactiveTab).toHaveClass("pb-0.5");
    expect(activeTab).toHaveClass("items-center");
    expect(inactiveTab).toHaveClass("items-center");
  });

  it("renders a mobile sidebar trigger in the tab bar", () => {
    renderTabBar();

    const triggerWrapper = screen.getByRole("button", {
      name: "Toggle Sidebar",
    }).parentElement;
    expect(triggerWrapper).not.toBeNull();
    expect(triggerWrapper!).toHaveClass("md:hidden");
  });

  it("renames groups through a dialog with synced draft state", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <RenameGroupDialog
        open={true}
        onOpenChange={vi.fn()}
        initialName="Launch"
        onSubmit={onSubmit}
      />,
    );

    const input = screen.getByLabelText("Name");
    expect(input).toHaveValue("Launch");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "  Planning  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledWith("Planning");

    rerender(
      <RenameGroupDialog
        open={true}
        onOpenChange={vi.fn()}
        initialName="Follow-up"
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Follow-up");
  });
});

describe("ChatGroupsList", () => {
  it("renders the empty state", () => {
    render(<ChatGroupsList groups={[]} activeGroupId={null} onSelectGroup={vi.fn()} onCloseGroup={vi.fn()} />);

    expect(screen.getByText("No groups yet")).toBeInTheDocument();
  });

  it("renders count-only idle group slots and status icons for active groups", () => {
    const { rerender } = render(<ChatGroupRightSlot status="idle" count={3} />);
    expect(screen.getByLabelText("3 open chats")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent is working")).not.toBeInTheDocument();

    rerender(<ChatGroupRightSlot status="running" count={3} />);
    expect(screen.getByLabelText("Agent is working")).toHaveClass("animate-spin");
    expect(screen.getByLabelText("3 open chats")).toHaveClass("tabular-nums");

    rerender(<ChatGroupRightSlot status="unread" count={3} />);
    expect(screen.getByLabelText("Awaiting your review")).toHaveClass("bg-red-500");
    expect(screen.getByLabelText("3 open chats")).toBeInTheDocument();
    const rightSlot = screen.getByLabelText("3 open chats").parentElement;
    expect(rightSlot).not.toBeNull();
    expect(screen.getByLabelText("3 open chats")).toHaveClass(
      "group-hover/menu-item:opacity-0",
    );
    expect(screen.getByLabelText("3 open chats")).toHaveClass(
      "group-has-[[data-state=open]]/menu-item:opacity-0",
    );
    expect(rightSlot!).not.toHaveClass("group-hover/menu-item:opacity-0");
  });

  it("counts visible open chats in the sidebar instead of closed tabs", () => {
    render(
      <SidebarProvider>
        <ChatGroupsList
          groups={[
            {
              ...groupView,
              member_count: 2,
              closed_thread_ids: ["thread_2"],
              closed_threads: [
                makeThreadSummary({
                  id: "thread_2",
                  title: "Dismissed",
                  updated_at: 1,
                  status: "idle",
                  membership: "closed",
                }),
              ],
            },
          ]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={vi.fn()}
        />
      </SidebarProvider>,
    );

    expect(screen.getByLabelText("1 open chat")).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Launch" })).toHaveClass("!pr-2");
    expect(screen.queryByLabelText("2 open chats")).not.toBeInTheDocument();
  });

  it("renders collapsed initials as decoration instead of selectable text", () => {
    const { container } = render(<ChatGroupCollapsedIcon group={groupView} />);

    const collapsedIcon = container.querySelector("[data-initial='L']");
    expect(collapsedIcon).not.toBeNull();
    expect(collapsedIcon).toHaveAttribute("aria-hidden", "true");
    expect(collapsedIcon).toHaveClass("pointer-events-none");
    expect(collapsedIcon).toHaveClass("select-none");
    expect(collapsedIcon).toHaveClass("before:content-[attr(data-initial)]");
    expect(collapsedIcon).not.toHaveTextContent("L");
  });

  it("selects and opens close confirmation for a single-chat group by default", () => {
    const onSelectGroup = vi.fn();
    const onCloseGroup = vi.fn();

    render(
      <SidebarProvider>
        <ChatGroupsList
          groups={[groupView]}
          activeGroupId={null}
          onSelectGroup={onSelectGroup}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    const groupButton = screen.getByRole("button", { name: "Launch" });
    expect(groupButton).toHaveAttribute("data-size", "sm");
    expect(groupButton).toHaveClass(
      "group-data-[collapsible=icon]:[&_*]:pointer-events-none",
    );
    expect(groupButton).toHaveClass(
      "group-data-[collapsible=icon]:[&_*]:cursor-pointer",
    );

    const closeButton = screen.getByRole("button", { name: "Close Launch" });
    expect(closeButton).not.toHaveClass("top-1/2");
    expect(closeButton).not.toHaveClass("-translate-y-1/2");

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));

    expect(onSelectGroup).toHaveBeenCalledWith("group_1");
    expect(onCloseGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(/Its 1 chat will be removed/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close group" }));

    expect(onCloseGroup).toHaveBeenCalledWith("group_1");
  });

  it("opens close confirmation for a multi-chat group by default", () => {
    const onCloseGroup = vi.fn();
    render(
      <SidebarProvider>
        <ChatGroupsList
          groups={[multiChatGroupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));

    expect(onCloseGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(/Its 2 chats will be removed/)).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Do not show again" }),
    ).not.toBeChecked();
  });

  it("does not suppress future close group confirmations when confirming without the checkbox", () => {
    const onCloseGroup = vi.fn();
    const { rerender } = render(
      <SidebarProvider>
        <ChatGroupsList
          groups={[multiChatGroupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));
    fireEvent.click(screen.getByRole("button", { name: "Close group" }));

    expect(onCloseGroup).toHaveBeenCalledWith("group_multi");
    expect(
      window.localStorage.getItem(
        CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
      ),
    ).toBeNull();

    onCloseGroup.mockClear();
    rerender(
      <SidebarProvider>
        <ChatGroupsList
          groups={[
            {
              ...multiChatGroupView,
              id: "group_follow_up",
              name: "Follow-up",
            },
          ]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Follow-up" }));

    expect(onCloseGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("can suppress future close group confirmations after confirming with the checkbox", () => {
    const onCloseGroup = vi.fn();
    const { rerender } = render(
      <SidebarProvider>
        <ChatGroupsList
          groups={[multiChatGroupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Do not show again" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close group" }));

    expect(onCloseGroup).toHaveBeenCalledWith("group_multi");
    expect(
      window.localStorage.getItem(
        CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
      ),
    ).toBe("true");

    onCloseGroup.mockClear();
    rerender(
      <SidebarProvider>
        <ChatGroupsList
          groups={[
            {
              ...multiChatGroupView,
              id: "group_follow_up",
              name: "Follow-up",
            },
          ]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Follow-up" }));

    expect(onCloseGroup).toHaveBeenCalledWith("group_follow_up");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("honors an existing saved close confirmation suppression preference", () => {
    const onCloseGroup = vi.fn();
    window.localStorage.setItem(
      CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
      "true",
    );

    render(
      <SidebarProvider>
        <ChatGroupsList
          groups={[multiChatGroupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));

    expect(onCloseGroup).toHaveBeenCalledWith("group_multi");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("ignores stale unversioned close confirmation suppression preferences", () => {
    const onCloseGroup = vi.fn();
    window.localStorage.setItem(
      "camelai:close-chat-group-confirmation-suppressed",
      "true",
    );

    render(
      <SidebarProvider>
        <ChatGroupsList
          groups={[multiChatGroupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));

    expect(onCloseGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("shows close confirmation when the saved preference cannot be read", () => {
    const onCloseGroup = vi.fn();
    const getItemSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage unavailable");
      });

    try {
      render(
        <SidebarProvider>
          <ChatGroupsList
            groups={[multiChatGroupView]}
            activeGroupId={null}
            onSelectGroup={vi.fn()}
            onCloseGroup={onCloseGroup}
          />
        </SidebarProvider>,
      );
    } finally {
      getItemSpy.mockRestore();
    }

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));

    expect(onCloseGroup).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("keeps close group confirmation enabled when the checked dialog is canceled", () => {
    const onCloseGroup = vi.fn();
    render(
      <SidebarProvider>
        <ChatGroupsList
          groups={[multiChatGroupView]}
          activeGroupId={null}
          onSelectGroup={vi.fn()}
          onCloseGroup={onCloseGroup}
        />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Do not show again" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCloseGroup).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem(
        CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
      ),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Do not show again" }),
    ).not.toBeChecked();
  });
});

describe("getCloseGroupRedirect", () => {
  it("navigates away before closing the active group so the thread route cannot recreate it", () => {
    expect(getCloseGroupRedirect([groupView], "group_1", "group_1")).toBe(
      "/chat",
    );
  });

  it("moves to another group when closing the active group and leaves inactive closes in place", () => {
    const nextGroup: ChatGroupView = {
      ...groupView,
      id: "group_2",
      name: "Research",
      last_active_thread_id: "thread_2",
      open_thread_ids: ["thread_2"],
      open_threads: [
        makeThreadSummary({
          id: "thread_2",
          title: "Research notes",
          updated_at: 2,
          status: "idle",
        }),
      ],
    };

    expect(
      getCloseGroupRedirect([groupView, nextGroup], "group_1", "group_1"),
    ).toBe("/chat/thread_2");
    expect(
      getCloseGroupRedirect([groupView, nextGroup], "group_1", "group_2"),
    ).toBeNull();
  });
});

describe("getGroupLandingHref", () => {
  it("opens the group landing page instead of a closed thread when no tabs are open", () => {
    expect(
      getGroupLandingHref({
        ...groupView,
        open_thread_ids: [],
        closed_thread_ids: ["thread_1"],
        open_threads: [],
        closed_threads: groupView.open_threads,
        member_count: 1,
      }),
    ).toBe("/chat?group=group_1");
  });
});

describe("mergeActiveChatGroup", () => {
  it("replaces stale layout group data with the active route group", () => {
    const activeGroup: ChatGroupView = {
      ...groupView,
      open_thread_ids: ["thread_1", "thread_2"],
      open_threads: [
        ...groupView.open_threads,
        makeThreadSummary({
          id: "thread_2",
          title: "New tab",
          updated_at: 2,
          status: "running",
        }),
      ],
      member_count: 2,
      status: "running",
    };

    const merged = mergeActiveChatGroup([groupView], activeGroup);

    expect(merged).toHaveLength(1);
    expect(merged[0].open_thread_ids).toEqual(["thread_1", "thread_2"]);
    expect(merged[0].open_threads.map((thread) => thread.id)).toEqual([
      "thread_1",
      "thread_2",
    ]);
  });

  it("adds an active group missing from the stale layout list", () => {
    const activeGroup: ChatGroupView = {
      ...groupView,
      id: "group_new",
      name: "New group",
    };

    const merged = mergeActiveChatGroup([groupView], activeGroup);

    expect(merged.map((group) => group.id)).toEqual(["group_new", "group_1"]);
  });
});

describe("hasPendingCompletionSummaries", () => {
  it("detects pending assistant summaries in open and closed threads", () => {
    expect(
      hasPendingCompletionSummaries([
        {
          ...groupView,
          open_threads: [
            makeThreadSummary({
              id: "thread_pending_open",
              title: "Pending open",
              last_assistant_summary_status: "pending",
            }),
          ],
        },
      ]),
    ).toBe(true);

    expect(
      hasPendingCompletionSummaries([
        {
          ...groupView,
          open_threads: [],
          closed_threads: [
            makeThreadSummary({
              id: "thread_pending_closed",
              title: "Pending closed",
              membership: "closed",
              last_assistant_summary_status: "pending",
            }),
          ],
        },
      ]),
    ).toBe(true);

    expect(hasPendingCompletionSummaries([groupView])).toBe(false);
  });
});

describe("shouldRevalidateThreadStatusUpdate", () => {
  it("keeps summary metadata-only frames eligible for fallback revalidation", () => {
    expect(shouldRevalidateThreadStatusUpdate("unread", true, true)).toBe(true);
    expect(shouldRevalidateThreadStatusUpdate("idle", true, false)).toBe(false);
    expect(shouldRevalidateThreadStatusUpdate("running", false, false)).toBe(true);
  });
});

describe("reconcileLocalThreadStatusesWithSnapshot", () => {
  it("clears stale local running statuses when the snapshot omits them", () => {
    const current = new Map<string, "idle" | "running" | "unread">([
      ["thread_1", "running"],
      ["thread_2", "unread"],
    ]);

    const next = reconcileLocalThreadStatusesWithSnapshot(current, new Set());

    expect(next).not.toBe(current);
    expect(Array.from(next.entries())).toEqual([["thread_2", "unread"]]);
  });

  it("lets snapshot running state win over stale local non-running statuses", () => {
    const current = new Map<string, "idle" | "running" | "unread">([
      ["thread_1", "idle"],
      ["thread_2", "unread"],
    ]);

    const next = reconcileLocalThreadStatusesWithSnapshot(
      current,
      new Set(["thread_1"]),
    );

    expect(Array.from(next.entries())).toEqual([["thread_2", "unread"]]);
  });

  it("clears stale local idle metadata when the snapshot says the thread is running", () => {
    const current = new Map([
      [
        "thread_1",
        {
          status: "idle" as const,
          latestUserMessage: "optimistic prompt",
          runningActivityText: "optimistic prompt",
        },
      ],
    ]);

    const next = reconcileLocalThreadStatusesWithSnapshot(
      current,
      new Set(["thread_1"]),
    );

    expect(Array.from(next.entries())).toEqual([]);
  });
});

describe("mergeLiveAndLocalThreadStatuses", () => {
  it("keeps authoritative live running state over stale local idle overlays", () => {
    const merged = mergeLiveAndLocalThreadStatuses(
      new Map([
        [
          "thread_1",
          {
            status: "running",
            runningActivityText: "Running typecheck...",
          },
        ],
      ]),
      new Map([
        [
          "thread_1",
          {
            status: "idle",
            latestUserMessage: "local prompt",
          },
        ],
      ]),
    );

    expect(merged.get("thread_1")).toEqual({
      status: "running",
      runningActivityText: "Running typecheck...",
    });
  });
});

describe("reconcileThreadSummaryPatchesWithGroups", () => {
  it("keeps optimistic patches when refreshed group data is older", () => {
    const current = new Map([
      ["thread_1", { title: "Optimistic title", updatedAt: 5 }],
    ]);

    expect(reconcileThreadSummaryPatchesWithGroups(current, [groupView])).toBe(
      current,
    );
  });

  it("drops optimistic patches for threads present in matching-or-newer group data", () => {
    const current = new Map([
      ["thread_1", { title: "Optimistic title", updatedAt: 1 }],
      ["thread_missing", { title: "Drop me", updatedAt: 1 }],
    ]);

    const next = reconcileThreadSummaryPatchesWithGroups(current, [groupView]);

    expect(next).not.toBe(current);
    expect(next.has("thread_1")).toBe(false);
    expect(next.has("thread_missing")).toBe(false);
  });

  it("preserves patch identity when no refreshed thread matches", () => {
    const current = new Map([["thread_other", { title: "Pending", updatedAt: 5 }]]);

    expect(reconcileThreadSummaryPatchesWithGroups(current, undefined)).toBe(current);
  });

  it("clears all patches when fresh group data has no threads", () => {
    const current = new Map([["thread_1", { title: "Pending", updatedAt: 5 }]]);
    const emptyGroup: ChatGroupView = {
      ...groupView,
      open_thread_ids: [],
      closed_thread_ids: [],
      open_threads: [],
      closed_threads: [],
      member_count: 0,
      status: "idle",
    };

    expect(
      reconcileThreadSummaryPatchesWithGroups(current, [emptyGroup]).size,
    ).toBe(0);
  });
});

describe("ChatGroupsProvider summary patches", () => {
  it("keeps newer local title patches over older loader group data", async () => {
    let loaderState = authLoaderState([groupViewWithThreadRevision("API plan", 1)]);
    const router = createMemoryRouter(
      [
        {
          id: "routes/_app",
          path: "/",
          loader: () => loaderState,
          element: (
            <ChatGroupsProvider>
              <ChatGroupsProviderProbe />
            </ChatGroupsProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("thread-title")).toHaveTextContent(
      "API plan",
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent("camelai:thread-status", {
          detail: {
            threadId: "thread_1",
            title: "Optimistic title",
            updatedAt: 5,
          },
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("thread-title")).toHaveTextContent(
        "Optimistic title",
      );
    });

    loaderState = authLoaderState([groupViewWithThreadRevision("Old title", 1)]);
    await act(async () => {
      await router.revalidate();
    });

    expect(screen.getByTestId("thread-title")).toHaveTextContent(
      "Optimistic title",
    );

    loaderState = authLoaderState([groupViewWithThreadRevision("Server title", 6)]);
    await act(async () => {
      await router.revalidate();
    });

    await waitFor(() => {
      expect(screen.getByTestId("thread-title")).toHaveTextContent(
        "Server title",
      );
    });
  });

  it("refreshes inactive thread metadata from status completions without broad revalidation", async () => {
    vi.stubGlobal("WebSocket", MockStatusWebSocket as unknown as typeof WebSocket);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          thread: {
            id: "thread_2",
            title: "Generated UI polish",
            model: "sonnet",
            updated_at: 10,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const runningGroup: ChatGroupView = {
      ...multiChatGroupView,
      status: "running",
      open_threads: multiChatGroupView.open_threads.map((thread) =>
        thread.id === "thread_2"
          ? { ...thread, status: "running" as const }
          : thread,
      ),
    };
    const loader = vi.fn(() => authLoaderState([runningGroup]));
    const router = createMemoryRouter(
      [
        {
          id: "routes/_app",
          path: "/",
          loader,
          element: (
            <ChatGroupsProvider>
              <ChatGroupsProviderProbe threadId="thread_2" />
            </ChatGroupsProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );

    try {
      render(<RouterProvider router={router} />);

      expect(await screen.findByTestId("thread-title")).toHaveTextContent(
        "UI polish",
      );
      await waitFor(() => {
        expect(MockStatusWebSocket.instances).toHaveLength(1);
      });

      act(() => {
        MockStatusWebSocket.instances[0].emit({
          type: "thread_status",
          threadId: "thread_2",
          status: "unread",
          completedAt: 10,
        });
      });

      await waitFor(
        () => {
          expect(fetchMock).toHaveBeenCalledWith("/api/threads/thread_2");
        },
        { timeout: 1200 },
      );
      await waitFor(() => {
        expect(screen.getByTestId("thread-title")).toHaveTextContent(
          "Generated UI polish",
        );
      });
      expect(loader).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("applyLiveRunningStatuses", () => {
  it("preserves group and thread identities for no-op status frames", () => {
    const source = [groupView];
    const result = applyLiveRunningStatuses(
      source,
      new Set(),
      false,
      null,
      new Map([["thread_1", "idle"] as const]),
    );

    expect(result).toBe(source);
    expect(result[0]).toBe(groupView);
    expect(result[0].open_threads[0]).toBe(groupView.open_threads[0]);
  });

  it("clears loader-derived running state after the socket snapshot arrives", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          status: "running",
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 1,
              status: "running",
              is_unread: false,
            }),
          ],
        },
      ],
      new Set(),
      true,
    );

    expect(group.status).toBe("idle");
    expect(group.open_threads[0].status).toBe("idle");
  });

  it("does not convert the active thread to unread after running stops", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          status: "running",
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 2,
              status: "running",
              is_unread: true,
            }),
          ],
        },
      ],
      new Set(),
      true,
      "thread_1",
    );

    expect(group.status).toBe("idle");
    expect(group.open_threads[0].is_unread).toBe(false);
    expect(group.open_threads[0].status).toBe("idle");
  });

  it("identifies active unread completion frames as viewed work", () => {
    expect(
      shouldMarkActiveUnreadThreadViewed("unread", "thread_1", "thread_1"),
    ).toBe(true);
    expect(
      shouldMarkActiveUnreadThreadViewed("unread", "thread_1", "thread_2"),
    ).toBe(false);
    expect(
      shouldMarkActiveUnreadThreadViewed("idle", "thread_1", "thread_1"),
    ).toBe(false);
  });

  it("identifies active local idle completions as viewed work", () => {
    expect(
      shouldMarkActiveIdleThreadViewed("idle", "thread_1", "thread_1"),
    ).toBe(true);
    expect(
      shouldMarkActiveIdleThreadViewed("idle", "thread_1", "thread_2"),
    ).toBe(false);
    expect(
      shouldMarkActiveIdleThreadViewed("running", "thread_1", "thread_1"),
    ).toBe(false);
  });

  it("revalidates when a snapshot drops a background running thread", () => {
    expect(
      getThreadIdsRequiringSnapshotRevalidation(
        new Map([["thread_1", "running"] as const]),
        new Map([["thread_2", "running"] as const]),
        new Set(["thread_2"]),
        "thread_active",
      ),
    ).toEqual(["thread_1"]);
  });

  it("does not revalidate when a snapshot drops the active running thread", () => {
    expect(
      getThreadIdsRequiringSnapshotRevalidation(
        new Map([["thread_1", "running"] as const]),
        new Map(),
        new Set(),
        "thread_1",
      ),
    ).toEqual([]);
  });

  it("treats an explicit idle status frame as authoritative before a snapshot", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          status: "running",
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 2,
              status: "running",
              is_unread: false,
            }),
          ],
        },
      ],
      new Set(),
      false,
      null,
      new Map([["thread_1", "idle"] as const]),
    );

    expect(group.status).toBe("idle");
    expect(group.open_threads[0].status).toBe("idle");
  });

  it("treats an explicit idle status as authoritative over stale unread loader state", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          status: "unread",
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 2,
              status: "unread",
              is_unread: true,
            }),
          ],
        },
      ],
      new Set(),
      true,
      null,
      new Map([["thread_1", "idle"] as const]),
    );

    expect(group.status).toBe("idle");
    expect(group.open_threads[0].status).toBe("idle");
    expect(group.open_threads[0].is_unread).toBe(false);
  });

  it("marks a completed background thread unread from live status", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          open_thread_ids: ["thread_1", "thread_2"],
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 2,
              status: "running",
              is_unread: false,
            }),
            makeThreadSummary({
              id: "thread_2",
              title: "UI polish",
              updated_at: 2,
              status: "idle",
              is_unread: false,
            }),
          ],
        },
      ],
      new Set(),
      true,
      "thread_2",
      new Map([["thread_1", "unread"] as const]),
    );

    expect(group.status).toBe("unread");
    expect(group.open_threads[0].status).toBe("unread");
    expect(group.open_threads[1].status).toBe("idle");
  });

  it("applies local thread summary patches without status revalidation", () => {
    const [group] = applyLiveRunningStatuses(
      [groupView],
      new Set(),
      false,
      null,
      new Map(),
      new Map([["thread_1", { title: "Renamed thread", updatedAt: 2 }]]),
    );

    expect(group.open_threads[0].title).toBe("Renamed thread");
    expect(group.open_threads[0].status).toBe("idle");
  });

  it("overlays completion timestamps from live status metadata", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 10,
              last_active_at: 10,
              status: "running",
              is_unread: false,
            }),
          ],
        },
      ],
      new Set(),
      true,
      null,
      new Map([
        [
          "thread_1",
          {
            status: "unread",
            completedAt: 20,
            summaryStatus: "ready",
            summary: "Generated summary",
          },
        ],
      ]),
    );

    expect(group.status).toBe("unread");
    expect(group.open_threads[0].last_assistant_completed_at).toBe(20);
    expect(group.open_threads[0].last_assistant_summary).toBe("Generated summary");
    expect(group.open_threads[0].last_assistant_summary_status).toBe("ready");
    expect(group.open_threads[0].updated_at).toBe(20);
    expect(group.open_threads[0].last_active_at).toBe(20);
  });

  it("overlays optimistic latest user messages while running", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          open_threads: [
            makeThreadSummary({
              id: "thread_1",
              title: "API plan",
              updated_at: 10,
              last_active_at: 10,
              status: "idle",
              latest_user_message: "stale prompt",
            }),
          ],
        },
      ],
      new Set(),
      true,
      null,
      new Map([
        [
          "thread_1",
          {
            status: "running",
            latestUserMessage: "fresh prompt",
            latestUserMessageAt: 20,
          },
        ],
      ]),
    );

    expect(group.status).toBe("running");
    expect(group.open_threads[0].status).toBe("running");
    expect(group.open_threads[0].latest_user_message).toBe("fresh prompt");
    expect(group.open_threads[0].latest_user_message_at).toBe(20);
  });

  it("overlays live running activity metadata while running", () => {
    const [group] = applyLiveRunningStatuses(
      [groupView],
      new Set(),
      true,
      null,
      new Map([
        [
          "thread_1",
          {
            status: "running",
            runningActivityText: "Running typecheck...",
            runningActivityAt: 40,
            runningStartedAt: 30,
          },
        ],
      ]),
    );

    expect(group.status).toBe("running");
    expect(group.open_threads[0].running_activity_text).toBe("Running typecheck...");
    expect(group.open_threads[0].running_activity_at).toBe(40);
    expect(group.open_threads[0].running_started_at).toBe(30);
    expect(group.open_threads[0].last_active_at).toBe(40);
  });
});
