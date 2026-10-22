/**
 * Guard the session-authenticated React Router surface. SameSite cookies are
 * insufficient: deployed user apps can be on a sibling (same-site) origin.
 * Webhooks and bearer-auth Worker routes run before this guard.
 */
export function rejectCrossOriginMutation(request: Request): Response | null {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return null;
  const forbidden = () => Response.json({ error: "Invalid request origin" }, { status: 403 });
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return forbidden();

  const origin = request.headers.get("Origin");
  const referer = request.headers.get("Referer");
  const source = origin ?? referer;
  if (source !== null) {
    try {
      if (new URL(source).origin !== new URL(request.url).origin) return forbidden();
    } catch {
      return forbidden();
    }
    return null;
  }
  if (site === "same-origin") return null;
  // Non-browser callers may authenticate explicitly without browser metadata.
  // Cookie-authenticated calls must prove their source, even if Referrer-Policy
  // suppresses the Referer header. Browsers supply Origin on same-origin POSTs.
  return request.headers.has("Cookie") ? forbidden() : null;
}
