/**
 * Worker Auth Utilities
 *
 * Handles cross-domain authentication for private worker access:
 * - Auth state: Temporary state stored before redirect to main app
 * - One-time tokens: Short-lived tokens for session establishment
 * - Dispatcher sessions: Sessions for authenticated access to workers
 *
 * All stored in existing KV namespaces with prefixes:
 * - Auth state: wauth_state:{uuid} in APP_KV KV (60s TTL)
 * - One-time token: wauth_token:{token} in APP_KV KV (60s TTL)
 * - Dispatcher session: worker_session:{uuid} in SESSIONS KV (30d TTL)
 */

// Key prefixes
const AUTH_STATE_PREFIX = 'wauth_state:';
const AUTH_TOKEN_PREFIX = 'wauth_token:';
const DISPATCHER_SESSION_PREFIX = 'worker_session:';

// TTLs (KV requires minimum 60 seconds)
const AUTH_STATE_TTL_SECONDS = 60;
const AUTH_TOKEN_TTL_SECONDS = 60;
const DISPATCHER_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// Token prefix for one-time tokens
const TOKEN_PREFIX = 'wtok_';

/**
 * Auth state stored before redirecting to main app for authentication.
 * Contains the return URL and worker context for validation.
 */
export interface WorkerAuthState {
  return_url: string;
  script_name: string;
  required_org_id: string;
  created_at: number;
}

/**
 * One-time token data generated after successful authentication.
 * Used to establish a dispatcher session on the worker domain.
 */
export interface WorkerAuthToken {
  user_id: string;
  org_id: string;
  state: string;
  script_name: string;
  created_at: number;
}

/**
 * Session data for authenticated access to workers on the dispatcher domain.
 */
export interface DispatcherSession {
  user_id: string;
  org_id: string;
  created_at: number;
  last_accessed: number;
}

/**
 * Generate a cryptographically secure base64url-encoded token.
 */
function generateSecureToken(prefix: string = ''): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return prefix + base64;
}

// ============================================================================
// Auth State Functions (stored in APP_KV KV)
// ============================================================================

/**
 * Create an auth state for the redirect flow.
 * Returns the state UUID to include in the redirect URL.
 */
export async function createAuthState(
  kv: KVNamespace,
  data: Omit<WorkerAuthState, 'created_at'>
): Promise<string> {
  const state = crypto.randomUUID();
  const stateData: WorkerAuthState = {
    ...data,
    created_at: Date.now(),
  };
  await kv.put(
    `${AUTH_STATE_PREFIX}${state}`,
    JSON.stringify(stateData),
    { expirationTtl: AUTH_STATE_TTL_SECONDS }
  );
  return state;
}

/**
 * Validate and consume an auth state.
 * Returns the state data and deletes it (single-use).
 * Returns null if state doesn't exist or is invalid.
 */
export async function validateAndConsumeAuthState(
  kv: KVNamespace,
  state: string
): Promise<WorkerAuthState | null> {
  const key = `${AUTH_STATE_PREFIX}${state}`;
  const data = await kv.get<WorkerAuthState>(key, 'json');
  if (!data) return null;

  // Delete immediately (single-use)
  await kv.delete(key);

  // Additional timestamp validation (belt and suspenders with TTL)
  const age = Date.now() - data.created_at;
  if (age > AUTH_STATE_TTL_SECONDS * 1000) {
    return null;
  }

  return data;
}

// ============================================================================
// One-Time Token Functions (stored in APP_KV KV)
// ============================================================================

/**
 * Create a one-time token for session establishment.
 * Returns the full token string (wtok_xxx).
 */
export async function createWorkerAuthToken(
  kv: KVNamespace,
  data: Omit<WorkerAuthToken, 'created_at'>
): Promise<string> {
  const token = generateSecureToken(TOKEN_PREFIX);
  const tokenData: WorkerAuthToken = {
    ...data,
    created_at: Date.now(),
  };
  await kv.put(
    `${AUTH_TOKEN_PREFIX}${token}`,
    JSON.stringify(tokenData),
    { expirationTtl: AUTH_TOKEN_TTL_SECONDS }
  );
  return token;
}

