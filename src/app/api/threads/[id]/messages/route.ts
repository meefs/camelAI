import { NextRequest, NextResponse } from 'next/server';
import * as chatDO from '@/lib/chat-do';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  try {
    const messages = await chatDO.getMessages(id);
    return NextResponse.json(messages);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  try {
    const body = await request.json() as { role: string; content: string };
    const message = await chatDO.addMessage(id, body.role, body.content);
    return NextResponse.json(message);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
