import { useEffect } from "react";
import { useLocation } from "react-router";
import {
  captureMarketingAttribution,
  trackMarketingEvent,
} from "@/lib/marketing-attribution.client";

export function MarketingAttributionTracker() {
  const location = useLocation();

  useEffect(() => {
    captureMarketingAttribution(location.search);
    if (location.pathname === "/signup") {
      trackMarketingEvent("signup_start", { page_path: location.pathname });
    }
  }, [location.pathname, location.search]);

  return null;
}
