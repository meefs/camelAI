import { NextResponse } from "next/server";
import { clearSessionCookie, getSession } from "@/lib/auth";

export async function POST() {
  try {
    const session = await getSession();

    if (session) {
      // TODO: Invalidate session in your auth DO
      // await fetch(`${AUTH_DO_URL}/sessions/${session.id}`, {
      //   method: "DELETE",
      // });
    }

    await clearSessionCookie();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Logout error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
