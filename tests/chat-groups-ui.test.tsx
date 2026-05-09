import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  getCloseGroupRedirect,
  mergeActiveChatGroup,
} from "@/hooks/use-chat-groups";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { ChatGroup, ChatGroupView } from "@/types";

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

const groupView: ChatGroupView = {
  ...moveGroups[0],
  open_thread_ids: ["thread_1"],
  closed_thread_ids: [],
  open_threads: [
    {
      id: "thread_1",
      title: "API plan",
      model: "haiku",
      provider: "claude",
      updated_at: 1,
      status: "idle",
    },
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
    {
      id: "thread_2",
      title: "UI polish",
      model: "haiku",
      provider: "claude",
      updated_at: 2,
      status: "idle",
    },
  ],
  member_count: 2,
};

beforeEach(() => {
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
    <SidebarProvider>
      <ChatTabBar {...props} />
    </SidebarProvider>,
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
                {
                  id: "thread_2",
                  title: "Dismissed",
                  model: "haiku",
                  provider: "claude",
                  updated_at: 1,
                  status: "idle",
                },
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
        {
          id: "thread_2",
          title: "Research notes",
          model: "haiku",
          provider: "claude",
          updated_at: 2,
          status: "idle",
        },
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

describe("mergeActiveChatGroup", () => {
  it("replaces stale layout group data with the active route group", () => {
    const activeGroup: ChatGroupView = {
      ...groupView,
      open_thread_ids: ["thread_1", "thread_2"],
      open_threads: [
        ...groupView.open_threads,
        {
          id: "thread_2",
          title: "New tab",
          model: "haiku",
          provider: "claude",
          updated_at: 2,
          status: "running",
        },
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

describe("applyLiveRunningStatuses", () => {
  it("clears loader-derived running state after the socket snapshot arrives", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          status: "running",
          open_threads: [
            {
              id: "thread_1",
              title: "API plan",
              model: "haiku",
              provider: "claude",
              updated_at: 1,
              status: "running",
              is_unread: false,
            },
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
            {
              id: "thread_1",
              title: "API plan",
              model: "haiku",
              provider: "claude",
              updated_at: 2,
              status: "running",
              is_unread: true,
            },
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

  it("treats an explicit idle status frame as authoritative before a snapshot", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          status: "running",
          open_threads: [
            {
              id: "thread_1",
              title: "API plan",
              model: "haiku",
              provider: "claude",
              updated_at: 2,
              status: "running",
              is_unread: false,
            },
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

  it("marks a completed background thread unread from live status", () => {
    const [group] = applyLiveRunningStatuses(
      [
        {
          ...groupView,
          open_thread_ids: ["thread_1", "thread_2"],
          open_threads: [
            {
              id: "thread_1",
              title: "API plan",
              model: "haiku",
              provider: "claude",
              updated_at: 2,
              status: "running",
              is_unread: false,
            },
            {
              id: "thread_2",
              title: "UI polish",
              model: "haiku",
              provider: "claude",
              updated_at: 2,
              status: "idle",
              is_unread: false,
            },
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
});
