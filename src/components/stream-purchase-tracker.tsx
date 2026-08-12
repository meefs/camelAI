import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { trackMarketingEventOnce } from "@/lib/marketing-attribution.client";

type PurchaseResponse = {
  purchased: boolean;
  shouldTrack?: boolean;
  eventId?: string;
  billingStatus?: "active" | "trialing";
  subscriptionId?: string | null;
};

export function StreamPurchaseTracker() {
  const location = useLocation();
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (attemptedRef.current) return;
    const searchParams = new URLSearchParams(location.search);
    if (searchParams.get("checkout") !== "success") return;

    attemptedRef.current = true;

    void fetch("/api/marketing-attribution/purchase", {
      method: "POST",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Failed to confirm purchase");
        }
        return response.json() as Promise<PurchaseResponse>;
      })
      .then(async (result) => {
        if (result.purchased && result.shouldTrack && result.eventId) {
          await trackMarketingEventOnce("purchase", result.eventId, {
            billing_status: result.billingStatus,
            subscription_id: result.subscriptionId,
            transaction_id: result.eventId,
          });
        }
      })
      .catch((error) => {
        attemptedRef.current = false;
        console.error("Failed to track Stream purchase", error);
      })
      .finally(() => {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete("checkout");
        window.history.replaceState(
          window.history.state,
          "",
          `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`,
        );
      });
  }, [location.search]);

  return null;
}
