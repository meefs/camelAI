import { NextRequest, NextResponse } from 'next/server';
import * as chatDO from '@/lib/chat-do';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const threads = await chatDO.getThreads();
    return NextResponse.json(threads);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { title?: string };
    const thread = await chatDO.createThread('default', body.title);
    return NextResponse.json(thread);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
