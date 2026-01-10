/**
 * Session storage using KV instead of Durable Objects.
 *
 * Key structure:
 * - session:{sessionId} -> SessionData (with TTL)
 * - user_sessions:{userId}:{sessionId} -> "1" (for listing user sessions)
 */

export interface SessionData {
  user_id: string;
  org_id: string;
  workspace_id: string | null;
  created_at: number;
  last_accessed: number;
  expires_at: number;
}

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function userSessionKey(userId: string, sessionId: string): string {
  return `user_sessions:${userId}:${sessionId}`;
}

export async function getSession(
  kv: KVNamespace,
  sessionId: string
): Promise<SessionData | null> {
  const data = await kv.get(sessionKey(sessionId), 'json');
  if (!data) return null;

  const session = data as SessionData;

  // Check expiration
  if (session.expires_at < Date.now()) {
    await destroySession(kv, sessionId, session.user_id);
    return null;
  }

  return session;
}

export async function createSession(
  kv: KVNamespace,
  sessionId: string,
  data: SessionData
): Promise<void> {
  // Store session with TTL
  await kv.put(sessionKey(sessionId), JSON.stringify(data), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  // Store user->session mapping for listing
  await kv.put(userSessionKey(data.user_id, sessionId), '1', {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function updateSession(
  kv: KVNamespace,
  sessionId: string,
  data: SessionData
): Promise<void> {
  // Calculate remaining TTL based on expires_at
  const remainingMs = data.expires_at - Date.now();
  const remainingSeconds = Math.max(60, Math.floor(remainingMs / 1000)); // min 60s

  await kv.put(sessionKey(sessionId), JSON.stringify(data), {
    expirationTtl: remainingSeconds,
  });
}

export async function destroySession(
  kv: KVNamespace,
  sessionId: string,
  userId?: string
): Promise<void> {
  // If we don't have userId, fetch session first to get it
  let resolvedUserId = userId;
  if (!resolvedUserId) {
    const session = await kv.get(sessionKey(sessionId), 'json') as SessionData | null;
    resolvedUserId = session?.user_id;
  }

  // Delete session
  await kv.delete(sessionKey(sessionId));

  // Delete user->session mapping if we have userId
  if (resolvedUserId) {
    await kv.delete(userSessionKey(resolvedUserId, sessionId));
  }
}

export async function listUserSessions(
  kv: KVNamespace,
  userId: string
): Promise<string[]> {
  const prefix = `user_sessions:${userId}:`;
  const list = await kv.list({ prefix });
  return list.keys.map((k) => k.name.slice(prefix.length));
}

export async function destroyAllUserSessions(
  kv: KVNamespace,
  userId: string
): Promise<void> {
  const sessionIds = await listUserSessions(kv, userId);
  await Promise.all(sessionIds.map((id) => destroySession(kv, id, userId)));
}
