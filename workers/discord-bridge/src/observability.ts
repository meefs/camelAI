import type { DiscordBridgeEnv } from "./types.js";

interface DiscordBridgeObservabilityEvent {
  event: string;
  component: "discord_gateway" | "discord_control" | "discord_rest";
  operation?: string;
  status?: string;
  severity?: "debug" | "info" | "warn" | "error";
  orgId?: string | null;
  workspaceId?: string | null;
  integrationId?: string | null;
  durationMs?: number | null;
  statusCode?: number | null;
  count?: number | null;
  size?: number | null;
  error?: unknown;
}

function safeBlob(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorFields(error: unknown): { name: string; message: string; stack: string } {
  if (!(error instanceof Error)) {
    return { name: error ? "Error" : "", message: error ? String(error) : "", stack: "" };
  }
  return {
    name: error.name || "Error",
    message: error.message || "Unknown error",
    stack: error.stack || "",
  };
}

/**
 * Writes only operational Discord metadata. Callers must never include message
 * content, attachment URLs, OAuth tokens, Gateway session data, or bot tokens.
 */
export function recordDiscordBridgeEvent(
  env: Pick<DiscordBridgeEnv, "OBSERVABILITY_EVENTS" | "ERROR_ANALYTICS">,
  event: DiscordBridgeObservabilityEvent,
): void {
  const error = errorFields(event.error);
  const now = Date.now();
  const sampleIndex = safeBlob(
    event.integrationId || event.workspaceId || event.component,
    96,
  ) || "discord";
  try {
    env.OBSERVABILITY_EVENTS?.writeDataPoint({
      blobs: [
        safeBlob(event.event, 128),
        safeBlob(event.severity ?? (event.error ? "error" : "info"), 32),
        safeBlob(event.component, 128),
        safeBlob(event.operation, 128),
        safeBlob(event.status, 128),
        "",
        "",
        "",
        "",
        safeBlob(event.workspaceId, 128),
        safeBlob(event.orgId, 128),
        "",
        "",
        "discord",
        "",
        safeBlob(error.name, 128),
        safeBlob(error.message, 2_048),
        safeBlob(error.stack, 4_096),
      ],
      doubles: [
        now,
        safeNumber(event.durationMs),
        safeNumber(event.statusCode),
        safeNumber(event.count),
        safeNumber(event.size),
      ],
      indexes: [sampleIndex],
    });
  } catch (analyticsError) {
    console.warn("[discord-observability] failed to write event", analyticsError);
  }

  if (!event.error && event.severity !== "error") return;
  try {
    env.ERROR_ANALYTICS?.writeDataPoint({
      blobs: [
        safeBlob(event.event, 128),
        safeBlob(event.component, 128),
        safeBlob(event.operation, 128),
        safeBlob(event.status, 128),
        safeBlob(error.name, 128),
        safeBlob(error.message, 2_048),
        "",
        safeBlob(event.workspaceId, 128),
        safeBlob(event.orgId, 128),
        "",
        "",
        "",
        "",
        safeBlob(error.stack, 4_096),
      ],
      doubles: [
        now,
        safeNumber(event.durationMs),
        safeNumber(event.statusCode),
        safeNumber(event.count),
        safeNumber(event.size),
      ],
      indexes: [sampleIndex],
    });
  } catch (analyticsError) {
    console.warn("[discord-observability] failed to write error event", analyticsError);
  }
}
