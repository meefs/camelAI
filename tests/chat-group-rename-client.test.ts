import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastErrorMock,
    success: toastSuccessMock,
  },
}));

import { saveChatGroupRename } from "@/lib/chat-group-rename.client";
import type { Avatar } from "@/types";

const avatar: Avatar = { color: "#4F46E5", content: "💬" };

describe("saveChatGroupRename", () => {
  beforeEach(() => {
    toastErrorMock.mockClear();
    toastSuccessMock.mockClear();
  });

  it("dispatches the local avatar event, revalidates, and shows a success toast", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const dispatchEvent = vi.fn();
    const revalidate = vi.fn();

    await saveChatGroupRename(
      "group 1",
      { name: "Planning", avatar },
      {
        fetchFn: fetchFn as unknown as typeof fetch,
        dispatchEvent,
        revalidate,
        now: () => 123,
      },
    );

    expect(fetchFn).toHaveBeenCalledWith("/api/chat-groups/group%201", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Planning", avatar }),
    });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent;
    expect(event.type).toBe("camelai:chat-group-avatar");
    expect(event.detail).toEqual({
      groupId: "group 1",
      avatar: { ...avatar, status: "user" },
      updatedAt: 123,
    });
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).toHaveBeenCalledWith("Chat group updated");
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("omits avatar side effects for a name-only save", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const dispatchEvent = vi.fn();
    const revalidate = vi.fn();

    await saveChatGroupRename(
      "group_1",
      { name: "Renamed only" },
      {
        fetchFn: fetchFn as unknown as typeof fetch,
        dispatchEvent,
        revalidate,
      },
    );

    expect(fetchFn).toHaveBeenCalledWith("/api/chat-groups/group_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed only" }),
    });
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a local avatar event and shows an error toast when the update fails", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const dispatchEvent = vi.fn();
    const revalidate = vi.fn();

    await saveChatGroupRename(
      "group_1",
      { name: "Planning", avatar },
      {
        fetchFn: fetchFn as unknown as typeof fetch,
        dispatchEvent,
        revalidate,
      },
    );

    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith("Failed to update chat group");
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });
});
