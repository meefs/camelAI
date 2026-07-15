import { describe, expect, it } from "vitest";
import {
  getChatGroupRecency,
  orderChatGroupsForDisplay,
  reconcileOptimisticUserMessageRecencyPatches,
} from "@/hooks/use-chat-groups";
import type { ChatGroupThreadSummary, ChatGroupView } from "@/types";

function makeThread(
  id: string,
  lastUserMessageAt: number | null,
  membership: "open" | "closed" = "open",
  latestUserMessageAt: number | null = lastUserMessageAt,
): ChatGroupThreadSummary {
  return {
    id,
    title: id,
    model: "haiku",
    updated_at: 1,
    status: "idle",
    membership,
    last_active_at: 1,
    first_user_message: null,
    latest_user_message: null,
    latest_user_message_at: latestUserMessageAt,
    last_user_message_at: lastUserMessageAt,
    running_activity_text: null,
    running_activity_at: null,
    last_assistant_completed_at: null,
    last_assistant_summary: null,
    last_assistant_summary_status: null,
    running_started_at: null,
  };
}

function makeGroup(
  id: string,
  updatedAt: number,
  {
    openThreads = [],
    closedThreads = [],
  }: {
    openThreads?: ChatGroupThreadSummary[];
    closedThreads?: ChatGroupThreadSummary[];
  } = {},
): ChatGroupView {
  return {
    id,
    org_id: "org_1",
    workspace_id: "workspace_1",
    name: id,
    avatar: { color: "#4F46E5", content: "messages-square" },
    last_active_thread_id: null,
    created_at: 1,
    updated_at: updatedAt,
    open_thread_ids: openThreads.map((thread) => thread.id),
    closed_thread_ids: closedThreads.map((thread) => thread.id),
    open_threads: openThreads,
    closed_threads: closedThreads,
    member_count: openThreads.length + closedThreads.length,
    status: "idle",
  };
}

describe("getChatGroupRecency", () => {
  it("returns updated_at when the group has no threads", () => {
    expect(getChatGroupRecency(makeGroup("group_1", 100))).toBe(100);
  });

  it("lets a newer open-thread last_user_message_at win over updated_at", () => {
    const group = makeGroup("group_1", 100, {
      openThreads: [makeThread("thread_1", 250)],
    });

    expect(getChatGroupRecency(group)).toBe(250);
  });

  it("keeps updated_at when open-thread sends are older", () => {
    const group = makeGroup("group_1", 100, {
      openThreads: [makeThread("thread_1", 40), makeThread("thread_2", 90)],
    });

    expect(getChatGroupRecency(group)).toBe(100);
  });

  it("treats null last_user_message_at as no signal", () => {
    const group = makeGroup("group_1", 100, {
      openThreads: [makeThread("thread_1", null)],
    });

    expect(getChatGroupRecency(group)).toBe(100);
  });

  it("ignores a synthesized latest_user_message_at without a real user timestamp", () => {
    const group = makeGroup("group_1", 100, {
      openThreads: [makeThread("thread_legacy", null, "open", 900)],
    });

    expect(getChatGroupRecency(group)).toBe(100);
  });

  it("uses a separate optimistic send overlay without changing canonical recency", () => {
    const thread = makeThread("thread_legacy", null, "open", 900);
    const group = makeGroup("group_1", 100, { openThreads: [thread] });
    const optimisticPatches = new Map([
      ["thread_legacy", { sentAt: 300, snapshotVersion: 1 }],
    ]);

    expect(getChatGroupRecency(group, optimisticPatches)).toBe(300);
    expect(thread.last_user_message_at).toBeNull();
  });

  it("lets a newer closed-thread last_user_message_at win over updated_at", () => {
    const group = makeGroup("group_1", 100, {
      closedThreads: [makeThread("thread_closed", 900, "closed")],
    });

    expect(getChatGroupRecency(group)).toBe(900);
  });
});

