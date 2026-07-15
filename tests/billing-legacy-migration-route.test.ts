import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const getEnvMock = vi.fn();
const previewLegacyStripeMigrationMock = vi.fn();
const migrateLegacyStripeSubscriptionMock = vi.fn();

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
    previewLegacyStripeMigration: previewLegacyStripeMigrationMock,
    migrateLegacyStripeSubscription: migrateLegacyStripeSubscriptionMock,
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
    previewLegacyStripeMigrationMock.mockResolvedValue({
      plan: "team",
      seatCount: 3,
      currency: "usd",
      monthlyPriceCents: 15000,
      amountDueTodayCents: 11996,
      legacyCreditCents: 3004,
      newPlanProrationCents: 15000,
      includedCreditCents: 15000,
    });

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
      legacyMigrationPreview: {
        plan: "team",
        seatCount: 3,
        currency: "usd",
        monthlyPriceCents: 15000,
        amountDueTodayCents: 11996,
        legacyCreditCents: 3004,
        newPlanProrationCents: 15000,
        includedCreditCents: 15000,
      },
    });
    expect(previewLegacyStripeMigrationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        userEmail: "owner@example.com",
        plan: "team",
        seatCount: 3,
      }),
    );
  });

  it("applies the locked migration only on an explicit confirmation", async () => {
    const org = {
      id: "org_123",
      name: "Legacy Pro",
      billing_status: "inactive",
      billing_plan: "free",
      billing_subscription_id: null,
    };
    const orgStub = {
      getInfo: vi.fn(async () => org),
      getMemberCount: vi.fn(async () => 1),
      getInvitations: vi.fn(async () => []),
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
    migrateLegacyStripeSubscriptionMock.mockResolvedValue(org);
    const formData = new FormData();
    formData.set("plan", "pro");
    formData.set("confirm", "true");

    const response = await action({
      request: new Request(
        "https://camelai.test/api/billing/legacy-migration",
        { method: "POST", body: formData },
      ),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(migrateLegacyStripeSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        org,
        userEmail: "owner@example.com",
        plan: "pro",
        seatCount: 1,
      }),
    );
    expect(previewLegacyStripeMigrationMock).not.toHaveBeenCalled();
  });
});