/**
 * Validate and consume a one-time token.
 * Returns the token data and deletes it (single-use).
 * Returns null if token doesn't exist, is invalid, or has wrong prefix.
 */
export async function validateAndConsumeAuthToken(
  kv: KVNamespace,
  token: string
): Promise<WorkerAuthToken | null> {
  // Validate token prefix
  if (!token.startsWith(TOKEN_PREFIX)) {
    return null;
  }

  const key = `${AUTH_TOKEN_PREFIX}${token}`;
  const data = await kv.get<WorkerAuthToken>(key, 'json');
  if (!data) return null;

  // Delete immediately (single-use)
  await kv.delete(key);

  // Additional timestamp validation
  const age = Date.now() - data.created_at;
  if (age > AUTH_TOKEN_TTL_SECONDS * 1000) {
    return null;
  }

  return data;
}

// ============================================================================
// Dispatcher Session Functions (stored in SESSIONS KV)
// ============================================================================

/**
 * Create a dispatcher session for authenticated worker access.
 * Returns the session ID to store in a cookie.
 */
export async function createDispatcherSession(
  kv: KVNamespace,
  userId: string,
  orgId: string
): Promise<{ sessionId: string; session: DispatcherSession }> {
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const session: DispatcherSession = {
    user_id: userId,
    org_id: orgId,
    created_at: now,
    last_accessed: now,
  };
  await kv.put(
    `${DISPATCHER_SESSION_PREFIX}${sessionId}`,
    JSON.stringify(session),
    { expirationTtl: DISPATCHER_SESSION_TTL_SECONDS }
  );
  return { sessionId, session };
}

/**
 * Get a dispatcher session by ID.
 * Returns null if session doesn't exist.
 */
export async function getDispatcherSession(
  kv: KVNamespace,
  sessionId: string
): Promise<DispatcherSession | null> {
  const key = `${DISPATCHER_SESSION_PREFIX}${sessionId}`;
  return kv.get<DispatcherSession>(key, 'json');
}

/**
 * Update the last_accessed timestamp of a dispatcher session.
 * Resets the TTL (sliding window expiration).
 */
export async function touchDispatcherSession(
  kv: KVNamespace,
  sessionId: string
): Promise<DispatcherSession | null> {
  const key = `${DISPATCHER_SESSION_PREFIX}${sessionId}`;
  const session = await kv.get<DispatcherSession>(key, 'json');
  if (!session) return null;

  session.last_accessed = Date.now();
  await kv.put(key, JSON.stringify(session), {
    expirationTtl: DISPATCHER_SESSION_TTL_SECONDS,
  });
  return session;
}

/**
 * Destroy a dispatcher session.
 */
export async function destroyDispatcherSession(
  kv: KVNamespace,
  sessionId: string
): Promise<void> {
  await kv.delete(`${DISPATCHER_SESSION_PREFIX}${sessionId}`);
}

// ============================================================================
// URL Validation
// ============================================================================

/**
 * Validate that a return URL is safe (points to allowed domain).
 * Prevents open redirect attacks.
 */
export function isValidReturnUrl(url: string, allowedDomainPattern: RegExp): boolean {
  try {
    const parsed = new URL(url);
    // Must be HTTPS in production
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    // Must match allowed domain pattern
    return allowedDomainPattern.test(parsed.hostname);
  } catch {
    return false;
  }
}

// Default pattern for worker domains (*.chiridion.run)
export const WORKER_DOMAIN_PATTERN = /^[a-zA-Z0-9-]+\.chiridion\.run$/;

// Cookie name for dispatcher sessions
export const DISPATCHER_SESSION_COOKIE = 'chiridion_run_session';
