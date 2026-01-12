/**
 * Auth API route handlers.
 *
 * These are example implementations. In production, integrate with
 * your auth Durable Object for persistent user/session storage.
 */

const SESSION_COOKIE = "session_id";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface Session {
  id: string;
  user_id: string;
  email: string;
  expires_at: number;
}

// In-memory session store (for demo only - use Durable Objects in production)
const sessions = new Map<string, Session>();

export async function handleAuthLogin(request: Request): Promise<Response> {
  try {
    const { email, password } = await request.json() as { email: string; password: string };

    if (!email || !password) {
      return Response.json(
        { error: "Email and password are required" },
        { status: 400 }
      );
    }

    // TODO: Validate credentials with your auth Durable Object
    // For demo, accept any email/password
    const sessionId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const expiresAt = Date.now() + SESSION_DURATION_MS;

    const session: Session = {
      id: sessionId,
      user_id: userId,
      email,
      expires_at: expiresAt,
    };

    sessions.set(sessionId, session);

    const user = {
      id: userId,
      email,
      name: null,
    };

    return new Response(JSON.stringify({ user }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DURATION_MS / 1000}`,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function handleAuthLogout(request: Request): Promise<Response> {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  const sessionId = match?.[1];

  if (sessionId) {
    sessions.delete(sessionId);
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });
}

export async function handleAuthMe(request: Request): Promise<Response> {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  const sessionId = match?.[1];

  if (!sessionId) {
    return Response.json({ user: null }, { status: 401 });
  }

  const session = sessions.get(sessionId);

  if (!session || session.expires_at < Date.now()) {
    if (session) sessions.delete(sessionId);
    return Response.json({ user: null }, { status: 401 });
  }

  const user = {
    id: session.user_id,
    email: session.email,
    name: null,
  };

  return Response.json({ user });
}
