/** Accept only app-local paths, after the same URL normalization browsers use. */
export function safeRedirectPath(input: string | null | undefined, fallback = "/"): string {
  if (!input?.startsWith("/") || /[\\\p{Cc}\s]/u.test(input)) return fallback;
  try {
    const base = "https://redirect.invalid";
    const parsed = new URL(input, base);
    if (parsed.origin !== base || parsed.pathname.startsWith("//")) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
