import { beforeEach, describe, expect, it, vi } from "vitest";

const generateChatGroupIconWithOpenAIMock = vi.fn();

vi.mock("@/lib/chat-group-avatar-generation.server", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/chat-group-avatar-generation.server")
  >();
  return {
    ...actual,
    generateChatGroupIconWithOpenAI: generateChatGroupIconWithOpenAIMock,
  };
});

const { drainChatGroupAvatarMigration } = await import(
  "@/lib/chat-group-avatar-migration.server"
);

function claim(index: number) {
  return {
    id: `group_${index}`,
    name: `Private group name ${index}`,
    avatar: {
      color: "#4F46E5",
      content: "messages-square",
      status: "pending" as const,
    },
    claimId: `claim_${index}`,
    claimedAt: index,
    trigger: "legacy_migration" as const,
  };
}

function makeStub(batches: ReturnType<typeof claim>[][]) {
  return {
    claimChatGroupAvatarMigrationBatch: vi
      .fn()
      .mockImplementation(async () => batches.shift() ?? []),
    setGeneratedChatGroupIcon: vi.fn(
      async (_groupId: string, _claimId: string, icon: string) => ({
        color: "#4F46E5",
        content: icon,
        status: "generated" as const,
      }),
    ),
    markChatGroupAvatarGenerationFailed: vi.fn(async () => ({
      color: "#4F46E5",
      content: "messages-square",
      status: "default" as const,
    })),
    hasChatGroupAvatarMigrationCandidates: vi.fn(async () => false),
  };
}

const args = {
  userId: "user_1",
  orgId: "org_1",
  workspaceId: "workspace_1",
};

describe("chat group avatar migration drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses only each group name, runs at most three selectors concurrently, and continues after failure", async () => {
    const stub = makeStub([
      [claim(1), claim(2), claim(3)],
      [claim(4)],
      [],
    ]);
    let active = 0;
    let maxActive = 0;
    generateChatGroupIconWithOpenAIMock.mockImplementation(
      async (_ai, name: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        if (name.endsWith("2")) throw new Error("model output was private");
        return "rocket";
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await drainChatGroupAvatarMigration(
      { AI: { run: vi.fn() } },
      stub,
      args,
    );

    expect(maxActive).toBe(3);
    expect(generateChatGroupIconWithOpenAIMock).toHaveBeenCalledTimes(4);
    expect(
      generateChatGroupIconWithOpenAIMock.mock.calls.map((call) => call[1]),
    ).toEqual([
      "Private group name 1",
      "Private group name 2",
      "Private group name 3",
      "Private group name 4",
    ]);
    for (const call of generateChatGroupIconWithOpenAIMock.mock.calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({ orgId: "org_1", workspaceId: "workspace_1" }),
      );
      expect(call[2]).not.toHaveProperty("threadId");
    }
    expect(stub.setGeneratedChatGroupIcon).toHaveBeenCalledWith(
      "group_1",
      "claim_1",
      "rocket",
    );
    expect(stub.markChatGroupAvatarGenerationFailed).toHaveBeenCalledWith(
      "group_2",
      "claim_2",
    );
  });

  it("settles null results as failed but leaves ambiguous completion writes leased", async () => {
    const stub = makeStub([[claim(1), claim(2)], []]);
    generateChatGroupIconWithOpenAIMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("rocket");
    stub.setGeneratedChatGroupIcon.mockRejectedValueOnce(
      new Error("ambiguous write"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await drainChatGroupAvatarMigration(
      { AI: { run: vi.fn() } },
      stub,
      args,
    );

    expect(stub.markChatGroupAvatarGenerationFailed).toHaveBeenCalledTimes(1);
    expect(stub.markChatGroupAvatarGenerationFailed).toHaveBeenCalledWith(
      "group_1",
      "claim_1",
    );
  });

  it("caps one drain at 30 groups", async () => {
    const batches = Array.from({ length: 10 }, (_, batch) =>
      Array.from({ length: 3 }, (_, item) => claim(batch * 3 + item)),
    );
    const stub = makeStub(batches);
    stub.hasChatGroupAvatarMigrationCandidates.mockResolvedValueOnce(true);
    generateChatGroupIconWithOpenAIMock.mockResolvedValue("rocket");

    await drainChatGroupAvatarMigration(
      { AI: { run: vi.fn() } },
      stub,
      args,
    );

    expect(stub.claimChatGroupAvatarMigrationBatch).toHaveBeenCalledTimes(10);
    expect(generateChatGroupIconWithOpenAIMock).toHaveBeenCalledTimes(30);
    expect(stub.hasChatGroupAvatarMigrationCandidates).toHaveBeenCalledTimes(1);
  });

  it("does not consume claims when AI is missing and does not log names or model output", async () => {
    const stub = makeStub([[claim(1)]]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await drainChatGroupAvatarMigration({}, stub, args);

    expect(stub.claimChatGroupAvatarMigrationBatch).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Private group name");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("model output");
  });
});
