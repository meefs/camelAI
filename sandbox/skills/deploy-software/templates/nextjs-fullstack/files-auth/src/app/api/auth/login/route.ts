import { NextResponse } from "next/server";
import { setSessionCookie } from "@/lib/auth";

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
      );
    }

    // TODO: Validate credentials with your auth DO
    // const response = await fetch(`${AUTH_DO_URL}/login`, {
    //   method: "POST",
    //   body: JSON.stringify({ email, password }),
    // });
    // if (!response.ok) {
    //   return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    // }
    // const { session, user } = await response.json();

    // For now, return a placeholder response
    // Replace this with actual auth DO integration
    const session = {
      id: crypto.randomUUID(),
      user_id: crypto.randomUUID(),
      expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    };

    const user = {
      id: session.user_id,
      email,
      name: null,
    };

    await setSessionCookie(session.id, new Date(session.expires_at));

    return NextResponse.json({ user });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
