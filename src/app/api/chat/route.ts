import { NextRequest } from 'next/server';
import * as chatDO from '@/lib/chat-do';
import * as authDO from '@/lib/auth-do';
import { getSessionId, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

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

    const { threadId, message } = await request.json() as { threadId: string; message: string };

    if (!threadId || !message) {
      return Response.json({ error: 'Missing threadId or message' }, { status: 400 });
    }

    // Save user message
    await chatDO.addMessage(threadId, 'user', message, session.org_id);

    // Mock assistant response
    const response = `This is a mock response to: "${message}"`;
    await chatDO.addMessage(threadId, 'assistant', response, session.org_id);

    // Auto-generate title for new conversations
    const history = await chatDO.getMessages(threadId);
    if (history.length === 2) {
      const title = message.slice(0, 30) + (message.length > 30 ? '...' : '');
      await chatDO.updateThread(threadId, title, session.org_id);
    }

    return Response.json({ response });
  } catch (e) {
    console.error('Chat error:', e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
