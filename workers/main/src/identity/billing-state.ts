import type { Organization } from "../../../../src/types";
import {
  normalizeBillingPlan,
  normalizeSeatCount,
} from "../../../../src/lib/billing-plans";

export function normalizeOrgBillingFields(info: Organization): boolean {
  let changed = false;
  if (!info.billing_status) {
    info.billing_status = "inactive";
    changed = true;
  }
  const subscriptionStatus = info.billing_subscription_status?.trim();
  const hasRecoverableSubscription =
    Boolean(info.billing_subscription_id?.trim()) &&
    (subscriptionStatus === "active" ||
      subscriptionStatus === "trialing" ||
      subscriptionStatus === "past_due" ||
      subscriptionStatus === "unpaid" ||
      subscriptionStatus === "incomplete" ||
      subscriptionStatus === "paused");
  if (
    info.billing_status === "canceled" ||
    (info.billing_status === "inactive" && !hasRecoverableSubscription)
  ) {
    if (info.billing_status !== "inactive") {
      info.billing_status = "inactive";
      changed = true;
    }
    if (info.billing_plan !== "payg") {
      info.billing_plan = "payg";
      changed = true;
    }
    if (!hasRecoverableSubscription && info.billing_subscription_id !== null) {
      info.billing_subscription_id = null;
      changed = true;
    }
    if (
      !hasRecoverableSubscription &&
      info.billing_subscription_status !== null
    ) {
      info.billing_subscription_status = null;
      changed = true;
    }
  }
  const normalizedPlan = normalizeBillingPlan(
    info.billing_plan,
    info.billing_status,
  );
  if (info.billing_plan !== normalizedPlan) {
    info.billing_plan = normalizedPlan;
    changed = true;
  }
  const normalizedSeats = normalizeSeatCount(
    normalizedPlan,
    info.billing_seat_count,
  );
  if (info.billing_seat_count !== normalizedSeats) {
    info.billing_seat_count = normalizedSeats;
    changed = true;
  }
  return changed;
}
