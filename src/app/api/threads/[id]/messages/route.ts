import { NextRequest, NextResponse } from 'next/server';
import * as chatDO from '@/lib/chat-do';
import * as authDO from '@/lib/auth-do';
import { getSessionId, unauthorizedResponse } from '@/lib/auth';

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/threads/[id]/messages - Get messages from container's Claude JSONL file
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    // Messages are read directly from the container's Claude conversation JSONL file
    const messages = await chatDO.getMessages(id);
    return NextResponse.json(messages);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST is not supported - messages are sent through WebSocket to the Claude SDK
