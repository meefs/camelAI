export function sanitizeOAuthRedirectPath(input: string): string {
  if (!input || !input.startsWith("/") || input.startsWith("//")) {
    return "/connections";
  }
  try {
    const parsed = new URL(input, "https://camel.invalid");
    if (parsed.pathname.includes("://") || parsed.pathname.startsWith("//")) {
      return "/connections";
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/connections";
  }
}
