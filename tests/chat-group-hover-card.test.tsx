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
    updated_at: updatedAt,
    status: "idle",
    membership: "open",
    last_active_at: updatedAt,
    first_user_message: null,
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
    avatar: { color: "#4F46E5", content: "💬" },
    pinned_at: null,
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
      last_assistant_summary_status: "ready",
    });
    const quiet = makeThread({
      id: "quiet",
      title: "BYOK setup notes",
      status: "idle",
      updated_at: now - 2 * 3_600_000,
      last_active_at: now - 2 * 3_600_000,
    });

    const { container } = render(
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
    expect(screen.getByText("does org 097d have BYOK enabled?")).toHaveClass(
      "truncate",
      "max-w-full",
      "min-w-0",
    );
    expect(screen.getByText("does org 097d have BYOK enabled?")).not.toHaveClass(
      "pl-4",
    );
    expect(screen.getByText("Found three common setup issues.")).toHaveClass(
      "line-clamp-2",
      "max-w-full",
      "min-w-0",
      "break-words",
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
    const viewport = container.querySelector("[data-slot='scroll-area-viewport']");
    expect(viewport?.className).toContain("[&>div]:!block");
    expect(viewport?.className).toContain("[&>div]:!w-full");
  });

  it("shows only open chats and excludes closed chats from hover sections", () => {
    const open = makeThread({
      id: "open",
      title: "Visible open chat",
      status: "idle",
      last_active_at: now - 10_000,
    });
    const closedRunning = makeThread({
      id: "closed_running",
      title: "Closed running chat",
      status: "running",
      membership: "closed",
    });
    const closedCompleted = makeThread({
      id: "closed_completed",
      title: "Closed completed chat",
      status: "unread",
      membership: "closed",
      last_assistant_completed_at: now - 60_000,
    });
    const closedQuiet = makeThread({
      id: "closed_quiet",
      title: "Closed quiet chat",
      status: "idle",
      membership: "closed",
      last_active_at: now - 120_000,
    });
    const group = makeGroup({
      open_threads: [open],
      closed_threads: [closedRunning, closedCompleted, closedQuiet],
    });

    const sections = splitThreadsBySection(group);

    expect(sections.inProgress).toEqual([]);
    expect(sections.completed).toEqual([]);
    expect(sections.quiet.map((thread) => thread.id)).toEqual(["open"]);

    render(<ChatGroupHoverCard group={group} onSelectThread={vi.fn()} />);

    expect(screen.getByText("1 chat")).toBeInTheDocument();
    expect(screen.getByText("Visible open chat")).toBeInTheDocument();
    expect(screen.queryByText("Closed running chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Closed completed chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Closed quiet chat")).not.toBeInTheDocument();
  });

  it("reserves completed-row summary space while generation is pending", () => {
    const { container } = render(
      <ChatGroupHoverCard
        group={makeGroup({
          open_threads: [
            makeThread({
              id: "completed",
              title: "Summarize custom domains",
              status: "unread",
              last_assistant_completed_at: now - 60_000,
              last_assistant_summary_status: "pending",
            }),
          ],
        })}
        onSelectThread={vi.fn()}
      />,
    );

    const pendingSummary = screen.getByRole("status", {
      name: "Generating summary",
    });
    expect(pendingSummary).toHaveClass("min-h-[2.0625rem]");
    expect(
      pendingSummary.querySelectorAll("[data-slot='skeleton']"),
    ).toHaveLength(2);
    expect(
      container.querySelector("[data-slot='skeleton']"),
    ).toHaveClass("motion-reduce:animate-none");
  });

  it("constrains long streaming update text inside the popover width", () => {
    const longText =
      "can you build me a screen saver? just an html file will suffice but make sure this sentence is very long and keeps streaming into the row";
    render(
      <ChatGroupHoverCard
        group={makeGroup({
          open_threads: [
            makeThread({
              id: "running",
              title: "Build screen saver",
              status: "running",
              latest_user_message: longText,
            }),
            makeThread({
              id: "completed",
              title: "Completed screen saver",
              status: "unread",
              last_assistant_completed_at: now - 60_000,
              last_assistant_summary:
                "Created a polished interactive particle screensaver with 11 configurable display modes and a responsive animation surface that should stay constrained.",
              last_assistant_summary_status: "ready",
            }),
          ],
        })}
        onSelectThread={vi.fn()}
      />,
    );

    expect(screen.getByText(longText)).toHaveClass(
      "w-full",
      "max-w-full",
      "truncate",
    );
    expect(
      screen.getByText(/Created a polished interactive particle screensaver/),
    ).toHaveClass(
      "w-full",
      "max-w-full",
      "line-clamp-2",
      "break-words",
    );
  });

  it("prefers live running activity over the latest user message", () => {
    render(
      <ChatGroupHoverCard
        group={makeGroup({
          open_threads: [
            makeThread({
              id: "running",
              title: "Build screen saver",
              status: "running",
              latest_user_message: "build a screen saver",
              running_activity_text:
                "Implemented controls and wiring up the animation loop",
            }),
          ],
        })}
        onSelectThread={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Implemented controls and wiring up the animation loop"),
    ).toHaveClass("truncate", "max-w-full");
    expect(screen.queryByText("build a screen saver")).toBeNull();
  });

  it("omits empty sections and sorts sections by their stable timestamps", () => {
    const olderRunningWithNewerActivity = makeThread({
      id: "running_old",
      title: "Older prompt, newer activity",
      status: "running",
      updated_at: 70,
      last_active_at: 90,
      latest_user_message_at: 10,
      running_started_at: 10,
    });
    const newerRunningWithOlderActivity = makeThread({
      id: "running_new",
      title: "Newer prompt, older activity",
      status: "running",
      updated_at: 60,
      last_active_at: 80,
      latest_user_message_at: 20,
      running_started_at: 20,
    });
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
        open_threads: [
          olderRunningWithNewerActivity,
          newerRunningWithOlderActivity,
          olderQuiet,
          newerQuiet,
          olderCompleted,
          newerCompleted,
        ],
      }),
    );

    expect(sections.inProgress.map((thread) => thread.id)).toEqual([
      "running_new",
      "running_old",
    ]);
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
