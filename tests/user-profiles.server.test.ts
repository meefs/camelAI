import { describe, expect, it } from "vitest";
import type { User } from "@/types";
import type { AuthEnv } from "@/lib/auth-helpers";
import { loadUserProfileSummaries } from "@/lib/user-profiles.server";

function makeUser(id: string, overrides: Partial<User> = {}): User {
  return {
    id,
    email: `${id}@example.com`,
    email_verified_at: null,
    name: id,
    created_at: 1,
    is_superuser: false,
    avatar: { color: "#000000", content: id.slice(0, 1).toUpperCase() },
    is_orphaned: false,
    orphaned_at: null,
    ...overrides,
  };
}

function makeAuthEnv(profiles: Map<string, User | null>) {
  const calls: string[] = [];
  const env = {
    USER: {
      idFromName(id: string) {
        return id;
      },
      get(id: string) {
        return {
          async getProfile() {
            calls.push(id);
            return profiles.get(id) ?? null;
          },
        };
      },
    },
  } as unknown as AuthEnv;
  return { env, calls };
}

describe("loadUserProfileSummaries", () => {
  it("dedupes ids and reuses preloaded profiles", async () => {
    const currentUser = makeUser("user-current", { name: "Current User" });
    const otherUser = makeUser("user-other", { name: "Other User" });
    const { env, calls } = makeAuthEnv(new Map([["user-other", otherUser]]));

    const profiles = await loadUserProfileSummaries(
      env,
      ["user-current", "user-other", "user-other", "", null, undefined],
      { preloadedUsers: [currentUser] },
    );

    expect(calls).toEqual(["user-other"]);
    expect(profiles.get("user-current")).toEqual({
      id: "user-current",
      name: "Current User",
      email: "user-current@example.com",
      avatar: currentUser.avatar,
    });
    expect(profiles.get("user-other")).toEqual({
      id: "user-other",
      name: "Other User",
      email: "user-other@example.com",
      avatar: otherUser.avatar,
    });
  });

  it("reuses cached profile promises for the same request", async () => {
    const user = makeUser("user-1");
    const { env, calls } = makeAuthEnv(new Map([["user-1", user]]));
    const request = new Request("https://example.com/apps");

    await loadUserProfileSummaries(env, ["user-1"], { request });
    await loadUserProfileSummaries(env, ["user-1"], { request });

    expect(calls).toEqual(["user-1"]);
  });

  it("omits profiles that no longer exist", async () => {
    const { env } = makeAuthEnv(new Map([["deleted-user", null]]));

    const profiles = await loadUserProfileSummaries(env, ["deleted-user"]);

    expect(profiles.has("deleted-user")).toBe(false);
  });
});
