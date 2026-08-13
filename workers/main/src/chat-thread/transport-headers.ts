// Request-header hygiene for the hand-rolled chat transport routes.
//
// The SSE/POST transport hands a browser-shaped `fetch()` request straight to
// ChatThreadDO, and both partyserver and the Agents SDK take routing input from
// request HEADERS. On the WebSocket path those headers were unreachable from a
// browser (a WS handshake cannot carry custom headers) and `routeAgentRequest`
// overwrote the partyserver ones anyway; over plain HTTP any authenticated
// caller can set them:
//   - `x-partykit-room` / `x-partykit-props` — the room/props partyserver
//     resolves the server instance and connection props from.
//   - `x-cf-agents-subagent-url` (`SUB_AGENT_OUTER_URL_HEADER`) — read by
//     `Agent`'s onConnect wrapper, stashed as the `_cf_subAgentOuterUrl`
//     connection flag, and then PREFERRED over `connection.uri` when resolving
//     sub-agent routing. A client-supplied value diverts the attach out of the
//     chat protocol chain (and can make the DO instantiate an unrelated
//     sub-agent facet) instead of running ChatThreadDO.onConnect.
//
// Both namespaces are framework-internal, so the transport strips them wholesale
// rather than enumerating individual names an SDK bump could add to.
const RESERVED_HEADER_PREFIXES = ["x-partykit-", "x-cf-agents-"];

function isReservedTransportHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Deletes every framework-reserved header from a mutable header set. */
export function stripReservedTransportHeaders(headers: Headers): void {
  // Collected first: deleting while iterating a live header set can skip names.
  const reserved: string[] = [];
  for (const name of headers.keys()) {
    if (isReservedTransportHeader(name)) reserved.push(name);
  }
  for (const name of reserved) headers.delete(name);
}

export function hasReservedTransportHeader(headers: Headers): boolean {
  for (const name of headers.keys()) {
    if (isReservedTransportHeader(name)) return true;
  }
  return false;
}

/**
 * Defense in depth for the DO end of the transport: the request object handed to
 * the framework's connect chain must never carry client-supplied routing
 * headers, whatever put it there. Returns the same request when it is already
 * clean, so ordinary traffic is untouched.
 */
export function withoutReservedTransportHeaders(request: Request): Request {
  if (!hasReservedTransportHeader(request.headers)) return request;
  const headers = new Headers(request.headers);
  stripReservedTransportHeaders(headers);
  return new Request(request, { headers });
}
