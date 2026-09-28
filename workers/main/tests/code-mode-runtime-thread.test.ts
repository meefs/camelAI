/**
 * Tools called for a thread that runs directly on the agent runtime
 * (plans/runtime-threads-direct.md §4.4): it has no ChatThreadDO, so thread
 * UI state goes to OrgDO or stays in the tool's result, and nothing reaches
 * CHAT_THREAD.
 */
import { describe, expect, it, vi } from "vitest";
import { CodeModeToolsBinding } from "../src/code-mode-tools";

const PROPS = { orgId: "org1", workspaceId: "ws1", threadId: "thread1", userId: "user1", directRuntime: true };
type Method = (this: unknown, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
const methods = CodeModeToolsBinding.prototype as unknown as Record<string, Method>;

function binding(org: Record<string, unknown>) {
  const instance = Object.create(CodeModeToolsBinding.prototype) as Record<string, unknown>;
  const chatThread = vi.fn(() => { throw new Error("CHAT_THREAD must not be used"); });
  Object.assign(instance, { ctx: { props: PROPS }, env: { CHAT_THREAD: { idFromName: chatThread, get: chatThread } } });
  Object.defineProperty(instance, "orgStub", { value: org });
  return { instance, chatThread };
}

describe("tools on a runtime thread", () => {
  it("keeps todos in the call's result only", async () => {
    const { instance, chatThread } = binding({});
    const result = await methods.updateTodos.call(instance, { todos: [{ content: "Ship", status: "in_progress" }] });
    expect(result).toMatchObject({ success: true, todos: [{ content: "Ship", status: "in_progress" }] });
    expect(chatThread).not.toHaveBeenCalled();
  });

  it("opens a set_preview target in OrgDO's thread UI state", async () => {
    const upsertThreadPreviewTarget = vi.fn(async () => ({}));
    const { instance, chatThread } = binding({
      getWorkerScript: async () => ({ workspace_id: "ws1", is_public: true, script_name: "shop" }),
      upsertThreadPreviewTarget,
    });
    Object.defineProperty(instance, "getAppUrl", { value: async () => "https://shop.test" });
    const result = await methods.setPreview.call(instance, { app_name: "shop" });
    const target = { kind: "app", scriptName: "shop", isPublic: true };
    expect(result).toMatchObject({ success: true, target });
    expect(upsertThreadPreviewTarget).toHaveBeenCalledWith("thread1", target);
    expect(chatThread).not.toHaveBeenCalled();
  });

  it("refuses the automation outcome, which only scheduled runs report", async () => {
    const { instance } = binding({});
    await expect(methods.reportAutomationOutcome.call(instance, { status: "success", summary: "x" }))
      .rejects.toThrow(/scheduled automation runs/);
  });
});
