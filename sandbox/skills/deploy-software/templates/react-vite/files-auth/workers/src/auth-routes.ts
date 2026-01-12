/**
 * Auth API route handlers using Hono.
 *
 * These are example implementations. In production, integrate with
 * your auth Durable Object for persistent user/session storage.
 */

import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const SESSION_COOKIE = "session_id";
const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60; // 7 days

interface Session {
  id: string;
  user_id: string;
  email: string;
  expires_at: number;
}

// In-memory session store (for demo only - use Durable Objects in production)
const sessions = new Map<string, Session>();

export const authRoutes = new Hono();

authRoutes.post("/login", async (c) => {
  try {
    const { email, password } = await c.req.json<{ email: string; password: string }>();

    if (!email || !password) {
      return c.json({ error: "Email and password are required" }, 400);
    }

    // TODO: Validate credentials with your auth Durable Object
    // For demo, accept any email/password
    const sessionId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const expiresAt = Date.now() + SESSION_DURATION_SECONDS * 1000;

    const session: Session = {
      id: sessionId,
      user_id: userId,
      email,
      expires_at: expiresAt,
    };

    sessions.set(sessionId, session);

    setCookie(c, SESSION_COOKIE, sessionId, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      maxAge: SESSION_DURATION_SECONDS,
    });

    const user = {
      id: userId,
      email,
      name: null,
    };

    return c.json({ user });
  } catch (error) {
    console.error("Login error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

authRoutes.post("/logout", (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);

  if (sessionId) {
    sessions.delete(sessionId);
  }

  deleteCookie(c, SESSION_COOKIE, { path: "/" });

  return c.json({ success: true });
});

authRoutes.get("/me", (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);

  if (!sessionId) {
    return c.json({ user: null }, 401);
  }

  const session = sessions.get(sessionId);

  if (!session || session.expires_at < Date.now()) {
    if (session) sessions.delete(sessionId);
    return c.json({ user: null }, 401);
  }

  const user = {
    id: session.user_id,
    email: session.email,
    name: null,
  };

  return c.json({ user });
});
