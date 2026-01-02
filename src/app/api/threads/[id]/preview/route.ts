import { NextRequest, NextResponse } from 'next/server';
import * as chatDO from '@/lib/chat-do';

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/threads/[id]/preview - Get current preview workers
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  try {
    const workers = await chatDO.getThreadPreview(id);
    return NextResponse.json({ workers });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST /api/threads/[id]/preview - Set preview workers
// Called from Claude SDK tool in container after successful deploy
export async function POST(request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  try {
    const body = await request.json() as { workers?: string[] };
    if (!body.workers || !Array.isArray(body.workers)) {
      return NextResponse.json({ error: 'Missing workers array' }, { status: 400 });
    }

    const workers = await chatDO.setThreadPreview(id, body.workers);
    return NextResponse.json({ workers });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
