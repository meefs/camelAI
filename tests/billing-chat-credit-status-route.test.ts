import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgBillingOverview } from "@/lib/billing.server";

const requireAuthContextMock = vi.fn();
const getEnvMock = vi.fn();
const getOrgBillingOverviewMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/billing.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing.server")>();
  return {
    ...actual,
    getOrgBillingOverview: getOrgBillingOverviewMock,
  };
});

const { loader } = await import("@/routes/api/billing.chat-credit-status");

function makeOverview(): OrgBillingOverview {
  return {
    org_id: "org_123",
    billing_status: "active",
    billing_plan: "starter",
    billing_seat_count: 1,
    billing_subscription_status: "active",
    billing_trial_started_at: null,
    billing_trial_ends_at: null,
    billing_credit_purchase_total_cents: 0,
    billing_credit_grant_total_cents: 0,
    billing_trial_credit_grant_cents: 0,
    billing_trial_credit_granted_at: null,
    billing_free_credit_grant_cents: 0,
    billing_free_credit_granted_at: null,
    billing_last_included_credit_invoice_id: null,
    billing_credit_usage_started_at: null,
    lifetime_spend_cents: 0,
    chargeable_usage_cents: 0,
    chargeable_request_count: 0,
    available_credits_cents: 0,
    total_credit_limit_cents: 0,
    trial_credit_allowance_cents: 1000,
    subscription_included_credit_cents: 1000,
  };
}

describe("billing chat credit status route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the bootstrapped org provider config without rereading OrgDO", async () => {
    const getLlmProviderConfig = vi.fn(async () => {
      throw new Error("unexpected provider config read");
    });
    getEnvMock.mockReturnValue({
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ getLlmProviderConfig })),
      },
    });
    requireAuthContextMock.mockResolvedValue({
      currentOrg: {
        id: "org_123",
        name: "Org",
        billing_status: "active",
        billing_plan: "starter",
      },
      currentOrgLlmProviderConfig: {
        provider: "anthropic",
        credentials_encrypted: "encrypted",
        config: "{}",
        created_by: "user_123",
        created_at: 1,
        updated_at: 1,
      },
    });
    getOrgBillingOverviewMock.mockResolvedValue(makeOverview());

    const result = await loader({
      request: new Request(
        "https://camelai.test/api/billing/chat-credit-status?model=sonnet",
      ),
      context: {},
      params: {},
    } as never);

    expect(getLlmProviderConfig).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      billingCreditStatus: null,
    });
  });
});
