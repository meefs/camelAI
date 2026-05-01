import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const getEnvMock = vi.fn();
const createLegacyStripeMigrationPortalSessionMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
  requireOrgAdmin: requireOrgAdminMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/billing.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing.server")>();
  return {
    ...actual,
    createLegacyStripeMigrationPortalSession:
      createLegacyStripeMigrationPortalSessionMock,
  };
});

const { action } = await import("@/routes/api/billing.legacy-migration");

describe("legacy billing migration route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireOrgAdminMock.mockResolvedValue(undefined);
  });

  it("uses billable seats including active invitations for Team migration", async () => {
    const org = {
      id: "org_123",
      name: "Legacy Team",
      slug: "legacy-team",
      billing_status: "inactive",
      billing_plan: "free",
      billing_subscription_id: null,
    };
    const orgStub = {
      getInfo: vi.fn(async () => org),
      getMemberCount: vi.fn(async () => 2),
      getInvitations: vi.fn(async () => [
        { expires_at: Date.now() + 60_000 },
        { expires_at: Date.now() - 60_000 },
      ]),
    };
    const env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
    };
    getEnvMock.mockReturnValue(env);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_123", email: "owner@example.com" },
      currentOrg: org,
    });
    createLegacyStripeMigrationPortalSessionMock.mockResolvedValue(
      "https://billing.stripe.test/legacy-migration",
    );

    const response = await action({
      request: new Request("https://camelai.test/api/billing/legacy-migration", {
        method: "POST",
        headers: {
          referer: "https://camelai.test/settings/organization/team",
        },
        body: (() => {
          const formData = new FormData();
          formData.set("plan", "team");
          return formData;
        })(),
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      billingPortalUrl: "https://billing.stripe.test/legacy-migration",
    });
    expect(createLegacyStripeMigrationPortalSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        userEmail: "owner@example.com",
        returnUrl:
          "https://camelai.test/settings/organization/team?legacy_migration=returned",
        plan: "team",
        seatCount: 3,
      }),
    );
  });
});
