import { NextResponse } from 'next/server';
import * as authDO from '@/lib/auth-do';
import { getSessionId, deleteSessionCookie } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const sessionId = await getSessionId();

    if (sessionId) {
      // Destroy session in DO
      await authDO.destroySession(sessionId);
    }

    // Delete session cookie
    await deleteSessionCookie();

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('Logout error:', e);
    // Still delete cookie even if DO call fails
    await deleteSessionCookie();
    return NextResponse.json({ success: true });
  }
}
