import type { DOEnv } from "./env";
import { getAppIndexDatabase } from "../app-index-db.js";
import type { AdminEventType } from "../admin-index-types.js";

export function dispatchAdminEvent(
  ctx: DurableObjectState,
  env: DOEnv,
  event: AdminEventType,
) {
  try {
    const appIndex = getAppIndexDatabase(env);
    if (!appIndex) {
      console.error("APP_DB binding is not configured; admin index event skipped");
      return;
    }
    ctx.waitUntil(
      appIndex
        .applyAdminEvent(event)
        .catch((err) => console.error("D1 admin index sync failed:", err)),
    );
  } catch (err) {
    console.error("Failed to dispatch to D1 admin index", err);
  }
}
