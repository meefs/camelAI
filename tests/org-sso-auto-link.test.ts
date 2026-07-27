import { describe, expect, it, vi } from "vitest";
import type { User } from "@/types";
import type { AuthEnv } from "@/lib/auth-helpers";
import {
  resolveOrgSsoUser,
  validateOrgSsoIdentityClaims,
} from "@/lib/org-sso.server";

function user(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "alice@example.com",
    email_verified_at: Date.now(),
    name: "Alice",
    created_at: Date.now(),
    is_superuser: false,
    avatar: { color: "#000000", content: "A" },
    is_orphaned: false,
    orphaned_at: null,
    ...overrides,
  };
}

function authEnv(profile: User): AuthEnv {
  const userStub = { getProfile: vi.fn().mockResolvedValue(profile) };
  return {
    EMAIL_TO_USER: {
      get: vi.fn().mockResolvedValue(profile.id),
    },
    USER: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => userStub),
    },
    APP_KV: {
      get: vi.fn().mockResolvedValue(null),
    },
  } as unknown as AuthEnv;
}

const googleIdentity = validateOrgSsoIdentityClaims(
  {
    sub: "google-subject",
    email: "alice@example.com",
    email_verified: true,
    hd: "example.com",
  },
  {
    issuer: "https://accounts.google.com",
    email_claim: "email",
    email_domains: ["example.com"],
  },
);

describe("enterprise SSO first-login linking", () => {
  it("auto-links a verified existing organization member", async () => {
    const profile = user();
    const memberLookup = { getMember: vi.fn().mockResolvedValue({ role: "member" }) };
    await expect(
      resolveOrgSsoUser({
        authEnv: authEnv(profile),
        orgStub: memberLookup,
        identity: googleIdentity,
        mappedUserId: null,
        linkUserId: null,
      }),
    ).resolves.toEqual({ userId: profile.id, user: profile });
    expect(memberLookup.getMember).toHaveBeenCalledWith(profile.id);
  });

  it("does not auto-link an unverified local account or a non-member", async () => {
    await expect(
      resolveOrgSsoUser({
        authEnv: authEnv(user({ email_verified_at: null })),
        orgStub: { getMember: vi.fn().mockResolvedValue({ role: "member" }) },
        identity: googleIdentity,
        mappedUserId: null,
        linkUserId: null,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveOrgSsoUser({
        authEnv: authEnv(user()),
        orgStub: { getMember: vi.fn().mockResolvedValue(null) },
        identity: googleIdentity,
        mappedUserId: null,
        linkUserId: null,
      }),
    ).resolves.toBeNull();
  });

  it("keeps superusers out of enterprise-authenticated sessions", async () => {
    try {
      await resolveOrgSsoUser({
        authEnv: authEnv(user({ is_superuser: true })),
        orgStub: { getMember: vi.fn().mockResolvedValue({ role: "owner" }) },
        identity: googleIdentity,
        mappedUserId: null,
        linkUserId: null,
      });
      throw new Error("Expected superuser resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(403);
    }
  });
});
