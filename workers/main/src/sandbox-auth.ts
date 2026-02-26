/**
 * Sandbox Proxy Authentication
 *
 * Validates requests forwarded by the sandbox host reverse proxy.
 * The sandbox host adds identity headers (org ID, workspace ID) and a
 * static shared secret so the Worker can trust the request without
 * per-request token signing.
 *
 */

export interface SandboxProxyIdentity {
  valid: true;
  orgId: string;
  workspaceId: string;
  userId?: string;
}

export interface SandboxProxyInvalid {
  valid: false;
}

export type SandboxProxyResult = SandboxProxyIdentity | SandboxProxyInvalid;

/**
 * Check if a request was forwarded by the sandbox host proxy.
 * Returns the org/workspace identity if the shared secret matches,
 * or { valid: false } if the header is absent or doesn't match.
 */
export function validateSandboxProxy(
  request: Request,
  env: { SANDBOX_PROXY_SECRET?: string }
): SandboxProxyResult {
  const secret = request.headers.get('x-sandbox-secret');
  if (!secret || !env.SANDBOX_PROXY_SECRET || secret !== env.SANDBOX_PROXY_SECRET) {
    return { valid: false };
  }
  const orgId = request.headers.get('x-chiridion-org-id');
  const workspaceId = request.headers.get('x-chiridion-workspace-id');
  if (!orgId || !workspaceId) {
    return { valid: false };
  }
  const userId = request.headers.get('x-chiridion-user-id')?.trim() || undefined;
  return { valid: true, orgId, workspaceId, userId };
}
