/**
 * Sandbox Proxy Authentication
 *
 * Validates requests forwarded by the sandbox host reverse proxy.
 * The sandbox host adds identity headers (org ID, workspace ID) and a
 * static shared secret so the Worker can trust the request without
 * per-request token signing.
 *
 * For MCP requests, an additional HMAC identity proof binds each sandbox
 * to a specific org+workspace pair, preventing a malicious sandbox from
 * crafting proxy requests for a different org/workspace.
 */

export interface SandboxProxyIdentity {
  valid: true;
  orgId: string;
  workspaceId: string;
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
  return { valid: true, orgId, workspaceId };
}

// ─── MCP Identity Proof (HMAC) ──────────────────────────────

/**
 * Create an HMAC identity proof binding an MCP caller to a specific
 * org+workspace. The Worker creates this and passes it as an env var
 * to the sandbox; the sandbox includes it in MCP request headers.
 * Since the sandbox doesn't have SANDBOX_PROXY_SECRET, it can't forge
 * a proof for a different org/workspace.
 */
export async function createMcpIdentityProof(
  secret: string,
  orgId: string,
  workspaceId: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`mcp:${orgId}:${workspaceId}`)
  );
  return bufferToHex(new Uint8Array(signature));
}

/**
 * Validate an HMAC identity proof for MCP requests.
 * Uses crypto.subtle.verify for constant-time comparison.
 */
export async function validateMcpIdentityProof(
  secret: string,
  orgId: string,
  workspaceId: string,
  proof: string
): Promise<boolean> {
  const proofBytes = hexToBuffer(proof);
  if (!proofBytes) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    proofBytes.buffer as ArrayBuffer,
    encoder.encode(`mcp:${orgId}:${workspaceId}`)
  );
}

function bufferToHex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuffer(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const matches = hex.match(/.{2}/g);
  if (!matches) return null;
  return new Uint8Array(matches.map(b => parseInt(b, 16)));
}
