import type { Organization } from "../../../src/types";

export const PAID_VLLM_PRIORITY = "0";
export const FREE_VLLM_PRIORITY = "100";

/**
 * Returns the priority understood by the self-hosted vLLM provider. This is
 * deliberately derived only from server-side billing state: callers must not
 * be able to promote their own requests with a request header.
 *
 * Active subscriptions, enterprise contracts, and organizations that have
 * purchased PAYG credit are paid traffic. Trials and grant-only organizations
 * use the free tier.
 */
export function getHostedVllmPriority(
  org: Pick<Organization, "billing_status"> & {
    billing_credit_purchase_total_cents?: number;
  },
): string {
  if (
    org.billing_status === "active" ||
    org.billing_status === "enterprise" ||
    (org.billing_credit_purchase_total_cents ?? 0) > 0
  ) {
    return PAID_VLLM_PRIORITY;
  }
  return FREE_VLLM_PRIORITY;
}
