import { NextRequest, NextResponse } from 'next/server';
import * as chatDO from '@/lib/chat-do';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  try {
    const thread = await chatDO.getThread(id);
    if (!thread) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(thread);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  try {
    const body = await request.json() as { title: string };
    const thread = await chatDO.updateThread(id, body.title);
    return NextResponse.json(thread);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  try {
    await chatDO.deleteThread(id);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
