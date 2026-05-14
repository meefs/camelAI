import { describe, expect, it } from "vitest";

import {
  BILLING_PLAN_LIMITS,
  getBillableTeamInviteSeatChange,
  getBillableTeamInviteSeatChangeForCount,
  normalizeBillingPlan,
} from "@/lib/billing-plans";

const teamOrg = (seatCount: number) => ({
  billing_status: "active" as const,
  billing_plan: "team" as const,
  billing_seat_count: seatCount,
  billing_subscription_id: "sub_team",
  billing_subscription_status: "active",
});

describe("getBillableTeamInviteSeatChange", () => {
  it("returns null when no invites are requested", () => {
    expect(getBillableTeamInviteSeatChangeForCount(teamOrg(3), 3, 0)).toBeNull();
  });

  it("does not charge for an invite covered by the Team 3-seat minimum", () => {
    expect(getBillableTeamInviteSeatChange(teamOrg(3), 2)).toBeNull();
  });

  it("detects when the next invite exceeds covered Team seats", () => {
    expect(getBillableTeamInviteSeatChange(teamOrg(3), 3)).toEqual({
      coveredSeatCount: 3,
      occupiedSeatCount: 3,
      requestedInviteCount: 1,
      nextSeatCount: 4,
      addedSeatCount: 1,
      addedMonthlyAmountCents: BILLING_PLAN_LIMITS.team.monthlyPriceCents,
    });
  });

  it("detects a batch crossing from 3 to 6 seats", () => {
    expect(getBillableTeamInviteSeatChangeForCount(teamOrg(3), 3, 3)).toEqual({
      coveredSeatCount: 3,
      occupiedSeatCount: 3,
      requestedInviteCount: 3,
      nextSeatCount: 6,
      addedSeatCount: 3,
      addedMonthlyAmountCents:
        3 * (BILLING_PLAN_LIMITS.team.monthlyPriceCents ?? 0),
    });
  });

  it("does not warn when the current subscription already covers the next seat", () => {
    expect(getBillableTeamInviteSeatChange(teamOrg(5), 4)).toBeNull();
  });

  it("uses Stripe subscription status when top-level billing status is stale", () => {
    expect(
      getBillableTeamInviteSeatChange(
        {
          billing_status: "inactive",
          billing_plan: "team",
          billing_seat_count: 3,
          billing_subscription_id: "sub_team",
          billing_subscription_status: "active",
        },
        3,
      ),
    ).toEqual({
      coveredSeatCount: 3,
      occupiedSeatCount: 3,
      requestedInviteCount: 1,
      nextSeatCount: 4,
      addedSeatCount: 1,
      addedMonthlyAmountCents: BILLING_PLAN_LIMITS.team.monthlyPriceCents,
    });
  });

  it("does not allow paid seat expansion for unpaid Stripe subscriptions", () => {
    expect(
      getBillableTeamInviteSeatChange(
        {
          billing_status: "past_due",
          billing_plan: "team",
          billing_seat_count: 3,
          billing_subscription_id: "sub_team",
          billing_subscription_status: "unpaid",
        },
        3,
      ),
    ).toBeNull();
  });

  it("does not warn for non-Team plans or Team orgs without an active Stripe subscription", () => {
    expect(
      getBillableTeamInviteSeatChange(
        {
          billing_status: "active",
          billing_plan: "pro",
          billing_seat_count: 1,
          billing_subscription_id: "sub_pro",
          billing_subscription_status: "active",
        },
        1,
      ),
    ).toBeNull();

    expect(
      getBillableTeamInviteSeatChange(
        {
          billing_status: "inactive",
          billing_plan: "team",
          billing_seat_count: 3,
          billing_subscription_id: null,
          billing_subscription_status: null,
        },
        3,
      ),
    ).toBeNull();
  });
});

describe("normalizeBillingPlan", () => {
  it("uses Pay as you go as the default non-subscription plan", () => {
    expect(normalizeBillingPlan(undefined, "inactive")).toBe("payg");
    expect(normalizeBillingPlan("free", "inactive")).toBe("payg");
  });

  it("preserves explicit subscription plans for stale top-level statuses", () => {
    expect(normalizeBillingPlan("team", "inactive")).toBe("team");
  });
});
