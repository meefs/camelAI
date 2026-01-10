/**
 * Session storage using KV.
 * Key structure: session:{sessionId} -> SessionData (with TTL)
 */

export interface SessionData {
  user_id: string;
  org_id: string;
  workspace_id: string | null;
  created_at: number;
  last_accessed: number;
}

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

export async function getSession(
  kv: KVNamespace,
  sessionId: string
): Promise<SessionData | null> {
  // KV automatically returns null for expired keys
  return kv.get(sessionKey(sessionId), 'json');
}

export async function createSession(
  kv: KVNamespace,
  sessionId: string,
  data: SessionData
): Promise<void> {
  await kv.put(sessionKey(sessionId), JSON.stringify(data), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

/**
 * Creates a new session with auto-generated ID.
 */
export async function createNewSession(
  kv: KVNamespace,
  userId: string,
  orgId: string,
  workspaceId: string | null
): Promise<{ sessionId: string; sessionData: SessionData }> {
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const sessionData: SessionData = {
    user_id: userId,
    org_id: orgId,
    workspace_id: workspaceId,
    created_at: now,
    last_accessed: now,
  };
  await createSession(kv, sessionId, sessionData);
  return { sessionId, sessionData };
}

export async function updateSession(
  kv: KVNamespace,
  sessionId: string,
  data: SessionData
): Promise<void> {
  // Sliding expiration: reset TTL on every update
  await kv.put(sessionKey(sessionId), JSON.stringify(data), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function destroySession(
  kv: KVNamespace,
  sessionId: string
): Promise<void> {
  await kv.delete(sessionKey(sessionId));
}
