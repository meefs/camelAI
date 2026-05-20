import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatGroupHoverCard,
  splitThreadsBySection,
} from "@/components/sidebar/chat-group-hover-card";
import type { ChatGroupThreadSummary, ChatGroupView } from "@/types";

function makeThread(
  overrides: Partial<ChatGroupThreadSummary> &
    Pick<ChatGroupThreadSummary, "id" | "title">,
): ChatGroupThreadSummary {
  const updatedAt = overrides.updated_at ?? 1;
  return {
    model: "haiku",
    provider: "claude",
    updated_at: updatedAt,
    status: "idle",
    membership: "open",
    last_active_at: updatedAt,
    latest_user_message: null,
    last_assistant_completed_at: null,
    last_assistant_summary: null,
    running_started_at: null,
    ...overrides,
  };
}

function makeGroup(
  overrides: Partial<ChatGroupView> = {},
): ChatGroupView {
  const openThreads = overrides.open_threads ?? [];
  const closedThreads = overrides.closed_threads ?? [];
  return {
    id: "group_1",
    org_id: "org_1",
    workspace_id: "workspace_1",
    name: "Support tickets",
    last_active_thread_id: null,
    created_at: 1,
    updated_at: 1,
    open_thread_ids: openThreads.map((thread) => thread.id),
    closed_thread_ids: closedThreads.map((thread) => thread.id),
    open_threads: openThreads,
    closed_threads: closedThreads,
    member_count: openThreads.length + closedThreads.length,
    status: "idle",
    ...overrides,
  };
}

describe("ChatGroupHoverCard", () => {
  const now = Date.UTC(2026, 4, 19, 12, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders sectioned rows with compact metadata", () => {
    const running = makeThread({
      id: "running",
      title: "Check provider config",
      status: "running",
      updated_at: now - 5_000,
      last_active_at: now - 5_000,
      latest_user_message: "does org 097d have BYOK enabled?",
    });
    const completed = makeThread({
      id: "completed",
      title: "Summarize custom domains",
      status: "unread",
      updated_at: now - 60_000,
      last_active_at: now - 60_000,
      last_assistant_completed_at: now - 12 * 60_000,
      last_assistant_summary: "Found three common setup issues.",
    });
    const quiet = makeThread({
      id: "quiet",
      title: "BYOK setup notes",
      status: "idle",
      updated_at: now - 2 * 3_600_000,
      last_active_at: now - 2 * 3_600_000,
    });

    render(
      <ChatGroupHoverCard
        group={makeGroup({ open_threads: [running, completed, quiet] })}
        onSelectThread={vi.fn()}
      />,
    );

    expect(screen.getByText("Support tickets")).toBeInTheDocument();
    expect(screen.getByText("3 chats")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Quiet")).toBeInTheDocument();
    expect(screen.getByText("does org 097d have BYOK enabled?")).toBeInTheDocument();
    expect(screen.getByText("does org 097d have BYOK enabled?")).not.toHaveClass(
      "pl-4",
    );
    expect(screen.getByText("Found three common setup issues.")).toHaveClass(
      "line-clamp-2",
    );
    expect(screen.getByText("Found three common setup issues.")).not.toHaveClass(
      "pl-4",
    );
    expect(screen.getByText("BYOK setup notes")).toHaveClass("text-xs");
    expect(
      screen.getByText("BYOK setup notes").parentElement?.querySelector("[aria-hidden='true']"),
    ).toBeNull();
    expect(screen.getByText("12m ago")).toBeInTheDocument();
    expect(screen.getByText("2h ago")).toBeInTheDocument();
    expect(screen.getByText("\u2014")).toBeInTheDocument();
  });

  it("omits empty sections and sorts each section newest first", () => {
    const olderQuiet = makeThread({
      id: "quiet_old",
      title: "Older quiet",
      last_active_at: 10,
    });
    const newerQuiet = makeThread({
      id: "quiet_new",
      title: "Newer quiet",
      last_active_at: 20,
    });
    const olderCompleted = makeThread({
      id: "completed_old",
      title: "Older completed",
      status: "unread",
      last_assistant_completed_at: 30,
    });
    const newerCompleted = makeThread({
      id: "completed_new",
      title: "Newer completed",
      status: "unread",
      last_assistant_completed_at: 40,
    });

    const sections = splitThreadsBySection(
      makeGroup({
        open_threads: [olderQuiet, newerQuiet, olderCompleted, newerCompleted],
      }),
    );

    expect(sections.inProgress).toEqual([]);
    expect(sections.quiet.map((thread) => thread.id)).toEqual([
      "quiet_new",
      "quiet_old",
    ]);
    expect(sections.completed.map((thread) => thread.id)).toEqual([
      "completed_new",
      "completed_old",
    ]);

    render(
      <ChatGroupHoverCard
        group={makeGroup({ open_threads: [olderQuiet, newerQuiet] })}
        onSelectThread={vi.fn()}
      />,
    );

    expect(screen.queryByText("In progress")).not.toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    expect(screen.getByText("Quiet")).toBeInTheDocument();
  });

  it("delegates row selection with the selected thread", () => {
    const onSelectThread = vi.fn();
    const thread = makeThread({
      id: "thread_1",
      title: "Open this chat",
      status: "idle",
    });

    render(
      <ChatGroupHoverCard
        group={makeGroup({ open_threads: [thread] })}
        onSelectThread={onSelectThread}
      />,
    );

    fireEvent.click(screen.getByText("Open this chat").closest("button")!);

    expect(onSelectThread).toHaveBeenCalledWith(thread);
  });
});
