import { describe, expect, it } from "vitest";

import { getBillableTeamInviteSeatChange } from "@/lib/billing-plans";

const teamOrg = (seatCount: number) => ({
  billing_status: "active" as const,
  billing_plan: "team" as const,
  billing_seat_count: seatCount,
  billing_subscription_id: "sub_team",
  billing_subscription_status: "active",
});

describe("getBillableTeamInviteSeatChange", () => {
  it("does not charge for an invite covered by the Team 3-seat minimum", () => {
    expect(getBillableTeamInviteSeatChange(teamOrg(3), 2)).toBeNull();
  });

  it("detects when the next invite exceeds covered Team seats", () => {
    expect(getBillableTeamInviteSeatChange(teamOrg(3), 3)).toEqual({
      coveredSeatCount: 3,
      nextSeatCount: 4,
      addedSeatCount: 1,
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
      nextSeatCount: 4,
      addedSeatCount: 1,
    });
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
