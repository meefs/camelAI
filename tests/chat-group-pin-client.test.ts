import { describe, expect, it, vi } from "vitest";

import { saveChatGroupPinned } from "@/lib/chat-group-pin.client";

function eventDetail(event: Event) {
  return (event as CustomEvent<{ groupId: string; pinnedAt: number | null }>).detail;
}

describe("saveChatGroupPinned", () => {
  it("optimistically pins, updates the hint, saves, and revalidates", async () => {
    const calls: string[] = [];
    const events: Event[] = [];
    const result = await saveChatGroupPinned(
      {
        groupId: "group/1",
        workspaceId: "workspace_1",
        pinned: true,
        currentPinnedAt: null,
        currentPinnedCount: 2,
        revalidate: () => calls.push("revalidate"),
      },
      {
        now: () => 123,
        dispatchEvent: (event) => {
          calls.push("event");
          events.push(event);
          return true;
        },
        writePinnedCountHint: (_workspaceId, count) =>
          calls.push(`cookie:${count}`),
        fetchFn: vi.fn(async (input, init) => {
          calls.push("fetch");
          expect(input).toBe("/api/chat-groups/group%2F1");
          expect(init).toMatchObject({
            method: "PATCH",
            body: JSON.stringify({ pinned: true }),
          });
          return new Response(null, { status: 200 });
        }) as typeof fetch,
      },
    );

    expect(result).toBe(true);
    expect(calls).toEqual(["event", "cookie:3", "fetch", "revalidate"]);
    expect(eventDetail(events[0])).toEqual({
      groupId: "group/1",
      pinnedAt: 123,
    });
  });

  it("reverts an unsuccessful unpin before reporting and revalidating", async () => {
    const calls: string[] = [];
    const events: Event[] = [];
    const now = vi.fn(() => 201);
    const result = await saveChatGroupPinned(
      {
        groupId: "group_1",
        workspaceId: "workspace_1",
        pinned: false,
        currentPinnedAt: 177,
        currentPinnedCount: 2,
        revalidate: () => calls.push("revalidate"),
      },
      {
        now,
        dispatchEvent: (event) => {
          calls.push("event");
          events.push(event);
          return true;
        },
        writePinnedCountHint: (_workspaceId, count) =>
          calls.push(`cookie:${count}`),
        fetchFn: vi.fn(async () => {
          calls.push("fetch");
          return new Response(null, { status: 500 });
        }) as typeof fetch,
        showError: (message) => calls.push(`error:${message}`),
      },
    );

    expect(result).toBe(false);
    expect(calls).toEqual([
      "event",
      "cookie:1",
      "fetch",
      "event",
      "cookie:2",
      "error:Couldn't unpin group. Please try again.",
      "revalidate",
    ]);
    expect(eventDetail(events[0]).pinnedAt).toBeNull();
    expect(eventDetail(events[1]).pinnedAt).toBe(177);
    expect(now).not.toHaveBeenCalled();
  });
});
