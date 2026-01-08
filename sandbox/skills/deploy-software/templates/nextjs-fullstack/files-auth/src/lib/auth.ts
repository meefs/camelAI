import { cookies } from "next/headers";

const SESSION_COOKIE = "session_id";

export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
}

export interface Session {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

/**
 * Get the current session from cookies.
 * Returns null if no valid session exists.
 */
export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;

  if (!sessionId) {
    return null;
  }

  // TODO: Validate session with your auth DO
  // const response = await fetch(`${AUTH_DO_URL}/sessions/${sessionId}`);
  // if (!response.ok) return null;
  // return response.json();

  return null;
}

/**
 * Get the current user from the session.
 * Returns null if not authenticated.
 */
export async function getCurrentUser(): Promise<User | null> {
  const session = await getSession();
  if (!session) {
    return null;
  }

  // TODO: Fetch user from your auth DO
  // const response = await fetch(`${AUTH_DO_URL}/users/${session.user_id}`);
  // if (!response.ok) return null;
  // return response.json();

  return null;
}

/**
 * Create a session cookie.
 */
export async function setSessionCookie(sessionId: string, expiresAt: Date) {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });
}

/**
 * Clear the session cookie.
 */
export async function clearSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

/**
 * Require authentication for a route.
 * Throws a redirect to /login if not authenticated.
 */
export async function requireAuth(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("Unauthorized");
  }
  return user;
}
