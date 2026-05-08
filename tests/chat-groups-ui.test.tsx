import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ChatTabBar,
  RenameGroupDialog,
  TabRightSlot,
} from "@/components/chat-tab-bar";
import {
  ChatGroupRightSlot,
  ChatGroupsList,
} from "@/components/sidebar/chat-groups-list";
import { applyLiveRunningStatuses } from "@/hooks/use-chat-groups";
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

  it("reopens closed tabs from the overflow menu", async () => {
    const onReopenClosedTab = vi.fn();
    renderTabBar({ onReopenClosedTab });

    fireEvent.click(screen.getByRole("button", { name: "Closed chat tabs" }));
    fireEvent.click(await screen.findByText("Archived idea"));

    expect(onReopenClosedTab).toHaveBeenCalledWith("thread_3");
  });

  it("renders stable right slots for idle, running, and unread tabs", () => {
    const { rerender } = render(<TabRightSlot status="idle" model="haiku" />);
    expect(screen.getByAltText("claude")).toBeInTheDocument();

    rerender(<TabRightSlot status="running" model="haiku" />);
    expect(screen.getByLabelText("Agent is working")).toHaveClass("animate-spin");

    rerender(<TabRightSlot status="unread" model="haiku" />);
    expect(screen.getByLabelText("Awaiting your review")).toHaveClass("bg-red-500");
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
    expect(screen.getByLabelText("3 chats")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent is working")).not.toBeInTheDocument();

    rerender(<ChatGroupRightSlot status="running" count={3} />);
    expect(screen.getByLabelText("Agent is working")).toHaveClass("animate-spin");
    expect(screen.getByLabelText("3 chats")).toHaveClass("tabular-nums");

    rerender(<ChatGroupRightSlot status="unread" count={3} />);
    expect(screen.getByLabelText("Awaiting your review")).toHaveClass("bg-red-500");
    expect(screen.getByLabelText("3 chats")).toBeInTheDocument();
    const rightSlot = screen.getByLabelText("3 chats").parentElement;
    expect(rightSlot).not.toBeNull();
    expect(rightSlot!).not.toHaveClass("group-hover/menu-item:opacity-0");
  });

  it("selects and closes a single-chat group without confirmation", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Launch" }));

    expect(onSelectGroup).toHaveBeenCalledWith("group_1");
    expect(onCloseGroup).toHaveBeenCalledWith("group_1");
    expect(screen.getByRole("button", { name: "Close Launch" })).toHaveClass(
      "top-1/2",
      "-translate-y-1/2",
    );
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
});
