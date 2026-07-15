import { describe, expect, it } from "vitest";
import {
  FREE_VLLM_PRIORITY,
  PAID_VLLM_PRIORITY,
  getHostedVllmPriority,
} from "../src/hosted-vllm-priority";

describe("getHostedVllmPriority", () => {
  it("prioritizes active subscriptions, enterprise, and PAYG credit purchases", () => {
    expect(getHostedVllmPriority({ billing_status: "active" })).toBe(
      PAID_VLLM_PRIORITY,
    );
    expect(getHostedVllmPriority({ billing_status: "enterprise" })).toBe(
      PAID_VLLM_PRIORITY,
    );
    expect(
      getHostedVllmPriority({
        billing_status: "inactive",
        billing_credit_purchase_total_cents: 1,
      }),
    ).toBe(PAID_VLLM_PRIORITY);
  });

  it("keeps trials and grant-only organizations in the free queue", () => {
    expect(getHostedVllmPriority({ billing_status: "trialing" })).toBe(
      FREE_VLLM_PRIORITY,
    );
    expect(
      getHostedVllmPriority({
        billing_status: "inactive",
        billing_credit_purchase_total_cents: 0,
      }),
    ).toBe(FREE_VLLM_PRIORITY);
  });
});
