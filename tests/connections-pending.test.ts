import { describe, expect, it } from "vitest";
import { isCurrentWorkspacePendingAction } from "@/lib/connections-pending";

describe("isCurrentWorkspacePendingAction", () => {
  it("accepts pending optimistic actions only for the active workspace", () => {
    expect(isCurrentWorkspacePendingAction("ws_a", "ws_a")).toBe(true);
    expect(isCurrentWorkspacePendingAction("ws_a", "ws_b")).toBe(false);
  });
});
