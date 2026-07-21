import { useEffect } from "react";
import { useLocation } from "react-router";
import {
  initializeMarketingAttribution,
  trackMarketingEvent,
} from "@/lib/marketing-attribution.client";

export function MarketingAttributionTracker() {
  const location = useLocation();

  useEffect(() => {
    void initializeMarketingAttribution(location.search).then(() => {
      if (location.pathname === "/signup") {
        void trackMarketingEvent("signup_start", {
          page_path: location.pathname,
        });
      }
    });
  }, [location.pathname, location.search]);

  return null;
}
