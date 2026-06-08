/**
 * Sandbox Proxy Authentication
 *
 * Validates requests forwarded by a trusted runtime proxy.
 * The proxy adds identity headers (org ID, workspace ID) and authenticates
 * either with Cloudflare-verified mTLS or a configured bearer/shared secret.
 *
 */

export interface SandboxProxyAuthEnv {
  SANDBOX_PROXY_SECRET?: string;
  PROJECT_RUNTIME_PROXY_SECRET?: string;
}

export interface SandboxProxyIdentity {
  valid: true;
  orgId: string;
  workspaceId: string;
  userId?: string;
  threadId?: string;
  projectId?: string;
}

export interface SandboxProxyInvalid {
  valid: false;
}

export type SandboxProxyResult = SandboxProxyIdentity | SandboxProxyInvalid;

export interface ProjectRuntimeProxyIdentity {
  valid: true;
  projectId: string;
}

export type ProjectRuntimeProxyResult = ProjectRuntimeProxyIdentity | SandboxProxyInvalid;

/**
 * Check if a request was forwarded by a trusted runtime proxy.
 * Returns the org/workspace identity if mTLS or shared-secret auth succeeds,
 * or { valid: false } if the header is absent or doesn't match.
 */
export function validateSandboxProxy(
  request: Request,
  env: SandboxProxyAuthEnv,
): SandboxProxyResult {
  if (!hasVerifiedClientCertificate(request) && !hasValidSharedSecret(request, env)) {
    return { valid: false };
  }

  const orgId = request.headers.get('x-chiridion-org-id');
  const workspaceId = request.headers.get('x-chiridion-workspace-id');
  if (!orgId || !workspaceId) {
    return { valid: false };
  }
  const userId = request.headers.get('x-chiridion-user-id')?.trim() || undefined;
  const threadId = request.headers.get('x-chiridion-thread-id')?.trim() || undefined;
  const projectId = request.headers.get('x-chiridion-project-id')?.trim() || undefined;
  return { valid: true, orgId, workspaceId, userId, threadId, projectId };
}

export function validateProjectRuntimeProxy(
  request: Request,
  env: SandboxProxyAuthEnv,
): ProjectRuntimeProxyResult {
  if (
    !hasVerifiedClientCertificate(request) &&
    !hasValidProjectRuntimeSharedSecret(request, env)
  ) {
    return { valid: false };
  }
  const projectId = request.headers.get("x-project-runtime-project")?.trim();
  if (!projectId) return { valid: false };
  return { valid: true, projectId };
}

type TlsClientAuth = {
  certRevoked?: string;
  certVerified?: string;
};

type RequestWithCloudflareMetadata = Request & {
  cf?: {
    tlsClientAuth?: TlsClientAuth;
  };
};

function hasVerifiedClientCertificate(request: Request): boolean {
  const tlsClientAuth = (request as RequestWithCloudflareMetadata).cf?.tlsClientAuth;
  if (tlsClientAuth?.certVerified !== "SUCCESS" || tlsClientAuth.certRevoked === "1") {
    return false;
  }

  return true;
}

function hasValidSharedSecret(request: Request, env: SandboxProxyAuthEnv): boolean {
  const providedSecrets = [
    request.headers.get("x-project-runtime-secret"),
    request.headers.get("x-sandbox-secret"),
    bearerToken(request.headers.get("authorization")),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);

  const expectedSecrets = secretList([
    env.PROJECT_RUNTIME_PROXY_SECRET,
    env.SANDBOX_PROXY_SECRET,
  ]);

  return providedSecrets.some((provided) =>
    expectedSecrets.some((expected) => constantTimeEqual(provided, expected)),
  );
}

function hasValidProjectRuntimeSharedSecret(request: Request, env: SandboxProxyAuthEnv): boolean {
  const providedSecrets = [
    request.headers.get("x-project-runtime-secret"),
    bearerToken(request.headers.get("authorization")),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);

  const expectedSecrets = secretList([
    env.PROJECT_RUNTIME_PROXY_SECRET,
  ]);

  return providedSecrets.some((provided) =>
    expectedSecrets.some((expected) => constantTimeEqual(provided, expected)),
  );
}

function bearerToken(authorization: string | null): string | null {
  const match = authorization?.match(/^Bearer\s+(.+?)\s*$/i);
  return match?.[1] ?? null;
}

function secretList(values: Array<string | undefined>): string[] {
  return values
    .flatMap((value) => value?.split(",") ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
}

function constantTimeEqual(a: string, b: string): boolean {
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}
