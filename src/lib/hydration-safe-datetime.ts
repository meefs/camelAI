import { useEffect, useState } from "react";

/**
 * Hydration-safe date/number formatting.
 *
 * workerd renders SSR output with a UTC timezone and an en-US default locale,
 * while browsers format with the user's locale and zone. Any render-path
 * formatting that lets either vary produces different text on the server and
 * the first client render, which React 19 surfaces as hydration error #418.
 *
 * The contract here: always format with a fixed locale, and format with UTC
 * on the server and first client render. Components that want browser-local
 * times call `useHydratedTimeZone()` and pass the result through — it flips
 * from "UTC" to the local zone only after hydration (the same pattern as chat
 * message timestamps in chat-messages-view.tsx).
 */
export const HYDRATION_SAFE_LOCALE = "en-US";

/**
 * "UTC" during SSR and the first client render, then `undefined` (browser
 * local zone) after hydration.
 */
export function useHydratedTimeZone(): string | undefined {
  const [timeZone, setTimeZone] = useState<string | undefined>("UTC");

  useEffect(() => {
    setTimeZone(undefined);
  }, []);

  return timeZone;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(
  options: Intl.DateTimeFormatOptions,
  cacheKey: string,
): Intl.DateTimeFormat {
  let formatter = formatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(HYDRATION_SAFE_LOCALE, options);
    formatterCache.set(cacheKey, formatter);
  }
  return formatter;
}

/** e.g. "Jul 21, 2026". Pass a `useHydratedTimeZone()` value from render paths. */
export function formatDate(
  timestampMs: number,
  timeZone?: string,
): string {
  return getFormatter(
    { dateStyle: "medium", timeZone },
    `date|${timeZone ?? "local"}`,
  ).format(new Date(timestampMs));
}

/** e.g. "Jul 21, 2026, 7:00 PM". Pass a `useHydratedTimeZone()` value from render paths. */
export function formatDateTime(
  timestampMs: number,
  timeZone?: string,
): string {
  return getFormatter(
    { dateStyle: "medium", timeStyle: "short", timeZone },
    `datetime|${timeZone ?? "local"}`,
  ).format(new Date(timestampMs));
}

/** e.g. "1,234,567" — fixed locale so SSR and client group digits identically. */
export function formatInteger(value: number): string {
  return value.toLocaleString(HYDRATION_SAFE_LOCALE);
}
