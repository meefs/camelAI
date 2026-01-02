import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import { getSessionId, unauthorizedResponse } from '@/lib/auth';

// This REST endpoint is deprecated - messages are sent through WebSocket to Claude SDK
// Keeping for backwards compatibility but returning an error
export async function POST(request: NextRequest) {
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    // Validate request format
    const { threadId, message } = await request.json() as { threadId: string; message: string };
    if (!threadId || !message) {
      return Response.json({ error: 'Missing threadId or message' }, { status: 400 });
    }

    // Messages should be sent through WebSocket, not REST
    return Response.json(
      { error: 'Use WebSocket connection to send messages to Claude' },
      { status: 400 }
    );
  } catch (e) {
    console.error('Chat error:', e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
