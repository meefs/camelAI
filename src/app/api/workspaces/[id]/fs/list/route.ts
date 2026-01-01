import { NextRequest } from 'next/server';
import * as computerDO from '@/lib/computer-do';
import { errorResponse, jsonResponse } from '@/lib/auth';
import { getPathParam, requireWorkspaceSession } from '../utils';

interface RouteParams {
  params: Promise<{ id: string }>;
}

function parseBooleanParam(value: string | null, defaultValue: boolean): boolean {
  if (value === null) return defaultValue;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  return defaultValue;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireWorkspaceSession(id);
    if (auth.response) return auth.response;

    const path = getPathParam(request);
    const recursive = parseBooleanParam(request.nextUrl.searchParams.get('recursive'), false);
    const includeHidden = parseBooleanParam(
      request.nextUrl.searchParams.get('includeHidden'),
      true
    );

    const listing = await computerDO.listWorkspaceEntries(id, {
      path,
      recursive,
      includeHidden,
    });

    return jsonResponse(listing);
  } catch (error) {
    console.error('Error listing workspace files:', error);
    return errorResponse('Failed to list workspace files', 500);
  }
}
