import { NextRequest, NextResponse } from 'next/server';
import * as chatDO from '@/lib/chat-do';

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/threads/[id]/preview - Get current preview workers (script names)
// Returns array of script names like ["orgprefix-myworker"]
// Frontend constructs full URL: https://{scriptName}.chiridion.ai
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  try {
    const workers = await chatDO.getThreadPreview(id);
    return NextResponse.json({ workers });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST is handled by the worker with deploy token auth (see workers/main/src/index.ts)
// This prevents unauthenticated access to setting previews
