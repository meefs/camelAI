import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const deleteThreadMock = vi.fn();
const removeDeletedThreadFromOrgGroupsMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  getAuthEnv: vi.fn(),
  requireAuthContext: requireAuthContextMock,
  requireOrgAdmin: requireOrgAdminMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: vi.fn(),
}));

vi.mock("@/lib/chat-do.server", () => ({
  deleteThread: deleteThreadMock,
}));

vi.mock("@/lib/chat-groups.server", () => ({
  removeDeletedThreadFromOrgGroups: removeDeletedThreadFromOrgGroupsMock,
}));

vi.mock("@/components/pages/history/history-client", () => ({
  default: () => null,
}));

vi.mock("@/components/history/history-loading", () => ({
  HistoryLoadingSkeleton: () => null,
}));

vi.mock("@/components/no-workspaces-error", () => ({
  NoWorkspacesError: () => null,
}));

vi.mock("@/lib/history.server", () => ({
  buildHistoryQueryKey: vi.fn(),
  fetchHistoryThreadCreators: vi.fn(),
  fetchHistoryThreadsPage: vi.fn(),
  getHistoryCreatedBy: vi.fn(),
  getHistoryScope: vi.fn(),
  hydrateHistoryThreadCreators: vi.fn(),
  hydrateHistoryThreads: vi.fn(),
}));

const historyRoute = await import("@/routes/_app.history");
const settingsChatsRoute = await import("@/routes/_app.settings.workspace.chats");

function makeDeleteArgs() {
  const formData = new FormData();
  formData.set("intent", "deleteThread");
  formData.set("threadId", "thread_1");
  formData.set("workspaceId", "ws_1");
  return {
    request: new Request("https://camelai.test/chat-history", {
      method: "POST",
      body: formData,
    }),
    context: {},
    params: {},
  } as never;
}

describe("chat delete cleanup routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthContextMock.mockResolvedValue({
      currentOrg: { id: "org_1" },
    });
    requireOrgAdminMock.mockResolvedValue(undefined);
    deleteThreadMock.mockResolvedValue(true);
    removeDeletedThreadFromOrgGroupsMock.mockResolvedValue(undefined);
  });

  it("does not remove org group memberships when history delete is a no-op", async () => {
    deleteThreadMock.mockResolvedValue(false);

    await expect(historyRoute.action(makeDeleteArgs())).resolves.toEqual({
      error: "Thread not found",
    });
    expect(removeDeletedThreadFromOrgGroupsMock).not.toHaveBeenCalled();
  });

  it("cleans org group memberships after a confirmed history delete", async () => {
    await expect(historyRoute.action(makeDeleteArgs())).resolves.toEqual({
      success: true,
    });
    expect(removeDeletedThreadFromOrgGroupsMock).toHaveBeenCalledWith(
      {},
      "org_1",
      "thread_1",
    );
  });

  it("does not remove org group memberships when settings delete is a no-op", async () => {
    deleteThreadMock.mockResolvedValue(false);

    await expect(settingsChatsRoute.action(makeDeleteArgs())).resolves.toEqual({
      error: "Thread not found",
    });
    expect(removeDeletedThreadFromOrgGroupsMock).not.toHaveBeenCalled();
  });
});