describe("reconcileOptimisticUserMessageRecencyPatches", () => {
  it("keeps patches through their source snapshot and drops them on the next one", () => {
    const patches = new Map([
      ["thread_old", { sentAt: 300, snapshotVersion: 4 }],
      ["thread_current", { sentAt: 400, snapshotVersion: 5 }],
    ]);

    expect(reconcileOptimisticUserMessageRecencyPatches(patches, 4)).toBe(
      patches,
    );
    const reconciled = reconcileOptimisticUserMessageRecencyPatches(patches, 5);
    expect(Array.from(reconciled.keys())).toEqual(["thread_current"]);
  });
});

describe("orderChatGroupsForDisplay", () => {
  it("sorts descending by recency", () => {
    const groups = [
      makeGroup("group_old", 10),
      makeGroup("group_new", 30),
      makeGroup("group_mid", 20),
    ];

    expect(orderChatGroupsForDisplay(groups).map((group) => group.id)).toEqual([
      "group_new",
      "group_mid",
      "group_old",
    ]);
  });

  it("keeps input (server) order for ties", () => {
    const groups = [
      makeGroup("group_a", 50),
      makeGroup("group_b", 50),
      makeGroup("group_c", 50),
    ];

    expect(orderChatGroupsForDisplay(groups).map((group) => group.id)).toEqual([
      "group_a",
      "group_b",
      "group_c",
    ]);
  });

  it("moves a group up when a live send bumps a thread past the leader", () => {
    const groups = [
      makeGroup("group_a", 200),
      makeGroup("group_b", 100, {
        openThreads: [makeThread("thread_1", 300)],
      }),
    ];

    expect(orderChatGroupsForDisplay(groups).map((group) => group.id)).toEqual([
      "group_b",
      "group_a",
    ]);
  });

  it("moves a group up when a live send bumps a closed thread past the leader", () => {
    const groups = [
      makeGroup("group_a", 200),
      makeGroup("group_b", 100, {
        closedThreads: [makeThread("thread_closed", 300, "closed")],
      }),
    ];

    expect(orderChatGroupsForDisplay(groups).map((group) => group.id)).toEqual([
      "group_b",
      "group_a",
    ]);
  });

  it("moves a closed-thread group with an optimistic send overlay", () => {
    const groups = [
      makeGroup("group_a", 200),
      makeGroup("group_b", 100, {
        closedThreads: [makeThread("thread_closed", null, "closed")],
      }),
    ];
    const optimisticPatches = new Map([
      ["thread_closed", { sentAt: 300, snapshotVersion: 1 }],
    ]);

    expect(
      orderChatGroupsForDisplay(groups, null, optimisticPatches).map(
        (group) => group.id,
      ),
    ).toEqual(["group_b", "group_a"]);
  });

  it("pins the requested group to the top without disturbing the rest", () => {
    const groups = [
      makeGroup("group_a", 40),
      makeGroup("group_b", 30),
      makeGroup("group_pinned", 10),
      makeGroup("group_c", 20),
    ];

    expect(
      orderChatGroupsForDisplay(groups, "group_pinned").map(
        (group) => group.id,
      ),
    ).toEqual(["group_pinned", "group_a", "group_b", "group_c"]);
  });

  it("ignores a pinned id that is not in the list", () => {
    const groups = [makeGroup("group_a", 20), makeGroup("group_b", 10)];

    expect(
      orderChatGroupsForDisplay(groups, "group_missing").map(
        (group) => group.id,
      ),
    ).toEqual(["group_a", "group_b"]);
  });

  it("treats a null pin as a plain recency sort", () => {
    const groups = [makeGroup("group_a", 10), makeGroup("group_b", 20)];

    expect(
      orderChatGroupsForDisplay(groups, null).map((group) => group.id),
    ).toEqual(["group_b", "group_a"]);
  });

  it("does not mutate the input array", () => {
    const groups = [makeGroup("group_a", 10), makeGroup("group_b", 20)];

    orderChatGroupsForDisplay(groups);

    expect(groups.map((group) => group.id)).toEqual(["group_a", "group_b"]);
  });
});
