import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatGroupSummary, Thread } from "@/types";

const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getThreadsByIdsMock = vi.fn();
const drainChatGroupAvatarMigrationMock = vi.fn(async () => undefined);

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-helpers", () => ({
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/chat-do.server", () => ({
  getThreadsByIds: getThreadsByIdsMock,
}));

vi.mock("@/lib/chat-group-avatar-migration.server", () => ({
  drainChatGroupAvatarMigration: drainChatGroupAvatarMigrationMock,
}));

const { listGroupsForWorkspace } = await import("@/lib/chat-groups.server");

function makeThread(id: string): Thread {
  return {
    id,
    workspace_id: "workspace_1",
    title: `Thread ${id}`,
    created_by: "user_1",
    model: "haiku",
    created_at: 100,
    updated_at: 200,
    user_message_count: 1,
    first_user_message: null,
    last_user_message: null,
    last_user_message_at: null,
    last_assistant_completed_at: null,
    last_assistant_summary: null,
    last_assistant_summary_status: null,
    source: "web",
    channel_kind: null,
    channel_kinds: null,
    channel_connection_id: null,
    channel_conversation_id: null,
    channel_message_id: null,
  };
}

function makeGroup(): ChatGroupSummary {
  return {
    id: "group_1",
    org_id: "org_1",
    workspace_id: "workspace_1",
    name: "Database migrations",
    last_active_thread_id: "thread_1",
    created_at: 100,
    updated_at: 200,
    avatar: {
      color: "#4F46E5",
      content: "💬",
      status: "default",
    },
    open_thread_ids: ["thread_1"],
    closed_thread_ids: [],
  };
}

describe("chat group server loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("schedules avatar migration without delaying the sidebar loader", async () => {
    const waitUntil = vi.fn();
    const group = makeGroup();
    const userStub = {
      listChatGroups: vi.fn(async () => [group]),
      listThreadViews: vi.fn(async () => ({})),
      pruneMissingThreads: vi.fn(async () => undefined),
    };
    getThreadsByIdsMock.mockResolvedValue([makeThread("thread_1")]);
    getEnvMock.mockReturnValue({
      AI: {
        run: vi.fn(),
      },
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => ({
          listStreamingThreadStatuses: vi.fn(async () => []),
        }),
      },
    });
    getAuthEnvMock.mockReturnValue({
      USER: {
        idFromName: (id: string) => id,
        get: () => userStub,
      },
    });

    const result = await listGroupsForWorkspace(
      {
        cloudflare: {
          ctx: { waitUntil },
        },
      } as never,
      {
        userId: "user_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0].avatar.status).toBe("default");
    expect(result[0].open_threads[0].upload_ref_paths).toBeUndefined();
    expect(drainChatGroupAvatarMigrationMock).toHaveBeenCalledWith(
      expect.objectContaining({ AI: expect.any(Object) }),
      userStub,
      expect.objectContaining({
        userId: "user_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
      }),
    );
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it("hydrates upload ref hints from full user messages before truncating summaries", async () => {
    const waitUntil = vi.fn();
    const group = makeGroup();
    const userStub = {
      listChatGroups: vi.fn(async () => [group]),
      listThreadViews: vi.fn(async () => ({})),
      pruneMissingThreads: vi.fn(async () => undefined),
    };
    const longUserMessage = `${"x".repeat(520)}\n\n(user uploaded file to uploads/report-1712345678901-abcd.csv)`;
    getThreadsByIdsMock.mockResolvedValue([
      {
        ...makeThread("thread_1"),
        last_user_message: longUserMessage,
        last_user_message_at: 150,
      },
    ]);
    getEnvMock.mockReturnValue({
      AI: {
        run: vi.fn(),
      },
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => ({
          listStreamingThreadStatuses: vi.fn(async () => []),
        }),
      },
    });
    getAuthEnvMock.mockReturnValue({
      USER: {
        idFromName: (id: string) => id,
        get: () => userStub,
      },
    });

    const result = await listGroupsForWorkspace(
      {
        cloudflare: {
          ctx: { waitUntil },
        },
      } as never,
      {
        userId: "user_1",
        orgId: "org_1",
        workspaceId: "workspace_1",
      },
    );

    const thread = result[0].open_threads[0];
    expect(thread.upload_ref_paths).toEqual([
      "uploads/report-1712345678901-abcd.csv",
    ]);
    expect(thread.latest_user_message).toHaveLength(500);
    expect(thread.latest_user_message).not.toContain("uploads/report");
  });
});
