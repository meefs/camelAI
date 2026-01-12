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

export interface AuthState {
  user: User | null;
  loading: boolean;
}

/**
 * Get session ID from cookie (client-side).
 */
export function getSessionId(): string | null {
  const match = document.cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

/**
 * Fetch current user from API.
 */
export async function fetchCurrentUser(): Promise<User | null> {
  try {
    const response = await fetch("/api/auth/me", {
      credentials: "include",
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.user;
  } catch {
    return null;
  }
}

/**
 * Login with email and password.
 */
export async function login(email: string, password: string): Promise<User> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    credentials: "include",
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || "Login failed");
  }

  const data = await response.json();
  return data.user;
}

/**
 * Logout current session.
 */
export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
  });
}
